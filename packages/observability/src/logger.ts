import { mkdirSync, createWriteStream } from "node:fs";
import { dirname } from "node:path";
import type { Writable } from "node:stream";
import { isSpanContextValid, trace } from "@opentelemetry/api";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFormat = "json" | "plaintext";
export type LogAttributeValue =
  string | number | boolean | null | LogAttributeValue[] | { [key: string]: LogAttributeValue };
export type LogAttributes = Record<string, LogAttributeValue>;

export type LogSinkConfig =
  | {
      type: "stdout";
      format: LogFormat;
    }
  | {
      type: "file";
      path: string;
      format: LogFormat;
    };

export type LoggerOptions = {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  minimumLevel?: LogLevel;
  sinks?: LogSinkConfig[];
  attributes?: LogAttributes;
  onSinkError?: (error: Error) => void;
};

export type LogContext = {
  attributes?: LogAttributes;
  error?: unknown;
  eventName?: string;
};

export interface Logger {
  trace(body: string, context?: LogContext): void;
  debug(body: string, context?: LogContext): void;
  info(body: string, context?: LogContext): void;
  warn(body: string, context?: LogContext): void;
  error(body: string, context?: LogContext): void;
  fatal(body: string, context?: LogContext): void;
  child(attributes: LogAttributes): Logger;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

type LogRecord = {
  timestamp: string;
  observedTimestamp: string;
  severityNumber: number;
  severityText: Uppercase<LogLevel>;
  body: string;
  resource: LogAttributes;
  attributes: LogAttributes;
  eventName?: string;
  traceId?: string;
  spanId?: string;
  traceFlags?: number;
};

type Sink = {
  write(record: LogRecord): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
};

const SEVERITY_NUMBERS: Record<LogLevel, number> = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
};

const LEVEL_RANKS = Object.fromEntries(LOG_LEVELS.map((level, index) => [level, index])) as Record<
  LogLevel,
  number
>;

const quotePlaintextValue = (value: LogAttributeValue) => {
  return JSON.stringify(value);
};

const formatPlaintext = (record: LogRecord) => {
  // Plaintext keeps the same structured fields as JSON, just sorted for readability.
  const context: LogAttributes = {
    ...record.resource,
    ...record.attributes,
  };

  if (record.eventName !== undefined) context.event_name = record.eventName;
  if (record.traceId !== undefined) context.trace_id = record.traceId;
  if (record.spanId !== undefined) context.span_id = record.spanId;
  if (record.traceFlags !== undefined) context.trace_flags = record.traceFlags;

  const fields = Object.entries(context)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${quotePlaintextValue(value)}`)
    .join(" ");

  return `${record.timestamp} ${record.severityText} ${record.body}${fields ? ` ${fields}` : ""}\n`;
};

const formatJson = (record: LogRecord) => `${JSON.stringify(record)}\n`;

const waitForWritable = (stream: Writable) =>
  stream.writableNeedDrain
    ? new Promise<void>((resolve, reject) => {
        const onDrain = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const cleanup = () => {
          stream.off("drain", onDrain);
          stream.off("error", onError);
        };

        stream.once("drain", onDrain);
        stream.once("error", onError);
      })
    : Promise.resolve();

const closeWritable = (stream: Writable) =>
  new Promise<void>((resolve, reject) => {
    stream.end((error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });

const createSink = (config: LogSinkConfig, onError: (error: Error) => void): Sink => {
  const stream =
    config.type === "stdout"
      ? process.stdout
      : (() => {
          mkdirSync(dirname(config.path), { recursive: true });
          return createWriteStream(config.path, { flags: "a", encoding: "utf8" });
        })();
  const format = config.format === "json" ? formatJson : formatPlaintext;
  const ownsStream = config.type === "file";
  let closed = false;

  stream.on("error", onError);

  return {
    write(record) {
      if (!closed) stream.write(format(record));
    },
    flush() {
      return closed ? Promise.resolve() : waitForWritable(stream);
    },
    async shutdown() {
      if (closed) return;
      await waitForWritable(stream);
      closed = true;
      if (ownsStream) await closeWritable(stream);
    },
  };
};

const serializeError = (error: unknown): LogAttributes => {
  if (error instanceof Error) {
    const attributes: LogAttributes = {
      "exception.type": error.name,
      "exception.message": error.message,
    };

    if (error.stack !== undefined) {
      attributes["exception.stacktrace"] = error.stack;
    }

    return attributes;
  }

  return {
    "exception.type": typeof error,
    "exception.message": String(error),
  };
};

const defaultSinkErrorHandler = (error: Error) => {
  process.stderr.write(`Log sink failed: ${error.message}\n`);
};

export const createLogger = (options: LoggerOptions): Logger => {
  const minimumLevel = options.minimumLevel ?? "info";
  const sinks = (options.sinks ?? [{ type: "stdout", format: "json" }]).map((sink) =>
    createSink(sink, options.onSinkError ?? defaultSinkErrorHandler),
  );
  const resource: LogAttributes = {
    "service.name": options.serviceName,
  };

  if (options.serviceVersion !== undefined) {
    resource["service.version"] = options.serviceVersion;
  }
  if (options.environment !== undefined) {
    resource["deployment.environment.name"] = options.environment;
  }

  let shutdownPromise: Promise<void> | undefined;

  const buildLogger = (boundAttributes: LogAttributes): Logger => {
    const write = (level: LogLevel, body: string, context: LogContext = {}) => {
      if (LEVEL_RANKS[level] < LEVEL_RANKS[minimumLevel]) return;

      const now = new Date().toISOString();
      const activeSpanContext = trace.getActiveSpan()?.spanContext();
      // Attach trace IDs only when a real OpenTelemetry span is active.
      const spanContext =
        activeSpanContext !== undefined && isSpanContextValid(activeSpanContext)
          ? activeSpanContext
          : undefined;
      const attributes: LogAttributes = {
        ...options.attributes,
        ...boundAttributes,
        ...context.attributes,
      };
      if (context.error !== undefined) {
        Object.assign(attributes, serializeError(context.error));
      }

      const record: LogRecord = {
        timestamp: now,
        observedTimestamp: now,
        severityNumber: SEVERITY_NUMBERS[level],
        severityText: level.toUpperCase() as Uppercase<LogLevel>,
        body,
        resource,
        attributes,
      };

      if (context.eventName !== undefined) {
        record.eventName = context.eventName;
      }
      if (spanContext !== undefined) {
        record.traceId = spanContext.traceId;
        record.spanId = spanContext.spanId;
        record.traceFlags = spanContext.traceFlags;
      }

      for (const sink of sinks) sink.write(record);
    };

    return {
      trace: (body, context) => write("trace", body, context),
      debug: (body, context) => write("debug", body, context),
      info: (body, context) => write("info", body, context),
      warn: (body, context) => write("warn", body, context),
      error: (body, context) => write("error", body, context),
      fatal: (body, context) => write("fatal", body, context),
      child: (attributes) => buildLogger({ ...boundAttributes, ...attributes }),
      flush: () => Promise.all(sinks.map((sink) => sink.flush())).then(() => undefined),
      shutdown: () => {
        shutdownPromise ??= Promise.all(sinks.map((sink) => sink.shutdown())).then(() => undefined);
        return shutdownPromise;
      },
    };
  };

  return buildLogger({});
};
