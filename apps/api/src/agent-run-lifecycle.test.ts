import { AgentRunExecutionError, type AgentRunExecutor } from "@teach-everything/agent";
import type {
  AgentRunTelemetryScope,
  AgentRunTerminalOutcome,
} from "@teach-everything/observability";
import {
  agentRunRequestSchema,
  type AgentRunEvent,
  type AgentRunExecutorEvent,
  type AgentRunRequest,
} from "@teach-everything/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRunLifecycle } from "./agent-run-lifecycle";

const INPUT: AgentRunRequest = { message: "Explain closures." };

type RecordedTelemetry = {
  cancellationRequests: number;
  finishes: AgentRunTerminalOutcome[];
  scope: AgentRunTelemetryScope;
};

const createRecordedTelemetry = (): RecordedTelemetry => {
  const telemetry: RecordedTelemetry = {
    cancellationRequests: 0,
    finishes: [],
    scope: {
      recordCancellationRequested: () => {
        telemetry.cancellationRequests += 1;
      },
      runInContext: (operation) => operation(),
      finish: (terminalOutcome) => {
        telemetry.finishes.push(terminalOutcome);
      },
    },
  };

  return telemetry;
};

const collectEvents = async (events: AsyncIterable<AgentRunEvent>) => {
  const collected: AgentRunEvent[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
};

const unsafeAgentRunExecutor = (events: AsyncIterable<unknown>): AgentRunExecutor =>
  ({ execute: () => events }) as unknown as AgentRunExecutor;

const asyncIterableFrom = <T>(items: T[]): AsyncIterable<T> => ({
  [Symbol.asyncIterator]: () => {
    let index = 0;

    return {
      next: () => {
        if (index >= items.length) return Promise.resolve({ done: true, value: undefined });

        const value = items[index] as T;
        index += 1;

        return Promise.resolve({ done: false, value });
      },
    };
  },
});

const agentRunEvents = (...events: AgentRunExecutorEvent[]) => asyncIterableFrom(events);

const emptyAsyncIterable = (): AsyncIterable<unknown> => ({
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true, value: undefined }),
  }),
});

const rejectedAgentRunExecutor = (error: unknown): AgentRunExecutor => ({
  execute: () => ({
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.reject<IteratorResult<AgentRunExecutorEvent>>(error),
    }),
  }),
});

const neverSettlingExecutorResult = () =>
  new Promise<IteratorResult<AgentRunExecutorEvent>>(() => undefined);

const hangingAgentRunExecutor = (
  options: {
    onSignal?: (signal: AbortSignal) => void;
    onCleanup?: () => void;
    cleanup?: () => Promise<IteratorResult<AgentRunExecutorEvent>>;
  } = {},
): AgentRunExecutor => ({
  execute: (_request, signal) => {
    options.onSignal?.(signal);

    return {
      [Symbol.asyncIterator]: () => ({
        next: neverSettlingExecutorResult,
        ...(options.cleanup === undefined
          ? {}
          : {
              return: () => {
                options.onCleanup?.();
                return options.cleanup?.() ?? neverSettlingExecutorResult();
              },
            }),
      }),
    };
  },
});

const resolveCleanupAfter = (
  delayMs: number,
  onStopped?: () => void,
): Promise<IteratorResult<AgentRunExecutorEvent>> =>
  new Promise((resolve) => {
    setTimeout(() => {
      onStopped?.();
      resolve({ done: true, value: undefined });
    }, delayMs);
  });

