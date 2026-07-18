import { LogsDedupStrategy, TableCellHeight } from "@grafana/grafana-foundation-sdk/common";
import {
  DashboardCursorSync,
  VariableHide,
  type Dashboard as DashboardV2,
  type DataQueryKind,
  type FieldConfigSource,
  type GridLayoutItemKind,
  type PanelKind,
  type PanelQueryKind,
  type TextVariableKind,
  type VariableKind,
  type VizConfigKind,
} from "@grafana/grafana-foundation-sdk/dashboardv2";
import {
  AGENT_RUN_DIAGNOSIS_QUERIES,
  AGENT_RUN_IDENTIFIER_VARIABLE_NAME,
  EXPECTED_AGENT_RUN_DIAGNOSIS_DATASOURCES,
} from "./agent-run-diagnosis.queries";

export type JsonObject = {
  [key: string]: JsonValue;
};

export type JsonValue = boolean | JsonObject | JsonValue[] | null | number | string;

type DatasourceReference = {
  type: "loki" | "tempo";
  uid: "loki" | "tempo";
};

type GridPosition = {
  h: number;
  w: number;
  x: number;
  y: number;
};

type LegacyDashboardPanel = JsonObject & {
  datasource: DatasourceReference;
  fieldConfig?: FieldConfigSource;
  gridPos: GridPosition;
  id: number;
  options: JsonObject;
  repeatDirection: "h";
  targets: JsonObject[];
  title: string;
  transparent: false;
  type: string;
};

const DASHBOARD_UID = "agent-run-diagnosis";

const DASHBOARD_VERSION = 1;

const SCHEMA_VERSION = 42;

type TempoTableType = "spans" | "traces";

const tempoDatasource = (): DatasourceReference => ({
  type: EXPECTED_AGENT_RUN_DIAGNOSIS_DATASOURCES.tempo.type,
  uid: EXPECTED_AGENT_RUN_DIAGNOSIS_DATASOURCES.tempo.uid,
});

const lokiDatasource = (): DatasourceReference => ({
  type: EXPECTED_AGENT_RUN_DIAGNOSIS_DATASOURCES.loki.type,
  uid: EXPECTED_AGENT_RUN_DIAGNOSIS_DATASOURCES.loki.uid,
});

const textVariable = (): TextVariableKind => ({
  kind: "TextVariable",
  spec: {
    name: AGENT_RUN_IDENTIFIER_VARIABLE_NAME,
    current: {
      text: "",
      value: "",
    },
    query: "",
    label: "Agent Run Identifier",
    hide: VariableHide.DontHide,
    skipUrlSync: false,
  },
});

const tempoQuery = (query: string, tableType: TempoTableType): DataQueryKind => ({
  kind: "DataQuery",
  group: "tempo",
  version: "v1",
  spec: {
    filters: [],
    refId: "A",
    datasource: tempoDatasource(),
    queryType: "traceql",
    tableType,
    query,
    limit: 20,
  },
});

const lokiQuery = (expr: string): DataQueryKind => ({
  kind: "DataQuery",
  group: "loki",
  version: "v1",
  spec: {
    expr,
    refId: "A",
    datasource: lokiDatasource(),
    queryType: "range",
  },
});

const panelQuery = (query: DataQueryKind): PanelQueryKind => ({
  kind: "PanelQuery",
  spec: {
    query,
    refId: "A",
    hidden: false,
  },
});

const queryPanelData = (query: DataQueryKind) => ({
  kind: "QueryGroup" as const,
  spec: {
    queries: [panelQuery(query)],
    transformations: [],
    queryOptions: {},
  },
});

const tableVizConfig = (): VizConfigKind => ({
  kind: "VizConfig",
  group: "table",
  version: "v1",
  spec: {
    options: {
      frameIndex: 0,
      showHeader: true,
      showTypeIcons: false,
      footer: {
        show: false,
        reducer: [],
        countRows: false,
      },
      cellHeight: TableCellHeight.Sm,
    },
    fieldConfig: {
      defaults: {
        custom: {
          align: "auto",
          inspect: false,
        },
      },
      overrides: [],
    },
  },
});

