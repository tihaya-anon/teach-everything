import type { AgentRunExecutor } from "@teach-everything/agent";
import {
  createAgentRunTelemetry,
  runDiagnosticTelemetrySafely,
  type Logger,
  type AgentRunTelemetry,
} from "@teach-everything/observability";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { BlankEnv, ExtractSchema } from "hono/types";
import { logger as defaultLogger } from "./logger";
import { invalidAgentRunRequestResponse, registerAgentRunRoutes } from "./routes/agent-runs";
import { registerHealthRoutes } from "./routes/health";

export interface CreateAppOptions {
  agentRunExecutor?: AgentRunExecutor;
  createAgentRunId?: () => string;
  logger?: Logger;
}

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
    if (error instanceof HTTPException && error.status === 400) {
      return invalidAgentRunRequestResponse(c);
    }

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

  const appWithHealthRoute = registerHealthRoutes(baseApp);

  if (agentRunExecutor) {
    return registerAgentRunRoutes(appWithHealthRoute, {
      agentRunExecutor,
      agentRunTelemetry,
      createAgentRunId,
    });
  }

  return appWithHealthRoute;
};

export const app = createApp();

type AppWithHealthRoute = ReturnType<typeof registerHealthRoutes<Hono>>;
type AppWithAgentRunRoute = ReturnType<typeof registerAgentRunRoutes<AppWithHealthRoute>>;
type AppSchema = ExtractSchema<typeof app> & ExtractSchema<AppWithAgentRunRoute>;

export type AppType = Hono<BlankEnv, AppSchema>;
