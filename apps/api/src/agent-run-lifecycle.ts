import { AgentRunExecutionError, type AgentRunExecutor } from "@teach-everything/agent";
import {
  type AgentRunErrorClassification,
  type AgentRunTelemetryScope,
  type AgentRunTerminalOutcome,
} from "@teach-everything/observability";
import {
  agentRunErrorClassificationSchema,
  agentRunExecutorEventSchema,
  isAgentRunValidationError,
  type AgentRunEvent,
  type AgentRunExecutorEvent,
  type AgentRunRequest,
} from "@teach-everything/shared";
import { defaultAgentRunCancellationConfirmationTimeoutMs } from "./agent-run-lifecycle.defaults";

type TerminalAgentRunEvent = Extract<
  AgentRunEvent,
  { type: "run.completed" | "run.failed" | "run.cancelled" }
>;

type ExecutorNextResult =
  | {
      result: IteratorResult<AgentRunExecutorEvent>;
      type: "next";
    }
  | {
      error: unknown;
      type: "error";
    };

export type CreateAgentRunLifecycleOptions = {
  agentRunExecutor: AgentRunExecutor;
  agentRunId: string;
  cancellationConfirmationTimeoutMs?: number;
  input: AgentRunRequest;
  signal: AbortSignal;
  telemetryScope: AgentRunTelemetryScope;
};

export type AgentRunLifecycle = {
  cancel: () => Promise<void>;
  events: AsyncIterable<AgentRunEvent>;
};

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private closed = false;

  private readonly items: T[] = [];

  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];

  public close() {
    if (this.closed) return;
    this.closed = true;

    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  public enqueue(item: T) {
    if (this.closed) return;

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: item });
      return;
    }

    this.items.push(item);
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ done: false, value: item });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });

        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

const getErrorClassification = (error: unknown) => {
  if (error instanceof AgentRunExecutionError) {
    const parsedClassification = agentRunErrorClassificationSchema.safeParse(
      error.errorClassification,
    );
    return parsedClassification.success ? parsedClassification.data : "internal";
  }
  if (isAgentRunValidationError(error)) return "validation";
  return "internal";
};

const isTerminalEvent = (event: AgentRunEvent): event is TerminalAgentRunEvent =>
  event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled";

const terminalTelemetryOutcome = (event: TerminalAgentRunEvent): AgentRunTerminalOutcome => {
  if (event.type === "run.failed") {
    return { outcome: "failed", errorClassification: event.errorClassification };
  }

  return { outcome: event.type === "run.completed" ? "succeeded" : "cancelled" };
};

const failureEvent = (errorClassification: AgentRunErrorClassification): TerminalAgentRunEvent => ({
  version: 1,
  type: "run.failed",
  errorClassification,
});

