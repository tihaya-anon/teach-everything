import { Hono } from "hono";
import { healthResponseSchema } from "@teach-everything/shared";
import { logger } from "./logger";

const baseApp = new Hono();

baseApp.use("*", async (c, next) => {
  const startedAt = performance.now();

  await next();

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

baseApp.onError((error, c) => {
  logger.error("HTTP request failed", {
    error,
    eventName: "http.server.request.failed",
    attributes: {
      "http.request.method": c.req.method,
      "http.response.status_code": 500,
      "url.path": new URL(c.req.url).pathname,
    },
  });

  return c.json({ success: false, message: "Internal server error" }, 500);
});

export const app = baseApp.get("/api/health", (c) => {
  const response = healthResponseSchema.parse({
    success: true,
    message: "API is running",
    timestamp: new Date().toISOString(),
  });

  return c.json(response);
});

export type AppType = typeof app;
