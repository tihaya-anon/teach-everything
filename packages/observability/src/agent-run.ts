import {
  context,
  INVALID_SPAN_CONTEXT,
  metrics,
  SpanStatusCode,
  trace,
  type Context,
  type Histogram,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type { AgentRunErrorClassification, AgentRunOutcome } from "@teach-everything/shared";
import type { Logger } from "./logger";

export type { AgentRunErrorClassification, AgentRunOutcome } from "@teach-everything/shared";

export type AgentRunTerminalOutcome =
  | {
      outcome: Exclude<AgentRunOutcome, "failed">;
    }
  | {
      errorClassification: AgentRunErrorClassification;
      outcome: "failed";
    };

export type AgentRunTelemetryOptions = {
  instrumentationName?: string;
  instrumentationVersion?: string;
  logger: Logger;
};

export interface AgentRunTelemetry {
  start(agentRunId: string): AgentRunTelemetryScope;
}

export interface AgentRunTelemetryScope {
  recordCancellationRequested(): void;
  runInContext<T>(operation: () => T): T;
  finish(terminalOutcome: AgentRunTerminalOutcome): void;
}

const defaultInstrumentationName = "@teach-everything/observability/agent-run";

type AgentRunTerminalAttributes = {
  "agent.run.outcome": AgentRunOutcome;
  "error.type"?: AgentRunErrorClassification;
};

export const runDiagnosticTelemetrySafely = (operation: () => void) => {
  try {
    operation();
  } catch {
    // Diagnostic telemetry must not change application behavior.
  }
};

const tryOr = <T>(operation: () => T, fallback: T): T => {
  try {
    return operation();
  } catch {
    return fallback;
  }
};

const noopHistogram = {
  record: () => undefined,
} as Histogram;

const terminalAttributes = (
  terminalOutcome: AgentRunTerminalOutcome,
): AgentRunTerminalAttributes => ({
  "agent.run.outcome": terminalOutcome.outcome,
  ...(terminalOutcome.outcome === "failed"
    ? { "error.type": terminalOutcome.errorClassification }
    : {}),
});

class OpenTelemetryAgentRunTelemetryScope implements AgentRunTelemetryScope {
  private cancellationRequested = false;

  private finished = false;

  public constructor(
    private readonly agentRunId: string,
    private readonly logger: Logger,
    private readonly runContext: Context,
    private readonly runDuration: Histogram,
    private readonly span: Span,
    private readonly startedAt: number,
  ) {}

  public runInContext<T>(operation: () => T): T {
    return context.with(this.runContext, operation);
  }

  public recordCancellationRequested() {
    if (this.finished || this.cancellationRequested) return;
    this.cancellationRequested = true;

    this.runInContext(() => {
      runDiagnosticTelemetrySafely(() => {
        this.logger.child({ "agent.run.id": this.agentRunId }).info(
          "Agent Run cancellation requested",
          {
            eventName: "agent.run.cancellation_requested",
          },
        );
      });
    });
  }

  public finish(terminalOutcome: AgentRunTerminalOutcome) {
    if (this.finished) return;
    this.finished = true;

    const attributes = terminalAttributes(terminalOutcome);
    const durationSeconds = (performance.now() - this.startedAt) / 1_000;

    this.runInContext(() => {
      runDiagnosticTelemetrySafely(() => {
        this.span.setAttributes(attributes);
        if (terminalOutcome.outcome === "failed") {
          this.span.setStatus({ code: SpanStatusCode.ERROR });
        }
      });
      runDiagnosticTelemetrySafely(() => {
        this.runDuration.record(durationSeconds, attributes);
      });
      runDiagnosticTelemetrySafely(() => {
        const runLogger = this.logger.child({ "agent.run.id": this.agentRunId });
        if (terminalOutcome.outcome === "failed") {
          runLogger.error("Agent Run failed", {
            eventName: "agent.run.failed",
            attributes,
          });
          return;
        }

        runLogger.info(
          terminalOutcome.outcome === "succeeded" ? "Agent Run completed" : "Agent Run cancelled",
          {
            eventName:
              terminalOutcome.outcome === "succeeded"
                ? "agent.run.completed"
                : "agent.run.cancelled",
            attributes,
          },
        );
      });
      runDiagnosticTelemetrySafely(() => {
        this.span.end();
      });
    });
  }
}

class OpenTelemetryAgentRunTelemetry implements AgentRunTelemetry {
  private readonly runDuration: Histogram;

  private readonly tracer: Tracer;

  public constructor(private readonly options: AgentRunTelemetryOptions) {
    const instrumentationName = options.instrumentationName ?? defaultInstrumentationName;
    this.tracer = trace.getTracer(instrumentationName, options.instrumentationVersion);
    this.runDuration = tryOr(
      () =>
        metrics
          .getMeter(instrumentationName, options.instrumentationVersion)
          .createHistogram("agent.run.duration", {
            description: "Duration of an Agent Run",
            unit: "s",
          }),
      noopHistogram,
    );
  }

  public start(agentRunId: string): AgentRunTelemetryScope {
    const startedAt = performance.now();
    const span = tryOr(
      () =>
        this.tracer.startSpan("agent.run", {
          attributes: { "agent.run.id": agentRunId },
        }),
      trace.wrapSpanContext(INVALID_SPAN_CONTEXT),
    );
    const runContext = trace.setSpan(context.active(), span);
    const scope = new OpenTelemetryAgentRunTelemetryScope(
      agentRunId,
      this.options.logger,
      runContext,
      this.runDuration,
      span,
      startedAt,
    );

    scope.runInContext(() => {
      runDiagnosticTelemetrySafely(() => {
        this.options.logger.child({ "agent.run.id": agentRunId }).info("Agent Run accepted", {
          eventName: "agent.run.accepted",
        });
      });
    });

    return scope;
  }
}

export const createAgentRunTelemetry = (options: AgentRunTelemetryOptions): AgentRunTelemetry =>
  new OpenTelemetryAgentRunTelemetry(options);
