import { telemetry } from "../../../apps/api/src/instrumentation";
import { createApp } from "../../../apps/api/src/app";
import { logger } from "../../../apps/api/src/logger";
import { AgentRunExecutionError, type AgentRunExecutor } from "../../../packages/agent/src";
import { createLangChainTelemetryCallback } from "../../../packages/observability/src";
import type { AgentRunExecutorEvent } from "../../../packages/shared/src";

type Scenario = "cancellation-failed" | "cancelled" | "failed" | "slow" | "succeeded";

type LifecycleCallback = {
  handleChainEnd(outputs: unknown, runId: string): void;
  handleChainError(error: unknown, runId: string): void;
  handleChainStart(
    chain: unknown,
    inputs: unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runType?: string,
    runName?: string,
  ): void;
  handleChatModelStart(
    llm: unknown,
    messages: unknown[][],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): void;
  handleLLMEnd(output: unknown, runId: string): void;
  handleToolEnd(output: unknown, runId: string): void;
  handleToolError(error: unknown, runId: string): void;
  handleToolStart(
    tool: unknown,
    input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): void;
};

type ScenarioResult = {
  agentRunId: string;
  events: string[];
  scenario: Scenario;
};

type StartedScenario = {
  agentRunId: string;
  response: Response;
};

const scenarioPrefix = process.env.AGENT_RUN_DIAGNOSIS_ACCEPTANCE_PREFIX ?? "ar_acceptance";
const exportSettleMs = Number(process.env.AGENT_RUN_DIAGNOSIS_EXPORT_SETTLE_MS ?? 15_000);

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const waitForAbort = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    signal.addEventListener("abort", () => resolve(), { once: true });
  });

const llmOutput = () => ({
  generations: [
    [
      {
        generationInfo: { finish_reason: "stop" },
        message: {
          response_metadata: {
            model_name: "acceptance-model-response",
          },
          usage_metadata: {
            input_tokens: 17,
            output_tokens: 23,
          },
        },
      },
    ],
  ],
  llmOutput: {
    tokenUsage: {
      promptTokens: 17,
      completionTokens: 23,
    },
  },
});

const createAcceptanceExecutor = (): AgentRunExecutor => ({
  async *execute(input, signal) {
    const scenario = input.message as Scenario;
    const callback = createLangChainTelemetryCallback({
      instrumentationName: "@teach-everything/observability/agent-run-diagnosis-acceptance",
    }) as LifecycleCallback;

    switch (scenario) {
      case "succeeded":
        yield* succeededScenario(callback);
        return;
      case "slow":
        yield* slowScenario(callback);
        return;
      case "failed":
        await failedScenario(callback);
        return;
      case "cancelled":
        yield* cancelledScenario(signal);
        return;
      case "cancellation-failed":
        yield* unconfirmedCancellationScenario(signal);
        return;
      default:
        throw new AgentRunExecutionError("validation");
    }
  },
});

const succeededScenario = async function* (
  callback: LifecycleCallback,
): AsyncGenerator<AgentRunExecutorEvent> {
  callback.handleChainStart(
    {},
    {},
    "acceptance-success-graph",
    undefined,
    undefined,
    {},
    undefined,
    "agent",
  );
  callback.handleChatModelStart(
    {},
    [[]],
    "acceptance-success-model",
    "acceptance-success-graph",
    undefined,
    undefined,
    { ls_model_name: "acceptance-model-request", ls_provider: "acceptance-provider" },
    "AcceptanceChatModel",
  );
  callback.handleLLMEnd(llmOutput(), "acceptance-success-model");
  callback.handleToolStart(
    { name: "AcceptanceLookupTool" },
    "",
    "acceptance-success-tool",
    "acceptance-success-graph",
  );
  callback.handleToolEnd({}, "acceptance-success-tool");
  callback.handleChainEnd({}, "acceptance-success-graph");

  yield { version: 1, type: "message.delta", text: "Acceptance success complete." };
  yield { version: 1, type: "run.completed" };
};

const slowScenario = async function* (
  callback: LifecycleCallback,
): AsyncGenerator<AgentRunExecutorEvent> {
  callback.handleChainStart(
    {},
    {},
    "acceptance-slow-graph",
    undefined,
    undefined,
    {},
    undefined,
    "agent",
  );
  callback.handleToolStart(
    { name: "AcceptanceSlowTool" },
    "",
    "acceptance-slow-tool",
    "acceptance-slow-graph",
  );
  await sleep(1_250);
  callback.handleToolEnd({}, "acceptance-slow-tool");
  callback.handleChainEnd({}, "acceptance-slow-graph");

  yield { version: 1, type: "message.delta", text: "Acceptance slow operation complete." };
  yield { version: 1, type: "run.completed" };
};

