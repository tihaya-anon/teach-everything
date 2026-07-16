import {
  RunnableMap,
  type RunnableConfig,
  type RunnableInterface,
} from "@langchain/core/runnables";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { createLangChainTelemetryCallback } from "@teach-everything/observability";

export const agentInput = Annotation.Root({
  prompt: Annotation<string>,
});

export const agentOutput = Annotation.Root({
  answer: Annotation<string>,
});

export const agentState = Annotation.Root({
  prompt: Annotation<string>,
  answer: Annotation<string>,
});

export type AgentInput = typeof agentInput.State;
export type AgentOutput = typeof agentOutput.State;
export type AgentState = typeof agentState.State;
export type AgentStateUpdate = typeof agentState.Update;
export type AgentNode = typeof agentState.Node;

const telemetryCallback = createLangChainTelemetryCallback({
  instrumentationName: "@teach-everything/agent",
});

const normalizeInput: AgentNode = (state) => {
  const prompt = state.prompt.trim();

  if (prompt.length === 0) {
    throw new RangeError("Agent prompt must not be empty");
  }

  return { prompt };
};

const getCurrentRunId = (callbacks: RunnableConfig["callbacks"]) =>
  callbacks === undefined || Array.isArray(callbacks) ? undefined : callbacks.getParentRunId();

const isAgentRunnable = (
  node: AgentNode,
): node is RunnableInterface<AgentState, AgentStateUpdate | Partial<AgentState>> =>
  typeof node === "object" &&
  node !== null &&
  "invoke" in node &&
  typeof node.invoke === "function";

const withActiveNodeContext = (node: AgentNode): AgentNode => {
  if (typeof node === "function") {
    return (state, config) =>
      telemetryCallback.runInActiveContext(getCurrentRunId(config.callbacks), () =>
        node(state, config),
      );
  }

  // LangGraph accepts both Runnable nodes and map-shaped nodes; map nodes need conversion.
  const runnable = isAgentRunnable(node)
    ? node
    : RunnableMap.from<AgentState, AgentStateUpdate | Partial<AgentState>>(node);

  return (state, config) =>
    telemetryCallback.runInActiveContext(getCurrentRunId(config.callbacks), () =>
      runnable.invoke(state, config),
    );
};

const observedNode = <Name extends string>(name: Name, node: AgentNode) =>
  [name, withActiveNodeContext(node)] as const;

export const createAgentGraph = (generateNode: AgentNode) =>
  new StateGraph({
    state: agentState,
    input: agentInput,
    output: agentOutput,
  })
    .addNode(...observedNode("normalize_input", normalizeInput))
    .addNode(...observedNode("generate", generateNode))
    .addEdge(START, "normalize_input")
    .addEdge("normalize_input", "generate")
    .addEdge("generate", END)
    .compile({ name: "agent" })
    .withConfig({
      callbacks: [telemetryCallback],
      runName: "agent",
    });
