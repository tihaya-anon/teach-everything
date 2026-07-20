import type { AgentRunExecutor } from "@teach-everything/agent";
import {
  createAgentRunTelemetry,
  runDiagnosticTelemetrySafely,
  type AgentRunTelemetry,
  type Logger,
} from "@teach-everything/observability";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { BlankEnv, ExtractSchema } from "hono/types";
import developmentProfileDocument from "../../../profiles/runtime-development.json";
import {
  DEFAULT_DEVELOPMENT_AGENT_BEHAVIOR_VERSION,
  validateAgentBehaviorVersionAcceptanceConfig,
  type AgentBehaviorVersionAcceptanceConfig,
} from "./agent-run-behavior";
import { logger as defaultLogger } from "./logger";
import { invalidAgentRunRequestResponse, registerAgentRunRoutes } from "./routes/agent-runs";
import { registerHealthRoutes } from "./routes/health";

const defaultAgentBehaviorVersionAcceptance = {
  agentBehaviorVersion: DEFAULT_DEVELOPMENT_AGENT_BEHAVIOR_VERSION,
  runtimeProfile: developmentProfileDocument,
} satisfies AgentBehaviorVersionAcceptanceConfig;

export interface CreateAppOptions {
  agentBehaviorVersionAcceptance?: AgentBehaviorVersionAcceptanceConfig;
  agentRunExecutor?: AgentRunExecutor;
  createAgentRunId?: () => string;
  logger?: Logger;
}

export const createApp = ({
  agentBehaviorVersionAcceptance = defaultAgentBehaviorVersionAcceptance,
  agentRunExecutor,
  createAgentRunId = crypto.randomUUID,
  logger = defaultLogger,
}: CreateAppOptions = {}) => {
  const validatedAgentBehaviorVersionAcceptance = validateAgentBehaviorVersionAcceptanceConfig(
    agentBehaviorVersionAcceptance,
  );
  const baseApp = new Hono();
  const agentRunTelemetry: AgentRunTelemetry = createAgentRunTelemetry({ logger });

  // Request logging stays outside route handlers so every route gets consistent metadata.
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
    // Hono validators throw HTTPException; normalize them to the public Agent Run error shape.
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
      agentBehaviorVersionAcceptance: validatedAgentBehaviorVersionAcceptance,
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
