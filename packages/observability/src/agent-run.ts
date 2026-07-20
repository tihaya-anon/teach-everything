import {
  OpenInferenceSpanKind,
  SemanticConventions,
} from "@arizeai/openinference-semantic-conventions";
import {
  context,
  INVALID_SPAN_CONTEXT,
  metrics,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Histogram,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type {
  AgentRunErrorClassification,
  AgentRunOutcome,
  DevelopmentAgentBehaviorVersion,
  StrictAgentBehaviorVersion,
} from "@teach-everything/shared";
import type { LogAttributes, Logger } from "./logger";

export type { AgentRunErrorClassification, AgentRunOutcome } from "@teach-everything/shared";

export type AgentRunTerminalOutcome =
  | {
      outcome: Exclude<AgentRunOutcome, "failed">;
    }
  | {
      errorClassification: AgentRunErrorClassification;
      outcome: "failed";
    };

export type AgentRunAcceptedTelemetry = {
  agentBehaviorVersion: StrictAgentBehaviorVersion | DevelopmentAgentBehaviorVersion;
  comparable: boolean;
  promotable: boolean;
  runtimeProfileId: string;
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
  recordAccepted(acceptedTelemetry: AgentRunAcceptedTelemetry): void;
  recordCancellationRequested(): void;
  runInContext<T>(operation: () => T): T;
  finish(terminalOutcome: AgentRunTerminalOutcome): void;
}

const DEFAULT_INSTRUMENTATION_NAME = "@teach-everything/observability/agent-run";

const AGENT_RUN_OUTCOME_ATTRIBUTE = `${SemanticConventions.METADATA}.agent_run.outcome` as const;
const AGENT_RUN_COMPARABLE_ATTRIBUTE =
  `${SemanticConventions.METADATA}.agent_run.comparable` as const;
const AGENT_RUN_PROMOTABLE_ATTRIBUTE =
  `${SemanticConventions.METADATA}.agent_run.promotable` as const;
const AGENT_BEHAVIOR_GRAPH_ATTRIBUTE =
  `${SemanticConventions.METADATA}.agent_behavior_version.graph` as const;
const AGENT_BEHAVIOR_STATE_ATTRIBUTE =
  `${SemanticConventions.METADATA}.agent_behavior_version.state` as const;
const AGENT_BEHAVIOR_ACTION_ATTRIBUTE =
  `${SemanticConventions.METADATA}.agent_behavior_version.action` as const;
const AGENT_BEHAVIOR_PROMPT_ATTRIBUTE =
  `${SemanticConventions.METADATA}.agent_behavior_version.prompt` as const;
const AGENT_BEHAVIOR_TOOL_ATTRIBUTE =
  `${SemanticConventions.METADATA}.agent_behavior_version.tool` as const;
const AGENT_BEHAVIOR_MODEL_ATTRIBUTE =
  `${SemanticConventions.METADATA}.agent_behavior_version.model` as const;
const AGENT_BEHAVIOR_TRIAL_PARAMETER_ATTRIBUTE =
  `${SemanticConventions.METADATA}.agent_behavior_version.trial_parameter` as const;
const RUNTIME_PROFILE_ID_ATTRIBUTE = `${SemanticConventions.METADATA}.runtime_profile.id` as const;
const SOURCE_REVISION_ATTRIBUTE = `${SemanticConventions.METADATA}.source_revision` as const;

type AgentRunTerminalAttributes = {
  [AGENT_RUN_OUTCOME_ATTRIBUTE]: AgentRunOutcome;
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

const NOOP_HISTOGRAM = {
  record: () => undefined,
} as Histogram;

const terminalAttributes = (
  terminalOutcome: AgentRunTerminalOutcome,
): AgentRunTerminalAttributes => {
  const attributes: AgentRunTerminalAttributes = {
    [AGENT_RUN_OUTCOME_ATTRIBUTE]: terminalOutcome.outcome,
  };

  if (terminalOutcome.outcome === "failed") {
    attributes["error.type"] = terminalOutcome.errorClassification;
  }

  return attributes;
};

const setIfPresent = (
  attributes: LogAttributes,
  attributeName: string,
  value: string | undefined,
) => {
  if (value !== undefined) attributes[attributeName] = value;
};

const acceptedTelemetryAttributes = ({
  agentBehaviorVersion,
  comparable,
  promotable,
  runtimeProfileId,
}: AgentRunAcceptedTelemetry): LogAttributes => {
  const attributes: LogAttributes = {
    [AGENT_RUN_COMPARABLE_ATTRIBUTE]: comparable,
    [AGENT_RUN_PROMOTABLE_ATTRIBUTE]: promotable,
    [RUNTIME_PROFILE_ID_ATTRIBUTE]: runtimeProfileId,
  };

  setIfPresent(attributes, AGENT_BEHAVIOR_GRAPH_ATTRIBUTE, agentBehaviorVersion.graph);
  setIfPresent(attributes, AGENT_BEHAVIOR_STATE_ATTRIBUTE, agentBehaviorVersion.state);
  setIfPresent(attributes, AGENT_BEHAVIOR_ACTION_ATTRIBUTE, agentBehaviorVersion.action);
  setIfPresent(attributes, AGENT_BEHAVIOR_PROMPT_ATTRIBUTE, agentBehaviorVersion.prompt);
  setIfPresent(attributes, AGENT_BEHAVIOR_TOOL_ATTRIBUTE, agentBehaviorVersion.tool);
  setIfPresent(attributes, AGENT_BEHAVIOR_MODEL_ATTRIBUTE, agentBehaviorVersion.model);
  setIfPresent(
    attributes,
    AGENT_BEHAVIOR_TRIAL_PARAMETER_ATTRIBUTE,
    agentBehaviorVersion.trialParameter,
  );
  setIfPresent(attributes, SOURCE_REVISION_ATTRIBUTE, agentBehaviorVersion.sourceRevision);

  return attributes;
};

class OpenTelemetryAgentRunTelemetryScope implements AgentRunTelemetryScope {
  private acceptedAttributes: LogAttributes = {};

  private accepted = false;

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

  public recordAccepted(acceptedTelemetry: AgentRunAcceptedTelemetry) {
    if (this.finished || this.accepted) return;
    this.accepted = true;
    this.acceptedAttributes = acceptedTelemetryAttributes(acceptedTelemetry);

    this.runInContext(() => {
      runDiagnosticTelemetrySafely(() => {
        this.span.setAttributes(this.acceptedAttributes as Attributes);
      });
      runDiagnosticTelemetrySafely(() => {
        this.runLogger().info("Agent Run accepted", {
          eventName: "agent.run.accepted",
        });
      });
    });
  }

  public recordCancellationRequested() {
    if (this.finished || this.cancellationRequested) return;
    this.cancellationRequested = true;

    this.runInContext(() => {
      runDiagnosticTelemetrySafely(() => {
        this.runLogger().info("Agent Run cancellation requested", {
          eventName: "agent.run.cancellation_requested",
        });
      });
    });
  }

  public finish(terminalOutcome: AgentRunTerminalOutcome) {
    // Terminal telemetry is idempotent because lifecycle cancellation can race stream cleanup.
    if (this.finished) return;
    this.finished = true;

    const attributes = terminalAttributes(terminalOutcome);
    const logAndSpanAttributes = {
      ...this.acceptedAttributes,
      ...attributes,
    };
    const durationSeconds = (performance.now() - this.startedAt) / 1_000;

    this.runInContext(() => {
      runDiagnosticTelemetrySafely(() => {
        this.span.setAttributes(logAndSpanAttributes as Attributes);
        if (terminalOutcome.outcome === "failed") {
          this.span.setStatus({ code: SpanStatusCode.ERROR });
        }
      });
      runDiagnosticTelemetrySafely(() => {
        this.runDuration.record(durationSeconds, attributes);
      });
      runDiagnosticTelemetrySafely(() => {
        const runLogger = this.runLogger();
        if (terminalOutcome.outcome === "failed") {
          const cancellationFailed = terminalOutcome.errorClassification === "cancellation_failed";

          runLogger.error(
            cancellationFailed ? "Agent Run cancellation failed" : "Agent Run failed",
            {
              eventName: cancellationFailed ? "agent.run.cancellation_failed" : "agent.run.failed",
              attributes,
            },
          );
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

  private runLogger() {
    return this.logger.child({
      [SemanticConventions.SESSION_ID]: this.agentRunId,
      ...this.acceptedAttributes,
    });
  }
}

class OpenTelemetryAgentRunTelemetry implements AgentRunTelemetry {
  private readonly runDuration: Histogram;

  private readonly tracer: Tracer;

  public constructor(private readonly options: AgentRunTelemetryOptions) {
    const instrumentationName = options.instrumentationName ?? DEFAULT_INSTRUMENTATION_NAME;
    this.tracer = trace.getTracer(instrumentationName, options.instrumentationVersion);
    this.runDuration = tryOr(
      () =>
        metrics
          .getMeter(instrumentationName, options.instrumentationVersion)
          .createHistogram("agent.run.duration", {
            description: "Duration of an Agent Run",
            unit: "s",
          }),
      NOOP_HISTOGRAM,
    );
  }

  public start(agentRunId: string): AgentRunTelemetryScope {
    const startedAt = performance.now();
    // Fall back to an invalid span when OpenTelemetry is unavailable or misconfigured.
    const span = tryOr(
      () =>
        this.tracer.startSpan("agent.run", {
          attributes: {
            [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
            [SemanticConventions.SESSION_ID]: agentRunId,
          },
        }),
      trace.wrapSpanContext(INVALID_SPAN_CONTEXT),
    );
    const runContext = trace.setSpan(context.active(), span);
    return new OpenTelemetryAgentRunTelemetryScope(
      agentRunId,
      this.options.logger,
      runContext,
      this.runDuration,
      span,
      startedAt,
    );
  }
}

export const createAgentRunTelemetry = (options: AgentRunTelemetryOptions): AgentRunTelemetry =>
  new OpenTelemetryAgentRunTelemetry(options);
