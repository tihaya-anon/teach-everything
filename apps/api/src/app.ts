import { AgentRunExecutionError, type AgentRunExecutor } from "@teach-everything/agent";
import {
  createAgentRunTelemetry,
  runDiagnosticTelemetrySafely,
  type AgentRunErrorClassification,
  type AgentRunTelemetryScope,
  type Logger,
  type AgentRunTelemetry,
  type AgentRunTerminalOutcome,
} from "@teach-everything/observability";
import {
  agentRunErrorClassificationSchema,
  agentRunExecutorEventSchema,
  agentRunRequestSchema,
  encodeAgentRunEventLine,
  healthResponseSchema,
  isAgentRunValidationError,
  type AgentRunEvent,
  type AgentRunExecutorEvent,
} from "@teach-everything/shared";
import { Hono } from "hono";
import { logger as defaultLogger } from "./logger";

export interface CreateAppOptions {
  agentRunExecutor?: AgentRunExecutor;
  createAgentRunId?: () => string;
  logger?: Logger;
}

const defaultCancellationConfirmationTimeoutMs = 10_000;

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

const isTerminalEvent = (event: AgentRunEvent): event is TerminalAgentRunEvent =>
  event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled";

const terminalTelemetryOutcome = (event: TerminalAgentRunEvent): AgentRunTerminalOutcome => {
  if (event.type === "run.failed") {
    return { outcome: "failed", errorClassification: event.errorClassification };
  }

  return { outcome: event.type === "run.completed" ? "succeeded" : "cancelled" };
};

const failureEvent = (errorClassification: AgentRunErrorClassification): TerminalAgentRunEvent => ({
  version: 1 as const,
  type: "run.failed" as const,
  errorClassification,
});

const createExecutionCancellation = (requestSignal: AbortSignal) => {
  const controller = new AbortController();
  const cancel = (reason?: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const cancelForRequestAbort = () => cancel(requestSignal.reason);

  if (requestSignal.aborted) cancelForRequestAbort();
  else requestSignal.addEventListener("abort", cancelForRequestAbort, { once: true });

  return {
    cancel,
    release: () => requestSignal.removeEventListener("abort", cancelForRequestAbort),
    signal: controller.signal,
  };
};

const createAgentRunStream = (
  executor: AgentRunExecutor,
  agentRunId: string,
  input: ReturnType<typeof agentRunRequestSchema.parse>,
  requestSignal: AbortSignal,
  telemetryScope: AgentRunTelemetryScope,
) => {
  const encoder = new TextEncoder();
  let completion: Promise<void> = Promise.resolve();
  let markStreamClosed: () => void = () => {};
  let requestCancellation: (reason?: unknown) => void = () => {};

  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      let terminal = false;
      let cancellationRequested = false;
      let cancellationDeadline: Promise<"deadline"> | undefined;
      let cancellationDeadlineTimeout: ReturnType<typeof setTimeout> | undefined;
      let cleanupConfirmation: Promise<"cleanup" | "cleanup_failed"> | undefined;
      let iterator: AsyncIterator<AgentRunExecutorEvent> | undefined;
      let streamOpen = true;
      let resolveCancellationRequested: () => void = () => {};
      const cancellationRequestedPromise = new Promise<"cancellation-requested">((resolve) => {
        resolveCancellationRequested = () => resolve("cancellation-requested");
      });
      const executionCancellation = createExecutionCancellation(requestSignal);

      markStreamClosed = () => {
        streamOpen = false;
      };
      const send = (event: AgentRunEvent) => {
        if (!streamOpen) return;
        try {
          controller.enqueue(encoder.encode(encodeAgentRunEventLine(event)));
        } catch {
          streamOpen = false;
          requestCancellation(requestSignal.reason);
        }
      };
      const closeStream = () => {
        if (!streamOpen) return;
        streamOpen = false;
        try {
          controller.close();
        } catch {
          streamOpen = false;
        }
      };
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
        send(event);
        closeStream();
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
      const createNextExecutorResult = () =>
        iterator!.next().then(
          (result) => ({ result, type: "next" as const }),
          (error: unknown) => ({ error, type: "error" as const }),
        );
      const waitForCancellationConfirmation = async (
        initialNextExecutorResult: Promise<ExecutorNextResult>,
      ) => {
        const cleanup = getCleanupConfirmation();
        let cleanupConfirmed = cleanup === undefined;
        let executorConfirmed = false;
        let nextExecutorResult = initialNextExecutorResult;

        while (!cleanupConfirmed || !executorConfirmed) {
          const progress = await Promise.race([
            getCancellationDeadline(),
            ...(cleanupConfirmed || cleanup === undefined ? [] : [cleanup]),
            ...(executorConfirmed ? [] : [nextExecutorResult]),
          ]);

          if (progress === "deadline" || progress === "cleanup_failed") {
            return "failed" as const;
          }

          if (progress === "cleanup") {
            cleanupConfirmed = true;
            continue;
          }

          if (progress.type === "error") {
            return "failed" as const;
          }

          if (progress.result.done === true) {
            executorConfirmed = true;
            continue;
          }

          const parsedEvent = agentRunExecutorEventSchema.safeParse(progress.result.value);
          if (!parsedEvent.success) {
            return "failed" as const;
          }

          if (isTerminalEvent(parsedEvent.data)) {
            if (parsedEvent.data.type === "run.failed") {
              return "failed" as const;
            }

            executorConfirmed = true;
            continue;
          }

          nextExecutorResult = createNextExecutorResult();
        }

        return "confirmed" as const;
      };
      const requestExecutorCancellation = (reason?: unknown) => {
        if (terminal || cancellationRequested) return;
        cancellationRequested = true;
        telemetryScope.recordCancellationRequested();
        executionCancellation.cancel(reason);
        cancellationDeadline = new Promise((resolve) => {
          cancellationDeadlineTimeout = setTimeout(
            () => resolve("deadline"),
            defaultCancellationConfirmationTimeoutMs,
          );
        });
        void getCleanupConfirmation();
        resolveCancellationRequested();
      };
      const requestExecutorCancellationForRequestAbort = () =>
        requestExecutorCancellation(requestSignal.reason);
      const failCancellation = () => {
        terminate(failureEvent("cancellation_failed"));
      };
      const finishConfirmedCancellation = () => {
        terminate({ version: 1, type: "run.cancelled" });
      };
      const finishCancellationAfterConfirmation = (
        confirmation: Awaited<ReturnType<typeof waitForCancellationConfirmation>>,
      ) => {
        if (confirmation === "confirmed") {
          finishConfirmedCancellation();
          return;
        }

        failCancellation();
      };

      requestCancellation = requestExecutorCancellation;
      if (requestSignal.aborted) requestExecutorCancellationForRequestAbort();
      else {
        requestSignal.addEventListener("abort", requestExecutorCancellationForRequestAbort, {
          once: true,
        });
      }

      completion = telemetryScope.runInContext(async () => {
        try {
          send({ version: 1, type: "run.started", agentRunId });

          iterator = executor.execute(input, executionCancellation.signal)[Symbol.asyncIterator]();

          while (!terminal) {
            const nextExecutorResult = createNextExecutorResult();
            let executorResult = cancellationRequested
              ? await waitForCancellationConfirmation(nextExecutorResult)
              : await Promise.race([nextExecutorResult, cancellationRequestedPromise]);

            if (executorResult === "cancellation-requested") {
              executorResult = await waitForCancellationConfirmation(nextExecutorResult);
            }

            if (executorResult === "confirmed" || executorResult === "failed") {
              finishCancellationAfterConfirmation(executorResult);
              return;
            }

            if (cancellationRequested) {
              failCancellation();
              return;
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

            send(parsedEvent.data);
          }
        } catch (error) {
          if (cancellationRequested) {
            failCancellation();
            return;
          }

          terminate(failureEvent(getErrorClassification(error)));
        } finally {
          requestSignal.removeEventListener("abort", requestExecutorCancellationForRequestAbort);
          executionCancellation.release();
          markStreamClosed = () => {};
        }
      });
    },
    cancel: (reason) => {
      markStreamClosed();
      requestCancellation(reason);
      return completion;
    },
  });
};

