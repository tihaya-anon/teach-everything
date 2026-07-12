import { startNodeTelemetry } from "@teach-everything/observability";

export const telemetry = startNodeTelemetry({
  defaultServiceName: "teach-everything-api",
});
