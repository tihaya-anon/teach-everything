import { z } from "zod";

export const agentRunProtocolVersion = 1 as const;

export const agentRunOutcomeSchema = z.enum(["succeeded", "failed", "cancelled"]);

export const agentRunErrorClassificationSchema = z.enum([
  "validation",
  "provider",
  "tool",
  "timeout",
  "cancellation_failed",
  "internal",
]);

export const isAgentRunValidationError = (error: unknown) => error instanceof z.ZodError;

export const agentRunRequestSchema = z
  .object({
    message: z.string().refine((message) => message.trim().length > 0, {
      message: "Message must not be empty",
    }),
  })
  .strict();

export const agentRunStartedEventSchema = z
  .object({
    version: z.literal(agentRunProtocolVersion),
    type: z.literal("run.started"),
    agentRunId: z.string().refine((agentRunId) => agentRunId.trim().length > 0, {
      message: "Agent Run Identifier must not be empty",
    }),
  })
  .strict();

export const agentRunMessageDeltaEventSchema = z
  .object({
    version: z.literal(agentRunProtocolVersion),
    type: z.literal("message.delta"),
    text: z.string(),
  })
  .strict();

export const agentRunCompletedEventSchema = z
  .object({
    version: z.literal(agentRunProtocolVersion),
    type: z.literal("run.completed"),
  })
  .strict();

export const agentRunFailedEventSchema = z
  .object({
    version: z.literal(agentRunProtocolVersion),
    type: z.literal("run.failed"),
    errorClassification: agentRunErrorClassificationSchema,
  })
  .strict();

export const agentRunCancelledEventSchema = z
  .object({
    version: z.literal(agentRunProtocolVersion),
    type: z.literal("run.cancelled"),
  })
  .strict();

export const agentRunExecutorEventSchema = z.discriminatedUnion("type", [
  agentRunMessageDeltaEventSchema,
  agentRunCompletedEventSchema,
  agentRunFailedEventSchema,
  agentRunCancelledEventSchema,
]);

export const agentRunEventSchema = z.discriminatedUnion("type", [
  agentRunStartedEventSchema,
  agentRunMessageDeltaEventSchema,
  agentRunCompletedEventSchema,
  agentRunFailedEventSchema,
  agentRunCancelledEventSchema,
]);

export const agentRunEventLineSchema = z.preprocess((line) => {
  if (typeof line !== "string") {
    return undefined;
  }

  // NDJSON streams may use LF or CRLF; strip exactly one record terminator.
  const record = line.endsWith("\r\n")
    ? line.slice(0, -2)
    : line.endsWith("\n")
      ? line.slice(0, -1)
      : line;
  if (record.length === 0 || /[\r\n]/u.test(record)) {
    return undefined;
  }

  try {
    return JSON.parse(record) as unknown;
  } catch {
    return undefined;
  }
}, agentRunEventSchema);

export type AgentRunOutcome = z.infer<typeof agentRunOutcomeSchema>;
export type AgentRunErrorClassification = z.infer<typeof agentRunErrorClassificationSchema>;
export type AgentRunRequest = z.infer<typeof agentRunRequestSchema>;
export type AgentRunStartedEvent = z.infer<typeof agentRunStartedEventSchema>;
export type AgentRunMessageDeltaEvent = z.infer<typeof agentRunMessageDeltaEventSchema>;
export type AgentRunCompletedEvent = z.infer<typeof agentRunCompletedEventSchema>;
export type AgentRunFailedEvent = z.infer<typeof agentRunFailedEventSchema>;
export type AgentRunCancelledEvent = z.infer<typeof agentRunCancelledEventSchema>;
export type AgentRunExecutorEvent = z.infer<typeof agentRunExecutorEventSchema>;
export type AgentRunEvent = z.infer<typeof agentRunEventSchema>;

export const encodeAgentRunEventLine = (event: AgentRunEvent) =>
  `${JSON.stringify(agentRunEventSchema.parse(event))}\n`;
