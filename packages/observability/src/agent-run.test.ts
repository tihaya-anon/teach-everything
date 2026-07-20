import {
  OpenInferenceSpanKind,
  SemanticConventions,
} from "@arizeai/openinference-semantic-conventions";
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
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentRunTelemetry,
  type AgentRunErrorClassification,
  type AgentRunTerminalOutcome,
} from "./agent-run";
import type { Logger, LogAttributes, LogContext } from "./logger";

const AGENT_RUN_OUTCOME_ATTRIBUTE = `${SemanticConventions.METADATA}.agent_run.outcome`;
const AGENT_RUN_COMPARABLE_ATTRIBUTE = `${SemanticConventions.METADATA}.agent_run.comparable`;
const AGENT_RUN_PROMOTABLE_ATTRIBUTE = `${SemanticConventions.METADATA}.agent_run.promotable`;
const AGENT_BEHAVIOR_GRAPH_ATTRIBUTE = `${SemanticConventions.METADATA}.agent_behavior_version.graph`;
const AGENT_BEHAVIOR_STATE_ATTRIBUTE = `${SemanticConventions.METADATA}.agent_behavior_version.state`;
const AGENT_BEHAVIOR_ACTION_ATTRIBUTE = `${SemanticConventions.METADATA}.agent_behavior_version.action`;
const AGENT_BEHAVIOR_PROMPT_ATTRIBUTE = `${SemanticConventions.METADATA}.agent_behavior_version.prompt`;
const AGENT_BEHAVIOR_TOOL_ATTRIBUTE = `${SemanticConventions.METADATA}.agent_behavior_version.tool`;
const AGENT_BEHAVIOR_MODEL_ATTRIBUTE = `${SemanticConventions.METADATA}.agent_behavior_version.model`;
const AGENT_BEHAVIOR_TRIAL_PARAMETER_ATTRIBUTE = `${SemanticConventions.METADATA}.agent_behavior_version.trial_parameter`;
const RUNTIME_PROFILE_ID_ATTRIBUTE = `${SemanticConventions.METADATA}.runtime_profile.id`;
const SOURCE_REVISION_ATTRIBUTE = `${SemanticConventions.METADATA}.source_revision`;

