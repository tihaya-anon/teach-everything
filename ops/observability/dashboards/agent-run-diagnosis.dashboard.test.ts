import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAgentRunDiagnosisDashboard, type JsonObject } from "./agent-run-diagnosis.dashboard";

const panelByTitle = (dashboard: JsonObject, title: string) => {
  const panels = dashboard.panels;
  if (!Array.isArray(panels)) throw new Error("Dashboard panels must be an array");

  const panel = panels.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      candidate.title === title,
  );
  if (panel === undefined) throw new Error(`Missing dashboard panel: ${title}`);

  return panel as JsonObject;
};

const firstTarget = (panel: JsonObject) => {
  const targets = panel.targets;
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error(`Panel ${String(panel.title)} must have a query target`);
  }

  return targets[0] as JsonObject;
};

describe("Agent Run Diagnosis dashboard", () => {
  it("keeps the checked-in dashboard artifact synchronized", () => {
    // Given
    const artifactUrl = new URL("./agent-run-diagnosis.dashboard.json", import.meta.url);

    // When
    const artifact = JSON.parse(readFileSync(artifactUrl, "utf8"));

    // Then
    expect(artifact).toEqual(buildAgentRunDiagnosisDashboard());
  });

  it("requests span results for execution-path and operation panels", () => {
    // Given
    const dashboard = buildAgentRunDiagnosisDashboard();

    // When
    const completeTrace = panelByTitle(dashboard, "Complete Trace");
    const slowOperations = panelByTitle(dashboard, "Slow Model and Tool Operations");
    const failedOperations = panelByTitle(dashboard, "Failed Model and Tool Operations");

    // Then
    expect(completeTrace.type).toBe("table");
    expect(firstTarget(completeTrace)).toMatchObject({
      queryType: "traceql",
      tableType: "spans",
    });
    expect(firstTarget(slowOperations).tableType).toBe("spans");
    expect(firstTarget(failedOperations).tableType).toBe("spans");
  });

  it("selects the complete Agent Run execution path", () => {
    // Given
    const dashboard = buildAgentRunDiagnosisDashboard();

    // When
    const query = firstTarget(panelByTitle(dashboard, "Complete Trace")).query;

    // Then
    expect(query).toContain("&>> { true }");
    expect(query).toContain('span."session.id" = "$agent_run_id"');
  });
});
