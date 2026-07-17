import { describe, expect, it, vi } from "vitest";
import { startAgentRunStream } from "./agent-run-client";

const mocks = vi.hoisted(() => ({
  postAgentRun: vi.fn(),
}));

vi.mock("../api", () => ({
  api: {
    api: {
      "agent-runs": {
        $post: mocks.postAgentRun,
      },
    },
  },
}));

const createStreamResponse = (body: BodyInit | null = "stream") =>
  new Response(body, {
    headers: {
      "X-Agent-Run-Id": "ar_client_01",
    },
  });

describe("startAgentRunStream", () => {
  it("starts an Agent Run through the typed Hono client", async () => {
    // Given
    const signal = new AbortController().signal;
    const response = createStreamResponse();
    mocks.postAgentRun.mockResolvedValue(response);

    // When
    const started = await startAgentRunStream({ message: "Explain closures.", signal });

    // Then
    expect(mocks.postAgentRun).toHaveBeenCalledWith(
      { json: { message: "Explain closures." } },
      { init: { signal } },
    );
    expect(started).toEqual({ agentRunId: "ar_client_01", body: response.body });
  });

  it("rejects failed Agent Run requests", async () => {
    // Given
    mocks.postAgentRun.mockResolvedValue(new Response("failed", { status: 500 }));

    // When
    const started = startAgentRunStream({
      message: "Explain closures.",
      signal: new AbortController().signal,
    });

    // Then
    await expect(started).rejects.toThrow("Agent Run request failed");
  });

  it("rejects responses without an Agent Run Identifier", async () => {
    // Given
    mocks.postAgentRun.mockResolvedValue(new Response("stream"));

    // When
    const started = startAgentRunStream({
      message: "Explain closures.",
      signal: new AbortController().signal,
    });

    // Then
    await expect(started).rejects.toThrow(
      "Agent Run response is missing its stream identifier or body",
    );
  });

  it("rejects responses without a stream body", async () => {
    // Given
    mocks.postAgentRun.mockResolvedValue(createStreamResponse(null));

    // When
    const started = startAgentRunStream({
      message: "Explain closures.",
      signal: new AbortController().signal,
    });

    // Then
    await expect(started).rejects.toThrow(
      "Agent Run response is missing its stream identifier or body",
    );
  });
});
