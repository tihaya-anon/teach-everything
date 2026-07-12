import { useLocalRuntime, type ChatModelAdapter, type ThreadMessage } from "@assistant-ui/react";

const RESPONSE_DELAY_MS = 45;

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

const waitForNextChunk = async (abortSignal: AbortSignal) => {
  if (abortSignal.aborted) return;

  await new Promise<void>((resolve) => {
    const handleAbort = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(() => {
      abortSignal.removeEventListener("abort", handleAbort);
      resolve();
    }, RESPONSE_DELAY_MS);

    abortSignal.addEventListener("abort", handleAbort, { once: true });
  });
};

const createResponse = (prompt: string) => {
  const normalizedPrompt = prompt.toLowerCase();

  if (normalizedPrompt.includes("stack")) {
    return [
      "This frontend now uses **assistant-ui** for the conversation runtime and primitives, ",
      "**Tailwind CSS v4** for styling, and **shadcn/ui** as the source-owned component convention.\n\n",
      "The adapter is deliberately repository-owned, so the Hono and LangGraph boundary can evolve independently.",
    ];
  }

  if (normalizedPrompt.includes("runtime")) {
    return [
      "The UI talks to a small `ChatModelAdapter` owned by this repository. ",
      "Today it streams this preview response locally; later the same adapter can call a Hono route ",
      "without changing the thread, messages, composer, cancellation, or Markdown rendering.",
    ];
  }

  return [
    `You asked: **${prompt}**\n\n`,
    "The assistant surface is ready for a real teaching workflow. ",
    "The next integration point is the application-owned Hono endpoint that will invoke the LangGraph runtime and stream its events.",
  ];
};

const previewModel: ChatModelAdapter = {
  async *run({ messages, abortSignal }) {
    const prompt = getLatestUserText(messages).trim();

    if (prompt.toLowerCase().includes("error")) {
      throw new Error("Preview error requested. The thread error state is working.");
    }

    const toolCall = {
      type: "tool-call" as const,
      toolCallId: crypto.randomUUID(),
      toolName: "inspectWorkspace",
      args: { scope: "apps/web" },
      argsText: '{"scope":"apps/web"}',
    };

    yield { content: [toolCall] };
    await waitForNextChunk(abortSignal);
    if (abortSignal.aborted) return;

    const completedToolCall = {
      ...toolCall,
      result: {
        framework: "Vite + React",
        runtime: "assistant-ui LocalRuntime",
        styling: "Tailwind CSS + shadcn/ui",
      },
    };
    const chunks = createResponse(prompt);
    let text = "";

    for (const chunk of chunks) {
      text += chunk;
      yield {
        content: [completedToolCall, { type: "text", text }],
      };
      await waitForNextChunk(abortSignal);
      if (abortSignal.aborted) return;
    }
  },
};

export const usePreviewAssistantRuntime = () =>
  useLocalRuntime(previewModel, {
    adapters: {
      suggestion: {
        async generate() {
          return [
            { prompt: "Explain the runtime boundary" },
            { prompt: "Show me the frontend stack" },
            { prompt: "Trigger an error preview" },
          ];
        },
      },
    },
  });
