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

const fieldLink = (panel: JsonObject, fieldName: string) => {
  const fieldConfig = panel.fieldConfig as JsonObject;
  const overrides = fieldConfig.overrides;
  if (!Array.isArray(overrides))
    throw new Error(`Panel ${String(panel.title)} must have overrides`);

  const override = overrides.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      (candidate.matcher as JsonObject).options === fieldName,
  ) as JsonObject | undefined;
  if (override === undefined) throw new Error(`Missing ${fieldName} override`);

  const properties = override.properties;
  if (!Array.isArray(properties)) throw new Error(`${fieldName} override must have properties`);

  const linksProperty = properties.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      candidate.id === "links" &&
      Array.isArray(candidate.value),
  ) as JsonObject | undefined;
  const links = linksProperty?.value;
  if (!Array.isArray(links) || links.length === 0) throw new Error(`${fieldName} must have a link`);

  return links[0] as JsonObject;
};

const fieldLinkProperties = (panel: JsonObject, fieldName: string) => {
  const fieldConfig = panel.fieldConfig as JsonObject;
  const overrides = fieldConfig.overrides;
  if (!Array.isArray(overrides))
    throw new Error(`Panel ${String(panel.title)} must have overrides`);

  const override = overrides.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      (candidate.matcher as JsonObject).options === fieldName,
  ) as JsonObject | undefined;
  if (override === undefined || !Array.isArray(override.properties)) {
    throw new Error(`Missing ${fieldName} link properties`);
  }

  return override.properties;
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

  it("preserves the dashboard time range in trace navigation links", () => {
    // Given
    const dashboard = buildAgentRunDiagnosisDashboard();
    const selectedRunSummary = panelByTitle(dashboard, "Selected Agent Run Summary");
    const completeTrace = panelByTitle(dashboard, "Complete Trace");
    const failedOperations = panelByTitle(dashboard, "Failed Model and Tool Operations");

    // When
    const traceLink = fieldLink(selectedRunSummary, "traceID");
    const completeTraceSpanLink = fieldLink(completeTrace, "spanID");
    const failedOperationSpanLink = fieldLink(failedOperations, "spanID");

    // Then
    expect(traceLink.url).toContain("${__value.raw}");
    expect(completeTraceSpanLink.url).toContain("${__data.fields.traceIdHidden}");
    expect(completeTraceSpanLink.url).toContain("${__value.raw}");
    for (const link of [traceLink, completeTraceSpanLink, failedOperationSpanLink]) {
      expect(link.url).toContain("${__from}");
      expect(link.url).toContain("${__to}");
    }
    for (const [panel, fieldName] of [
      [selectedRunSummary, "traceID"],
      [completeTrace, "spanID"],
      [failedOperations, "spanID"],
    ] as const) {
      expect(fieldLinkProperties(panel, fieldName)[0]).toEqual({ id: "links", value: null });
    }
  });
});
