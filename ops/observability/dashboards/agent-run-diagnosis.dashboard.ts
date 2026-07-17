import {
  agentRunDiagnosisQueries,
  agentRunIdentifierVariableName,
  expectedAgentRunDiagnosisDatasources,
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

type TraceQlTarget = {
  refId: "A";
  datasource: DatasourceReference;
  queryType: "traceql";
  query: string;
  limit: 20;
};

type LogQlTarget = {
  refId: "A";
  datasource: DatasourceReference;
  expr: string;
  queryType: "range";
};

type Panel = {
  datasource: DatasourceReference;
  fieldConfig?: JsonObject;
  gridPos: GridPosition;
  id: number;
  options: JsonObject;
  targets: [LogQlTarget] | [TraceQlTarget];
  title: string;
  type: "logs" | "table" | "traces";
};

type DashboardModel = JsonObject & {
  description: string;
  panels: Panel[];
  refresh: string;
  schemaVersion: number;
  tags: string[];
  templating: {
    list: [
      {
        current: {
          text: string;
          value: string;
        };
        hide: 0;
        label: string;
        name: typeof agentRunIdentifierVariableName;
        query: string;
        type: "textbox";
      },
    ];
  };
  timezone: string;
  title: string;
  uid: string;
  version: number;
};

const tempoDatasource = (): DatasourceReference => ({
  type: expectedAgentRunDiagnosisDatasources.tempo.type,
  uid: expectedAgentRunDiagnosisDatasources.tempo.uid,
});

const lokiDatasource = (): DatasourceReference => ({
  type: expectedAgentRunDiagnosisDatasources.loki.type,
  uid: expectedAgentRunDiagnosisDatasources.loki.uid,
});

const tableOptions = (): JsonObject => ({
  showHeader: true,
  cellHeight: "sm",
  footer: {
    show: false,
    reducer: ["sum"],
    countRows: false,
    fields: "",
  },
});

const defaultFieldConfig = (): JsonObject => ({
  defaults: {
    custom: {
      align: "auto",
      cellOptions: {
        type: "auto",
      },
      inspect: false,
    },
    mappings: [],
    thresholds: {
      mode: "absolute",
      steps: [
        {
          color: "green",
          value: null,
        },
      ],
    },
  },
  overrides: [],
});

const traceQlTarget = (query: string): TraceQlTarget => ({
  refId: "A",
  datasource: tempoDatasource(),
  queryType: "traceql",
  query,
  limit: 20,
});

const tracePanel = (
  panel: Pick<Panel, "id" | "title" | "type"> & {
    gridPos: GridPosition;
    query: string;
  },
): Panel => ({
  id: panel.id,
  type: panel.type,
  title: panel.title,
  gridPos: panel.gridPos,
  datasource: tempoDatasource(),
  targets: [traceQlTarget(panel.query)],
  options: panel.type === "table" ? tableOptions() : {},
  fieldConfig: defaultFieldConfig(),
});

const logsPanel = (): Panel => ({
  id: 5,
  type: "logs",
  title: "Correlated Agent Run Logs",
  gridPos: {
    h: 12,
    w: 24,
    x: 0,
    y: 37,
  },
  datasource: lokiDatasource(),
  targets: [
    {
      refId: "A",
      datasource: lokiDatasource(),
      expr: agentRunDiagnosisQueries.correlatedLogs,
      queryType: "range",
    },
  ],
  options: {
    showTime: true,
    showLabels: false,
    showCommonLabels: false,
    wrapLogMessage: true,
    prettifyLogMessage: true,
    enableLogDetails: true,
    dedupStrategy: "none",
  },
});

export const buildAgentRunDiagnosisDashboard = (): DashboardModel => ({
  uid: "agent-run-diagnosis",
  title: "Agent Run Diagnosis",
  description: "Diagnose one Teach Everything Agent Run from its opaque Agent Run Identifier.",
  tags: ["teach-everything", "agent-run-diagnosis"],
  timezone: "browser",
  schemaVersion: 41,
  version: 1,
  refresh: "",
  templating: {
    list: [
      {
        name: agentRunIdentifierVariableName,
        label: "Agent Run Identifier",
        type: "textbox",
        query: "",
        current: {
          text: "",
          value: "",
        },
        hide: 0,
      },
    ],
  },
  panels: [
    tracePanel({
      id: 1,
      type: "table",
      title: "Selected Agent Run Summary",
      gridPos: {
        h: 8,
        w: 24,
        x: 0,
        y: 0,
      },
      query: agentRunDiagnosisQueries.selectedRunSummary,
    }),
    tracePanel({
      id: 2,
      type: "traces",
      title: "Complete Trace",
      gridPos: {
        h: 9,
        w: 24,
        x: 0,
        y: 8,
      },
      query: agentRunDiagnosisQueries.completeTrace,
    }),
    tracePanel({
      id: 3,
      type: "table",
      title: "Slow Model and Tool Operations",
      gridPos: {
        h: 10,
        w: 24,
        x: 0,
        y: 17,
      },
      query: agentRunDiagnosisQueries.slowOperations,
    }),
    tracePanel({
      id: 4,
      type: "table",
      title: "Failed Model and Tool Operations",
      gridPos: {
        h: 10,
        w: 24,
        x: 0,
        y: 27,
      },
      query: agentRunDiagnosisQueries.failedOperations,
    }),
    logsPanel(),
  ],
});
