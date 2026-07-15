import { AgentRunExecutionError, type AgentRunExecutor } from "@teach-everything/agent";
import {
  agentRunEventLineSchema,
  agentRunRequestSchema,
  healthResponseSchema,
  type AgentRunExecutorEvent,
} from "@teach-everything/shared";
import { describe, expect, it } from "vitest";
import { app, createApp } from "./app";

const decodeAgentRunEvents = (body: string) =>
  body
    .trim()
    .split("\n")
    .map((line) => agentRunEventLineSchema.parse(line));

const unsafeAgentRunExecutor = (events: AsyncIterable<unknown>): AgentRunExecutor =>
  ({ execute: () => events }) as unknown as AgentRunExecutor;

const rejectedAgentRunExecutor = (error: unknown): AgentRunExecutor => ({
  execute: () => ({
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.reject<IteratorResult<AgentRunExecutorEvent>>(error),
    }),
  }),
});

const emptyAsyncIterable = (): AsyncIterable<unknown> => ({
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true, value: undefined }),
  }),
});

describe("GET /api/health", () => {
  it("returns a successful health response", async () => {
    // Given
    const request = new Request("http://localhost/api/health");

    // When
    const response = await app.request(request);
    const body: unknown = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(healthResponseSchema.safeParse(body).success).toBe(true);
  });
});

