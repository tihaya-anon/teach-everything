import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { node as traceNode } from "@opentelemetry/sdk-node";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentRunTelemetry } from "./agent-run";
import { createLangChainTelemetryCallback } from "./langchain";
import type { Logger } from "./logger";

const noopLogger: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => noopLogger,
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

const serializeTelemetryPayload = (
  metricsData: Awaited<ReturnType<ReturnType<typeof installTelemetryExporters>["collectMetrics"]>>,
  spans: ReturnType<ReturnType<typeof installTelemetryExporters>["getSpans"]>,
) =>
  JSON.stringify({
    metricsData,
    spans: spans.map((span) => ({
      attributes: span.attributes,
      events: span.events,
      name: span.name,
      status: span.status,
    })),
  });

const findMetric = (
  metricsData: Awaited<ReturnType<ReturnType<typeof installTelemetryExporters>["collectMetrics"]>>,
  metricName: string,
) =>
  metricsData
    .flatMap((resourceMetrics) => resourceMetrics.scopeMetrics)
    .flatMap((scopeMetrics) => scopeMetrics.metrics)
    .find((metric) => metric.descriptor.name === metricName);

const expectPayloadToExclude = (payload: string, prohibitedValues: string[]) => {
  for (const prohibited of prohibitedValues) {
    expect(payload).not.toContain(prohibited);
  }
};

type TestLifecycleCallback = {
  handleChainEnd: (outputs: unknown, runId: string) => void;
  handleChainStart: (
    chain: unknown,
    inputs: unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runType?: string,
    runName?: string,
  ) => void;
  handleChatModelStart: (
    llm: unknown,
    messages: unknown[][],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ) => void;
  handleLLMEnd: (output: unknown, runId: string) => void;
  handleToolEnd: (output: unknown, runId: string) => void;
  handleToolError: (error: unknown, runId: string) => void;
  handleToolStart: (
    tool: unknown,
    input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ) => void;
};

const asTestLifecycleCallback = (callback: unknown): TestLifecycleCallback =>
  callback as TestLifecycleCallback;

afterEach(() => {
  metrics.disable();
  trace.disable();
});

