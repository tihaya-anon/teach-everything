import { AgentRunExecutionError, type AgentRunExecutor } from "@teach-everything/agent";
import {
  context,
  metrics,
  SpanStatusCode,
  trace,
  type Meter,
  type MeterProvider as ApiMeterProvider,
} from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { node as traceNode } from "@opentelemetry/sdk-node";
import type { Logger, LogAttributes, LogContext } from "@teach-everything/observability";
import {
  agentRunEventLineSchema,
  agentRunRequestSchema,
  healthResponseSchema,
  type AgentRunErrorClassification,
  type AgentRunExecutorEvent,
} from "@teach-everything/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app, createApp } from "./app";

type CapturedLogRecord = {
  body: string;
  attributes: LogAttributes;
  eventName?: string;
  traceId?: string;
  spanId?: string;
  traceFlags?: number;
};

const createCapturingLogger = (
  records: CapturedLogRecord[],
  boundAttributes: LogAttributes = {},
): Logger => {
  const write = (body: string, logContext: LogContext = {}) => {
    const spanContext = trace.getActiveSpan()?.spanContext();

    records.push({
      body,
      attributes: {
        ...boundAttributes,
        ...logContext.attributes,
      },
      ...(logContext.eventName === undefined ? {} : { eventName: logContext.eventName }),
      ...(spanContext === undefined
        ? {}
        : {
            traceId: spanContext.traceId,
            spanId: spanContext.spanId,
            traceFlags: spanContext.traceFlags,
          }),
    });
  };

  return {
    trace: write,
    debug: write,
    info: write,
    warn: write,
    error: write,
    fatal: write,
    child: (attributes) => createCapturingLogger(records, { ...boundAttributes, ...attributes }),
    flush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
};

const installTelemetryExporters = () => {
  const { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } = traceNode;
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  tracerProvider.register();

  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60_000,
  });
  const meterProvider = new MeterProvider({ readers: [metricReader] });
  metrics.setGlobalMeterProvider(meterProvider);

  return {
    collectMetrics: async () => {
      await metricReader.forceFlush();
      return metricExporter.getMetrics();
    },
    getSpans: () => spanExporter.getFinishedSpans(),
    shutdown: async () => {
      await tracerProvider.shutdown();
      await meterProvider.shutdown();
    },
  };
};

const installThrowingSpanExporter = () => {
  const { NodeTracerProvider, SimpleSpanProcessor } = traceNode;
  const tracerProvider = new NodeTracerProvider({
    spanProcessors: [
      new SimpleSpanProcessor({
        export: () => {
          throw new Error("SENTINEL_TRACE_EXPORTER_FAILURE");
        },
        shutdown: () => Promise.resolve(),
      }),
    ],
  });
  tracerProvider.register();

  return {
    shutdown: () => tracerProvider.shutdown(),
  };
};

const serializeTelemetryPayload = (
  logs: CapturedLogRecord[],
  metrics: Awaited<ReturnType<ReturnType<typeof installTelemetryExporters>["collectMetrics"]>>,
  spans: ReturnType<ReturnType<typeof installTelemetryExporters>["getSpans"]>,
) =>
  JSON.stringify({
    logs,
    metrics,
    spans: spans.map((span) => ({
      attributes: span.attributes,
      events: span.events,
      name: span.name,
      status: span.status,
    })),
  });

const findAgentRunDurationMetric = (
  metrics: Awaited<ReturnType<ReturnType<typeof installTelemetryExporters>["collectMetrics"]>>,
) =>
  metrics
    .flatMap((resourceMetrics) => resourceMetrics.scopeMetrics)
    .flatMap((scopeMetrics) => scopeMetrics.metrics)
    .find((metric) => metric.descriptor.name === "agent.run.duration");

const failureWithSentinels = (errorClassification: AgentRunErrorClassification) => {
  const error =
    errorClassification === "internal"
      ? new Error("SENTINEL_EXCEPTION_MESSAGE")
      : new AgentRunExecutionError(errorClassification, {
          cause: new Error("SENTINEL_EXCEPTION_CAUSE"),
        });
  error.stack = "SENTINEL_STACK_TRACE";
  return error;
};

const throwingLogger: Logger = {
  trace: () => {
    throw new Error("SENTINEL_LOG_SINK_FAILURE");
  },
  debug: () => {
    throw new Error("SENTINEL_LOG_SINK_FAILURE");
  },
  info: () => {
    throw new Error("SENTINEL_LOG_SINK_FAILURE");
  },
  warn: () => {
    throw new Error("SENTINEL_LOG_SINK_FAILURE");
  },
  error: () => {
    throw new Error("SENTINEL_LOG_SINK_FAILURE");
  },
  fatal: () => {
    throw new Error("SENTINEL_LOG_SINK_FAILURE");
  },
  child: () => {
    throw new Error("SENTINEL_LOG_SINK_FAILURE");
  },
  flush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

const installThrowingMeterProvider = () => {
  const throwingMeter = {
    createHistogram: () => {
      throw new Error("SENTINEL_METER_FAILURE");
    },
  } as unknown as Meter;

  metrics.setGlobalMeterProvider({
    getMeter: () => throwingMeter,
  } satisfies ApiMeterProvider);
};

afterEach(() => {
  vi.useRealTimers();
  context.disable();
  metrics.disable();
  trace.disable();
});

const decodeAgentRunEvents = (body: string) =>
  body
    .trim()
    .split("\n")
    .map((line) => agentRunEventLineSchema.parse(line));

const unsafeAgentRunExecutor = (events: AsyncIterable<unknown>): AgentRunExecutor =>
  ({ execute: () => events }) as unknown as AgentRunExecutor;

const rejectedAgentRunExecutor = (error: unknown): AgentRunExecutor => ({
  execute: () => ({
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.reject<IteratorResult<AgentRunExecutorEvent>>(error),
    }),
  }),
});

