import {
  createLoggerFromEnv,
  type EnvironmentLoggerOptions,
} from "@teach-everything/observability";

const LOGGER_OPTIONS: EnvironmentLoggerOptions = {
  defaultServiceName: "teach-everything-api",
  ...(process.env.npm_package_version === undefined
    ? {}
    : { serviceVersion: process.env.npm_package_version }),
};

export const logger = createLoggerFromEnv(LOGGER_OPTIONS);
