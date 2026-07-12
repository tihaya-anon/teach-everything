import {
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
  type SpanOptions,
} from "@opentelemetry/api";

export type TracerOptions = {
  instrumentationName: string;
  instrumentationVersion?: string;
};

export interface AppTracer {
  run<T>(
    spanName: string,
    operation: (span: Span) => Promise<T>,
    options?: SpanOptions & { attributes?: Attributes },
  ): Promise<T>;
}

export const createTracer = (options: TracerOptions): AppTracer => {
  const tracer = trace.getTracer(options.instrumentationName, options.instrumentationVersion);

  return {
    run: (spanName, operation, spanOptions) =>
      tracer.startActiveSpan(spanName, spanOptions ?? {}, async (span) => {
        try {
          return await operation(span);
        } catch (error) {
          if (error instanceof Error) span.recordException(error);
          else span.recordException(String(error));
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      }),
  };
};
