import { Hono } from "hono";
import { healthResponseSchema } from "@teach-everything/shared";

export const app = new Hono().get("/api/health", (c) => {
  const response = healthResponseSchema.parse({
    success: true,
    message: "API is running",
    timestamp: new Date().toISOString(),
  });

  return c.json(response);
});

export type AppType = typeof app;
