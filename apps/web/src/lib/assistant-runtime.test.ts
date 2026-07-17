import type { ChatModelRunOptions, ChatModelRunResult, ThreadMessage } from "@assistant-ui/react";
import { describe, expect, it, vi } from "vitest";
import type { StartAgentRunStream } from "./agent-run-client";
import { createAgentRunModel } from "./assistant-runtime";

const createUserMessage = (text: string, id: string): ThreadMessage => ({
  id,
  createdAt: new Date(0),
  role: "user",
  content: [{ type: "text", text }],
  attachments: [],
  metadata: { custom: {} },
});

const messages = [
  createUserMessage("First question.", "message_01"),
  createUserMessage("  Explain lexical scope.  ", "message_03"),
] satisfies ThreadMessage[];

const createRunOptions = (signal: AbortSignal) =>
  ({
    messages,
    runConfig: {},
    abortSignal: signal,
    context: {},
    unstable_getMessage: () => messages[0]!,
  }) satisfies ChatModelRunOptions;

const streamFromText = (body: string) => {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
};

const completedStream = () =>
  streamFromText(
    '{"version":1,"type":"run.started","agentRunId":"ar_test_02"}\n{"version":1,"type":"message.delta","text":"Lexical "}\n{"version":1,"type":"message.delta","text":"scope."}\n{"version":1,"type":"run.completed"}\n',
  );

const collectUpdates = async (adapter: ReturnType<typeof createAgentRunModel>) => {
  const result = adapter.run(createRunOptions(new AbortController().signal));
  if (!(Symbol.asyncIterator in result)) {
    throw new Error("Expected the Agent Run adapter to stream updates");
  }

  const updates: ChatModelRunResult[] = [];
  for await (const update of result) {
    updates.push(update);
  }
  return updates;
};

describe("createAgentRunModel", () => {
  it("starts an Agent Run from the latest user text with the assistant abort signal", async () => {
    // Given
    const cancellation = new AbortController();
    const starter = vi.fn<StartAgentRunStream>().mockResolvedValue({
      agentRunId: "ar_test_02",
      body: completedStream(),
    });
    const adapter = createAgentRunModel(starter);

    // When
    const result = adapter.run(createRunOptions(cancellation.signal));
    if (!(Symbol.asyncIterator in result)) {
      throw new Error("Expected the Agent Run adapter to stream updates");
    }
    for await (const update of result) {
      // Drain the run so the starter is invoked.
      expect(update.content).toBeDefined();
    }

    // Then
    expect(starter).toHaveBeenCalledWith({
      message: "Explain lexical scope.",
      signal: cancellation.signal,
    });
  });

  it("maps consumer updates to cumulative assistant text and completion status", async () => {
    // Given
    const adapter = createAgentRunModel(
      vi.fn<StartAgentRunStream>().mockResolvedValue({
        agentRunId: "ar_test_02",
        body: completedStream(),
      }),
    );

    // When
    const updates = await collectUpdates(adapter);

    // Then
    expect(updates).toEqual([
      {
        content: [{ type: "text", text: "Lexical " }],
        metadata: { custom: { agentRunId: "ar_test_02" } },
      },
      {
        content: [{ type: "text", text: "Lexical scope." }],
        metadata: { custom: { agentRunId: "ar_test_02" } },
      },
      {
        content: [{ type: "text", text: "Lexical scope." }],
        metadata: { custom: { agentRunId: "ar_test_02" } },
        status: { type: "complete", reason: "stop" },
      },
    ]);
  });

  it.each([
    [
      "failed",
      '{"version":1,"type":"run.started","agentRunId":"ar_test_02"}\n{"version":1,"type":"message.delta","text":"Delivered text."}\n{"version":1,"type":"run.failed","errorClassification":"provider"}\n',
    ],
    [
      "cancelled",
      '{"version":1,"type":"run.started","agentRunId":"ar_test_02"}\n{"version":1,"type":"message.delta","text":"Delivered text."}\n{"version":1,"type":"run.cancelled"}\n',
    ],
  ])("throws the existing unsuccessful-run error when the Agent Run is %s", async (_type, body) => {
    // Given
    const adapter = createAgentRunModel(
      vi.fn<StartAgentRunStream>().mockResolvedValue({
        agentRunId: "ar_test_02",
        body: streamFromText(body),
      }),
    );
    const result = adapter.run(createRunOptions(new AbortController().signal));
    if (!(Symbol.asyncIterator in result)) {
      throw new Error("Expected the Agent Run adapter to stream updates");
    }
    const updates: ChatModelRunResult[] = [];
    let caughtError: unknown;

    // When
    try {
      for await (const update of result) {
        updates.push(update);
      }
    } catch (error) {
      caughtError = error;
    }

    // Then
    expect(updates).toEqual([
      {
        content: [{ type: "text", text: "Delivered text." }],
        metadata: { custom: { agentRunId: "ar_test_02" } },
      },
    ]);
    expect(caughtError).toEqual(new Error("Agent Run did not complete successfully"));
  });
});