const failedAfterModelContentExecutor = (error: unknown): AgentRunExecutor => ({
  async *execute() {
    yield { version: 1, type: "message.delta", text: "SENTINEL_MODEL_CONTENT" };
    throw error;
  },
});

const emptyAsyncIterable = (): AsyncIterable<unknown> => ({
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true, value: undefined }),
  }),
});

describe("GET /api/health", () => {
  it("returns a successful health response", async () => {
    // Given
    const request = new Request("http://localhost/api/health");

    // When
    const response = await app.request(request);
    const body: unknown = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(healthResponseSchema.safeParse(body).success).toBe(true);
  });
});

describe("POST /api/agent-runs", () => {
  it("streams a successful Agent Run with one identifier shared by the header and first event", async () => {
    // Given
    const received: { message?: string } = {};
    const executor: AgentRunExecutor = {
      async *execute(input) {
        received.message = input.message;
        yield { version: 1, type: "message.delta", text: "Closures retain their scope. " };
        yield { version: 1, type: "message.delta", text: "That is lexical scoping." };
        yield { version: 1, type: "run.completed" };
      },
    };
    const api = createApp({
      agentRunExecutor: executor,
      createAgentRunId: () => "ar_test_01",
    });
    const request = new Request("http://localhost/api/agent-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Explain closures." }),
    });

    // When
    const response = await api.request(request);
    const lines = decodeAgentRunEvents(await response.text());

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/x-ndjson");
    expect(response.headers.get("X-Agent-Run-Id")).toBe("ar_test_01");
    expect(received).toEqual({ message: "Explain closures." });
    expect(lines).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_test_01" },
      { version: 1, type: "message.delta", text: "Closures retain their scope. " },
      { version: 1, type: "message.delta", text: "That is lexical scoping." },
      { version: 1, type: "run.completed" },
    ]);
  });

  it("emits metadata-only root telemetry for a successful Agent Run", async () => {
    // Given
    const telemetry = installTelemetryExporters();
    const logs: CapturedLogRecord[] = [];
    const api = createApp({
      agentRunExecutor: {
        async *execute() {
          yield { version: 1, type: "message.delta", text: "SENTINEL_MODEL_CONTENT" };
          yield { version: 1, type: "run.completed" };
        },
      },
      createAgentRunId: () => "ar_success_telemetry",
      logger: createCapturingLogger(logs),
    });
    const request = new Request("http://localhost/api/agent-runs", {
      method: "POST",
      headers: {
        Authorization: "Bearer SENTINEL_AUTHORIZATION",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "SENTINEL_USER_CONTENT" }),
    });

    // When
    const response = await api.request(request);
    const body = await response.text();
    const metrics = await telemetry.collectMetrics();
    const spans = telemetry.getSpans();
    await telemetry.shutdown();

    // Then
    expect(response.status).toBe(200);
    expect(decodeAgentRunEvents(body)).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_success_telemetry" },
      { version: 1, type: "message.delta", text: "SENTINEL_MODEL_CONTENT" },
      { version: 1, type: "run.completed" },
    ]);

    const rootSpan = spans.find((span) => span.name === "agent.run");
    expect(rootSpan).toBeDefined();
    expect(rootSpan?.attributes).toMatchObject({
      "agent.run.id": "ar_success_telemetry",
      "agent.run.outcome": "succeeded",
    });
    expect(rootSpan?.status.code).toBe(SpanStatusCode.UNSET);
    expect(rootSpan?.events).toEqual([]);

    const runLogs = logs.filter(
      (record) => record.attributes["agent.run.id"] === "ar_success_telemetry",
    );
    expect(runLogs.map((record) => record.eventName)).toEqual([
      "agent.run.accepted",
      "agent.run.completed",
    ]);
    expect(runLogs.every((record) => record.traceId === rootSpan?.spanContext().traceId)).toBe(
      true,
    );
    expect(runLogs.map((record) => record.attributes)).toEqual([
      { "agent.run.id": "ar_success_telemetry" },
      { "agent.run.id": "ar_success_telemetry", "agent.run.outcome": "succeeded" },
    ]);

    const durationMetric = findAgentRunDurationMetric(metrics);
    expect(durationMetric?.dataPoints).toHaveLength(1);
    expect(durationMetric?.dataPoints[0]?.attributes).toEqual({
      "agent.run.outcome": "succeeded",
    });

    const telemetryPayload = serializeTelemetryPayload(logs, metrics, spans);
    for (const prohibited of [
      "SENTINEL_USER_CONTENT",
      "SENTINEL_MODEL_CONTENT",
      "SENTINEL_AUTHORIZATION",
    ]) {
      expect(telemetryPayload).not.toContain(prohibited);
    }
  });

  it("parents the root Agent Run span beneath active server telemetry", async () => {
    // Given
    const telemetry = installTelemetryExporters();
    const logs: CapturedLogRecord[] = [];
    const api = createApp({
      agentRunExecutor: {
        async *execute() {
          yield { version: 1, type: "run.completed" };
        },
      },
      createAgentRunId: () => "ar_parented_telemetry",
      logger: createCapturingLogger(logs),
    });
    const request = new Request("http://localhost/api/agent-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Run under a server span." }),
    });
    const tracer = trace.getTracer("test-http-server");

    // When
    await tracer.startActiveSpan("HTTP POST /api/agent-runs", async (serverSpan) => {
      const response = await api.request(request);
      await response.text();
      serverSpan.end();
    });
    const spans = telemetry.getSpans();
    await telemetry.shutdown();

    // Then
    const rootSpan = spans.find((span) => span.name === "agent.run");
    const serverSpan = spans.find((span) => span.name === "HTTP POST /api/agent-runs");
    expect(rootSpan?.parentSpanContext?.spanId).toBe(serverSpan?.spanContext().spanId);
  });

  it("keeps the Agent Run stream outcome when telemetry sinks fail", async () => {
    // Given
    const traceTelemetry = installThrowingSpanExporter();
    installThrowingMeterProvider();
    const api = createApp({
      agentRunExecutor: {
        async *execute() {
          yield { version: 1, type: "message.delta", text: "Streamed answer." };
          yield { version: 1, type: "run.completed" };
        },
      },
      createAgentRunId: () => "ar_fail_open_telemetry",
      logger: throwingLogger,
    });
    const request = new Request("http://localhost/api/agent-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Telemetry must be fail-open." }),
    });

    // When
    const response = await api.request(request);
    const body = await response.text();
    await traceTelemetry.shutdown();

    // Then
    expect(response.status).toBe(200);
    expect(decodeAgentRunEvents(body)).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_fail_open_telemetry" },
      { version: 1, type: "message.delta", text: "Streamed answer." },
      { version: 1, type: "run.completed" },
    ]);
  });

  it("records confirmed cancellation only after executor work stops", async () => {
    // Given
    vi.useFakeTimers();
    const telemetry = installTelemetryExporters();
    const logs: CapturedLogRecord[] = [];
    let executorSignal: AbortSignal | undefined;
    let cleanupStarted = false;
    let stopped = false;
    let resolveNext: (result: IteratorResult<AgentRunExecutorEvent>) => void = () => undefined;
    const requestCancellation = new AbortController();
    const api = createApp({
      agentRunExecutor: {
        execute: (_input, signal) => {
          executorSignal = signal;

          return {
            [Symbol.asyncIterator]: () => ({
              next: () =>
                new Promise<IteratorResult<AgentRunExecutorEvent>>((resolve) => {
                  resolveNext = resolve;
                }),
              return: () => {
                cleanupStarted = true;
                return new Promise<IteratorResult<AgentRunExecutorEvent>>((resolve) => {
                  setTimeout(() => {
                    stopped = true;
                    resolveNext({ done: true, value: undefined });
                    resolve({ done: true, value: undefined });
                  }, 9_999);
                });
              },
            }),
          };
        },
      },
      createAgentRunId: () => "ar_confirmed_cancellation",
      logger: createCapturingLogger(logs),
    });
    const request = new Request("http://localhost/api/agent-runs", {
      method: "POST",
      headers: {
        Authorization: "Bearer SENTINEL_AUTHORIZATION",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "SENTINEL_USER_CONTENT" }),
      signal: requestCancellation.signal,
    });

    // When
    const response = await api.request(request);
    const bodyPromise = response.text();
    requestCancellation.abort();
    await vi.advanceTimersByTimeAsync(9_999);
    const body = await bodyPromise;
    vi.useRealTimers();
    const metrics = await telemetry.collectMetrics();
    const spans = telemetry.getSpans();
    await telemetry.shutdown();

    // Then
    expect(executorSignal?.aborted).toBe(true);
    expect(cleanupStarted).toBe(true);
    expect(stopped).toBe(true);
    expect(decodeAgentRunEvents(body)).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_confirmed_cancellation" },
      { version: 1, type: "run.cancelled" },
    ]);

    const rootSpan = spans.find((span) => span.name === "agent.run");
    expect(rootSpan?.attributes).toMatchObject({
      "agent.run.id": "ar_confirmed_cancellation",
      "agent.run.outcome": "cancelled",
    });
    expect(rootSpan?.status.code).toBe(SpanStatusCode.UNSET);
    expect(rootSpan?.events).toEqual([]);

    const runLogs = logs.filter(
      (record) => record.attributes["agent.run.id"] === "ar_confirmed_cancellation",
    );
    expect(runLogs.map((record) => record.eventName)).toEqual([
      "agent.run.accepted",
      "agent.run.cancellation_requested",
      "agent.run.cancelled",
    ]);
    expect(runLogs.every((record) => record.traceId === rootSpan?.spanContext().traceId)).toBe(
      true,
    );
    expect(runLogs.map((record) => record.attributes)).toEqual([
      { "agent.run.id": "ar_confirmed_cancellation" },
      { "agent.run.id": "ar_confirmed_cancellation" },
      { "agent.run.id": "ar_confirmed_cancellation", "agent.run.outcome": "cancelled" },
    ]);

    const durationMetric = findAgentRunDurationMetric(metrics);
    expect(durationMetric?.dataPoints).toHaveLength(1);
    expect(durationMetric?.dataPoints[0]?.attributes).toEqual({
      "agent.run.outcome": "cancelled",
    });

    const telemetryPayload = serializeTelemetryPayload(logs, metrics, spans);
    for (const prohibited of ["SENTINEL_AUTHORIZATION", "SENTINEL_USER_CONTENT"]) {
      expect(telemetryPayload).not.toContain(prohibited);
    }
  });

  it("fails cancellation when executor work does not confirm before the deadline", async () => {
    // Given
    vi.useFakeTimers();
    const telemetry = installTelemetryExporters();
    const logs: CapturedLogRecord[] = [];
    let executorSignal: AbortSignal | undefined;
    let returnCalled = false;
    let cleanupFinished = false;
    let finishCleanup = () => undefined;
    const cleanupCompletion = new Promise<void>((resolve) => {
      finishCleanup = () => {
        cleanupFinished = true;
        resolve();
      };
    });
    const textDecoder = new TextDecoder();
    const api = createApp({
      agentRunExecutor: {
        execute: (_input, signal) => {
          executorSignal = signal;

          return {
            [Symbol.asyncIterator]: () => ({
              next: () => new Promise<IteratorResult<AgentRunExecutorEvent>>(() => undefined),
              return: async () => {
                returnCalled = true;
                await cleanupCompletion;
                return { done: true, value: undefined };
              },
            }),
          };
        },
      },
      createAgentRunId: () => "ar_cancellation_failed",
      logger: createCapturingLogger(logs),
    });
    const request = new Request("http://localhost/api/agent-runs", {
      method: "POST",
      headers: {
        Authorization: "Bearer SENTINEL_AUTHORIZATION",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "SENTINEL_USER_CONTENT" }),
    });

    // When
    const response = await api.request(request);
    const reader = response.body?.getReader();
    const startedChunk = await reader?.read();
    const cancellation = reader?.cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    await cancellation;
    vi.useRealTimers();
    const metrics = await telemetry.collectMetrics();
    const spans = telemetry.getSpans();
    await telemetry.shutdown();

    // Then
    expect(startedChunk?.done).toBe(false);
    expect(decodeAgentRunEvents(textDecoder.decode(startedChunk?.value))).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_cancellation_failed" },
    ]);
    expect(executorSignal?.aborted).toBe(true);
    expect(returnCalled).toBe(true);
    expect(cleanupFinished).toBe(false);

    const rootSpan = spans.find((span) => span.name === "agent.run");
    expect(rootSpan?.attributes).toMatchObject({
      "agent.run.id": "ar_cancellation_failed",
      "agent.run.outcome": "failed",
      "error.type": "cancellation_failed",
    });
    expect(rootSpan?.status.code).toBe(SpanStatusCode.ERROR);
    expect(rootSpan?.events).toEqual([]);

    const runLogs = logs.filter(
      (record) => record.attributes["agent.run.id"] === "ar_cancellation_failed",
    );
    expect(runLogs.map((record) => record.eventName)).toEqual([
      "agent.run.accepted",
      "agent.run.cancellation_requested",
      "agent.run.failed",
    ]);
    expect(runLogs.every((record) => record.traceId === rootSpan?.spanContext().traceId)).toBe(
      true,
    );
    expect(runLogs.map((record) => record.attributes)).toEqual([
      { "agent.run.id": "ar_cancellation_failed" },
      { "agent.run.id": "ar_cancellation_failed" },
      {
        "agent.run.id": "ar_cancellation_failed",
        "agent.run.outcome": "failed",
        "error.type": "cancellation_failed",
      },
    ]);

    const durationMetric = findAgentRunDurationMetric(metrics);
    expect(durationMetric?.dataPoints).toHaveLength(1);
    expect(durationMetric?.dataPoints[0]?.attributes).toEqual({
      "agent.run.outcome": "failed",
      "error.type": "cancellation_failed",
    });

    const telemetryPayload = serializeTelemetryPayload(logs, metrics, spans);
    for (const prohibited of [
      "SENTINEL_AUTHORIZATION",
      "SENTINEL_EXCEPTION_MESSAGE",
      "SENTINEL_USER_CONTENT",
    ]) {
      expect(telemetryPayload).not.toContain(prohibited);
    }

    finishCleanup();
    await Promise.resolve();
  });

  it("fails cancellation when executor cleanup rejects before the deadline", async () => {
    // Given
    vi.useFakeTimers();
    const telemetry = installTelemetryExporters();
    const logs: CapturedLogRecord[] = [];
    const api = createApp({
      agentRunExecutor: {
        execute: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise<IteratorResult<AgentRunExecutorEvent>>(() => undefined),
            return: () =>
              new Promise<IteratorResult<AgentRunExecutorEvent>>((_resolve, reject) => {
                setTimeout(() => reject(new Error("SENTINEL_EXCEPTION_MESSAGE")), 1_000);
              }),
          }),
        }),
      },
      createAgentRunId: () => "ar_cancellation_cleanup_rejected",
      logger: createCapturingLogger(logs),
    });
    const request = new Request("http://localhost/api/agent-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "SENTINEL_USER_CONTENT" }),
    });

    // When
    const response = await api.request(request);
    const reader = response.body?.getReader();
    await reader?.read();
    const cancellation = reader?.cancel();
    await vi.advanceTimersByTimeAsync(1_000);
    await cancellation;
    vi.useRealTimers();
    const metrics = await telemetry.collectMetrics();
    const spans = telemetry.getSpans();
    await telemetry.shutdown();

    // Then
    const rootSpan = spans.find((span) => span.name === "agent.run");
    expect(rootSpan?.attributes).toMatchObject({
      "agent.run.id": "ar_cancellation_cleanup_rejected",
      "agent.run.outcome": "failed",
      "error.type": "cancellation_failed",
    });
    expect(rootSpan?.status.code).toBe(SpanStatusCode.ERROR);
    expect(rootSpan?.events).toEqual([]);

    const runLogs = logs.filter(
      (record) => record.attributes["agent.run.id"] === "ar_cancellation_cleanup_rejected",
    );
    expect(runLogs.map((record) => record.eventName)).toEqual([
      "agent.run.accepted",
      "agent.run.cancellation_requested",
      "agent.run.failed",
    ]);

    const durationMetric = findAgentRunDurationMetric(metrics);
    expect(durationMetric?.dataPoints).toHaveLength(1);
    expect(durationMetric?.dataPoints[0]?.attributes).toEqual({
      "agent.run.outcome": "failed",
      "error.type": "cancellation_failed",
    });

    const telemetryPayload = serializeTelemetryPayload(logs, metrics, spans);
    for (const prohibited of ["SENTINEL_EXCEPTION_MESSAGE", "SENTINEL_USER_CONTENT"]) {
      expect(telemetryPayload).not.toContain(prohibited);
    }
  });

  it("fails cancellation when executor next rejects after cancellation", async () => {
    // Given
    vi.useFakeTimers();
    const telemetry = installTelemetryExporters();
    const logs: CapturedLogRecord[] = [];
    let rejectNext: (error: unknown) => void = () => undefined;
    const requestCancellation = new AbortController();
    const api = createApp({
      agentRunExecutor: {
        execute: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<IteratorResult<AgentRunExecutorEvent>>((_resolve, reject) => {
                rejectNext = reject;
              }),
          }),
        }),
      },
      createAgentRunId: () => "ar_cancellation_rejected_next",
      logger: createCapturingLogger(logs),
    });
    const request = new Request("http://localhost/api/agent-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "SENTINEL_USER_CONTENT" }),
      signal: requestCancellation.signal,
    });

    // When
    const response = await api.request(request);
    const bodyPromise = response.text();
    requestCancellation.abort();
    rejectNext(new Error("SENTINEL_EXCEPTION_MESSAGE"));
    const body = await bodyPromise;
    vi.useRealTimers();
    const metrics = await telemetry.collectMetrics();
    const spans = telemetry.getSpans();
    await telemetry.shutdown();

    // Then
    expect(decodeAgentRunEvents(body)).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_cancellation_rejected_next" },
      { version: 1, type: "run.failed", errorClassification: "cancellation_failed" },
    ]);

    const rootSpan = spans.find((span) => span.name === "agent.run");
    expect(rootSpan?.attributes).toMatchObject({
      "agent.run.id": "ar_cancellation_rejected_next",
      "agent.run.outcome": "failed",
      "error.type": "cancellation_failed",
    });
    expect(rootSpan?.status.code).toBe(SpanStatusCode.ERROR);
    expect(rootSpan?.events).toEqual([]);

    const runLogs = logs.filter(
      (record) => record.attributes["agent.run.id"] === "ar_cancellation_rejected_next",
    );
    expect(runLogs.map((record) => record.eventName)).toEqual([
      "agent.run.accepted",
      "agent.run.cancellation_requested",
      "agent.run.failed",
    ]);

    const durationMetric = findAgentRunDurationMetric(metrics);
    expect(durationMetric?.dataPoints).toHaveLength(1);
    expect(durationMetric?.dataPoints[0]?.attributes).toEqual({
      "agent.run.outcome": "failed",
      "error.type": "cancellation_failed",
    });

    const telemetryPayload = serializeTelemetryPayload(logs, metrics, spans);
    for (const prohibited of ["SENTINEL_EXCEPTION_MESSAGE", "SENTINEL_USER_CONTENT"]) {
      expect(telemetryPayload).not.toContain(prohibited);
    }
  });

  it("fails cancellation when executor emits a terminal failure after cancellation", async () => {
    // Given
    const telemetry = installTelemetryExporters();
    const logs: CapturedLogRecord[] = [];
    let resolveNext: (result: IteratorResult<AgentRunExecutorEvent>) => void = () => undefined;
    const requestCancellation = new AbortController();
    const api = createApp({
      agentRunExecutor: {
        execute: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<IteratorResult<AgentRunExecutorEvent>>((resolve) => {
                resolveNext = resolve;
              }),
            return: () => Promise.resolve({ done: true, value: undefined }),
          }),
        }),
      },
      createAgentRunId: () => "ar_cancellation_terminal_failure",
      logger: createCapturingLogger(logs),
    });
    const request = new Request("http://localhost/api/agent-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "SENTINEL_USER_CONTENT" }),
      signal: requestCancellation.signal,
    });

    // When
    const response = await api.request(request);
    const bodyPromise = response.text();
    requestCancellation.abort();
    resolveNext({
      done: false,
      value: { version: 1, type: "run.failed", errorClassification: "provider" },
    });
    const body = await bodyPromise;
    const metrics = await telemetry.collectMetrics();
    const spans = telemetry.getSpans();
    await telemetry.shutdown();

    // Then
    expect(decodeAgentRunEvents(body)).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_cancellation_terminal_failure" },
      { version: 1, type: "run.failed", errorClassification: "cancellation_failed" },
    ]);

    const rootSpan = spans.find((span) => span.name === "agent.run");
    expect(rootSpan?.attributes).toMatchObject({
      "agent.run.id": "ar_cancellation_terminal_failure",
      "agent.run.outcome": "failed",
      "error.type": "cancellation_failed",
    });
    expect(rootSpan?.status.code).toBe(SpanStatusCode.ERROR);
    expect(rootSpan?.events).toEqual([]);

    const runLogs = logs.filter(
      (record) => record.attributes["agent.run.id"] === "ar_cancellation_terminal_failure",
    );
    expect(runLogs.map((record) => record.eventName)).toEqual([
      "agent.run.accepted",
      "agent.run.cancellation_requested",
      "agent.run.failed",
    ]);

    const durationMetric = findAgentRunDurationMetric(metrics);
    expect(durationMetric?.dataPoints).toHaveLength(1);
    expect(durationMetric?.dataPoints[0]?.attributes).toEqual({
      "agent.run.outcome": "failed",
      "error.type": "cancellation_failed",
    });
  });

  it("does not confirm cancellation until in-flight executor work stops", async () => {
    // Given
    vi.useFakeTimers();
    const telemetry = installTelemetryExporters();
    const logs: CapturedLogRecord[] = [];
    let returnCalled = false;
    const requestCancellation = new AbortController();
    const api = createApp({
      agentRunExecutor: {
        execute: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise<IteratorResult<AgentRunExecutorEvent>>(() => undefined),
            return: () => {
              returnCalled = true;
              return Promise.resolve({ done: true, value: undefined });
            },
          }),
        }),
      },
      createAgentRunId: () => "ar_cleanup_before_next",
      logger: createCapturingLogger(logs),
    });
    const request = new Request("http://localhost/api/agent-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "SENTINEL_USER_CONTENT" }),
      signal: requestCancellation.signal,
    });

    // When
    const response = await api.request(request);
    const bodyPromise = response.text();
    requestCancellation.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    const body = await bodyPromise;
    vi.useRealTimers();
    const metrics = await telemetry.collectMetrics();
    const spans = telemetry.getSpans();
    await telemetry.shutdown();

    // Then
    expect(returnCalled).toBe(true);
    expect(decodeAgentRunEvents(body)).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_cleanup_before_next" },
      { version: 1, type: "run.failed", errorClassification: "cancellation_failed" },
    ]);

    const rootSpan = spans.find((span) => span.name === "agent.run");
    expect(rootSpan?.attributes).toMatchObject({
      "agent.run.id": "ar_cleanup_before_next",
      "agent.run.outcome": "failed",
      "error.type": "cancellation_failed",
    });

    const durationMetric = findAgentRunDurationMetric(metrics);
    expect(durationMetric?.dataPoints).toHaveLength(1);
    expect(durationMetric?.dataPoints[0]?.attributes).toEqual({
      "agent.run.outcome": "failed",
      "error.type": "cancellation_failed",
    });
  });

  it("does not send run.cancelled in-band when a disconnected client cancellation is confirmed", async () => {
    // Given
    vi.useFakeTimers();
    const telemetry = installTelemetryExporters();
    const logs: CapturedLogRecord[] = [];
    const textDecoder = new TextDecoder();
    const api = createApp({
      agentRunExecutor: {
        execute: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<IteratorResult<AgentRunExecutorEvent>>((resolve) => {
                setTimeout(() => resolve({ done: true, value: undefined }), 1_000);
              }),
            return: () => Promise.resolve({ done: true, value: undefined }),
          }),
        }),
      },
      createAgentRunId: () => "ar_disconnected_confirmed_cancellation",
      logger: createCapturingLogger(logs),
    });
    const request = new Request("http://localhost/api/agent-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "SENTINEL_USER_CONTENT" }),
    });

    // When
    const response = await api.request(request);
    const reader = response.body?.getReader();
    const startedChunk = await reader?.read();
    const cancellation = reader?.cancel();
    await vi.advanceTimersByTimeAsync(1_000);
    await cancellation;
    vi.useRealTimers();
    const metrics = await telemetry.collectMetrics();
    const spans = telemetry.getSpans();
    await telemetry.shutdown();

    // Then
    expect(decodeAgentRunEvents(textDecoder.decode(startedChunk?.value))).toEqual([
      {
        version: 1,
        type: "run.started",
        agentRunId: "ar_disconnected_confirmed_cancellation",
      },
    ]);

    const rootSpan = spans.find((span) => span.name === "agent.run");
    expect(rootSpan?.attributes).toMatchObject({
      "agent.run.id": "ar_disconnected_confirmed_cancellation",
      "agent.run.outcome": "cancelled",
    });
    expect(rootSpan?.status.code).toBe(SpanStatusCode.UNSET);
    expect(rootSpan?.events).toEqual([]);

    const runLogs = logs.filter(
      (record) => record.attributes["agent.run.id"] === "ar_disconnected_confirmed_cancellation",
    );
    expect(runLogs.map((record) => record.eventName)).toEqual([
      "agent.run.accepted",
      "agent.run.cancellation_requested",
      "agent.run.cancelled",
    ]);

    const durationMetric = findAgentRunDurationMetric(metrics);
    expect(durationMetric?.dataPoints).toHaveLength(1);
    expect(durationMetric?.dataPoints[0]?.attributes).toEqual({
      "agent.run.outcome": "cancelled",
    });
  });

  it.each([
    "validation",
    "provider",
    "tool",
    "timeout",
    "cancellation_failed",
    "internal",
  ] as const)(
    "emits metadata-only root telemetry for a %s Agent Run failure",
    async (errorClassification) => {
      // Given
      const telemetry = installTelemetryExporters();
      const logs: CapturedLogRecord[] = [];
      const api = createApp({
        agentRunExecutor: failedAfterModelContentExecutor(
          failureWithSentinels(errorClassification),
        ),
        createAgentRunId: () => "ar_failure_telemetry",
        logger: createCapturingLogger(logs),
      });
      const request = new Request("http://localhost/api/agent-runs", {
        method: "POST",
        headers: {
          Authorization: "Bearer SENTINEL_AUTHORIZATION",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: "SENTINEL_USER_CONTENT" }),
      });

      // When
      const response = await api.request(request);
      const body = await response.text();
      const metrics = await telemetry.collectMetrics();
      const spans = telemetry.getSpans();
      await telemetry.shutdown();

      // Then
      expect(response.status).toBe(200);
      expect(decodeAgentRunEvents(body)).toEqual([
        { version: 1, type: "run.started", agentRunId: "ar_failure_telemetry" },
        { version: 1, type: "message.delta", text: "SENTINEL_MODEL_CONTENT" },
        { version: 1, type: "run.failed", errorClassification },
      ]);

      const rootSpan = spans.find((span) => span.name === "agent.run");
      expect(rootSpan).toBeDefined();
      expect(rootSpan?.attributes).toMatchObject({
        "agent.run.id": "ar_failure_telemetry",
        "agent.run.outcome": "failed",
        "error.type": errorClassification,
      });
      expect(rootSpan?.status.code).toBe(SpanStatusCode.ERROR);
      expect(rootSpan?.events).toEqual([]);

      const runLogs = logs.filter(
        (record) => record.attributes["agent.run.id"] === "ar_failure_telemetry",
      );
      expect(runLogs.map((record) => record.eventName)).toEqual([
        "agent.run.accepted",
        "agent.run.failed",
      ]);
      expect(runLogs.every((record) => record.traceId === rootSpan?.spanContext().traceId)).toBe(
        true,
      );
      expect(runLogs.map((record) => record.attributes)).toEqual([
        { "agent.run.id": "ar_failure_telemetry" },
        {
          "agent.run.id": "ar_failure_telemetry",
          "agent.run.outcome": "failed",
          "error.type": errorClassification,
        },
      ]);

      const durationMetric = findAgentRunDurationMetric(metrics);
      expect(durationMetric?.dataPoints).toHaveLength(1);
      expect(durationMetric?.dataPoints[0]?.attributes).toEqual({
        "agent.run.outcome": "failed",
        "error.type": errorClassification,
      });

      const telemetryPayload = serializeTelemetryPayload(logs, metrics, spans);
      for (const prohibited of [
        "SENTINEL_AUTHORIZATION",
        "SENTINEL_EXCEPTION_CAUSE",
        "SENTINEL_EXCEPTION_MESSAGE",
        "SENTINEL_MODEL_CONTENT",
        "SENTINEL_STACK_TRACE",
        "SENTINEL_USER_CONTENT",
      ]) {
        expect(telemetryPayload).not.toContain(prohibited);
      }
      expect(JSON.stringify(durationMetric?.dataPoints)).not.toContain("ar_failure_telemetry");
    },
  );

  it.each(["{", JSON.stringify({ message: " \n " })])(
    "rejects invalid input before creating an Agent Run: %j",
    async (body) => {
      // Given
      const api = createApp({
        agentRunExecutor: {
          async *execute() {
            yield { version: 1, type: "run.completed" };
          },
        },
        createAgentRunId: () => "ar_must_not_exist",
      });
      const request = new Request("http://localhost/api/agent-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      // When
      const response = await api.request(request);
      const responseBody: unknown = await response.json();

      // Then
      expect(response.status).toBe(400);
      expect(response.headers.get("X-Agent-Run-Id")).toBeNull();
      expect(response.headers.get("Content-Type")).toContain("application/json");
      expect(responseBody).toEqual({ success: false, message: "Invalid Agent Run request" });
    },
  );

  it.each(["validation", "provider", "tool", "timeout"] as const)(
    "ends a post-start %s executor failure with a bounded failure event",
    async (errorClassification) => {
      // Given
      const api = createApp({
        agentRunExecutor: rejectedAgentRunExecutor(
          new AgentRunExecutionError(errorClassification, new Error("executor-secret")),
        ),
        createAgentRunId: () => "ar_failure_01",
      });
      const request = new Request("http://localhost/api/agent-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Run this executor." }),
      });

      // When
      const response = await api.request(request);
      const body = await response.text();
      const events = decodeAgentRunEvents(body);

      // Then
      expect(events).toEqual([
        { version: 1, type: "run.started", agentRunId: "ar_failure_01" },
        { version: 1, type: "run.failed", errorClassification },
      ]);
      expect(body).not.toContain("executor-secret");
    },
  );

  it.each([
    ["an unexpected thrown error", () => new Error("executor-secret")],
    [
      "a spoofed validation error",
      () => Object.assign(new Error("executor-secret"), { name: "ZodError" }),
    ],
    [
      "an invalid classified error",
      () => {
        const error = new AgentRunExecutionError("provider", {
          cause: new Error("executor-secret"),
        });
        Object.defineProperty(error, "errorClassification", { value: "unbounded" });
        return error;
      },
    ],
  ])("falls back to internal for %s", async (_description, createError) => {
    // Given
    const api = createApp({
      agentRunExecutor: rejectedAgentRunExecutor(createError()),
      createAgentRunId: () => "ar_internal_failure_01",
    });
    const request = new Request("http://localhost/api/agent-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Run this executor." }),
    });

    // When
    const response = await api.request(request);
    const body = await response.text();

    // Then
    expect(decodeAgentRunEvents(body)).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_internal_failure_01" },
      { version: 1, type: "run.failed", errorClassification: "internal" },
    ]);
    expect(body).not.toContain("executor-secret");
  });

  it("classifies validation performed by the configured executor after the stream starts", async () => {
    // Given
    const api = createApp({
      agentRunExecutor: {
        async *execute() {
          agentRunRequestSchema.parse({ message: " " });
          yield { version: 1, type: "run.completed" };
        },
      },
      createAgentRunId: () => "ar_validation_01",
    });
    const request = new Request("http://localhost/api/agent-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Run this executor." }),
    });

    // When
    const response = await api.request(request);
    const events = decodeAgentRunEvents(await response.text());

    // Then
    expect(events).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_validation_01" },
      { version: 1, type: "run.failed", errorClassification: "validation" },
    ]);
  });

  it("ends premature or malformed executor output with one internal failure", async () => {
    // Given
    const executors = [
      unsafeAgentRunExecutor(emptyAsyncIterable()),
      unsafeAgentRunExecutor(
        (async function* () {
          yield {
            version: 1,
            type: "run.failed",
            errorClassification: "provider",
            error: "executor-secret",
          };
        })(),
      ),
    ];

    // When
    const responses = await Promise.all(
      executors.map((agentRunExecutor) =>
        createApp({
          agentRunExecutor,
          createAgentRunId: () => "ar_internal_01",
        }).request(
          new Request("http://localhost/api/agent-runs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "Run this executor." }),
          }),
        ),
      ),
    );
    const bodies = await Promise.all(responses.map((response) => response.text()));
    const eventSequences = bodies.map(decodeAgentRunEvents);

    // Then
    expect(eventSequences).toEqual([
      [
        { version: 1, type: "run.started", agentRunId: "ar_internal_01" },
        { version: 1, type: "run.failed", errorClassification: "internal" },
      ],
      [
        { version: 1, type: "run.started", agentRunId: "ar_internal_01" },
        { version: 1, type: "run.failed", errorClassification: "internal" },
      ],
    ]);
    expect(bodies.join("\n")).not.toContain("executor-secret");
  });

  it("keeps exactly one terminal event when the executor attempts duplicate termination", async () => {
    // Given
    const api = createApp({
      agentRunExecutor: {
        async *execute() {
          yield { version: 1, type: "run.completed" };
          yield { version: 1, type: "run.failed", errorClassification: "internal" };
        },
      },
      createAgentRunId: () => "ar_terminal_01",
    });
    const request = new Request("http://localhost/api/agent-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Run this executor." }),
    });

    // When
    const response = await api.request(request);
    const events = decodeAgentRunEvents(await response.text());

    // Then
    expect(events).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_terminal_01" },
      { version: 1, type: "run.completed" },
    ]);
  });

  it("keeps the terminal decision when executor cleanup fails after termination", async () => {
    // Given
    const api = createApp({
      agentRunExecutor: {
        execute: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () =>
              Promise.resolve<IteratorResult<AgentRunExecutorEvent>>({
                done: false,
                value: { version: 1, type: "run.completed" },
              }),
            return: () => Promise.reject<IteratorResult<AgentRunExecutorEvent>>("executor-secret"),
          }),
        }),
      },
      createAgentRunId: () => "ar_terminal_cleanup_01",
    });
    const request = new Request("http://localhost/api/agent-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Run this executor." }),
    });

    // When
    const response = await api.request(request);
    const body = await response.text();
    const events = decodeAgentRunEvents(body);

    // Then
    expect(events).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_terminal_cleanup_01" },
      { version: 1, type: "run.completed" },
    ]);
    expect(body).not.toContain("executor-secret");
  });

  it("does not expose the Agent Run route when no executor is configured", async () => {
    // Given
    const request = new Request("http://localhost/api/agent-runs", { method: "POST" });

    // When
    const response = await app.request(request);

    // Then
    expect(response.status).toBe(404);
  });
});