const createLifecycle = (
  agentRunExecutor: AgentRunExecutor,
  options: {
    agentRunId?: string;
    cancellationConfirmationTimeoutMs?: number;
    signal?: AbortSignal;
    telemetry?: RecordedTelemetry;
  } = {},
) => {
  const telemetry = options.telemetry ?? createRecordedTelemetry();

  return {
    lifecycle: createAgentRunLifecycle({
      agentRunExecutor,
      agentRunId: options.agentRunId ?? "ar_lifecycle",
      input: INPUT,
      signal: options.signal ?? new AbortController().signal,
      telemetryScope: telemetry.scope,
      ...(options.cancellationConfirmationTimeoutMs === undefined
        ? {}
        : { cancellationConfirmationTimeoutMs: options.cancellationConfirmationTimeoutMs }),
    }),
    telemetry,
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("createAgentRunLifecycle", () => {
  it("emits a successful Agent Run and finishes telemetry once", async () => {
    // Given
    const received: { message?: string } = {};
    const { lifecycle, telemetry } = createLifecycle({
      execute: (request) => {
        received.message = request.message;
        return agentRunEvents(
          { version: 1, type: "message.delta", text: "Closures retain scope. " },
          { version: 1, type: "message.delta", text: "That is lexical scoping." },
          { version: 1, type: "run.completed" },
        );
      },
    });

    // When
    const events = await collectEvents(lifecycle.events);

    // Then
    expect(received).toEqual({ message: "Explain closures." });
    expect(events).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_lifecycle" },
      { version: 1, type: "message.delta", text: "Closures retain scope. " },
      { version: 1, type: "message.delta", text: "That is lexical scoping." },
      { version: 1, type: "run.completed" },
    ]);
    expect(telemetry.cancellationRequests).toBe(0);
    expect(telemetry.finishes).toEqual([{ outcome: "succeeded" }]);
  });

  it.each(["validation", "provider", "tool", "timeout"] as const)(
    "classifies a %s executor failure without exposing error details",
    async (errorClassification) => {
      // Given
      const { lifecycle, telemetry } = createLifecycle(
        rejectedAgentRunExecutor(
          new AgentRunExecutionError(errorClassification, {
            cause: new Error("executor-secret"),
          }),
        ),
      );

      // When
      const events = await collectEvents(lifecycle.events);

      // Then
      expect(events).toEqual([
        { version: 1, type: "run.started", agentRunId: "ar_lifecycle" },
        { version: 1, type: "run.failed", errorClassification },
      ]);
      expect(JSON.stringify(events)).not.toContain("executor-secret");
      expect(telemetry.finishes).toEqual([{ outcome: "failed", errorClassification }]);
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
    const { lifecycle, telemetry } = createLifecycle(rejectedAgentRunExecutor(createError()));

    // When
    const events = await collectEvents(lifecycle.events);

    // Then
    expect(events).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_lifecycle" },
      { version: 1, type: "run.failed", errorClassification: "internal" },
    ]);
    expect(JSON.stringify(events)).not.toContain("executor-secret");
    expect(telemetry.finishes).toEqual([{ outcome: "failed", errorClassification: "internal" }]);
  });

  it("classifies validation performed by the configured executor after the stream starts", async () => {
    // Given
    const { lifecycle, telemetry } = createLifecycle({
      execute: () => {
        agentRunRequestSchema.parse({ message: " " });
        return agentRunEvents({ version: 1, type: "run.completed" });
      },
    });

    // When
    const events = await collectEvents(lifecycle.events);

    // Then
    expect(events).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_lifecycle" },
      { version: 1, type: "run.failed", errorClassification: "validation" },
    ]);
    expect(telemetry.finishes).toEqual([{ outcome: "failed", errorClassification: "validation" }]);
  });

  it("ends premature or malformed executor output with one internal failure", async () => {
    // Given
    const executors = [
      unsafeAgentRunExecutor(emptyAsyncIterable()),
      unsafeAgentRunExecutor(
        asyncIterableFrom([
          {
            version: 1,
            type: "run.failed",
            errorClassification: "provider",
            error: "executor-secret",
          },
        ]),
      ),
    ];

    // When
    const results = await Promise.all(
      executors.map(async (agentRunExecutor) => {
        const { lifecycle, telemetry } = createLifecycle(agentRunExecutor);
        return {
          events: await collectEvents(lifecycle.events),
          telemetry,
        };
      }),
    );

    // Then
    expect(results.map((result) => result.events)).toEqual([
      [
        { version: 1, type: "run.started", agentRunId: "ar_lifecycle" },
        { version: 1, type: "run.failed", errorClassification: "internal" },
      ],
      [
        { version: 1, type: "run.started", agentRunId: "ar_lifecycle" },
        { version: 1, type: "run.failed", errorClassification: "internal" },
      ],
    ]);
    expect(JSON.stringify(results.map((result) => result.events))).not.toContain("executor-secret");
    expect(results.map((result) => result.telemetry.finishes)).toEqual([
      [{ outcome: "failed", errorClassification: "internal" }],
      [{ outcome: "failed", errorClassification: "internal" }],
    ]);
  });

  it("keeps exactly one terminal event when the executor attempts duplicate termination", async () => {
    // Given
    const { lifecycle, telemetry } = createLifecycle({
      execute: () =>
        agentRunEvents(
          { version: 1, type: "run.completed" },
          { version: 1, type: "run.failed", errorClassification: "internal" },
        ),
    });

    // When
    const events = await collectEvents(lifecycle.events);

    // Then
    expect(events).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_lifecycle" },
      { version: 1, type: "run.completed" },
    ]);
    expect(telemetry.finishes).toEqual([{ outcome: "succeeded" }]);
  });

  it("keeps the terminal decision when executor cleanup fails after termination", async () => {
    // Given
    const { lifecycle, telemetry } = createLifecycle({
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
    });

    // When
    const events = await collectEvents(lifecycle.events);

    // Then
    expect(events).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_lifecycle" },
      { version: 1, type: "run.completed" },
    ]);
    expect(JSON.stringify(events)).not.toContain("executor-secret");
    expect(telemetry.finishes).toEqual([{ outcome: "succeeded" }]);
  });

  it("releases the request abort listener after execution settles", async () => {
    // Given
    const requestCancellation = new AbortController();
    const addedAbortListeners: EventListenerOrEventListenerObject[] = [];
    const addEventListener = vi.spyOn(requestCancellation.signal, "addEventListener");
    const removeEventListener = vi.spyOn(requestCancellation.signal, "removeEventListener");
    addEventListener.mockImplementation((type, listener, options) => {
      if (type === "abort" && listener !== null) {
        addedAbortListeners.push(listener);
      }

      return EventTarget.prototype.addEventListener.call(
        requestCancellation.signal,
        type,
        listener,
        options,
      );
    });
    removeEventListener.mockImplementation((type, listener, options) =>
      EventTarget.prototype.removeEventListener.call(
        requestCancellation.signal,
        type,
        listener,
        options,
      ),
    );
    const { lifecycle, telemetry } = createLifecycle(
      {
        execute: () => agentRunEvents({ version: 1, type: "run.completed" }),
      },
      { signal: requestCancellation.signal },
    );

    // When
    const events = await collectEvents(lifecycle.events);

    // Then
    expect(events.at(-1)).toEqual({ version: 1, type: "run.completed" });
    expect(addedAbortListeners).toHaveLength(1);
    expect(removeEventListener).toHaveBeenCalledWith("abort", addedAbortListeners[0]);

    requestCancellation.abort();
    expect(telemetry.cancellationRequests).toBe(0);
    expect(telemetry.finishes).toEqual([{ outcome: "succeeded" }]);
  });

  it("records confirmed request cancellation only after executor cleanup stops", async () => {
    // Given
    vi.useFakeTimers();
    const requestCancellation = new AbortController();
    let cleanupStarted = false;
    let stopped = false;
    let resolveSignal!: (signal: AbortSignal) => void;
    const receivedSignal = new Promise<AbortSignal>((resolve) => {
      resolveSignal = resolve;
    });
    const { lifecycle, telemetry } = createLifecycle(
      hangingAgentRunExecutor({
        onSignal: resolveSignal,
        onCleanup: () => {
          cleanupStarted = true;
        },
        cleanup: () =>
          resolveCleanupAfter(19, () => {
            stopped = true;
          }),
      }),
      {
        cancellationConfirmationTimeoutMs: 20,
        signal: requestCancellation.signal,
      },
    );
    const eventsPromise = collectEvents(lifecycle.events);
    const executorSignal = await receivedSignal;

    // When
    requestCancellation.abort();
    await vi.advanceTimersByTimeAsync(19);
    const events = await eventsPromise;

    // Then
    expect(executorSignal.aborted).toBe(true);
    expect(cleanupStarted).toBe(true);
    expect(stopped).toBe(true);
    expect(events).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_lifecycle" },
      { version: 1, type: "run.cancelled" },
    ]);
    expect(telemetry.cancellationRequests).toBe(1);
    expect(telemetry.finishes).toEqual([{ outcome: "cancelled" }]);
  });

  it("confirms lifecycle cancellation through the same cleanup path", async () => {
    // Given
    vi.useFakeTimers();
    let resolveSignal!: (signal: AbortSignal) => void;
    const receivedSignal = new Promise<AbortSignal>((resolve) => {
      resolveSignal = resolve;
    });
    const { lifecycle, telemetry } = createLifecycle(
      hangingAgentRunExecutor({
        onSignal: resolveSignal,
        cleanup: () => resolveCleanupAfter(19),
      }),
      { cancellationConfirmationTimeoutMs: 20 },
    );
    const eventsPromise = collectEvents(lifecycle.events);
    const executorSignal = await receivedSignal;

    // When
    const cancellation = lifecycle.cancel();
    await vi.advanceTimersByTimeAsync(19);
    await cancellation;
    const events = await eventsPromise;

    // Then
    expect(executorSignal.aborted).toBe(true);
    expect(events).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_lifecycle" },
      { version: 1, type: "run.cancelled" },
    ]);
    expect(telemetry.cancellationRequests).toBe(1);
    expect(telemetry.finishes).toEqual([{ outcome: "cancelled" }]);
  });

  it("fails cancellation when executor work does not confirm before the deadline", async () => {
    // Given
    vi.useFakeTimers();
    let returnCalled = false;
    const { lifecycle, telemetry } = createLifecycle(
      hangingAgentRunExecutor({
        onCleanup: () => {
          returnCalled = true;
        },
        cleanup: neverSettlingExecutorResult,
      }),
      { cancellationConfirmationTimeoutMs: 20 },
    );
    const eventsPromise = collectEvents(lifecycle.events);

    // When
    const cancellation = lifecycle.cancel();
    await vi.advanceTimersByTimeAsync(20);
    await cancellation;
    const events = await eventsPromise;

    // Then
    expect(returnCalled).toBe(true);
    expect(events).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_lifecycle" },
      { version: 1, type: "run.failed", errorClassification: "cancellation_failed" },
    ]);
    expect(telemetry.cancellationRequests).toBe(1);
    expect(telemetry.finishes).toEqual([
      { outcome: "failed", errorClassification: "cancellation_failed" },
    ]);
  });

  it("fails cancellation when executor work lacks a cleanup hook and does not stop", async () => {
    // Given
    vi.useFakeTimers();
    const { lifecycle, telemetry } = createLifecycle(hangingAgentRunExecutor(), {
      cancellationConfirmationTimeoutMs: 20,
    });
    const eventsPromise = collectEvents(lifecycle.events);

    // When
    const cancellation = lifecycle.cancel();
    await vi.advanceTimersByTimeAsync(20);
    await cancellation;
    const events = await eventsPromise;

    // Then
    expect(events).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_lifecycle" },
      { version: 1, type: "run.failed", errorClassification: "cancellation_failed" },
    ]);
    expect(telemetry.finishes).toEqual([
      { outcome: "failed", errorClassification: "cancellation_failed" },
    ]);
  });

  it("fails cancellation when executor cleanup rejects before the deadline", async () => {
    // Given
    vi.useFakeTimers();
    const { lifecycle, telemetry } = createLifecycle(
      hangingAgentRunExecutor({
        cleanup: () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error("executor-secret")), 10);
          }),
      }),
      { cancellationConfirmationTimeoutMs: 20 },
    );
    const eventsPromise = collectEvents(lifecycle.events);

    // When
    const cancellation = lifecycle.cancel();
    await vi.advanceTimersByTimeAsync(10);
    await cancellation;
    const events = await eventsPromise;

    // Then
    expect(events).toEqual([
      { version: 1, type: "run.started", agentRunId: "ar_lifecycle" },
      { version: 1, type: "run.failed", errorClassification: "cancellation_failed" },
    ]);
    expect(JSON.stringify(events)).not.toContain("executor-secret");
    expect(telemetry.finishes).toEqual([
      { outcome: "failed", errorClassification: "cancellation_failed" },
    ]);
  });
});
