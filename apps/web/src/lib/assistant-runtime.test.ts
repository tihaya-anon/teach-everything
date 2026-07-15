import type { ChatModelRunOptions, ChatModelRunResult, ThreadMessage } from "@assistant-ui/react";
import { describe, expect, it, vi } from "vitest";
import { createAgentRunModel } from "./assistant-runtime";

const messages = [
  {
    id: "message_01",
    createdAt: new Date(0),
    role: "user" as const,
    content: [{ type: "text" as const, text: "Explain lexical scope." }],
    attachments: [],
    metadata: { custom: {} },
  },
] satisfies ThreadMessage[];

const createRunOptions = (signal: AbortSignal) =>
  ({
    messages,
    runConfig: {},
    abortSignal: signal,
    context: {},
    unstable_getMessage: () => messages[0]!,
  }) satisfies ChatModelRunOptions;

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

const createStreamResponse = (body: string) =>
  new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "X-Agent-Run-Id": "ar_test_02",
    },
  });

describe("createAgentRunModel", () => {
  it("streams cumulative assistant text and retains the Agent Run Identifier", async () => {
    // Given
    const encoder = new TextEncoder();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('{"version":1,"type":"run.started","agentRunId":"ar_test_'),
            );
            controller.enqueue(
              encoder.encode(
                '02"}\n{"version":1,"type":"message.delta","text":"Lexical "}\n{"version":1,"type":"message.delta","text":"scope."}\n{"version":1,"type":"run.completed"}\n',
              ),
            );
            controller.close();
          },
        }),
        {
          headers: {
            "Content-Type": "application/x-ndjson",
            "X-Agent-Run-Id": "ar_test_02",
          },
        },
      ),
    );
    const adapter = createAgentRunModel(fetcher);
    const cancellation = new AbortController();
    const options = createRunOptions(cancellation.signal);

    // When
    const result = adapter.run(options);
    if (!(Symbol.asyncIterator in result)) {
      throw new Error("Expected the Agent Run adapter to stream updates");
    }
    const updates: ChatModelRunResult[] = [];
    for await (const update of result) {
      updates.push(update);
    }

    // Then
    expect(fetcher).toHaveBeenCalledWith(
      "/api/agent-runs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: "Explain lexical scope." }),
        signal: cancellation.signal,
      }),
    );
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
    ["malformed JSON", '{"version":1,"type":"run.started"\n'],
    [
      "an unterminated final JSON record",
      '{"version":1,"type":"run.started","agentRunId":"ar_test_02"}',
    ],
    [
      "an unknown protocol version",
      '{"version":2,"type":"run.started","agentRunId":"ar_test_02"}\n',
    ],
    ["an unknown event type", '{"version":1,"type":"tool.started","toolName":"search"}\n'],
    [
      "a stream that does not start with run.started",
      '{"version":1,"type":"message.delta","text":"started late"}\n{"version":1,"type":"run.completed"}\n',
    ],
    ["premature EOF", '{"version":1,"type":"run.started","agentRunId":"ar_test_02"}\n'],
    [
      "a duplicate terminal event",
      '{"version":1,"type":"run.started","agentRunId":"ar_test_02"}\n{"version":1,"type":"run.completed"}\n{"version":1,"type":"run.completed"}\n',
    ],
    [
      "an event after termination",
      '{"version":1,"type":"run.started","agentRunId":"ar_test_02"}\n{"version":1,"type":"run.completed"}\n{"version":1,"type":"message.delta","text":"after termination"}\n',
    ],
  ])("rejects %s", async (_description, body) => {
    // Given
    const adapter = createAgentRunModel(
      vi.fn<typeof fetch>().mockResolvedValue(createStreamResponse(body)),
    );

    // When
    const run = collectUpdates(adapter);

    // Then
    await expect(run).rejects.toThrow("Agent Run stream");
  });

  it("preserves delivered assistant content before handling a valid failure event", async () => {
    // Given
    const adapter = createAgentRunModel(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          createStreamResponse(
            '{"version":1,"type":"run.started","agentRunId":"ar_test_02"}\n{"version":1,"type":"message.delta","text":"Delivered text."}\n{"version":1,"type":"run.failed","errorClassification":"provider"}\n',
          ),
        ),
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
      // The existing conversation runtime treats failed runs as an adapter error.
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
