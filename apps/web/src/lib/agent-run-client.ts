import { api } from "../api";

export type StartAgentRunOptions = {
  message: string;
  signal: AbortSignal;
};

export type StartedAgentRunStream = {
  agentRunId: string;
  body: ReadableStream<Uint8Array>;
};

export type StartAgentRunStream = (options: StartAgentRunOptions) => Promise<StartedAgentRunStream>;

export const startAgentRunStream: StartAgentRunStream = async ({ message, signal }) => {
  const response = await api.api["agent-runs"].$post({ json: { message } }, { init: { signal } });

  if (!response.ok) {
    throw new Error("Agent Run request failed");
  }

  const agentRunId = response.headers.get("X-Agent-Run-Id");
  if (!agentRunId || !response.body) {
    throw new Error("Agent Run response is missing its stream identifier or body");
  }

  return { agentRunId, body: response.body };
};
