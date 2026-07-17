import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentRunDiagnosisDashboard } from "./agent-run-diagnosis.dashboard";
import type { JsonObject, JsonValue } from "./agent-run-diagnosis.dashboard";
import {
  agentRunDiagnosisQueries,
  agentRunIdentifierVariableName,
  expectedAgentRunDiagnosisDatasources,
} from "./agent-run-diagnosis.queries";

const dashboardPath = path.resolve(import.meta.dirname, "agent-run-diagnosis.dashboard.json");

const currentAgentRunDiagnosisQueries = {
  selectedRunSummary:
    '{ span:name = "agent.run" && span."agent.run.id" = "$agent_run_id" } | select(span:name, trace:id, span:duration, span."agent.run.outcome", span."error.type")',
  completeTrace: '{ span:name = "agent.run" && span."agent.run.id" = "$agent_run_id" }',
  slowOperations:
    '{ span:name = "agent.run" && span."agent.run.id" = "$agent_run_id" } >> { span."langchain.run.kind" =~ "llm|tool" && span:duration > 1s } | select(span:name, trace:id, span:duration, span:status, span."langchain.run.kind", span."langchain.run.name", span."gen_ai.tool.name", span."gen_ai.provider.name", span."gen_ai.request.model", span."gen_ai.response.model", span."gen_ai.usage.input_tokens", span."gen_ai.usage.output_tokens")',
  failedOperations:
    '{ span:name = "agent.run" && span."agent.run.id" = "$agent_run_id" } >> { span."langchain.run.kind" =~ "llm|tool" && span:status = error } | select(span:name, trace:id, span:duration, span:status, span."langchain.run.kind", span."langchain.run.name", span."gen_ai.tool.name", span."gen_ai.provider.name", span."gen_ai.request.model", span."gen_ai.response.model", span."gen_ai.usage.input_tokens", span."gen_ai.usage.output_tokens")',
  correlatedLogs:
    '{service_name="teach-everything-api"} | json | __error__="" | traceId != "" | attributes_agent_run_id != "" | attributes_agent_run_id="$agent_run_id"',
} as const;

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readDashboard = async () => {
  const dashboard = JSON.parse(await readFile(dashboardPath, "utf8")) as JsonValue;
  if (!isObject(dashboard)) throw new Error("Dashboard must be a JSON object");

  return dashboard;
};

const normalizeJson = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (!isObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, childValue]) => [key, normalizeJson(childValue)]),
  );
};

const panelsFrom = (dashboard: JsonObject) => {
  const panels = dashboard.panels;
  if (!Array.isArray(panels)) throw new Error("Dashboard panels must be an array");

  return panels.filter(isObject);
};

const panelByTitle = (dashboard: JsonObject, title: string) => {
  const panel = panelsFrom(dashboard).find((candidate) => candidate.title === title);
  if (panel === undefined) throw new Error(`Missing panel: ${title}`);

  return panel;
};

const targetsFrom = (panel: JsonObject) => {
  const targets = panel.targets;
  if (!Array.isArray(targets)) throw new Error("Panel targets must be an array");

  return targets.filter(isObject);
};

const queryTextFrom = (target: JsonObject) => {
  const query = target.query ?? target.expr;
  if (typeof query !== "string") throw new Error("Target must define a query or expression");

  return query;
};

const datasourceReferencesFrom = (value: JsonValue): JsonObject[] => {
  if (Array.isArray(value)) return value.flatMap(datasourceReferencesFrom);
  if (!isObject(value)) return [];

  const childReferences = Object.values(value).flatMap(datasourceReferencesFrom);
  const datasource = value.datasource;

  return isObject(datasource) ? [datasource, ...childReferences] : childReferences;
};

const hasString = (value: JsonObject, key: string) =>
  typeof value[key] === "string" && value[key].length > 0;

const hasNumber = (value: JsonObject, key: string) => typeof value[key] === "number";