export const createApp = ({
  agentRunExecutor,
  createAgentRunId = crypto.randomUUID,
  logger = defaultLogger,
}: CreateAppOptions = {}) => {
  const baseApp = new Hono();
  const agentRunTelemetry: AgentRunTelemetry = createAgentRunTelemetry({ logger });

  baseApp.use("*", async (c, next) => {
    const startedAt = performance.now();

    await next();

    runDiagnosticTelemetrySafely(() => {
      logger.info("HTTP request completed", {
        eventName: "http.server.request.completed",
        attributes: {
          "http.request.method": c.req.method,
          "http.response.status_code": c.res.status,
          "url.path": new URL(c.req.url).pathname,
          "server.request.duration_ms": performance.now() - startedAt,
        },
      });
    });
  });

  baseApp.onError((error, c) => {
    runDiagnosticTelemetrySafely(() => {
      logger.error("HTTP request failed", {
        error,
        eventName: "http.server.request.failed",
        attributes: {
          "http.request.method": c.req.method,
          "http.response.status_code": 500,
          "url.path": new URL(c.req.url).pathname,
        },
      });
    });

    return c.json({ success: false, message: "Internal server error" }, 500);
  });

  const appWithHealthRoute = baseApp.get("/api/health", (c) => {
    const response = healthResponseSchema.parse({
      success: true,
      message: "API is running",
      timestamp: new Date().toISOString(),
    });

    return c.json(response);
  });

  if (agentRunExecutor) {
    appWithHealthRoute.post("/api/agent-runs", async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ success: false, message: "Invalid Agent Run request" }, 400);
      }

      const parsedRequest = agentRunRequestSchema.safeParse(body);
      if (!parsedRequest.success) {
        return c.json({ success: false, message: "Invalid Agent Run request" }, 400);
      }

      const agentRunId = createAgentRunId();
      const telemetryScope = agentRunTelemetry.start(agentRunId);
      return new Response(
        createAgentRunStream(
          agentRunExecutor,
          agentRunId,
          parsedRequest.data,
          c.req.raw.signal,
          telemetryScope,
        ),
        {
          headers: {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "X-Agent-Run-Id": agentRunId,
          },
        },
      );
    });
  }

  return appWithHealthRoute;
};

export const app = createApp();

export type AppType = typeof app;
