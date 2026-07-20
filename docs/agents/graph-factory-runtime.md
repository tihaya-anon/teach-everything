# Graph Factory Runtime Handoff

This project keeps executable graph behavior in TypeScript. Python experiment tooling chooses which
published TypeScript Graph Factory to run and supplies serializable trial parameters, but it does
not define graph behavior that the TypeScript runtime loads.

## Split Of Responsibility

TypeScript owns behavior definition:

- Defines Graph Factories as direct LangGraph code.
- Assigns each factory a stable `identity` and `version`.
- Registers publishable factory versions with Agent Behavior Version inputs and a Runtime Profile.
- Builds the factory catalog used by the runtime entry point.
- Creates and executes the selected graph.

Python owns experiment orchestration:

- Chooses trial matrices, parameter sweeps, seeds, and repetitions.
- Selects a TypeScript `graphFactoryIdentity` and `graphFactoryVersion`.
- Sends JSON `trialParameters` to the TypeScript runtime.
- Captures process output, telemetry references, and trial results.

Do not define Graph Factories in Python and ask TypeScript to load them. That would make the
TypeScript runtime execute Python-defined behavior, which this architecture explicitly avoids. If a
Python experiment needs a new behavior variant, add a TypeScript Graph Factory version, then have
Python select that version.

## TypeScript Definition

Define factories in a TypeScript module owned by the runtime or experiment package. A factory is a
small object with an identity, version, and `createGraph` function. Use `createAgentGraphFactory`
when the behavior fits the standard agent graph shape.

```ts
import {
  createAgentGraphFactory,
  createPublishableGraphFactoryCatalog,
  createPublishableGraphFactoryRuntime,
  readGraphFactoryRuntimeRequestFromStdin,
} from "@teach-everything/agent";

const baselineTutorFactory = createAgentGraphFactory<{ promptStyle: string }>({
  identity: "graph-factory:tutor",
  version: "v1",
  createGenerateNode: (trialParameters) => async (state) => ({
    answer: `${trialParameters.promptStyle}: ${state.prompt}`,
  }),
});

const catalog = createPublishableGraphFactoryCatalog([baselineTutorFactory]);
const runtime = createPublishableGraphFactoryRuntime(catalog);

const request = readGraphFactoryRuntimeRequestFromStdin();
const graph = runtime.createGraphForTrial(request);
const result = await graph.invoke({ prompt: "Explain lexical scope." });

process.stdout.write(`${JSON.stringify(result)}\n`);
```

The runtime request is validated by `graphFactoryRuntimeRequestSchema`. It carries only:

- `graphFactoryIdentity`
- `graphFactoryVersion`
- `trialParameters`

## Publishable Registration

When a Graph Factory version is promoted for comparable trials, register it with complete behavior
identity inputs. Registration captures the current Git Source Revision, checks the Runtime Profile's
source policy, and produces a strict Agent Behavior Version tuple.

```ts
import { registerPublishableGraphFactoryVersion } from "@teach-everything/agent";
import publishedProfileDocument from "../../profiles/runtime-published.json";

const registration = registerPublishableGraphFactoryVersion({
  graphFactory: baselineTutorFactory,
  runtimeProfile: publishedProfileDocument,
  behaviorVersionInputs: {
    state: "state:lesson-session:v1",
    action: "action:tutor-response:v1",
    prompt: "prompt:socratic:v3",
    tool: "tool:retrieval:v2",
    model: "model:openai:gpt-5:2026-07-20",
    trialParameter: "trial-parameter:baseline:v1",
  },
});
```

Under `profiles/runtime-published.json`, dirty worktrees are rejected so the Source Revision is a
checkoutable commit. Under a development Runtime Profile, dirty source can be allowed for local
ad hoc work, but those runs are not comparable or promotable.

## Python Orchestration

Python sends a runtime request to a TypeScript process. The request selects a pre-existing
TypeScript factory and supplies JSON trial parameters.

```python
import json
import subprocess

request = {
    "graphFactoryIdentity": "graph-factory:tutor",
    "graphFactoryVersion": "v1",
    "trialParameters": {
        "promptStyle": "socratic",
    },
}

completed = subprocess.run(
    ["pnpm", "exec", "tsx", "experiments/tutor-runtime.ts"],
    input=json.dumps(request),
    text=True,
    capture_output=True,
    check=True,
)

result = json.loads(completed.stdout)
```

For parameter sweeps, Python repeats this call with different `trialParameters` or different
factory selectors. The TypeScript catalog decides whether the requested identity and version exist.

```python
for prompt_style in ["socratic", "direct", "hint-first"]:
    request = {
        "graphFactoryIdentity": "graph-factory:tutor",
        "graphFactoryVersion": "v1",
        "trialParameters": {"promptStyle": prompt_style},
    }
    # invoke the TypeScript runtime and record the result
```

## Runtime Profile Selection

The API server selects Runtime Profile content from reviewable JSON documents:

- `RUNTIME_PROFILE_PATH=/path/to/profile.json` selects an explicit profile document.
- `NODE_ENV=production` defaults to `profiles/runtime-published.json`.
- Other environments default to `profiles/runtime-development.json`.

Profile selection may come from environment or CLI wiring, but policy content belongs in the JSON
document. Do not encode policy inline in Python, shell scripts, or environment variables.

## Why Not Python-Defined Factories?

Python-defined factories would require one of these unsupported designs:

- A graph schema or IDL that Python emits and TypeScript compiles.
- Loading Python code or Python graph objects inside the TypeScript runtime.
- A cross-language behavior serialization format for LangGraph objects.

Those are intentionally out of scope. The current design keeps full LangGraph SDK usage in
TypeScript and lets Python remain an external experiment performer.
