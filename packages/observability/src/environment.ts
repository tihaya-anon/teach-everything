import {
  createLogger,
  LOG_LEVELS,
  type LogFormat,
  type LogLevel,
  type LoggerOptions,
  type LogSinkConfig,
  type Logger,
} from "./logger";

export type EnvironmentLoggerOptions = {
  defaultServiceName: string;
  serviceVersion?: string;
  environment?: NodeJS.ProcessEnv;
};

const parseLevel = (value: string | undefined): LogLevel => {
  const level = value?.toLowerCase() ?? "info";
  if (LOG_LEVELS.some((candidate) => candidate === level)) return level as LogLevel;
  throw new Error(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(", ")}`);
};

const parseFormat = (value: string | undefined, variableName: string): LogFormat => {
  const format = value?.toLowerCase() ?? "json";
  if (format === "json" || format === "plaintext") return format;
  throw new Error(`${variableName} must be either json or plaintext`);
};

const parseSinks = (environment: NodeJS.ProcessEnv): LogSinkConfig[] => {
  const isDevelopment = environment.NODE_ENV?.toLowerCase() === "development";
  const configuredDefaultFormat =
    environment.LOG_FORMAT === undefined
      ? undefined
      : parseFormat(environment.LOG_FORMAT, "LOG_FORMAT");
  // Development logs default to human-readable stdout plus a structured file sink.
  const sinkNames = (environment.LOG_SINKS ?? (isDevelopment ? "stdout,file" : "stdout"))
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const sinks = sinkNames.map((sinkName): LogSinkConfig => {
    if (sinkName === "stdout") {
      return {
        type: "stdout",
        format: parseFormat(
          environment.LOG_STDOUT_FORMAT ??
            configuredDefaultFormat ??
            (isDevelopment ? "plaintext" : "json"),
          "LOG_STDOUT_FORMAT",
        ),
      };
    }
    if (sinkName === "file") {
      return {
        type: "file",
        path: environment.LOG_FILE_PATH ?? "logs/application.log",
        format: parseFormat(
          environment.LOG_FILE_FORMAT ?? configuredDefaultFormat ?? "json",
          "LOG_FILE_FORMAT",
        ),
      };
    }
    throw new Error("LOG_SINKS may contain only stdout and file");
  });

  if (sinks.length === 0) throw new Error("LOG_SINKS must contain at least one sink");
  return sinks;
};

export const createLoggerFromEnv = (options: EnvironmentLoggerOptions): Logger => {
  const environment = options.environment ?? process.env;
  const loggerOptions: LoggerOptions = {
    serviceName: environment.OTEL_SERVICE_NAME ?? options.defaultServiceName,
    minimumLevel: parseLevel(environment.LOG_LEVEL),
    sinks: parseSinks(environment),
  };

  if (options.serviceVersion !== undefined) {
    loggerOptions.serviceVersion = options.serviceVersion;
  }
  if (environment.NODE_ENV !== undefined) {
    loggerOptions.environment = environment.NODE_ENV;
  }

  return createLogger(loggerOptions);
};