const logsVizConfig = (): VizConfigKind => ({
  kind: "VizConfig",
  group: "logs",
  version: "v1",
  spec: {
    options: {
      showLabels: false,
      showCommonLabels: false,
      showTime: true,
      showLogContextToggle: false,
      wrapLogMessage: true,
      prettifyLogMessage: true,
      enableLogDetails: true,
      sortOrder: "Descending",
      dedupStrategy: LogsDedupStrategy.None,
    },
    fieldConfig: {
      defaults: {},
      overrides: [],
    },
  },
});

const panel = (panelSpec: {
  id: number;
  query: DataQueryKind;
  title: string;
  vizConfig: VizConfigKind;
}): PanelKind => ({
  kind: "Panel",
  spec: {
    id: panelSpec.id,
    title: panelSpec.title,
    description: "",
    links: [],
    data: queryPanelData(panelSpec.query),
    vizConfig: panelSpec.vizConfig,
    transparent: false,
  },
});

const gridItem = (name: string, gridPos: GridPosition): GridLayoutItemKind => ({
  kind: "GridLayoutItem",
  spec: {
    x: gridPos.x,
    y: gridPos.y,
    width: gridPos.w,
    height: gridPos.h,
    element: {
      kind: "ElementReference",
      name,
    },
  },
});

const agentRunDiagnosisDashboardV2 = (): DashboardV2 => ({
  annotations: [],
  cursorSync: DashboardCursorSync.Off,
  description: "Diagnose one Teach Everything Agent Run from its opaque Agent Run Identifier.",
  editable: true,
  elements: {
    selectedRunSummary: panel({
      id: 1,
      title: "Selected Agent Run Summary",
      query: tempoQuery(AGENT_RUN_DIAGNOSIS_QUERIES.selectedRunSummary, "traces"),
      vizConfig: tableVizConfig(),
    }),
    completeTrace: panel({
      id: 2,
      title: "Complete Trace",
      query: tempoQuery(AGENT_RUN_DIAGNOSIS_QUERIES.completeTrace, "spans"),
      vizConfig: tableVizConfig(),
    }),
    slowOperations: panel({
      id: 3,
      title: "Slow Model and Tool Operations",
      query: tempoQuery(AGENT_RUN_DIAGNOSIS_QUERIES.slowOperations, "spans"),
      vizConfig: tableVizConfig(),
    }),
    failedOperations: panel({
      id: 4,
      title: "Failed Model and Tool Operations",
      query: tempoQuery(AGENT_RUN_DIAGNOSIS_QUERIES.failedOperations, "spans"),
      vizConfig: tableVizConfig(),
    }),
    correlatedLogs: panel({
      id: 5,
      title: "Correlated Agent Run Logs",
      query: lokiQuery(AGENT_RUN_DIAGNOSIS_QUERIES.correlatedLogs),
      vizConfig: logsVizConfig(),
    }),
  },
  layout: {
    kind: "GridLayout",
    spec: {
      items: [
        gridItem("selectedRunSummary", { h: 8, w: 24, x: 0, y: 0 }),
        gridItem("completeTrace", { h: 9, w: 24, x: 0, y: 8 }),
        gridItem("slowOperations", { h: 10, w: 24, x: 0, y: 17 }),
        gridItem("failedOperations", { h: 10, w: 24, x: 0, y: 27 }),
        gridItem("correlatedLogs", { h: 12, w: 24, x: 0, y: 37 }),
      ],
    },
  },
  links: [],
  preload: false,
  tags: ["teach-everything", "agent-run-diagnosis"],
  timeSettings: {
    timezone: "browser",
    from: "now-6h",
    to: "now",
    autoRefresh: "",
    autoRefreshIntervals: [],
    hideTimepicker: false,
    fiscalYearStartMonth: 0,
  },
  title: "Agent Run Diagnosis",
  variables: [textVariable()],
});

