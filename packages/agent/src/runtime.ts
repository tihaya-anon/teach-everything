import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { createTracer } from "@teach-everything/observability";

export type AgentInput = {
  prompt: string;
};

export type AgentResult = {
  answer: string;
};

export interface AgentModel {
  generate(input: AgentInput): Promise<AgentResult>;
}

export interface AgentRuntime {
  invoke(input: AgentInput): Promise<AgentResult>;
}

const AgentState = Annotation.Root({
  input: Annotation<AgentInput>,
  result: Annotation<AgentResult>,
});

const tracer = createTracer({
  instrumentationName: "@teach-everything/agent",
});

export const createAgentRuntime = (model: AgentModel): AgentRuntime => {
  const graph = new StateGraph(AgentState)
    .addNode("generate", async (state) => ({
      result: await model.generate(state.input),
    }))
    .addEdge(START, "generate")
    .addEdge("generate", END)
    .compile();

  return {
    async invoke(input) {
      const prompt = input.prompt.trim();

      if (prompt.length === 0) {
        throw new RangeError("Agent prompt must not be empty");
      }

      const state = await tracer.run("agent.invoke", async (span) => {
        span.setAttribute("agent.input.prompt_length", prompt.length);

        return graph.invoke({
          input: { prompt },
        });
      });

      return state.result;
    },
  };
};
