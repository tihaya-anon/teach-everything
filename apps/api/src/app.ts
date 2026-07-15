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

const createAgentRunStream = (
  executor: AgentRunExecutor,
  agentRunId: string,
  input: ReturnType<typeof agentRunRequestSchema.parse>,
  requestSignal: AbortSignal,
  telemetryScope: AgentRunTelemetryScope,
) => {
  const encoder = new TextEncoder();
  let clientWritable = true;
  let completion: Promise<void> = Promise.resolve();
  let requestCancellation: () => void = () => {};

  return new ReadableStream<Uint8Array>({
    start: (controller) => {
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

      const send = (event: AgentRunEvent) => {
        if (!clientWritable) return;
        try {
          controller.enqueue(encoder.encode(encodeAgentRunEventLine(event)));
        } catch {
          clientWritable = false;
          requestCancellation();
        }
      };
      const close = () => {
        if (!clientWritable) return;
        try {
          controller.close();
        } catch {
          clientWritable = false;
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
        close();
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
            defaultCancellationConfirmationTimeoutMs,
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
      requestSignal.addEventListener("abort", requestExecutorCancellation, { once: true });

      completion = telemetryScope.runInContext(async () => {
        try {
          send({ version: 1, type: "run.started", agentRunId });
          if (requestSignal.aborted) requestExecutorCancellation();

          iterator = executor.execute(input, executorCancellation.signal)[Symbol.asyncIterator]();

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

              const parsedEvent = agentRunExecutorEventSchema.safeParse(
                executorResult.result.value,
              );
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

            send(parsedEvent.data);
          }
        } catch (error) {
          if (cancellationRequested) {
            terminate({ version: 1, type: "run.cancelled" });
            return;
          }

          terminate(failureEvent(getErrorClassification(error)));
        } finally {
          requestSignal.removeEventListener("abort", requestExecutorCancellation);
        }
      });
    },
    cancel: () => {
      clientWritable = false;
      requestCancellation();
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