describe("POST /api/agent-runs", () => {
  it("streams a successful Agent Run with one identifier shared by the header and first event", async () => {
    // Given
    const received: { message?: string } = {};
    const executor: AgentRunExecutor = {
      async *execute(input) {
        received.message = input.message;
        yield { version: 1, type: "message.delta", text: "Closures retain their scope. " };
        yield { version: 1, type: "message.delta", text: "That is lexical scoping." };
        yield { version: 1, type: "run.completed" };
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
    const lines = decodeAgentRunEvents(await response.text());

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/x-ndjson");
    expect(response.headers.get("X-Agent-Run-Id")).toBe("ar_test_01");
    expect(received).toEqual({ message: "Explain closures." });
    expect(lines).toEqual([
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
          async *execute() {
            yield { version: 1, type: "run.completed" };
          },
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

  it.each(["validation", "provider", "tool", "timeout"] as const)(
    "ends a post-start %s executor failure with a bounded failure event",
    async (errorClassification) => {
      // Given
      const api = createApp({
        agentRunExecutor: rejectedAgentRunExecutor(
          new AgentRunExecutionError(errorClassification, new Error("executor-secret")),
        ),
        createAgentRunId: () => "ar_failure_01",
      });
      const request = new Request("http://localhost/api/agent-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Run this executor." }),
      });

      // When
      const response = await api.request(request);
      const body = await response.text();
      const events = decodeAgentRunEvents(body);

      // Then
      expect(events).toEqual([
        { version: 1, type: "run.started", agentRunId: "ar_failure_01" },
        { version: 1, type: "run.failed", errorClassification },
      ]);
      expect(body).not.toContain("executor-secret");
    },
  );

  it.each([
    ["an unexpected thrown error", () => new Error("executor-secret")],
    [
      "a spoofed validation error",
      () => Object.assign(new Error("executor-secret"), { name: "ZodError" }),
    ],
    [
      "an invalid classified error",
      () => {
        const error = new AgentRunExecutionError("provider", {
          cause: new Error("executor-secret"),
        });
        Object.defineProperty(error, "errorClassification", { value: "unbounded" });
        return error;
      },
    ],
  ])("falls back to internal for %s", async (_description, createError) => {
    // Given
    const api = createApp({
      agentRunExecutor: rejectedAgentRunExecutor(createError()),
      createAgentRunId: () => "ar_internal_failure_01",
    });
    const request = new Request("http://localhost/api/agent-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Run this executor." }),
    });

    // When
    const response = await api.request(request);
    const body = await response.text();

    // Then
    expect(decodeAgentRunEvents(body)).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_internal_failure_01" },
      { version: 1, type: "run.failed", errorClassification: "internal" },
    ]);
    expect(body).not.toContain("executor-secret");
  });

  it("classifies validation performed by the configured executor after the stream starts", async () => {
    // Given
    const api = createApp({
      agentRunExecutor: {
        async *execute() {
          agentRunRequestSchema.parse({ message: " " });
          yield { version: 1, type: "run.completed" };
        },
      },
      createAgentRunId: () => "ar_validation_01",
    });
    const request = new Request("http://localhost/api/agent-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Run this executor." }),
    });

    // When
    const response = await api.request(request);
    const events = decodeAgentRunEvents(await response.text());

    // Then
    expect(events).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_validation_01" },
      { version: 1, type: "run.failed", errorClassification: "validation" },
    ]);
  });

  it("ends premature or malformed executor output with one internal failure", async () => {
    // Given
    const executors = [
      unsafeAgentRunExecutor(emptyAsyncIterable()),
      unsafeAgentRunExecutor(
        (async function* () {
          yield {
            version: 1,
            type: "run.failed",
            errorClassification: "provider",
            error: "executor-secret",
          };
        })(),
      ),
    ];

    // When
    const responses = await Promise.all(
      executors.map((agentRunExecutor) =>
        createApp({
          agentRunExecutor,
          createAgentRunId: () => "ar_internal_01",
        }).request(
          new Request("http://localhost/api/agent-runs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "Run this executor." }),
          }),
        ),
      ),
    );
    const bodies = await Promise.all(responses.map((response) => response.text()));
    const eventSequences = bodies.map(decodeAgentRunEvents);

    // Then
    expect(eventSequences).toEqual([
      [
        { version: 1, type: "run.started", agentRunId: "ar_internal_01" },
        { version: 1, type: "run.failed", errorClassification: "internal" },
      ],
      [
        { version: 1, type: "run.started", agentRunId: "ar_internal_01" },
        { version: 1, type: "run.failed", errorClassification: "internal" },
      ],
    ]);
    expect(bodies.join("\n")).not.toContain("executor-secret");
  });

  it("keeps exactly one terminal event when the executor attempts duplicate termination", async () => {
    // Given
    const api = createApp({
      agentRunExecutor: {
        async *execute() {
          yield { version: 1, type: "run.completed" };
          yield { version: 1, type: "run.failed", errorClassification: "internal" };
        },
      },
      createAgentRunId: () => "ar_terminal_01",
    });
    const request = new Request("http://localhost/api/agent-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Run this executor." }),
    });

    // When
    const response = await api.request(request);
    const events = decodeAgentRunEvents(await response.text());

    // Then
    expect(events).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_terminal_01" },
      { version: 1, type: "run.completed" },
    ]);
  });

  it("keeps the terminal decision when executor cleanup fails after termination", async () => {
    // Given
    const api = createApp({
      agentRunExecutor: {
        execute: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () =>
              Promise.resolve<IteratorResult<AgentRunExecutorEvent>>({
                done: false,
                value: { version: 1, type: "run.completed" },
              }),
            return: () => Promise.reject<IteratorResult<AgentRunExecutorEvent>>("executor-secret"),
          }),
        }),
      },
      createAgentRunId: () => "ar_terminal_cleanup_01",
    });
    const request = new Request("http://localhost/api/agent-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Run this executor." }),
    });

    // When
    const response = await api.request(request);
    const body = await response.text();
    const events = decodeAgentRunEvents(body);

    // Then
    expect(events).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_terminal_cleanup_01" },
      { version: 1, type: "run.completed" },
    ]);
    expect(body).not.toContain("executor-secret");
  });

  it("does not expose the Agent Run route when no executor is configured", async () => {
    // Given
    const request = new Request("http://localhost/api/agent-runs", { method: "POST" });

    // When
    const response = await app.request(request);

    // Then
    expect(response.status).toBe(404);
  });
});
