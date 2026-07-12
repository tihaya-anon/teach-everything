import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";

export type NodeTelemetryOptions = {
  defaultServiceName: string;
  environment?: NodeJS.ProcessEnv;
};

export interface NodeTelemetry {
  enabled: boolean;
  shutdown(): Promise<void>;
}

export const startNodeTelemetry = (options: NodeTelemetryOptions): NodeTelemetry => {
  const environment = options.environment ?? process.env;
  const enabled = environment.OTEL_SDK_DISABLED?.toLowerCase() === "false";
  if (!enabled) {
    return {
      enabled: false,
      shutdown: () => Promise.resolve(),
    };
  }

  const sdk = new NodeSDK({
    serviceName: environment.OTEL_SERVICE_NAME ?? options.defaultServiceName,
    instrumentations: [getNodeAutoInstrumentations()],
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
      }),
    ],
    traceExporter: new OTLPTraceExporter(),
  });
  sdk.start();
  let shutdownPromise: Promise<void> | undefined;

  return {
    enabled: true,
    shutdown: () => {
      shutdownPromise ??= sdk.shutdown();
      return shutdownPromise;
    },
  };
};