describe("createLangChainTelemetryCallback", () => {
  it("emits metadata-only graph, model, and tool child diagnostics under the Agent Run span", async () => {
    // Given
    const telemetry = installTelemetryExporters();
    const agentRunTelemetry = createAgentRunTelemetry({ logger: noopLogger });
    const callback = createLangChainTelemetryCallback({
      instrumentationName: "@teach-everything/observability-test",
    });
    const lifecycleCallback = asTestLifecycleCallback(callback);
    const agentRunScope = agentRunTelemetry.start("ar_child_diagnostics");
    const llmOutput = {
      generations: [
        [
          {
            generationInfo: { finish_reason: "stop" },
            message: {
              content: "SENTINEL_MODEL_RESPONSE",
              response_metadata: {
                model_name: "gpt-safe-response",
              },
              usage_metadata: {
                input_tokens: 13,
                output_tokens: 21,
              },
            },
          },
        ],
      ],
      llmOutput: {
        tokenUsage: {
          promptTokens: 13,
          completionTokens: 21,
        },
      },
    };

    // When
    agentRunScope.runInContext(() => {
      lifecycleCallback.handleChainStart(
        {},
        { prompt: "SENTINEL_GRAPH_STATE" },
        "graph-run-id",
        undefined,
        ["SENTINEL_USER_TAG"],
        { langgraph_node: "generate", langgraph_step: 2 },
        undefined,
        "agent",
      );
      lifecycleCallback.handleChatModelStart(
        {},
        [[{ content: "SENTINEL_PROMPT" }]],
        "model-run-id",
        "graph-run-id",
        undefined,
        undefined,
        { ls_provider: "openai", ls_model_name: "gpt-safe-request" },
        "ChatOpenAI",
      );
      lifecycleCallback.handleLLMEnd(llmOutput, "model-run-id");
      lifecycleCallback.handleToolStart(
        {
          id: ["langchain", "tools", "LookupTool"],
          lc: 1,
          type: "constructor",
        },
        "SENTINEL_TOOL_ARGUMENTS",
        "tool-run-id",
        "graph-run-id",
      );
      lifecycleCallback.handleToolEnd("SENTINEL_TOOL_RESULT", "tool-run-id");
      lifecycleCallback.handleChainEnd({ answer: "SENTINEL_GRAPH_STATE" }, "graph-run-id");
    });
    agentRunScope.finish({ outcome: "succeeded" });
    const metricsData = await telemetry.collectMetrics();
    const spans = telemetry.getSpans();
    await telemetry.shutdown();

    // Then
    const rootSpan = spans.find((span) => span.name === "agent.run");
    const graphSpan = spans.find((span) => span.name === "langchain.chain.agent");
    const modelSpan = spans.find((span) => span.name === "langchain.llm.ChatOpenAI");
    const toolSpan = spans.find((span) => span.name === "langchain.tool.LookupTool");
    expect(rootSpan).toBeDefined();
    expect(graphSpan?.parentSpanContext?.spanId).toBe(rootSpan?.spanContext().spanId);
    expect(modelSpan?.parentSpanContext?.spanId).toBe(graphSpan?.spanContext().spanId);
    expect(toolSpan?.parentSpanContext?.spanId).toBe(graphSpan?.spanContext().spanId);

    expect(graphSpan?.attributes).toMatchObject({
      "langchain.run.kind": "chain",
      "langchain.run.name": "agent",
      "langchain.run.status": "ok",
      "langgraph.node.name": "generate",
      "langgraph.step": 2,
    });
    expect(modelSpan?.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-safe-request",
      "gen_ai.response.model": "gpt-safe-response",
      "gen_ai.usage.input_tokens": 13,
      "gen_ai.usage.output_tokens": 21,
      "langchain.run.kind": "llm",
      "langchain.run.name": "ChatOpenAI",
      "langchain.run.status": "ok",
    });
    expect(toolSpan?.attributes).toMatchObject({
      "gen_ai.tool.name": "LookupTool",
      "langchain.run.kind": "tool",
      "langchain.run.name": "LookupTool",
      "langchain.run.status": "ok",
    });

    const tokenMetric = findMetric(metricsData, "gen_ai.client.token.usage");
    expect(tokenMetric?.dataPoints.map((dataPoint) => dataPoint.attributes)).toEqual([
      {
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-safe-request",
        "gen_ai.response.model": "gpt-safe-response",
        "gen_ai.token.type": "input",
      },
      {
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-safe-request",
        "gen_ai.response.model": "gpt-safe-response",
        "gen_ai.token.type": "output",
      },
    ]);

    const childTelemetryPayload = serializeTelemetryPayload(
      metricsData,
      spans.filter((span) => span.name !== "agent.run"),
    );
    expect(JSON.stringify(metricsData)).not.toContain("ar_child_diagnostics");
    expect(JSON.stringify(rootSpan?.attributes)).toContain("ar_child_diagnostics");
    expectPayloadToExclude(childTelemetryPayload, [
      "graph-run-id",
      "model-run-id",
      "tool-run-id",
      "SENTINEL_GRAPH_STATE",
      "SENTINEL_MODEL_RESPONSE",
      "SENTINEL_PROMPT",
      "SENTINEL_TOOL_ARGUMENTS",
      "SENTINEL_TOOL_RESULT",
      "SENTINEL_USER_TAG",
    ]);
  });

  it("sets error status and duration metrics without exporting exception payloads", async () => {
    // Given
    const telemetry = installTelemetryExporters();
    const callback = createLangChainTelemetryCallback({
      instrumentationName: "@teach-everything/observability-test",
    });
    const lifecycleCallback = asTestLifecycleCallback(callback);
    const error = new Error("SENTINEL_EXCEPTION_MESSAGE");
    error.stack = "SENTINEL_STACK_TRACE";

    // When
    lifecycleCallback.handleToolStart(
      {},
      "SENTINEL_TOOL_ARGUMENTS",
      "tool-run-id",
      undefined,
      undefined,
      undefined,
      "lookup",
    );
    lifecycleCallback.handleToolError(error, "tool-run-id");
    const metricsData = await telemetry.collectMetrics();
    const spans = telemetry.getSpans();
    await telemetry.shutdown();

    // Then
    const toolSpan = spans.find((span) => span.name === "langchain.tool.lookup");
    expect(toolSpan?.status.code).toBe(SpanStatusCode.ERROR);
    expect(toolSpan?.events).toEqual([]);
    expect(toolSpan?.attributes).toMatchObject({
      "langchain.run.kind": "tool",
      "langchain.run.name": "lookup",
      "langchain.run.status": "error",
    });

    const durationMetric = findMetric(metricsData, "langchain.run.duration");
    expect(durationMetric?.dataPoints).toHaveLength(1);
    expect(durationMetric?.dataPoints[0]?.attributes).toMatchObject({
      "langchain.run.kind": "tool",
      "langchain.run.name": "lookup",
      "langchain.run.status": "error",
    });

    const telemetryPayload = serializeTelemetryPayload(metricsData, spans);
    expectPayloadToExclude(telemetryPayload, [
      "SENTINEL_EXCEPTION_MESSAGE",
      "SENTINEL_STACK_TRACE",
      "SENTINEL_TOOL_ARGUMENTS",
      "tool-run-id",
    ]);
  });

  it("keeps LLM telemetry extraction failures fail-open and metadata-only", async () => {
    // Given
    const telemetry = installTelemetryExporters();
    const callbackErrors: unknown[] = [];
    const callback = createLangChainTelemetryCallback({
      instrumentationName: "@teach-everything/observability-test",
      onError: (error) => callbackErrors.push(error),
    });
    const lifecycleCallback = asTestLifecycleCallback(callback);
    const throwingOutput = new Proxy(
      {},
      {
        get: () => {
          throw new Error("SENTINEL_EXTRACTION_FAILURE");
        },
      },
    );

    // When
    lifecycleCallback.handleChatModelStart(
      {},
      [[{ content: "SENTINEL_PROMPT" }]],
      "model-run-id",
      undefined,
      undefined,
      undefined,
      { ls_provider: "openai", ls_model_name: "gpt-safe-request" },
      "ChatOpenAI",
    );
    lifecycleCallback.handleLLMEnd(throwingOutput, "model-run-id");
    const metricsData = await telemetry.collectMetrics();
    const spans = telemetry.getSpans();
    await telemetry.shutdown();

    // Then
    expect(callbackErrors).toHaveLength(1);
    const modelSpan = spans.find((span) => span.name === "langchain.llm.ChatOpenAI");
    expect(modelSpan?.status.code).toBe(SpanStatusCode.UNSET);
    expect(modelSpan?.events).toEqual([]);
    expect(modelSpan?.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-safe-request",
      "langchain.run.kind": "llm",
      "langchain.run.name": "ChatOpenAI",
      "langchain.run.status": "ok",
    });

    const durationMetric = findMetric(metricsData, "langchain.run.duration");
    expect(durationMetric?.dataPoints).toHaveLength(1);
    expect(durationMetric?.dataPoints[0]?.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-safe-request",
      "langchain.run.kind": "llm",
      "langchain.run.name": "ChatOpenAI",
      "langchain.run.status": "ok",
    });

    const telemetryPayload = serializeTelemetryPayload(metricsData, spans);
    expectPayloadToExclude(telemetryPayload, [
      "SENTINEL_EXTRACTION_FAILURE",
      "SENTINEL_PROMPT",
      "model-run-id",
    ]);
  });
});
