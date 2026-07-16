import { AgentRunExecutionError, type AgentRunExecutor } from "@teach-everything/agent";
import {
  type AgentRunErrorClassification,
  type AgentRunTelemetry,
  type AgentRunTelemetryScope,
  type AgentRunTerminalOutcome,
} from "@teach-everything/observability";
import {
  agentRunErrorClassificationSchema,
  agentRunExecutorEventSchema,
  agentRunRequestSchema,
  encodeAgentRunEventLine,
  isAgentRunValidationError,
  type AgentRunEvent,
  type AgentRunRequest,
} from "@teach-everything/shared";
import type { Context, Hono } from "hono";
import { validator } from "hono/validator";

type TerminalAgentRunEvent = Extract<
  AgentRunEvent,
  { type: "run.completed" | "run.failed" | "run.cancelled" }
>;

export type CreateAgentRunResponseOptions = {
  agentRunExecutor: AgentRunExecutor;
  agentRunId: string;
  input: AgentRunRequest;
  signal: AbortSignal;
  telemetryScope: AgentRunTelemetryScope;
};

export type RegisterAgentRunRoutesOptions = {
  agentRunExecutor: AgentRunExecutor;
  agentRunTelemetry: AgentRunTelemetry;
  createAgentRunId: () => string;
};

const getErrorClassification = (error: unknown) => {
  if (error instanceof AgentRunExecutionError) {
    const parsedClassification = agentRunErrorClassificationSchema.safeParse(
      error.errorClassification,
    );
    return parsedClassification.success ? parsedClassification.data : "internal";
  }
  if (isAgentRunValidationError(error)) return "validation";
  return "internal";
};

const isTerminalEvent = (event: AgentRunEvent): event is TerminalAgentRunEvent =>
  event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled";

const terminalTelemetryOutcome = (event: TerminalAgentRunEvent): AgentRunTerminalOutcome => {
  if (event.type === "run.failed") {
    return { outcome: "failed", errorClassification: event.errorClassification };
  }

  return { outcome: event.type === "run.completed" ? "succeeded" : "cancelled" };
};

const failureEvent = (errorClassification: AgentRunErrorClassification): TerminalAgentRunEvent => ({
  version: 1 as const,
  type: "run.failed" as const,
  errorClassification,
});

const createAgentRunStream = (
  executor: AgentRunExecutor,
  agentRunId: string,
  input: AgentRunRequest,
  signal: AbortSignal,
  telemetryScope: AgentRunTelemetryScope,
) => {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let terminal = false;
      const send = (event: AgentRunEvent) =>
        controller.enqueue(encoder.encode(encodeAgentRunEventLine(event)));
      const terminate = (event: TerminalAgentRunEvent) => {
        if (terminal) return;
        terminal = true;
        telemetryScope.finish(terminalTelemetryOutcome(event));
        send(event);
        controller.close();
      };

      telemetryScope.runInContext(() => {
        send({ version: 1, type: "run.started", agentRunId });
      });

      await telemetryScope.runInContext(async () => {
        try {
          for await (const executorEvent of executor.execute(input, signal)) {
            const parsedEvent = agentRunExecutorEventSchema.safeParse(executorEvent);
            if (!parsedEvent.success) {
              terminate(failureEvent("internal"));
              return;
            }

            if (isTerminalEvent(parsedEvent.data)) {
              terminate(parsedEvent.data);
              return;
            }

            send(parsedEvent.data);
          }

          terminate(failureEvent("internal"));
        } catch (error) {
          terminate(failureEvent(getErrorClassification(error)));
        }
      });
    },
  });
};

export const invalidAgentRunRequestResponse = (c: Context) =>
  c.json({ success: false, message: "Invalid Agent Run request" }, 400);

export const validateAgentRunRequest = validator("json", (body, c) => {
  const parsedRequest = agentRunRequestSchema.safeParse(body);
  if (!parsedRequest.success) return invalidAgentRunRequestResponse(c);

  return parsedRequest.data;
});

export const createAgentRunResponse = ({
  agentRunExecutor,
  agentRunId,
  input,
  signal,
  telemetryScope,
}: CreateAgentRunResponseOptions) =>
  new Response(createAgentRunStream(agentRunExecutor, agentRunId, input, signal, telemetryScope), {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Agent-Run-Id": agentRunId,
    },
  });

export const registerAgentRunRoutes = <App extends Hono>(
  app: App,
  { agentRunExecutor, agentRunTelemetry, createAgentRunId }: RegisterAgentRunRoutesOptions,
) =>
  app.post("/api/agent-runs", validateAgentRunRequest, (c) => {
    const agentRunId = createAgentRunId();
    const telemetryScope = agentRunTelemetry.start(agentRunId);

    return createAgentRunResponse({
      agentRunExecutor,
      agentRunId,
      input: c.req.valid("json"),
      signal: c.req.raw.signal,
      telemetryScope,
    });
  });
