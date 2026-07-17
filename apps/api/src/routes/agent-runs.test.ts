import type { AgentRunExecutor } from "@teach-everything/agent";
import { agentRunEventLineSchema, type AgentRunExecutorEvent } from "@teach-everything/shared";
import { serve } from "@hono/node-server";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";

const decodeAgentRunEvents = (body: string) =>
  body
    .trim()
    .split("\n")
    .map((line) => agentRunEventLineSchema.parse(line));

const waitForAbort = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    signal.addEventListener("abort", () => resolve(), { once: true });
  });

const agentRunEvents = (
  ...events: AgentRunExecutorEvent[]
): AsyncIterable<AgentRunExecutorEvent> => ({
  [Symbol.asyncIterator]: () => {
    let index = 0;

    return {
      next: () => {
        if (index >= events.length) return Promise.resolve({ done: true, value: undefined });

        const value = events[index] as AgentRunExecutorEvent;
        index += 1;

        return Promise.resolve({ done: false, value });
      },
    };
  },
});

const withTimeout = async <T>(promise: Promise<T>, message: string) => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 1_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const startEphemeralApi = (api: ReturnType<typeof createApp>) =>
  new Promise<{ close: () => Promise<void>; origin: string }>((resolve) => {
    const server = serve({ fetch: api.fetch, port: 0 }, (info) => {
      resolve({
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) closeReject(error);
              else closeResolve();
            });
          }),
        origin: `http://127.0.0.1:${info.port}`,
      });
    });
  });

const controlledCancellationExecutor = () => {
  let abortEvents = 0;
  let running = false;
  let resolveSignal!: (signal: AbortSignal) => void;
  let resolveStopped!: () => void;
  const receivedSignal = new Promise<AbortSignal>((resolve) => {
    resolveSignal = resolve;
  });
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  const stop = () => {
    if (!running) return;
    running = false;
    resolveStopped();
  };

  return {
    abortEvents: () => abortEvents,
    executor: {
      execute: (_input, signal) => {
        running = true;
        signal.addEventListener(
          "abort",
          () => {
            abortEvents += 1;
            stop();
          },
          { once: true },
        );
        resolveSignal(signal);

        let startedEventEmitted = false;

        return {
          [Symbol.asyncIterator]: () => ({
            next: () => {
              if (startedEventEmitted) {
                return waitForAbort(signal).then(() => ({ done: true, value: undefined }));
              }

              startedEventEmitted = true;
              return Promise.resolve({
                done: false,
                value: { version: 1, type: "message.delta", text: "Executor started." },
              });
            },
            return: () => {
              stop();
              return Promise.resolve({ done: true, value: undefined });
            },
          }),
        };
      },
    } satisfies AgentRunExecutor,
    isRunning: () => running,
    receivedSignal,
    stopped,
  };
};

describe("POST /api/agent-runs", () => {
  it("streams NDJSON Agent Run events with one identifier shared by the header and first event", async () => {
    // Given
    const received: { message?: string } = {};
    const executor: AgentRunExecutor = {
      execute: (input) => {
        received.message = input.message;
        return agentRunEvents(
          { version: 1, type: "message.delta", text: "Closures retain their scope. " },
          { version: 1, type: "message.delta", text: "That is lexical scoping." },
          { version: 1, type: "run.completed" },
        );
      },
    };
    const api = createApp({
      agentRunExecutor: executor,
      createAgentRunId: () => "ar_test_01",
    });
    const request = new Request("http://localhost/api/agent-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Explain closures." }),
    });

    // When
    const response = await api.request(request);
    const body = await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/x-ndjson");
    expect(response.headers.get("X-Agent-Run-Id")).toBe("ar_test_01");
    expect(received).toEqual({ message: "Explain closures." });
    expect(decodeAgentRunEvents(body)).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_test_01" },
      { version: 1, type: "message.delta", text: "Closures retain their scope. " },
      { version: 1, type: "message.delta", text: "That is lexical scoping." },
      { version: 1, type: "run.completed" },
    ]);
  });

  it.each(["{", JSON.stringify({ message: " \n " })])(
    "rejects invalid input before creating an Agent Run: %j",
    async (body) => {
      // Given
      const api = createApp({
        agentRunExecutor: {
          execute: () => agentRunEvents({ version: 1, type: "run.completed" }),
        },
        createAgentRunId: () => "ar_must_not_exist",
      });
      const request = new Request("http://localhost/api/agent-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      // When
      const response = await api.request(request);
      const responseBody: unknown = await response.json();

      // Then
      expect(response.status).toBe(400);
      expect(response.headers.get("X-Agent-Run-Id")).toBeNull();
      expect(response.headers.get("Content-Type")).toContain("application/json");
      expect(responseBody).toEqual({ success: false, message: "Invalid Agent Run request" });
    },
  );

  it("cancels lifecycle work when the response stream is cancelled", async () => {
    // Given
    const controlled = controlledCancellationExecutor();
    const api = createApp({
      agentRunExecutor: controlled.executor,
      createAgentRunId: () => "ar_stream_cancel",
    });
    const request = new Request("http://localhost/api/agent-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Cancel the response stream." }),
    });

    // When
    const response = await api.request(request);
    const executorSignal = await withTimeout(
      controlled.receivedSignal,
      "Timed out waiting for executor signal",
    );
    await response.body?.cancel();
    await withTimeout(controlled.stopped, "Timed out waiting for controlled work to stop");

    // Then
    expect(executorSignal.aborted).toBe(true);
    expect(controlled.abortEvents()).toBe(1);
    expect(controlled.isRunning()).toBe(false);
  });

  it("passes request-signal cancellation through to lifecycle work", async () => {
    // Given
    const controlled = controlledCancellationExecutor();
    const requestCancellation = new AbortController();
    const api = createApp({
      agentRunExecutor: controlled.executor,
      createAgentRunId: () => "ar_request_signal_cancel",
    });
    const request = new Request("http://localhost/api/agent-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Cancel the request signal." }),
      signal: requestCancellation.signal,
    });

    // When
    const response = await api.request(request);
    const executorSignal = await withTimeout(
      controlled.receivedSignal,
      "Timed out waiting for executor signal",
    );
    requestCancellation.abort();
    await withTimeout(controlled.stopped, "Timed out waiting for controlled work to stop");
    await response.body?.cancel();

    // Then
    expect(executorSignal.aborted).toBe(true);
    expect(controlled.abortEvents()).toBe(1);
    expect(controlled.isRunning()).toBe(false);
  });

  it("propagates a real Node HTTP client abort to the executor and stops controlled work", async () => {
    // Given
    const controlled = controlledCancellationExecutor();
    const server = await startEphemeralApi(
      createApp({
        agentRunExecutor: controlled.executor,
        createAgentRunId: () => "ar_http_abort",
      }),
    );
    const clientCancellation = new AbortController();

    try {
      const response = await fetch(`${server.origin}/api/agent-runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Start controlled work." }),
        signal: clientCancellation.signal,
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Expected streamed response body");

      // When
      await withTimeout(reader.read(), "Timed out waiting for Agent Run stream to start");
      const executorSignal = await withTimeout(
        controlled.receivedSignal,
        "Timed out waiting for executor signal",
      );
      clientCancellation.abort();
      await withTimeout(controlled.stopped, "Timed out waiting for controlled work to stop");

      // Then
      expect(response.status).toBe(200);
      expect(executorSignal.aborted).toBe(true);
      expect(controlled.abortEvents()).toBe(1);
      expect(controlled.isRunning()).toBe(false);
    } finally {
      await server.close();
    }
  });
});