const validateGrafanaDashboardModel = (dashboard: JsonObject) => {
  const errors: string[] = [];

  if ("dashboard" in dashboard) {
    errors.push("Dashboard artifact must be the dashboard model, not an import API envelope");
  }
  if ("datasources" in dashboard || "__inputs" in dashboard || "__requires" in dashboard) {
    errors.push("Dashboard artifact must not define provisioning or import-time dependencies");
  }
  if ("id" in dashboard && dashboard.id !== null) {
    errors.push("Dashboard artifact must not pin a Grafana instance-local numeric id");
  }
  if (!hasString(dashboard, "uid")) errors.push("Dashboard uid must be a non-empty string");
  if (!hasString(dashboard, "title")) errors.push("Dashboard title must be a non-empty string");
  if (!hasNumber(dashboard, "schemaVersion")) {
    errors.push("Dashboard schemaVersion must be numeric");
  }
  if (!hasNumber(dashboard, "version")) errors.push("Dashboard version must be numeric");
  if (!Array.isArray(dashboard.tags)) errors.push("Dashboard tags must be an array");
  if (!isObject(dashboard.templating) || !Array.isArray(dashboard.templating.list)) {
    errors.push("Dashboard templating.list must be an array");
  }

  const panels = Array.isArray(dashboard.panels) ? dashboard.panels : undefined;
  if (panels === undefined) {
    errors.push("Dashboard panels must be an array");
    return errors;
  }

  const panelIds = new Set<number>();
  for (const [index, panelValue] of panels.entries()) {
    if (!isObject(panelValue)) {
      errors.push(`Panel ${index} must be an object`);
      continue;
    }

    const panel = panelValue;
    if (!hasNumber(panel, "id")) errors.push(`Panel ${index} id must be numeric`);
    if (typeof panel.id === "number") {
      if (panelIds.has(panel.id)) errors.push(`Panel id ${panel.id} must be unique`);
      panelIds.add(panel.id);
    }
    if (!hasString(panel, "title")) errors.push(`Panel ${index} title must be a non-empty string`);
    if (!hasString(panel, "type")) errors.push(`Panel ${index} type must be a non-empty string`);
    if (!isObject(panel.gridPos)) {
      errors.push(`Panel ${index} gridPos must be an object`);
    } else {
      for (const key of ["h", "w", "x", "y"]) {
        if (!hasNumber(panel.gridPos, key)) {
          errors.push(`Panel ${index} gridPos.${key} must be numeric`);
        }
      }
    }

    if (panel.type !== "text") {
      if (!isObject(panel.datasource)) errors.push(`Panel ${index} datasource must be an object`);
      if (!Array.isArray(panel.targets) || panel.targets.length === 0) {
        errors.push(`Panel ${index} must define at least one target`);
      }
    }
  }

  return errors;
};

