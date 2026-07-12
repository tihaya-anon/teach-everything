import { createLoggerFromEnv } from "@teach-everything/observability";

export const logger = createLoggerFromEnv({
  defaultServiceName: "teach-everything-api",
  ...(process.env.npm_package_version === undefined
    ? {}
    : { serviceVersion: process.env.npm_package_version }),
});
