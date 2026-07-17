import {
  OpenInferenceSpanKind,
  SemanticConventions,
} from "@arizeai/openinference-semantic-conventions";
import { describe, expect, it } from "vitest";
import {
  langGraphStepAttribute,
  llmOperationAttribute,
  readLlmEndMetadata,
  readLlmTokenMetricAttributes,
  readRunStartMetadata,
  readToolName,
} from "./langchain-diagnostics";

const expectPayloadToExclude = (payload: string, prohibitedValues: string[]) => {
  for (const prohibited of prohibitedValues) {
    expect(payload).not.toContain(prohibited);
  }
};

describe("LangChain diagnostic metadata", () => {
  it("returns lightweight graph run metadata without non-profile fields", () => {
    // Given
    const metadata = {
      langgraph_node: "generate",
      langgraph_step: 2,
      prompt: "SENTINEL_GRAPH_PROMPT",
      run_id: "SENTINEL_RUN_ID",
      tags: ["SENTINEL_USER_TAG"],
    };

    // When
    const runMetadata = readRunStartMetadata("chain", "agent", metadata);

    // Then
    expect(runMetadata.spanAttributes).toEqual({
      [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.CHAIN,
      [SemanticConventions.AGENT_NAME]: "agent",
      [SemanticConventions.GRAPH_NODE_NAME]: "generate",
      [langGraphStepAttribute]: 2,
    });
    expect(runMetadata.metricAttributes).toEqual({
      [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.CHAIN,
      [SemanticConventions.AGENT_NAME]: "agent",
    });
    expectPayloadToExclude(JSON.stringify(runMetadata), [
      "SENTINEL_GRAPH_PROMPT",
      "SENTINEL_RUN_ID",
      "SENTINEL_USER_TAG",
    ]);
  });

  it("returns lightweight model run metadata and metric operation attributes", () => {
    // Given
    const metadata = {
      ls_model_name: "gpt-safe-request",
      ls_provider: "openai",
      messages: [{ content: "SENTINEL_PROMPT" }],
    };

    // When
    const runMetadata = readRunStartMetadata("llm", "ChatOpenAI", metadata, {
      [llmOperationAttribute]: "chat",
    });

    // Then
    expect(runMetadata.spanAttributes).toEqual({
      [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.LLM,
      [SemanticConventions.LLM_PROVIDER]: "openai",
      [SemanticConventions.LLM_MODEL_NAME]: "gpt-safe-request",
      [llmOperationAttribute]: "chat",
    });
    expect(runMetadata.metricAttributes).toEqual(runMetadata.spanAttributes);
    expect(JSON.stringify(runMetadata)).not.toContain("SENTINEL_PROMPT");
  });

  it("reads tool names without returning tool payload fields", () => {
    // Given
    const tool = {
      description: "SENTINEL_TOOL_DESCRIPTION",
      id: ["langchain", "tools", "LookupTool"],
      input: "SENTINEL_TOOL_ARGUMENTS",
      lc: 1,
      type: "constructor",
    };

    // When
    const toolName = readToolName(tool);
    const runMetadata = readRunStartMetadata("tool", toolName, {
      result: "SENTINEL_TOOL_RESULT",
    });

    // Then
    expect(toolName).toBe("LookupTool");
    expect(runMetadata.spanAttributes).toEqual({
      [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
      [SemanticConventions.TOOL_NAME]: "LookupTool",
    });
    expectPayloadToExclude(JSON.stringify({ runMetadata, toolName }), [
      "SENTINEL_TOOL_ARGUMENTS",
      "SENTINEL_TOOL_DESCRIPTION",
      "SENTINEL_TOOL_RESULT",
    ]);
  });

  it("reads LLM end metadata from provider token usage and response metadata", () => {
    // Given
    const output = {
      generations: [
        [
          {
            generationInfo: { finish_reason: "stop" },
            message: {
              content: "SENTINEL_MODEL_RESPONSE",
              response_metadata: {
                model_name: "gpt-safe-response",
              },
              usage_metadata: {
                input_tokens: 999,
                output_tokens: 999,
              },
            },
          },
        ],
      ],
      llmOutput: {
        tokenUsage: {
          completionTokens: 21,
          promptTokens: 13,
        },
      },
    };

    // When
    const metadata = readLlmEndMetadata(output);
    const tokenMetricAttributes = readLlmTokenMetricAttributes({
      [SemanticConventions.LLM_PROVIDER]: "openai",
      ...metadata.spanAttributes,
    });

    // Then
    expect(metadata).toEqual({
      inputTokens: 13,
      outputTokens: 21,
      spanAttributes: {
        [SemanticConventions.LLM_MODEL_NAME]: "gpt-safe-response",
        [SemanticConventions.LLM_TOKEN_COUNT_PROMPT]: 13,
        [SemanticConventions.LLM_TOKEN_COUNT_COMPLETION]: 21,
        [SemanticConventions.LLM_FINISH_REASON]: "stop",
      },
    });
    expect(tokenMetricAttributes).toEqual({
      [SemanticConventions.LLM_PROVIDER]: "openai",
      [SemanticConventions.LLM_MODEL_NAME]: "gpt-safe-response",
    });
    expect(JSON.stringify(metadata)).not.toContain("SENTINEL_MODEL_RESPONSE");
  });

  it("falls back to message usage metadata and collects multiple finish reasons", () => {
    // Given
    const output = {
      generations: [
        [
          {
            generationInfo: { finish_reason: "stop" },
            message: {
              response_metadata: {
                model: "gpt-safe-response",
              },
              usage_metadata: {
                input_tokens: 5,
                output_tokens: 8,
              },
            },
          },
          {
            generationInfo: { finish_reason: "length" },
            message: {
              content: "SENTINEL_SECOND_RESPONSE",
              response_metadata: {},
            },
          },
        ],
      ],
    };

    // When
    const metadata = readLlmEndMetadata(output);

    // Then
    expect(metadata).toEqual({
      inputTokens: 5,
      outputTokens: 8,
      spanAttributes: {
        [SemanticConventions.LLM_MODEL_NAME]: "gpt-safe-response",
        [SemanticConventions.LLM_TOKEN_COUNT_PROMPT]: 5,
        [SemanticConventions.LLM_TOKEN_COUNT_COMPLETION]: 8,
        [SemanticConventions.LLM_FINISH_REASON]: ["stop", "length"],
      },
    });
    expect(JSON.stringify(metadata)).not.toContain("SENTINEL_SECOND_RESPONSE");
  });

  it("lets hostile payload extraction throw so the adapter owns fail-open handling", () => {
    // Given
    const throwingOutput = new Proxy(
      {},
      {
        get: () => {
          throw new Error("SENTINEL_EXTRACTION_FAILURE");
        },
      },
    );

    // When / Then
    expect(() => readLlmEndMetadata(throwingOutput)).toThrow("SENTINEL_EXTRACTION_FAILURE");
  });
});
