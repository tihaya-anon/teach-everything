import {
  createLogger,
  logLevels,
  type LogFormat,
  type LogLevel,
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
  if (logLevels.some((candidate) => candidate === level)) return level as LogLevel;
  throw new Error(`LOG_LEVEL must be one of: ${logLevels.join(", ")}`);
};

const parseFormat = (value: string | undefined, variableName: string): LogFormat => {
  const format = value?.toLowerCase() ?? "json";
  if (format === "json" || format === "plaintext") return format;
  throw new Error(`${variableName} must be either json or plaintext`);
};

const parseSinks = (environment: NodeJS.ProcessEnv): LogSinkConfig[] => {
  const sinkNames = (environment.LOG_SINKS ?? "stdout")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const defaultFormat = parseFormat(environment.LOG_FORMAT, "LOG_FORMAT");
  const sinks = sinkNames.map((sinkName): LogSinkConfig => {
    if (sinkName === "stdout") {
      return {
        type: "stdout",
        format: parseFormat(environment.LOG_STDOUT_FORMAT ?? defaultFormat, "LOG_STDOUT_FORMAT"),
      };
    }
    if (sinkName === "file") {
      return {
        type: "file",
        path: environment.LOG_FILE_PATH ?? "logs/application.log",
        format: parseFormat(environment.LOG_FILE_FORMAT ?? defaultFormat, "LOG_FILE_FORMAT"),
      };
    }
    throw new Error("LOG_SINKS may contain only stdout and file");
  });

  if (sinks.length === 0) throw new Error("LOG_SINKS must contain at least one sink");
  return sinks;
};

export const createLoggerFromEnv = (options: EnvironmentLoggerOptions): Logger => {
  const environment = options.environment ?? process.env;

  return createLogger({
    serviceName: environment.OTEL_SERVICE_NAME ?? options.defaultServiceName,
    ...(options.serviceVersion === undefined ? {} : { serviceVersion: options.serviceVersion }),
    ...(environment.NODE_ENV === undefined ? {} : { environment: environment.NODE_ENV }),
    minimumLevel: parseLevel(environment.LOG_LEVEL),
    sinks: parseSinks(environment),
  });
};
