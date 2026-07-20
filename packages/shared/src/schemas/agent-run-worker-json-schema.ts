import { z } from "zod";
import { agentRunWorkerCommandSchema, agentRunWorkerEventSchema } from "./agent-run-worker";

const jsonSchemaOptions = {
  target: "draft-2020-12",
  unrepresentable: "any",
} as const;

export const createAgentRunWorkerJsonSchemas = () => ({
  command: z.toJSONSchema(agentRunWorkerCommandSchema, jsonSchemaOptions),
  event: z.toJSONSchema(agentRunWorkerEventSchema, jsonSchemaOptions),
});

export const stringifyAgentRunWorkerJsonSchema = (schema: unknown) =>
  `${JSON.stringify(schema, null, 2)}\n`;
