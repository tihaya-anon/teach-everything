import { describe, expect, it } from "vitest";
import {
  AgentRunStreamProtocolError,
  consumeAgentRunStream,
  type AgentRunStreamUpdate,
} from "./agent-run-stream-consumer";

const collectUpdates = async (body: ReadableStream<Uint8Array>) => {
  const updates: AgentRunStreamUpdate[] = [];

  for await (const update of consumeAgentRunStream({ agentRunId: "ar_test_02", body })) {
    updates.push(update);
  }

  return updates;
};

const streamFromChunks = (chunks: readonly string[]) => {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
};

const streamFromText = (body: string) => streamFromChunks([body]);

describe("consumeAgentRunStream", () => {
  it("decodes split UTF-8 and NDJSON records into cumulative Agent Run updates", async () => {
    // Given
    const body = streamFromChunks([
      '{"version":1,"type":"run.started","agentRunId":"ar_test_',
      '02"}\n{"version":1,"type":"message.delta","text":"Lexical "}\n',
      '{"version":1,"type":"message.delta","text":"scope ✅"}\n',
      '{"version":1,"type":"run.completed"}\n',
    ]);

    // When
    const updates = await collectUpdates(body);

    // Then
    expect(updates).toEqual([
      { agentRunId: "ar_test_02", text: "Lexical ", type: "message" },
      { agentRunId: "ar_test_02", text: "Lexical scope ✅", type: "message" },
      { agentRunId: "ar_test_02", text: "Lexical scope ✅", type: "completed" },
    ]);
  });

  it("yields failed terminal updates with the final cumulative text", async () => {
    // Given
    const body = streamFromText(
      '{"version":1,"type":"run.started","agentRunId":"ar_test_02"}\n{"version":1,"type":"message.delta","text":"Delivered text."}\n{"version":1,"type":"run.failed","errorClassification":"provider"}\n',
    );

    // When
    const updates = await collectUpdates(body);

    // Then
    expect(updates).toEqual([
      { agentRunId: "ar_test_02", text: "Delivered text.", type: "message" },
      {
        agentRunId: "ar_test_02",
        errorClassification: "provider",
        text: "Delivered text.",
        type: "failed",
      },
    ]);
  });

  it("yields cancelled terminal updates with the final cumulative text", async () => {
    // Given
    const body = streamFromText(
      '{"version":1,"type":"run.started","agentRunId":"ar_test_02"}\n{"version":1,"type":"message.delta","text":"Partial text."}\n{"version":1,"type":"run.cancelled"}\n',
    );

    // When
    const updates = await collectUpdates(body);

    // Then
    expect(updates).toEqual([
      { agentRunId: "ar_test_02", text: "Partial text.", type: "message" },
      { agentRunId: "ar_test_02", text: "Partial text.", type: "cancelled" },
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
      "a worker-only progress event",
      '{"version":1,"type":"run.started","agentRunId":"ar_test_02"}\n{"version":1,"type":"progress.update","scope":"task","label":"load-graph","status":"completed"}\n{"version":1,"type":"run.completed"}\n',
    ],
    [
      "a raw LangGraph chunk",
      '{"version":1,"type":"run.started","agentRunId":"ar_test_02"}\n{"version":1,"type":"raw.langgraph.chunk","chunk":{"content":"private"}}\n{"version":1,"type":"run.completed"}\n',
    ],
    [
      "a stream that does not start with run.started",
      '{"version":1,"type":"message.delta","text":"started late"}\n{"version":1,"type":"run.completed"}\n',
    ],
    [
      "a stream that starts with the wrong Agent Run Identifier",
      '{"version":1,"type":"run.started","agentRunId":"ar_other"}\n{"version":1,"type":"run.completed"}\n',
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
    const stream = streamFromText(body);

    // When
    const result = collectUpdates(stream);

    // Then
    await expect(result).rejects.toThrow(AgentRunStreamProtocolError);
    await expect(result).rejects.toThrow("Agent Run stream violates protocol");
  });
});
