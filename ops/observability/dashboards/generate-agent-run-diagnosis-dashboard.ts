import { writeFile } from "node:fs/promises";
import path from "node:path";
import { format } from "prettier";
import { buildAgentRunDiagnosisDashboard } from "./agent-run-diagnosis.dashboard";

const dashboardPath = path.resolve(import.meta.dirname, "agent-run-diagnosis.dashboard.json");

const main = async () => {
  const dashboard = JSON.stringify(buildAgentRunDiagnosisDashboard());
  await writeFile(dashboardPath, await format(dashboard, { parser: "json" }), "utf8");
};

void main();