type CapturedLogRecord = {
  attributes: LogAttributes;
  body: string;
  eventName?: string;
  spanId?: string;
  traceFlags?: number;
  traceId?: string;
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

const THROWING_LOGGER: Logger = {
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

const createTelemetryTestHarness = () => {
  const telemetry = installTelemetryExporters();
  const logs: CapturedLogRecord[] = [];

  return {
    agentRunTelemetry: createAgentRunTelemetry({ logger: createCapturingLogger(logs) }),
    logs,
    telemetry,
  };
};

const completeAcceptedTelemetry = {
  agentBehaviorVersion: {
    graph: "graph:teaching-assistant:v1",
    state: "state:lesson-session:v1",
    action: "action:tutor-response:v1",
    prompt: "prompt:socratic:v3",
    tool: "tool:retrieval:v2",
    model: "model:openai:gpt-5:2026-07-20",
    trialParameter: "trial-parameter:baseline:v1",
    sourceRevision: "0123456789abcdef0123456789abcdef01234567",
  },
  comparable: true,
  promotable: true,
  runtimeProfileId: "runtime-published",
} as const;

const completeAcceptedTelemetryAttributes = {
  [AGENT_RUN_COMPARABLE_ATTRIBUTE]: true,
  [AGENT_RUN_PROMOTABLE_ATTRIBUTE]: true,
  [AGENT_BEHAVIOR_GRAPH_ATTRIBUTE]: "graph:teaching-assistant:v1",
  [AGENT_BEHAVIOR_STATE_ATTRIBUTE]: "state:lesson-session:v1",
  [AGENT_BEHAVIOR_ACTION_ATTRIBUTE]: "action:tutor-response:v1",
  [AGENT_BEHAVIOR_PROMPT_ATTRIBUTE]: "prompt:socratic:v3",
  [AGENT_BEHAVIOR_TOOL_ATTRIBUTE]: "tool:retrieval:v2",
  [AGENT_BEHAVIOR_MODEL_ATTRIBUTE]: "model:openai:gpt-5:2026-07-20",
  [AGENT_BEHAVIOR_TRIAL_PARAMETER_ATTRIBUTE]: "trial-parameter:baseline:v1",
  [RUNTIME_PROFILE_ID_ATTRIBUTE]: "runtime-published",
  [SOURCE_REVISION_ATTRIBUTE]: "0123456789abcdef0123456789abcdef01234567",
} as const;

const serializeTelemetryPayload = (
  logs: CapturedLogRecord[],
  metricsData: Awaited<ReturnType<ReturnType<typeof installTelemetryExporters>["collectMetrics"]>>,
  spans: ReturnType<ReturnType<typeof installTelemetryExporters>["getSpans"]>,
) =>
  JSON.stringify({
    logs,
    metricsData,
    spans: spans.map((span) => ({
      attributes: span.attributes,
      events: span.events,
      name: span.name,
      status: span.status,
    })),
  });

const findAgentRunDurationMetric = (
  metricsData: Awaited<ReturnType<ReturnType<typeof installTelemetryExporters>["collectMetrics"]>>,
) =>
  metricsData
    .flatMap((resourceMetrics) => resourceMetrics.scopeMetrics)
    .flatMap((scopeMetrics) => scopeMetrics.metrics)
    .find((metric) => metric.descriptor.name === "agent.run.duration");

const terminalLogName = (terminalOutcome: AgentRunTerminalOutcome) => {
  if (terminalOutcome.outcome !== "failed") {
    return terminalOutcome.outcome === "succeeded" ? "agent.run.completed" : "agent.run.cancelled";
  }

  return terminalOutcome.errorClassification === "cancellation_failed"
    ? "agent.run.cancellation_failed"
    : "agent.run.failed";
};

afterEach(() => {
  context.disable();
  metrics.disable();
  trace.disable();
});

describe("createAgentRunTelemetry", () => {
  it("emits metadata-only root telemetry for a successful Agent Run", async () => {
    // Given
    const { agentRunTelemetry, logs, telemetry } = createTelemetryTestHarness();

    // When
    const scope = agentRunTelemetry.start("ar_success_telemetry");
    scope.recordAccepted(completeAcceptedTelemetry);
    scope.finish({ outcome: "succeeded" });
    const metricsData = await telemetry.collectMetrics();
    const spans = telemetry.getSpans();
    await telemetry.shutdown();

    // Then
    const rootSpan = spans.find((span) => span.name === "agent.run");
    expect(rootSpan).toBeDefined();
    expect(rootSpan?.attributes).toMatchObject({
      [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
      [SemanticConventions.SESSION_ID]: "ar_success_telemetry",
      ...completeAcceptedTelemetryAttributes,
      [AGENT_RUN_OUTCOME_ATTRIBUTE]: "succeeded",
    });
    expect(rootSpan?.status.code).toBe(SpanStatusCode.UNSET);
    expect(rootSpan?.events).toEqual([]);

    const runLogs = logs.filter(
      (record) => record.attributes[SemanticConventions.SESSION_ID] === "ar_success_telemetry",
    );
    expect(runLogs.map((record) => record.eventName)).toEqual([
      "agent.run.accepted",
      "agent.run.completed",
    ]);
    expect(runLogs.every((record) => record.traceId === rootSpan?.spanContext().traceId)).toBe(
      true,
    );
    expect(runLogs.map((record) => record.attributes)).toEqual([
      {
        [SemanticConventions.SESSION_ID]: "ar_success_telemetry",
        ...completeAcceptedTelemetryAttributes,
      },
      {
        [SemanticConventions.SESSION_ID]: "ar_success_telemetry",
        ...completeAcceptedTelemetryAttributes,
        [AGENT_RUN_OUTCOME_ATTRIBUTE]: "succeeded",
      },
    ]);

    const durationMetric = findAgentRunDurationMetric(metricsData);
    expect(durationMetric?.dataPoints).toHaveLength(1);
    expect(durationMetric?.dataPoints[0]?.attributes).toEqual({
      [AGENT_RUN_OUTCOME_ATTRIBUTE]: "succeeded",
    });
    expect(JSON.stringify(durationMetric?.dataPoints)).not.toContain("ar_success_telemetry");
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
    async (errorClassification: AgentRunErrorClassification) => {
      // Given
      const { agentRunTelemetry, logs, telemetry } = createTelemetryTestHarness();

      // When
      const scope = agentRunTelemetry.start("ar_failure_telemetry");
      scope.recordAccepted(completeAcceptedTelemetry);
      scope.finish({ outcome: "failed", errorClassification });
      const metricsData = await telemetry.collectMetrics();
      const spans = telemetry.getSpans();
      await telemetry.shutdown();

      // Then
      const rootSpan = spans.find((span) => span.name === "agent.run");
      expect(rootSpan?.attributes).toMatchObject({
        [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
        [SemanticConventions.SESSION_ID]: "ar_failure_telemetry",
        ...completeAcceptedTelemetryAttributes,
        [AGENT_RUN_OUTCOME_ATTRIBUTE]: "failed",
        "error.type": errorClassification,
      });
      expect(rootSpan?.status.code).toBe(SpanStatusCode.ERROR);
      expect(rootSpan?.events).toEqual([]);

      const runLogs = logs.filter(
        (record) => record.attributes[SemanticConventions.SESSION_ID] === "ar_failure_telemetry",
      );
      expect(runLogs.map((record) => record.eventName)).toEqual([
        "agent.run.accepted",
        terminalLogName({ outcome: "failed", errorClassification }),
      ]);
      expect(runLogs.map((record) => record.attributes)).toEqual([
        {
          [SemanticConventions.SESSION_ID]: "ar_failure_telemetry",
          ...completeAcceptedTelemetryAttributes,
        },
        {
          [SemanticConventions.SESSION_ID]: "ar_failure_telemetry",
          ...completeAcceptedTelemetryAttributes,
          [AGENT_RUN_OUTCOME_ATTRIBUTE]: "failed",
          "error.type": errorClassification,
        },
      ]);

      const durationMetric = findAgentRunDurationMetric(metricsData);
      expect(durationMetric?.dataPoints).toHaveLength(1);
      expect(durationMetric?.dataPoints[0]?.attributes).toEqual({
        [AGENT_RUN_OUTCOME_ATTRIBUTE]: "failed",
        "error.type": errorClassification,
      });
      expect(JSON.stringify(durationMetric?.dataPoints)).not.toContain("ar_failure_telemetry");
    },
  );

  it("surfaces pre-acceptance validation failures as metadata-only telemetry errors", async () => {
    // Given
    const { agentRunTelemetry, logs, telemetry } = createTelemetryTestHarness();

    // When
    const scope = agentRunTelemetry.start("ar_strict_rejected_telemetry");
    scope.finish({ outcome: "failed", errorClassification: "validation" });
    const metricsData = await telemetry.collectMetrics();
    const spans = telemetry.getSpans();
    await telemetry.shutdown();

    // Then
    const rootSpan = spans.find((span) => span.name === "agent.run");
    expect(rootSpan?.attributes).toMatchObject({
      [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
      [SemanticConventions.SESSION_ID]: "ar_strict_rejected_telemetry",
      [AGENT_RUN_OUTCOME_ATTRIBUTE]: "failed",
      "error.type": "validation",
    });
    expect(rootSpan?.status.code).toBe(SpanStatusCode.ERROR);

    const runLogs = logs.filter(
      (record) =>
        record.attributes[SemanticConventions.SESSION_ID] === "ar_strict_rejected_telemetry",
    );
    expect(runLogs.map((record) => record.eventName)).toEqual(["agent.run.failed"]);
    expect(runLogs.map((record) => record.attributes)).toEqual([
      {
        [SemanticConventions.SESSION_ID]: "ar_strict_rejected_telemetry",
        [AGENT_RUN_OUTCOME_ATTRIBUTE]: "failed",
        "error.type": "validation",
      },
    ]);

    const durationMetric = findAgentRunDurationMetric(metricsData);
    expect(durationMetric?.dataPoints[0]?.attributes).toEqual({
      [AGENT_RUN_OUTCOME_ATTRIBUTE]: "failed",
      "error.type": "validation",
    });

    const controlledTelemetryPayload = JSON.stringify({
      logs,
      metricAttributes: durationMetric?.dataPoints.map((dataPoint) => dataPoint.attributes),
      spanAttributes: spans.map((span) => span.attributes),
    });
    expect(controlledTelemetryPayload).not.toContain("private-user-message");
    expect(controlledTelemetryPayload).not.toContain("private-model-output");
    expect(controlledTelemetryPayload).not.toContain("unknown");
  });

  it("records cancellation requested once before a cancelled terminal outcome", async () => {
    // Given
    const { agentRunTelemetry, logs, telemetry } = createTelemetryTestHarness();

    // When
    const scope = agentRunTelemetry.start("ar_cancelled_telemetry");
    scope.recordAccepted(completeAcceptedTelemetry);
    scope.recordCancellationRequested();
    scope.recordCancellationRequested();
    scope.finish({ outcome: "cancelled" });
    scope.recordCancellationRequested();
    const metricsData = await telemetry.collectMetrics();
    const spans = telemetry.getSpans();
    await telemetry.shutdown();

    // Then
    const rootSpan = spans.find((span) => span.name === "agent.run");
    expect(rootSpan?.attributes).toMatchObject({
      [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
      [SemanticConventions.SESSION_ID]: "ar_cancelled_telemetry",
      ...completeAcceptedTelemetryAttributes,
      [AGENT_RUN_OUTCOME_ATTRIBUTE]: "cancelled",
    });
    expect(rootSpan?.status.code).toBe(SpanStatusCode.UNSET);

    const runLogs = logs.filter(
      (record) => record.attributes[SemanticConventions.SESSION_ID] === "ar_cancelled_telemetry",
    );
    expect(runLogs.map((record) => record.eventName)).toEqual([
      "agent.run.accepted",
      "agent.run.cancellation_requested",
      "agent.run.cancelled",
    ]);

    const durationMetric = findAgentRunDurationMetric(metricsData);
    expect(durationMetric?.dataPoints[0]?.attributes).toEqual({
      [AGENT_RUN_OUTCOME_ATTRIBUTE]: "cancelled",
    });
  });

  it("emits Agent Behavior Version and Source Revision as structured span and log attributes", async () => {
    // Given
    const { agentRunTelemetry, logs, telemetry } = createTelemetryTestHarness();

    // When
    const scope = agentRunTelemetry.start("ar_behavior_telemetry");
    scope.recordAccepted(completeAcceptedTelemetry);
    scope.finish({ outcome: "succeeded" });
    const spans = telemetry.getSpans();
    await telemetry.shutdown();

    // Then
    const rootSpan = spans.find((span) => span.name === "agent.run");
    expect(rootSpan?.attributes).toMatchObject(completeAcceptedTelemetryAttributes);

    const runLogs = logs.filter(
      (record) => record.attributes[SemanticConventions.SESSION_ID] === "ar_behavior_telemetry",
    );
    expect(runLogs).toHaveLength(2);
    expect(runLogs.every((record) => record.attributes[SOURCE_REVISION_ATTRIBUTE])).toBe(true);
    expect(runLogs.map((record) => record.attributes)).toEqual([
      {
        [SemanticConventions.SESSION_ID]: "ar_behavior_telemetry",
        ...completeAcceptedTelemetryAttributes,
      },
      {
        [SemanticConventions.SESSION_ID]: "ar_behavior_telemetry",
        ...completeAcceptedTelemetryAttributes,
        [AGENT_RUN_OUTCOME_ATTRIBUTE]: "succeeded",
      },
    ]);
  });

  it("parents the root Agent Run span beneath active server telemetry", async () => {
    // Given
    const { agentRunTelemetry, telemetry } = createTelemetryTestHarness();
    const tracer = trace.getTracer("test-http-server");

    // When
    await tracer.startActiveSpan("HTTP POST /api/agent-runs", async (serverSpan) => {
      const scope = agentRunTelemetry.start("ar_parented_telemetry");
      scope.recordAccepted(completeAcceptedTelemetry);
      scope.finish({ outcome: "succeeded" });
      serverSpan.end();
    });
    const spans = telemetry.getSpans();
    await telemetry.shutdown();

    // Then
    const rootSpan = spans.find((span) => span.name === "agent.run");
    const serverSpan = spans.find((span) => span.name === "HTTP POST /api/agent-runs");
    expect(rootSpan?.parentSpanContext?.spanId).toBe(serverSpan?.spanContext().spanId);
  });

  it("keeps Agent Run telemetry fail-open and metadata-only when sinks fail", async () => {
    // Given
    const traceTelemetry = installThrowingSpanExporter();
    installThrowingMeterProvider();
    const agentRunTelemetry = createAgentRunTelemetry({ logger: THROWING_LOGGER });

    // When
    const run = () => {
      const scope = agentRunTelemetry.start("ar_fail_open_telemetry");
      scope.recordAccepted(completeAcceptedTelemetry);
      scope.recordCancellationRequested();
      scope.finish({ outcome: "failed", errorClassification: "internal" });
    };

    // Then
    expect(run).not.toThrow();
    await traceTelemetry.shutdown();
  });

  it("does not record terminal telemetry more than once", async () => {
    // Given
    const { agentRunTelemetry, logs, telemetry } = createTelemetryTestHarness();

    // When
    const scope = agentRunTelemetry.start("ar_terminal_once");
    scope.recordAccepted(completeAcceptedTelemetry);
    scope.finish({ outcome: "succeeded" });
    scope.finish({ outcome: "failed", errorClassification: "internal" });
    const metricsData = await telemetry.collectMetrics();
    const spans = telemetry.getSpans();
    await telemetry.shutdown();

    // Then
    expect(spans.filter((span) => span.name === "agent.run")).toHaveLength(1);
    expect(
      logs.filter(
        (record) => record.attributes[SemanticConventions.SESSION_ID] === "ar_terminal_once",
      ),
    ).toHaveLength(2);
    expect(findAgentRunDurationMetric(metricsData)?.dataPoints).toHaveLength(1);

    const telemetryPayload = serializeTelemetryPayload(logs, metricsData, spans);
    expect(telemetryPayload).not.toContain("SENTINEL_LOG_SINK_FAILURE");
  });
});
