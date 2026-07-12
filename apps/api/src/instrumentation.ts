import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";

function createOpenTelemetrySdk() {
  return new NodeSDK({
    instrumentations: [getNodeAutoInstrumentations()],
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
      }),
    ],
    traceExporter: new OTLPTraceExporter(),
  });
}

const sdk =
  process.env.OTEL_SDK_DISABLED?.toLowerCase() === "false" ? createOpenTelemetrySdk() : undefined;

sdk?.start();

let shutdownPromise: Promise<void> | undefined;

function shutdown() {
  shutdownPromise ??= sdk?.shutdown() ?? Promise.resolve();
  return shutdownPromise;
}

function reportShutdownError(error: unknown) {
  console.error("OpenTelemetry shutdown failed", error);
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown()
      .catch(reportShutdownError)
      .finally(() => process.exit(process.exitCode ?? 0));
  });
}

process.once("beforeExit", () => {
  void shutdown().catch(reportShutdownError);
});
