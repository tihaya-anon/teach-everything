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
} from "@teach-everything/shared";
import { Hono } from "hono";
import { logger as defaultLogger } from "./logger";

export interface CreateAppOptions {
  agentRunExecutor?: AgentRunExecutor;
  createAgentRunId?: () => string;
  logger?: Logger;
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

type TerminalAgentRunEvent = Extract<
  AgentRunEvent,
  { type: "run.completed" | "run.failed" | "run.cancelled" }
>;

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
  let cancelExecution: ((reason?: unknown) => void) | undefined;
  let markStreamClosed: (() => void) | undefined;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let terminal = false;
      let streamOpen = true;
      const cancellation = createExecutionCancellation(requestSignal);
      cancelExecution = cancellation.cancel;
      markStreamClosed = () => {
        streamOpen = false;
      };
      const closeStream = () => {
        if (!streamOpen) return;
        streamOpen = false;
        controller.close();
      };
      const send = (event: AgentRunEvent) => {
        if (!streamOpen) return;
        controller.enqueue(encoder.encode(encodeAgentRunEventLine(event)));
      };
      const terminate = (event: TerminalAgentRunEvent) => {
        if (terminal) return;
        terminal = true;
        telemetryScope.finish(terminalTelemetryOutcome(event));
        send(event);
        closeStream();
      };

      telemetryScope.runInContext(() => {
        send({ version: 1, type: "run.started", agentRunId });
      });

      await telemetryScope.runInContext(async () => {
        try {
          for await (const executorEvent of executor.execute(input, cancellation.signal)) {
            if (cancellation.signal.aborted) return;

            const parsedEvent = agentRunExecutorEventSchema.safeParse(executorEvent);
            if (!parsedEvent.success) {
              terminate(failureEvent("internal"));
              return;
            }

            if (isTerminalEvent(parsedEvent.data)) {
              terminate(parsedEvent.data);
              return;
            }

            send(parsedEvent.data);
          }

          if (cancellation.signal.aborted) return;
          terminate(failureEvent("internal"));
        } catch (error) {
          if (cancellation.signal.aborted) return;
          terminate(failureEvent(getErrorClassification(error)));
        } finally {
          cancellation.release();
          cancelExecution = undefined;
          markStreamClosed = undefined;
          if (cancellation.signal.aborted) closeStream();
        }
      });
    },
    cancel() {
      markStreamClosed?.();
      cancelExecution?.(requestSignal.reason);
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
