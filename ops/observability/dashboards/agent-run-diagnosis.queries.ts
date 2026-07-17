export const agentRunIdentifierVariableName = "agent_run_id";

const agentRunIdentifierTemplate = `$${agentRunIdentifierVariableName}`;

const traceQlAttribute = (name: string) => `span."${name}"`;

export const agentRunDiagnosisFields = {
  apiServiceName: "teach-everything-api",
  rootSpanName: "agent.run",
  runIdSpanAttribute: traceQlAttribute("agent.run.id"),
  runOutcomeSpanAttribute: traceQlAttribute("agent.run.outcome"),
  errorTypeSpanAttribute: traceQlAttribute("error.type"),
  langChainRunKindSpanAttribute: traceQlAttribute("langchain.run.kind"),
  langChainRunNameSpanAttribute: traceQlAttribute("langchain.run.name"),
  toolNameSpanAttribute: traceQlAttribute("gen_ai.tool.name"),
  providerNameSpanAttribute: traceQlAttribute("gen_ai.provider.name"),
  requestModelSpanAttribute: traceQlAttribute("gen_ai.request.model"),
  responseModelSpanAttribute: traceQlAttribute("gen_ai.response.model"),
  inputTokensSpanAttribute: traceQlAttribute("gen_ai.usage.input_tokens"),
  outputTokensSpanAttribute: traceQlAttribute("gen_ai.usage.output_tokens"),
  logTraceIdField: "traceId",
  logAgentRunIdField: "attributes_agent_run_id",
} as const;

export const expectedAgentRunDiagnosisDatasources = {
  tempo: {
    type: "tempo",
    uid: "tempo",
  },
  loki: {
    type: "loki",
    uid: "loki",
  },
} as const;

const selectedRunRootSpan = `{ span:name = "${agentRunDiagnosisFields.rootSpanName}" && ${agentRunDiagnosisFields.runIdSpanAttribute} = "${agentRunIdentifierTemplate}" }`;

const operationFields = [
  "span:name",
  "trace:id",
  "span:duration",
  "span:status",
  agentRunDiagnosisFields.langChainRunKindSpanAttribute,
  agentRunDiagnosisFields.langChainRunNameSpanAttribute,
  agentRunDiagnosisFields.toolNameSpanAttribute,
  agentRunDiagnosisFields.providerNameSpanAttribute,
  agentRunDiagnosisFields.requestModelSpanAttribute,
  agentRunDiagnosisFields.responseModelSpanAttribute,
  agentRunDiagnosisFields.inputTokensSpanAttribute,
  agentRunDiagnosisFields.outputTokensSpanAttribute,
];

const select = (fields: readonly string[]) => `select(${fields.join(", ")})`;

const childOperationQuery = (condition: string) =>
  `${selectedRunRootSpan} >> { ${agentRunDiagnosisFields.langChainRunKindSpanAttribute} =~ "llm|tool" && ${condition} } | ${select(operationFields)}`;

export const agentRunDiagnosisQueries = {
  selectedRunSummary: `${selectedRunRootSpan} | ${select([
    "span:name",
    "trace:id",
    "span:duration",
    agentRunDiagnosisFields.runOutcomeSpanAttribute,
    agentRunDiagnosisFields.errorTypeSpanAttribute,
  ])}`,
  completeTrace: selectedRunRootSpan,
  slowOperations: childOperationQuery("span:duration > 1s"),
  failedOperations: childOperationQuery("span:status = error"),
  correlatedLogs: `{service_name="${agentRunDiagnosisFields.apiServiceName}"} | json | __error__="" | ${agentRunDiagnosisFields.logTraceIdField} != "" | ${agentRunDiagnosisFields.logAgentRunIdField} != "" | ${agentRunDiagnosisFields.logAgentRunIdField}="${agentRunIdentifierTemplate}"`,
} as const;
