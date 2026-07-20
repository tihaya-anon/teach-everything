import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentRunWorkerJsonSchemas,
  stringifyAgentRunWorkerJsonSchema,
} from "../src/schemas/agent-run-worker-json-schema";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const schemaPaths = {
  command: `${packageRoot}/json-schema/agent-run-worker-command.schema.json`,
  event: `${packageRoot}/json-schema/agent-run-worker-event.schema.json`,
} as const;

const schemas = createAgentRunWorkerJsonSchemas();

for (const [schemaName, schema] of Object.entries(schemas)) {
  const schemaPath = schemaPaths[schemaName as keyof typeof schemaPaths];
  mkdirSync(dirname(schemaPath), { recursive: true });
  writeFileSync(schemaPath, stringifyAgentRunWorkerJsonSchema(schema));
}
