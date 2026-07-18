import {
  OpenInferenceSpanKind,
  SemanticConventions,
} from "@arizeai/openinference-semantic-conventions";

export const AGENT_RUN_IDENTIFIER_VARIABLE_NAME = "agent_run_id";

const AGENT_RUN_IDENTIFIER_TEMPLATE = `$${AGENT_RUN_IDENTIFIER_VARIABLE_NAME}`;

const traceQlAttribute = (name: string) => `span."${name}"`;

const AGENT_RUN_OUTCOME_ATTRIBUTE = `${SemanticConventions.METADATA}.agent_run.outcome`;

export const AGENT_RUN_DIAGNOSIS_FIELDS = {
  apiServiceName: "teach-everything-api",
  rootSpanName: "agent.run",
  runIdSpanAttribute: traceQlAttribute(SemanticConventions.SESSION_ID),
  runOutcomeSpanAttribute: traceQlAttribute(AGENT_RUN_OUTCOME_ATTRIBUTE),
  errorTypeSpanAttribute: traceQlAttribute("error.type"),
  operationKindSpanAttribute: traceQlAttribute(SemanticConventions.OPENINFERENCE_SPAN_KIND),
  graphNodeNameSpanAttribute: traceQlAttribute(SemanticConventions.GRAPH_NODE_NAME),
  toolNameSpanAttribute: traceQlAttribute(SemanticConventions.TOOL_NAME),
  providerNameSpanAttribute: traceQlAttribute(SemanticConventions.LLM_PROVIDER),
  modelNameSpanAttribute: traceQlAttribute(SemanticConventions.LLM_MODEL_NAME),
  inputTokensSpanAttribute: traceQlAttribute(SemanticConventions.LLM_TOKEN_COUNT_PROMPT),
  outputTokensSpanAttribute: traceQlAttribute(SemanticConventions.LLM_TOKEN_COUNT_COMPLETION),
  finishReasonSpanAttribute: traceQlAttribute(SemanticConventions.LLM_FINISH_REASON),
  logTraceIdField: "traceId",
  logAgentRunIdField: "attributes_session_id",
} as const;

export const EXPECTED_AGENT_RUN_DIAGNOSIS_DATASOURCES = {
  tempo: {
    type: "tempo",
    uid: "tempo",
  },
  loki: {
    type: "loki",
    uid: "loki",
  },
} as const;

const SELECTED_RUN_ROOT_SPAN = `{ span:name = "${AGENT_RUN_DIAGNOSIS_FIELDS.rootSpanName}" && ${AGENT_RUN_DIAGNOSIS_FIELDS.runIdSpanAttribute} = "${AGENT_RUN_IDENTIFIER_TEMPLATE}" }`;

const OPERATION_FIELDS = [
  "span:name",
  "trace:id",
  "span:duration",
  "span:status",
  AGENT_RUN_DIAGNOSIS_FIELDS.operationKindSpanAttribute,
  AGENT_RUN_DIAGNOSIS_FIELDS.graphNodeNameSpanAttribute,
  AGENT_RUN_DIAGNOSIS_FIELDS.toolNameSpanAttribute,
  AGENT_RUN_DIAGNOSIS_FIELDS.providerNameSpanAttribute,
  AGENT_RUN_DIAGNOSIS_FIELDS.modelNameSpanAttribute,
  AGENT_RUN_DIAGNOSIS_FIELDS.inputTokensSpanAttribute,
  AGENT_RUN_DIAGNOSIS_FIELDS.outputTokensSpanAttribute,
  AGENT_RUN_DIAGNOSIS_FIELDS.finishReasonSpanAttribute,
];

const select = (fields: readonly string[]) => `select(${fields.join(", ")})`;

const childOperationQuery = (condition: string) =>
  `${SELECTED_RUN_ROOT_SPAN} >> { ${AGENT_RUN_DIAGNOSIS_FIELDS.operationKindSpanAttribute} =~ "${OpenInferenceSpanKind.LLM}|${OpenInferenceSpanKind.TOOL}" && ${condition} } | ${select(OPERATION_FIELDS)}`;

export const AGENT_RUN_DIAGNOSIS_QUERIES = {
  selectedRunSummary: `${SELECTED_RUN_ROOT_SPAN} | ${select([
    "span:name",
    "trace:id",
    "span:duration",
    AGENT_RUN_DIAGNOSIS_FIELDS.runOutcomeSpanAttribute,
    AGENT_RUN_DIAGNOSIS_FIELDS.errorTypeSpanAttribute,
  ])}`,
  completeTrace: SELECTED_RUN_ROOT_SPAN,
  slowOperations: childOperationQuery("span:duration > 1s"),
  failedOperations: childOperationQuery("span:status = error"),
  correlatedLogs: `{service_name="${AGENT_RUN_DIAGNOSIS_FIELDS.apiServiceName}"} | json | __error__="" | ${AGENT_RUN_DIAGNOSIS_FIELDS.logTraceIdField} != "" | ${AGENT_RUN_DIAGNOSIS_FIELDS.logAgentRunIdField} != "" | ${AGENT_RUN_DIAGNOSIS_FIELDS.logAgentRunIdField}="${AGENT_RUN_IDENTIFIER_TEMPLATE}"`,
} as const;