export const createAgentRunLifecycle = ({
  agentRunExecutor,
  agentRunId,
  cancellationConfirmationTimeoutMs = defaultAgentRunCancellationConfirmationTimeoutMs,
  input,
  signal,
  telemetryScope,
}: CreateAgentRunLifecycleOptions): AgentRunLifecycle => {
  const events = new AsyncEventQueue<AgentRunEvent>();
  let completion: Promise<void> | undefined;
  let cancellationRequestedBeforeStart = false;
  let requestCancellation = () => {
    cancellationRequestedBeforeStart = true;
  };

  const start = () => {
    if (completion !== undefined) return completion;

    completion = telemetryScope.runInContext(async () => {
      let terminal = false;
      let cancellationRequested = false;
      let cancellationDeadline: Promise<"deadline"> | undefined;
      let cancellationDeadlineTimeout: ReturnType<typeof setTimeout> | undefined;
      let cleanupConfirmation: Promise<"cleanup" | "cleanup_failed"> | undefined;
      let iterator: AsyncIterator<AgentRunExecutorEvent> | undefined;
      let resolveCancellationRequested: () => void = () => {};
      const cancellationRequestedPromise = new Promise<"cancellation-requested">((resolve) => {
        resolveCancellationRequested = () => resolve("cancellation-requested");
      });
      const executorCancellation = new AbortController();

      const clearCancellationDeadline = () => {
        if (cancellationDeadlineTimeout === undefined) return;
        clearTimeout(cancellationDeadlineTimeout);
        cancellationDeadlineTimeout = undefined;
      };
      const terminate = (event: TerminalAgentRunEvent) => {
        if (terminal) return;
        terminal = true;
        clearCancellationDeadline();
        telemetryScope.finish(terminalTelemetryOutcome(event));
        events.enqueue(event);
        events.close();
      };
      const getCancellationDeadline = () => cancellationDeadline ?? Promise.resolve("deadline");
      const releaseIteratorSafely = async (
        runningIterator: AsyncIterator<AgentRunExecutorEvent>,
      ) => {
        try {
          await runningIterator.return?.();
        } catch {
          // Executor cleanup failures must not replace the terminal Agent Run outcome.
        }
      };
      const getCleanupConfirmation = () => {
        if (cleanupConfirmation !== undefined) return cleanupConfirmation;
        if (iterator?.return === undefined) return undefined;

        cleanupConfirmation = iterator.return().then(
          () => "cleanup" as const,
          () => "cleanup_failed" as const,
        );
        return cleanupConfirmation;
      };
      const raceCancellationConfirmation = (nextExecutorResult: Promise<ExecutorNextResult>) => {
        const cleanup = getCleanupConfirmation();
        return Promise.race(
          cleanup === undefined
            ? [nextExecutorResult, getCancellationDeadline()]
            : [nextExecutorResult, cleanup, getCancellationDeadline()],
        );
      };
      const requestExecutorCancellation = () => {
        if (terminal || cancellationRequested) return;
        cancellationRequested = true;
        telemetryScope.recordCancellationRequested();
        executorCancellation.abort();
        cancellationDeadline = new Promise((resolve) => {
          cancellationDeadlineTimeout = setTimeout(
            () => resolve("deadline"),
            cancellationConfirmationTimeoutMs,
          );
        });
        void getCleanupConfirmation();
        resolveCancellationRequested();
      };
      const failCancellation = () => {
        terminate(failureEvent("cancellation_failed"));
      };
      const finishConfirmedCancellation = () => {
        terminate({ version: 1, type: "run.cancelled" });
      };
      const finishCancellationAfterCleanup = async () => {
        const cleanup = getCleanupConfirmation();
        if (cleanup === undefined) {
          finishConfirmedCancellation();
          return;
        }

        const cleanupResult = await Promise.race([cleanup, getCancellationDeadline()]);
        if (cleanupResult === "deadline" || cleanupResult === "cleanup_failed") {
          failCancellation();
          return;
        }

        finishConfirmedCancellation();
      };

      requestCancellation = requestExecutorCancellation;
      signal.addEventListener("abort", requestExecutorCancellation, { once: true });

      try {
        events.enqueue({ version: 1, type: "run.started", agentRunId });
        if (signal.aborted || cancellationRequestedBeforeStart) requestExecutorCancellation();

        iterator = agentRunExecutor
          .execute(input, executorCancellation.signal)
          [Symbol.asyncIterator]();

        while (!terminal) {
          const nextExecutorResult: Promise<ExecutorNextResult> = iterator.next().then(
            (result) => ({ result, type: "next" as const }),
            (error: unknown) => ({ error, type: "error" as const }),
          );
          let executorResult = cancellationRequested
            ? await raceCancellationConfirmation(nextExecutorResult)
            : await Promise.race([nextExecutorResult, cancellationRequestedPromise]);

          if (executorResult === "cancellation-requested") {
            executorResult = await raceCancellationConfirmation(nextExecutorResult);
          }

          if (executorResult === "deadline") {
            failCancellation();
            return;
          }

          if (executorResult === "cleanup_failed") {
            failCancellation();
            return;
          }

          if (executorResult === "cleanup") {
            finishConfirmedCancellation();
            return;
          }

          if (cancellationRequested) {
            if (executorResult.type === "error" || executorResult.result.done === true) {
              await finishCancellationAfterCleanup();
              return;
            }

            const parsedEvent = agentRunExecutorEventSchema.safeParse(executorResult.result.value);
            if (parsedEvent.success && isTerminalEvent(parsedEvent.data)) {
              await finishCancellationAfterCleanup();
              return;
            }

            continue;
          }

          if (executorResult.type === "error") {
            terminate(failureEvent(getErrorClassification(executorResult.error)));
            return;
          }

          if (executorResult.result.done === true) {
            terminate(failureEvent("internal"));
            return;
          }

          const executorEvent = executorResult.result.value;
          const parsedEvent = agentRunExecutorEventSchema.safeParse(executorEvent);
          if (!parsedEvent.success) {
            if (iterator !== undefined) void releaseIteratorSafely(iterator);
            terminate(failureEvent("internal"));
            return;
          }

          if (isTerminalEvent(parsedEvent.data)) {
            if (iterator !== undefined) void releaseIteratorSafely(iterator);
            terminate(parsedEvent.data);
            return;
          }

          events.enqueue(parsedEvent.data);
        }
      } catch (error) {
        if (cancellationRequested) {
          terminate({ version: 1, type: "run.cancelled" });
          return;
        }

        terminate(failureEvent(getErrorClassification(error)));
      } finally {
        signal.removeEventListener("abort", requestExecutorCancellation);
        if (!terminal) events.close();
      }
    });

    return completion;
  };

  return {
    cancel: async () => {
      requestCancellation();
      await start();
    },
    events: {
      [Symbol.asyncIterator]: () => {
        void start();
        return events[Symbol.asyncIterator]();
      },
    },
  };
};
