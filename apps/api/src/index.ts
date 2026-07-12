import { serve } from "@hono/node-server";
import { app } from "./app";
import { telemetry } from "./instrumentation";
import { logger } from "./logger";

const port = Number(process.env.PORT ?? 3000);

const server = serve({ fetch: app.fetch, port }, (info) => {
  logger.info("API server started", {
    eventName: "server.started",
    attributes: {
      "server.address": "localhost",
      "server.port": info.port,
      "telemetry.enabled": telemetry.enabled,
    },
  });
});

let shutdownPromise: Promise<void> | undefined;

const closeServer = () =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

const shutdown = (signal: NodeJS.Signals) => {
  shutdownPromise ??= (async () => {
    logger.info("API server stopping", {
      eventName: "server.stopping",
      attributes: { "process.signal": signal },
    });
    const errors: unknown[] = [];

    try {
      await closeServer();
    } catch (error) {
      errors.push(error);
    }

    const cleanupResults = await Promise.allSettled([telemetry.shutdown(), logger.shutdown()]);
    for (const result of cleanupResults) {
      if (result.status === "rejected") errors.push(result.reason);
    }

    if (errors.length > 0) throw new AggregateError(errors, "API shutdown failed");
  })();

  return shutdownPromise;
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal)
      .catch((error: unknown) => {
        process.stderr.write(`API shutdown failed: ${String(error)}\n`);
        process.exitCode = 1;
      })
      .finally(() => process.exit(process.exitCode ?? 0));
  });
}
