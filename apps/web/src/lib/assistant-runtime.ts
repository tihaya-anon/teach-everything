import {
  useLocalRuntime,
  type ChatModelAdapter,
  type ChatModelRunResult,
  type ThreadMessage,
} from "@assistant-ui/react";
import { startAgentRunStream, type StartAgentRunStream } from "./agent-run-client";
import { consumeAgentRunStream, type AgentRunStreamUpdate } from "./agent-run-stream-consumer";

const getLatestUserText = (messages: readonly ThreadMessage[]) => {
  let userMessage: ThreadMessage | undefined;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      userMessage = message;
      break;
    }
  }

  return (
    userMessage?.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ") ?? ""
  );
};

const toAssistantTextUpdate = (
  update: Extract<AgentRunStreamUpdate, { type: "message" | "completed" }>,
): ChatModelRunResult => ({
  content: [{ type: "text", text: update.text }],
  metadata: { custom: { agentRunId: update.agentRunId } },
  ...(update.type === "completed"
    ? { status: { type: "complete" as const, reason: "stop" as const } }
    : {}),
});

export const createAgentRunModel = (
  startRun: StartAgentRunStream = startAgentRunStream,
): ChatModelAdapter => ({
  async *run({ messages, abortSignal }): AsyncGenerator<ChatModelRunResult, void> {
    const startedRun = await startRun({
      message: getLatestUserText(messages).trim(),
      signal: abortSignal,
    });

    for await (const update of consumeAgentRunStream(startedRun)) {
      if (update.type === "message" || update.type === "completed") {
        yield toAssistantTextUpdate(update);
        continue;
      }

      throw new Error("Agent Run did not complete successfully");
    }
  },
});

const agentRunModel = createAgentRunModel();

export const useAgentRunAssistantRuntime = () =>
  useLocalRuntime(agentRunModel, {
    adapters: {
      suggestion: {
        async generate() {
          return [
            { prompt: "Explain the runtime boundary" },
            { prompt: "Show me the frontend stack" },
            { prompt: "Help me learn a new concept" },
          ];
        },
      },
    },
  });
