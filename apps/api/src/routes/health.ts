import { healthResponseSchema } from "@teach-everything/shared";
import type { Context, Hono } from "hono";

const getHealth = (c: Context) => {
  const response = healthResponseSchema.parse({
    success: true,
    message: "API is running",
    timestamp: new Date().toISOString(),
  });

  return c.json(response);
};

export const registerHealthRoutes = <App extends Hono>(app: App) =>
  app.get("/api/health", getHealth);
