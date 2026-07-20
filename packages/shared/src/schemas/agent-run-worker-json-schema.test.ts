import { describe, expect, it } from "vitest";
import commandJsonSchema from "../../json-schema/agent-run-worker-command.schema.json";
import eventJsonSchema from "../../json-schema/agent-run-worker-event.schema.json";
import {
  createAgentRunWorkerJsonSchemas,
  stringifyAgentRunWorkerJsonSchema,
} from "./agent-run-worker-json-schema";

describe("Agent Run worker JSON Schema artifacts", () => {
  it("keeps the command JSON Schema artifact generated from the canonical Zod schema", () => {
    // Given
    const schemas = createAgentRunWorkerJsonSchemas();

    // When
    const artifact = stringifyAgentRunWorkerJsonSchema(commandJsonSchema);

    // Then
    expect(artifact).toBe(stringifyAgentRunWorkerJsonSchema(schemas.command));
  });

  it("keeps the event JSON Schema artifact generated from the canonical Zod schema", () => {
    // Given
    const schemas = createAgentRunWorkerJsonSchemas();

    // When
    const artifact = stringifyAgentRunWorkerJsonSchema(eventJsonSchema);

    // Then
    expect(artifact).toBe(stringifyAgentRunWorkerJsonSchema(schemas.event));
  });
});
