import {
  OpenInferenceSpanKind,
  SemanticConventions,
} from "@arizeai/openinference-semantic-conventions";
import type { Attributes } from "@opentelemetry/api";

export type LangChainRunKind = "chain" | "llm" | "retriever" | "tool";

export type LangChainRunStartMetadata = {
  metricAttributes: Attributes;
  spanAttributes: Attributes;
};

export type LangChainLlmEndMetadata = {
  inputTokens?: number;
  outputTokens?: number;
  spanAttributes: Attributes;
};

export const runStatusAttribute = `${SemanticConventions.METADATA}.langchain.run.status` as const;

export const llmOperationAttribute = `${SemanticConventions.METADATA}.llm.operation.name` as const;

export const langGraphStepAttribute = `${SemanticConventions.METADATA}.langgraph.step` as const;

export const tokenTypeAttribute = `${SemanticConventions.METADATA}.llm.token.type` as const;

export const runDurationMetricName = "langchain.run.duration";

export const tokenUsageMetricName = "gen_ai.client.token.usage";

export const openInferenceSpanKind = (kind: LangChainRunKind): OpenInferenceSpanKind => {
  switch (kind) {
    case "chain":
      return OpenInferenceSpanKind.CHAIN;
    case "llm":
      return OpenInferenceSpanKind.LLM;
    case "retriever":
      return OpenInferenceSpanKind.RETRIEVER;
    case "tool":
      return OpenInferenceSpanKind.TOOL;
  }
};

const commonRunAttributes = (
  kind: LangChainRunKind,
  name: string | undefined,
  metadata: Record<string, unknown> | undefined,
): Attributes => {
  const attributes: Attributes = {
    [SemanticConventions.OPENINFERENCE_SPAN_KIND]: openInferenceSpanKind(kind),
  };

  if (kind === "chain" && name !== undefined) {
    attributes[SemanticConventions.AGENT_NAME] = name;
  }
  if (kind === "tool" && name !== undefined) {
    attributes[SemanticConventions.TOOL_NAME] = name;
  }
  if (typeof metadata?.ls_provider === "string") {
    attributes[SemanticConventions.LLM_PROVIDER] = metadata.ls_provider;
  }
  if (typeof metadata?.ls_model_name === "string") {
    attributes[SemanticConventions.LLM_MODEL_NAME] = metadata.ls_model_name;
  }

  return attributes;
};

export const readRunStartMetadata = (
  kind: LangChainRunKind,
  name: string | undefined,
  metadata: Record<string, unknown> | undefined,
  attributes: Attributes = {},
): LangChainRunStartMetadata => {
  const spanAttributes = commonRunAttributes(kind, name, metadata);

  if (typeof metadata?.langgraph_node === "string") {
    spanAttributes[SemanticConventions.GRAPH_NODE_NAME] = metadata.langgraph_node;
  }
  if (typeof metadata?.langgraph_step === "number") {
    spanAttributes[langGraphStepAttribute] = metadata.langgraph_step;
  }

  const metricAttributes = commonRunAttributes(kind, name, metadata);

  if (typeof attributes[llmOperationAttribute] === "string") {
    metricAttributes[llmOperationAttribute] = attributes[llmOperationAttribute];
  }

  return {
    metricAttributes,
    spanAttributes: {
      ...spanAttributes,
      ...attributes,
    },
  };
};

export const readLlmTokenMetricAttributes = (source: Attributes): Attributes => {
  const attributes: Attributes = {};

  if (typeof source[SemanticConventions.LLM_PROVIDER] === "string") {
    attributes[SemanticConventions.LLM_PROVIDER] = source[SemanticConventions.LLM_PROVIDER];
  }
  if (typeof source[SemanticConventions.LLM_MODEL_NAME] === "string") {
    attributes[SemanticConventions.LLM_MODEL_NAME] = source[SemanticConventions.LLM_MODEL_NAME];
  }

  return attributes;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recordProperty = (record: Record<string, unknown> | undefined, key: string) => {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
};

const firstNumber = (record: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number") return value;
  }

  return undefined;
};

const lastString = (values: unknown[]) => {
  for (const value of values.slice().reverse()) {
    if (typeof value === "string" && value.length > 0) return value;
  }

  return undefined;
};

export const readToolName = (tool: unknown): string | undefined => {
  if (!isRecord(tool)) return undefined;

  if (typeof tool.name === "string" && tool.name.length > 0) return tool.name;
  if (Array.isArray(tool.id)) return lastString(tool.id);

  return undefined;
};

export const readLlmEndMetadata = (output: unknown): LangChainLlmEndMetadata => {
  if (!isRecord(output)) return { spanAttributes: {} };

  // Providers report usage in different shapes; collect the common LangChain variants.
  const spanAttributes: Attributes = {};
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  const finishReasons = new Set<string>();
  const llmOutput = recordProperty(output, "llmOutput");
  const tokenUsage = recordProperty(llmOutput, "tokenUsage");

  if (tokenUsage !== undefined) {
    inputTokens = firstNumber(tokenUsage, ["inputTokens", "input_tokens", "promptTokens"]);
    outputTokens = firstNumber(tokenUsage, ["outputTokens", "output_tokens", "completionTokens"]);
  }

  if (Array.isArray(output.generations)) {
    for (const generationGroup of output.generations) {
      if (!Array.isArray(generationGroup)) continue;

      for (const generation of generationGroup) {
        if (!isRecord(generation)) continue;
        const generationInfo = recordProperty(generation, "generationInfo");
        const message = recordProperty(generation, "message");
        const responseMetadata = recordProperty(message, "response_metadata");
        const usageMetadata = recordProperty(message, "usage_metadata");
        const finishReason = generationInfo?.finish_reason ?? responseMetadata?.finish_reason;

        if (typeof finishReason === "string") finishReasons.add(finishReason);
        if (spanAttributes[SemanticConventions.LLM_MODEL_NAME] === undefined) {
          const responseModel = responseMetadata?.model_name ?? responseMetadata?.model;
          if (typeof responseModel === "string") {
            spanAttributes[SemanticConventions.LLM_MODEL_NAME] = responseModel;
          }
        }
        if (usageMetadata !== undefined) {
          inputTokens ??= firstNumber(usageMetadata, ["input_tokens", "inputTokens"]);
          outputTokens ??= firstNumber(usageMetadata, ["output_tokens", "outputTokens"]);
        }
      }
    }
  }

  if (inputTokens !== undefined)
    spanAttributes[SemanticConventions.LLM_TOKEN_COUNT_PROMPT] = inputTokens;
  if (outputTokens !== undefined) {
    spanAttributes[SemanticConventions.LLM_TOKEN_COUNT_COMPLETION] = outputTokens;
  }
  if (finishReasons.size > 0) {
    const reasons = [...finishReasons];
    spanAttributes[SemanticConventions.LLM_FINISH_REASON] =
      reasons.length === 1 ? reasons[0] : reasons;
  }

  const metadata: LangChainLlmEndMetadata = { spanAttributes };
  if (inputTokens !== undefined) metadata.inputTokens = inputTokens;
  if (outputTokens !== undefined) metadata.outputTokens = outputTokens;

  return metadata;
};
