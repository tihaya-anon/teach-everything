import type { AgentRunExecutor } from "@teach-everything/agent";
import {
  type AgentRunTelemetry,
  type AgentRunTelemetryScope,
} from "@teach-everything/observability";
import {
  agentRunRequestSchema,
  encodeAgentRunEventLine,
  type AgentRunRequest,
} from "@teach-everything/shared";
import type { Context } from "hono";
import type { HonoBase } from "hono/hono-base";
import { validator } from "hono/validator";
import type { AgentBehaviorVersionAcceptanceInput } from "../agent-run-behavior";
import { createAgentRunLifecycle } from "../agent-run-lifecycle";

export type CreateAgentRunResponseOptions = {
  agentBehaviorVersionAcceptance: AgentBehaviorVersionAcceptanceInput;
  agentRunExecutor: AgentRunExecutor;
  agentRunId: string;
  input: AgentRunRequest;
  signal: AbortSignal;
  telemetryScope: AgentRunTelemetryScope;
};

export type RegisterAgentRunRoutesOptions = {
  agentBehaviorVersionAcceptance: AgentBehaviorVersionAcceptanceInput;
  agentRunExecutor: AgentRunExecutor;
  agentRunTelemetry: AgentRunTelemetry;
  createAgentRunId: () => string;
};

const createAgentRunStream = (
  agentBehaviorVersionAcceptance: AgentBehaviorVersionAcceptanceInput,
  executor: AgentRunExecutor,
  agentRunId: string,
  input: AgentRunRequest,
  requestSignal: AbortSignal,
  telemetryScope: AgentRunTelemetryScope,
) => {
  // The response body is a validated NDJSON stream: one Agent Run event per line.
  const lifecycle = createAgentRunLifecycle({
    agentBehaviorVersionAcceptance,
    agentRunExecutor: executor,
    agentRunId,
    input,
    signal: requestSignal,
    telemetryScope,
  });
  const encoder = new TextEncoder();
  let clientWritable = true;
  let completion: Promise<void> = Promise.resolve();

  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      completion = (async () => {
        try {
          for await (const event of lifecycle.events) {
            // Once the client disconnects, stop writing and let lifecycle cancellation own cleanup.
            if (!clientWritable) return;
            controller.enqueue(encoder.encode(encodeAgentRunEventLine(event)));
          }
          if (!clientWritable) return;
          try {
            controller.close();
          } catch {
            clientWritable = false;
          }
        } catch {
          // Stream controller failures usually mean the peer disappeared mid-run.
          clientWritable = false;
          await lifecycle.cancel();
        }
      })();
    },
    cancel: async () => {
      clientWritable = false;
      await lifecycle.cancel();
      await completion;
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
  agentBehaviorVersionAcceptance,
  agentRunExecutor,
  agentRunId,
  input,
  signal,
  telemetryScope,
}: CreateAgentRunResponseOptions) =>
  new Response(
    createAgentRunStream(
      agentBehaviorVersionAcceptance,
      agentRunExecutor,
      agentRunId,
      input,
      signal,
      telemetryScope,
    ),
    {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "X-Agent-Run-Id": agentRunId,
      },
    },
  );

export const registerAgentRunRoutes = <App extends HonoBase>(
  app: App,
  {
    agentBehaviorVersionAcceptance,
    agentRunExecutor,
    agentRunTelemetry,
    createAgentRunId,
  }: RegisterAgentRunRoutesOptions,
) =>
  app.post("/api/agent-runs", validateAgentRunRequest, (c) => {
    const agentRunId = createAgentRunId();
    const telemetryScope = agentRunTelemetry.start(agentRunId);

    return createAgentRunResponse({
      agentBehaviorVersionAcceptance,
      agentRunExecutor,
      agentRunId,
      input: c.req.valid("json"),
      signal: c.req.raw.signal,
      telemetryScope,
    });
  });