const cursorSyncToGraphTooltip = (cursorSync: DashboardCursorSync) => {
  if (cursorSync === DashboardCursorSync.Crosshair) return 1;
  if (cursorSync === DashboardCursorSync.Tooltip) return 2;

  return 0;
};

const legacyVariable = (variable: VariableKind): JsonObject => {
  if (variable.kind !== "TextVariable") {
    throw new Error(`Unsupported Agent Run Diagnosis variable kind: ${variable.kind}`);
  }

  return {
    type: "textbox",
    name: variable.spec.name,
    skipUrlSync: variable.spec.skipUrlSync,
    multi: false,
    allowCustomValue: true,
    includeAll: false,
    auto: false,
    auto_min: "10s",
    auto_count: 30,
    label: variable.spec.label ?? variable.spec.name,
    query: variable.spec.query,
    current: variable.spec.current as unknown as JsonObject,
    hide: variable.spec.hide === VariableHide.DontHide ? 0 : 2,
  };
};

const legacyPanel = (dashboard: DashboardV2, item: GridLayoutItemKind): LegacyDashboardPanel => {
  const element = dashboard.elements[item.spec.element.name];
  if (element === undefined) {
    throw new Error(`Missing Agent Run Diagnosis dashboard element: ${item.spec.element.name}`);
  }
  if (element.kind !== "Panel") {
    throw new Error(`Unsupported Agent Run Diagnosis dashboard element: ${element.kind}`);
  }

  const query = element.spec.data.spec.queries[0];
  if (query === undefined) {
    throw new Error(`Panel ${element.spec.title} must define a query`);
  }

  const target = query.spec.query.spec as JsonObject;
  const datasource = target.datasource;
  if (
    typeof datasource !== "object" ||
    datasource === null ||
    Array.isArray(datasource) ||
    typeof datasource.type !== "string" ||
    typeof datasource.uid !== "string"
  ) {
    throw new Error(`Panel ${element.spec.title} must define a datasource`);
  }

  const projectedPanel: LegacyDashboardPanel = {
    type: element.spec.vizConfig.group,
    transparent: false,
    repeatDirection: "h",
    options: element.spec.vizConfig.spec.options as JsonObject,
    id: element.spec.id,
    title: element.spec.title,
    gridPos: {
      h: item.spec.height,
      w: item.spec.width,
      x: item.spec.x,
      y: item.spec.y,
    },
    datasource: datasource as DatasourceReference,
    targets: [target],
  };

  if (element.spec.vizConfig.group !== "logs") {
    projectedPanel.fieldConfig = element.spec.vizConfig.spec.fieldConfig;
  }

  return projectedPanel;
};

const legacyPanels = (dashboard: DashboardV2) => {
  if (dashboard.layout.kind !== "GridLayout") {
    throw new Error(`Unsupported Agent Run Diagnosis dashboard layout: ${dashboard.layout.kind}`);
  }

  return dashboard.layout.spec.items.map((item) => legacyPanel(dashboard, item));
};

const projectDashboardV2ToGrafanaDashboard = (dashboard: DashboardV2): JsonObject => ({
  timezone: dashboard.timeSettings.timezone ?? "browser",
  editable: dashboard.editable ?? true,
  graphTooltip: cursorSyncToGraphTooltip(dashboard.cursorSync),
  fiscalYearStartMonth: dashboard.timeSettings.fiscalYearStartMonth ?? 0,
  schemaVersion: SCHEMA_VERSION,
  templating: {
    list: dashboard.variables.map(legacyVariable),
  },
  annotations: {},
  title: dashboard.title,
  uid: DASHBOARD_UID,
  description: dashboard.description ?? "",
  tags: dashboard.tags,
  version: DASHBOARD_VERSION,
  refresh: dashboard.timeSettings.autoRefresh ?? "",
  panels: legacyPanels(dashboard),
});

export const buildAgentRunDiagnosisDashboard = (): JsonObject =>
  projectDashboardV2ToGrafanaDashboard(agentRunDiagnosisDashboardV2());