describe("Agent Run Diagnosis dashboard", () => {
  it("keeps the committed Grafana artifact structurally equal to the generated dashboard", async () => {
    // Given
    const committedDashboard = await readDashboard();
    const generatedDashboard = buildAgentRunDiagnosisDashboard();

    // When
    const normalizedGeneratedDashboard = normalizeJson(generatedDashboard);
    const normalizedCommittedDashboard = normalizeJson(committedDashboard);

    // Then
    expect(normalizedGeneratedDashboard).toEqual(normalizedCommittedDashboard);
  });

  it("preserves the current Agent Run Diagnosis query strings in named exports", () => {
    // Given
    const currentQueries = currentAgentRunDiagnosisQueries;

    // When
    const queryExports = agentRunDiagnosisQueries;

    // Then
    expect(queryExports).toEqual(currentQueries);
  });

  it("is a loadable production Grafana dashboard artifact", async () => {
    // Given
    const dashboard = await readDashboard();

    // When
    const panels = panelsFrom(dashboard);
    const serializedDashboard = JSON.stringify(dashboard);

    // Then
    expect(validateGrafanaDashboardModel(dashboard)).toEqual([]);
    expect(dashboard.uid).toBe("agent-run-diagnosis");
    expect(dashboard.title).toBe("Agent Run Diagnosis");
    expect(panels.length).toBeGreaterThan(0);
    expect(serializedDashboard).not.toMatch(/prototype|credential|password|secret/i);
    expect(serializedDashboard).not.toContain("prometheus");
    expect(serializedDashboard).not.toContain("alert");
  });

  it("uses only PGL-owned Tempo and Loki datasource UIDs", async () => {
    // Given
    const dashboard = await readDashboard();

    // When
    const datasourceReferences = datasourceReferencesFrom(dashboard);

    // Then
    expect(datasourceReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining(expectedAgentRunDiagnosisDatasources.tempo),
        expect.objectContaining(expectedAgentRunDiagnosisDatasources.loki),
      ]),
    );
    expect(
      datasourceReferences.every((datasource) => {
        if (datasource.type === "tempo") return datasource.uid === "tempo";
        if (datasource.type === "loki") return datasource.uid === "loki";

        return false;
      }),
    ).toBe(true);
  });

  it("locates the selected root span and exposes bounded run summary fields", async () => {
    // Given
    const dashboard = await readDashboard();
    const summaryPanel = panelByTitle(dashboard, "Selected Agent Run Summary");

    // When
    const summaryQuery = queryTextFrom(targetsFrom(summaryPanel)[0] ?? {});

    // Then
    expect(summaryQuery).toBe(agentRunDiagnosisQueries.selectedRunSummary);
  });

  it("uses the Agent Run Identifier variable to render the complete trace", async () => {
    // Given
    const dashboard = await readDashboard();
    const completeTracePanel = panelByTitle(dashboard, "Complete Trace");

    // When
    const variables = isObject(dashboard.templating) ? dashboard.templating.list : undefined;
    const completeTraceQuery = queryTextFrom(targetsFrom(completeTracePanel)[0] ?? {});

    // Then
    expect(variables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Agent Run Identifier",
          name: agentRunIdentifierVariableName,
          type: "textbox",
        }),
      ]),
    );
    expect(completeTracePanel.type).toBe("traces");
    expect(completeTraceQuery).toBe(agentRunDiagnosisQueries.completeTrace);
  });

  it("finds slow and failed child model or tool operations through the selected root", async () => {
    // Given
    const dashboard = await readDashboard();
    const slowOperationsPanel = panelByTitle(dashboard, "Slow Model and Tool Operations");
    const failedOperationsPanel = panelByTitle(dashboard, "Failed Model and Tool Operations");

    // When
    const slowOperationTargets = targetsFrom(slowOperationsPanel);
    const failedOperationTargets = targetsFrom(failedOperationsPanel);
    const slowOperationQuery = queryTextFrom(slowOperationTargets[0] ?? {});
    const failedOperationQuery = queryTextFrom(failedOperationTargets[0] ?? {});

    // Then
    expect(slowOperationTargets).toHaveLength(1);
    expect(failedOperationTargets).toHaveLength(1);
    expect(slowOperationQuery).toBe(agentRunDiagnosisQueries.slowOperations);
    expect(failedOperationQuery).toBe(agentRunDiagnosisQueries.failedOperations);
  });

  it("restricts correlated logs to the API service and selected Agent Run Identifier", async () => {
    // Given
    const dashboard = await readDashboard();
    const logsPanel = panelByTitle(dashboard, "Correlated Agent Run Logs");

    // When
    const logQuery = queryTextFrom(targetsFrom(logsPanel)[0] ?? {});

    // Then
    expect(logQuery).toBe(agentRunDiagnosisQueries.correlatedLogs);
    expect(logsPanel.options).toEqual(
      expect.objectContaining({
        enableLogDetails: true,
        showTime: true,
      }),
    );
  });
});