const failedScenario = async (callback: LifecycleCallback): Promise<never> => {
  const error = new AgentRunExecutionError("tool");

  callback.handleChainStart(
    {},
    {},
    "acceptance-failed-graph",
    undefined,
    undefined,
    {},
    undefined,
    "agent",
  );
  callback.handleToolStart(
    { name: "AcceptanceFailingTool" },
    "",
    "acceptance-failed-tool",
    "acceptance-failed-graph",
  );
  callback.handleToolError(error, "acceptance-failed-tool");
  callback.handleChainError(error, "acceptance-failed-graph");

  throw error;
};

const cancelledScenario = async function* (
  signal: AbortSignal,
): AsyncGenerator<AgentRunExecutorEvent> {
  try {
    yield { version: 1, type: "message.delta", text: "Acceptance cancellation waiting." };
    await waitForAbort(signal);
  } finally {
    await sleep(100);
  }
};

const unconfirmedCancellationScenario = async function* (
  signal: AbortSignal,
): AsyncGenerator<AgentRunExecutorEvent> {
  try {
    yield { version: 1, type: "message.delta", text: "Acceptance cancellation failure waiting." };
    await waitForAbort(signal);
  } finally {
    await new Promise<void>(() => undefined);
  }
};

const parseEventTypes = (body: string) =>
  body
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string })
    .map((event) => event.type);

const startScenario = async (
  app: ReturnType<typeof createApp>,
  scenario: Scenario,
): Promise<StartedScenario> => {
  const response = await app.request("/api/agent-runs", {
    body: JSON.stringify({ message: scenario }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const agentRunId = response.headers.get("X-Agent-Run-Id");
  if (agentRunId === null) throw new Error(`Missing Agent Run Identifier for ${scenario}`);

  return { agentRunId, response };
};

const postScenario = async (
  app: ReturnType<typeof createApp>,
  scenario: Scenario,
): Promise<ScenarioResult> => {
  const { agentRunId, response } = await startScenario(app, scenario);
  const body = await response.text();

  return {
    agentRunId,
    events: parseEventTypes(body),
    scenario,
  };
};

const cancelScenario = async (
  app: ReturnType<typeof createApp>,
  scenario: Scenario,
): Promise<ScenarioResult> => {
  const { agentRunId, response } = await startScenario(app, scenario);
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error(`Missing response body for ${scenario}`);

  const firstChunk = await reader.read();
  await reader.cancel();

  return {
    agentRunId,
    events: firstChunk.done ? [] : parseEventTypes(new TextDecoder().decode(firstChunk.value)),
    scenario,
  };
};

const run = async () => {
  let nextRun = 0;
  let cleanupError: AggregateError | undefined;
  let runError: unknown;
  const app = createApp({
    agentRunExecutor: createAcceptanceExecutor(),
    createAgentRunId: () => `${scenarioPrefix}_${String(++nextRun).padStart(2, "0")}`,
    logger,
  });

  try {
    const results = [
      await postScenario(app, "succeeded"),
      await postScenario(app, "slow"),
      await postScenario(app, "failed"),
      await cancelScenario(app, "cancelled"),
      await cancelScenario(app, "cancellation-failed"),
    ];

    await sleep(exportSettleMs);

    logger.info("Agent Run diagnosis acceptance completed", {
      attributes: {
        "agent.run.acceptance.export_settle_ms": exportSettleMs,
        "agent.run.acceptance.results": results.map((result) => ({
          "agent.run.id": result.agentRunId,
          events: result.events,
          scenario: result.scenario,
        })),
      },
      eventName: "agent.run.acceptance.completed",
    });
  } catch (error) {
    runError = error;
  } finally {
    const cleanupResults = await Promise.allSettled([telemetry.shutdown(), logger.shutdown()]);
    const errors = cleanupResults
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);

    if (errors.length > 0) {
      cleanupError = new AggregateError(errors, "Acceptance runner cleanup failed");
    }
  }

  if (runError !== undefined) throw runError;
  if (cleanupError !== undefined) throw cleanupError;
};

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
