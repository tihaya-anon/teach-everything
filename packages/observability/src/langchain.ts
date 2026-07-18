import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import {
  SpanStatusCode,
  context,
  metrics,
  trace,
  type Attributes,
  type Context,
  type Histogram,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import {
  LLM_OPERATION_ATTRIBUTE,
  readLlmEndMetadata,
  readLlmTokenMetricAttributes,
  readRunStartMetadata,
  readToolName,
  RUN_DURATION_METRIC_NAME,
  RUN_STATUS_ATTRIBUTE,
  TOKEN_TYPE_ATTRIBUTE,
  TOKEN_USAGE_METRIC_NAME,
  type LangChainLlmEndMetadata,
  type LangChainRunKind,
} from "./langchain-diagnostics";

export type LangChainTelemetryOptions = {
  instrumentationName: string;
  instrumentationVersion?: string;
  onError?: (error: unknown) => void;
};

export type LangChainTelemetryCallback = BaseCallbackHandler & {
  runInActiveContext<T>(runId: string | undefined, operation: () => T): T;
};

type ActiveRun = {
  context: Context;
  metricAttributes?: Attributes;
  span?: Span;
  startedAt?: number;
};

const spanName = (kind: LangChainRunKind, name: string | undefined) =>
  `langchain.${kind}.${name ?? "anonymous"}`;

const reportError = (onError: ((error: unknown) => void) | undefined, error: unknown) => {
  try {
    onError?.(error);
  } catch {
    // Observability diagnostics must never affect the instrumented operation.
  }
};

class NoopTelemetryCallbackHandler extends BaseCallbackHandler {
  name = "open-telemetry-noop";

  constructor() {
    super({ raiseError: false });
    this.awaitHandlers = true;
  }

  runInActiveContext<T>(_runId: string | undefined, operation: () => T): T {
    return operation();
  }
}

class OpenTelemetryCallbackHandler extends BaseCallbackHandler {
  name = "open-telemetry";

  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly runDuration: Histogram;
  private readonly tokenUsage: Histogram;
  private readonly tracer: Tracer;
  private readonly onError: (error: unknown) => void;

  constructor(options: LangChainTelemetryOptions) {
    super({ raiseError: false });
    this.awaitHandlers = true;
    this.tracer = trace.getTracer(options.instrumentationName, options.instrumentationVersion);
    const meter = metrics.getMeter(options.instrumentationName, options.instrumentationVersion);
    this.runDuration = meter.createHistogram(RUN_DURATION_METRIC_NAME, {
      description: "Duration of LangChain and LangGraph runs",
      unit: "s",
    });
    this.tokenUsage = meter.createHistogram(TOKEN_USAGE_METRIC_NAME, {
      description: "Number of input and output tokens used by a generative AI operation",
      unit: "{token}",
    });
    this.onError = options.onError ?? (() => undefined);
  }

  private safely(operation: () => void) {
    try {
      operation();
    } catch (error) {
      reportError(this.onError, error);
    }
  }

  private safelyReadLlmEndMetadata(output: unknown): LangChainLlmEndMetadata {
    try {
      return readLlmEndMetadata(output);
    } catch (error) {
      reportError(this.onError, error);
      return { spanAttributes: {} };
    }
  }

  private toolName(tool: unknown, runName: string | undefined) {
    if (runName !== undefined) return runName;

    try {
      return readToolName(tool);
    } catch (error) {
      reportError(this.onError, error);
      return undefined;
    }
  }

  runInActiveContext<T>(runId: string | undefined, operation: () => T): T {
    const runContext = runId === undefined ? undefined : this.activeRuns.get(runId)?.context;
    if (runContext === undefined) return operation();

    // Some context managers call the closure in unusual ways; keep operation execution exactly once.
    let invoked = false;
    let operationFailed = false;
    let operationError: unknown;
    let operationResult: T | undefined;

    try {
      context.with(runContext, () => {
        if (invoked) {
          if (operationFailed) throw operationError;
          return operationResult as T;
        }

        invoked = true;
        try {
          operationResult = operation();
          return operationResult;
        } catch (error) {
          operationFailed = true;
          operationError = error;
          throw error;
        }
      });
      if (!invoked) {
        reportError(this.onError, new Error("OpenTelemetry context manager skipped operation"));
        return operation();
      }
      if (operationFailed) throw operationError;

      return operationResult as T;
    } catch (error) {
      if (!invoked) {
        reportError(this.onError, error);
        return operation();
      }
      if (operationFailed) throw operationError;

      reportError(this.onError, error);
      return operationResult as T;
    }
  }

  private startRun(
    kind: LangChainRunKind,
    name: string | undefined,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    attributes: Attributes = {},
  ) {
    this.safely(() => {
      const parentContext =
        (parentRunId === undefined ? undefined : this.activeRuns.get(parentRunId)?.context) ??
        context.active();
      if (tags?.includes("langsmith:hidden") === true) {
        // Hidden LangSmith runs should not create spans but must keep child context attached.
        this.activeRuns.set(runId, { context: parentContext });
        return;
      }
      const runMetadata = readRunStartMetadata(kind, name, metadata, attributes);

      const span = this.tracer.startSpan(
        spanName(kind, name),
        {
          attributes: runMetadata.spanAttributes,
        },
        parentContext,
      );

      this.activeRuns.set(runId, {
        context: trace.setSpan(parentContext, span),
        metricAttributes: runMetadata.metricAttributes,
        span,
        startedAt: performance.now(),
      });
    });
  }

  private recordDuration(run: ActiveRun, status: "error" | "ok") {
    if (run.metricAttributes === undefined || run.startedAt === undefined) return;

    const durationSeconds = (performance.now() - run.startedAt) / 1_000;
    this.safely(() =>
      this.runDuration.record(durationSeconds, {
        ...run.metricAttributes,
        [RUN_STATUS_ATTRIBUTE]: status,
      }),
    );
  }

  private endRun(runId: string, attributes: Attributes = {}) {
    const run = this.activeRuns.get(runId);
    this.activeRuns.delete(runId);
    if (run === undefined) return;

    if (run.span !== undefined) {
      const span = run.span;
      this.safely(() =>
        span.setAttributes({
          ...attributes,
          [RUN_STATUS_ATTRIBUTE]: "ok",
        }),
      );
      this.safely(() => span.end());
    }
    this.recordDuration(run, "ok");
  }

  private failRun(_error: unknown, runId: string) {
    const run = this.activeRuns.get(runId);
    this.activeRuns.delete(runId);
    if (run?.span === undefined) return;

    const span = run.span;
    this.safely(() => span.setAttribute(RUN_STATUS_ATTRIBUTE, "error"));
    this.safely(() => span.setStatus({ code: SpanStatusCode.ERROR }));
    this.safely(() => span.end());
    this.recordDuration(run, "error");
  }

  private endLlmRun(output: unknown, runId: string) {
    const run = this.activeRuns.get(runId);
    const metadata = this.safelyReadLlmEndMetadata(output);

    if (run?.metricAttributes !== undefined) {
      const tokenAttributes = readLlmTokenMetricAttributes({
        ...run.metricAttributes,
        ...metadata.spanAttributes,
      });
      if (metadata.inputTokens !== undefined) {
        const inputTokens = metadata.inputTokens;
        this.safely(() =>
          this.tokenUsage.record(inputTokens, {
            ...tokenAttributes,
            [TOKEN_TYPE_ATTRIBUTE]: "input",
          }),
        );
      }
      if (metadata.outputTokens !== undefined) {
        const outputTokens = metadata.outputTokens;
        this.safely(() =>
          this.tokenUsage.record(outputTokens, {
            ...tokenAttributes,
            [TOKEN_TYPE_ATTRIBUTE]: "output",
          }),
        );
      }
    }

    this.endRun(runId, metadata.spanAttributes);
  }

  handleChainStart(
    _chain: unknown,
    _inputs: unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    _runType?: string,
    runName?: string,
  ) {
    this.startRun("chain", runName, runId, parentRunId, tags, metadata);
  }

  handleChainEnd(_outputs: unknown, runId: string) {
    this.endRun(runId);
  }

  handleChainError(error: unknown, runId: string) {
    this.failRun(error, runId);
  }

  handleLLMStart(
    _llm: unknown,
    _prompts: string[],
    runId: string,
    parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ) {
    this.startRun("llm", runName, runId, parentRunId, tags, metadata, {
      [LLM_OPERATION_ATTRIBUTE]: "text_completion",
    });
  }

  handleChatModelStart(
    _llm: unknown,
    _messages: unknown[][],
    runId: string,
    parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ) {
    this.startRun("llm", runName, runId, parentRunId, tags, metadata, {
      [LLM_OPERATION_ATTRIBUTE]: "chat",
    });
  }

  handleLLMEnd(output: unknown, runId: string) {
    this.endLlmRun(output, runId);
  }

  handleLLMError(error: unknown, runId: string) {
    this.failRun(error, runId);
  }

  handleToolStart(
    tool: unknown,
    _input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ) {
    this.startRun("tool", this.toolName(tool, runName), runId, parentRunId, tags, metadata);
  }

  handleToolEnd(_output: unknown, runId: string) {
    this.endRun(runId);
  }

  handleToolError(error: unknown, runId: string) {
    this.failRun(error, runId);
  }

  handleRetrieverStart(
    _retriever: unknown,
    _query: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ) {
    this.startRun("retriever", runName, runId, parentRunId, tags, metadata);
  }

  handleRetrieverEnd(_documents: unknown[], runId: string) {
    this.endRun(runId);
  }

  handleRetrieverError(error: unknown, runId: string) {
    this.failRun(error, runId);
  }
}

export const createLangChainTelemetryCallback = (
  options: LangChainTelemetryOptions,
): LangChainTelemetryCallback => {
  try {
    return new OpenTelemetryCallbackHandler(options);
  } catch (error) {
    reportError(options.onError, error);
    return new NoopTelemetryCallbackHandler();
  }
};
