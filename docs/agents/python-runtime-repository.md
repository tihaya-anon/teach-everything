# Python Runtime Repository

The Python LangGraph runtime repository is:

```text
tihaya-anon/agent-runtime-python
```

Use a public repository unless a later product or data-handling decision requires private access.

## Ownership

`agent-runtime-python` owns:

- Python LangGraph execution.
- Worker-side interpretation of LangGraph stream modes into Agent Run worker events.
- Experiment performers, including local sweeps and Optuna-style studies.
- Python runtime tests and Python dependency management.

`agent-workbench` owns:

- The TypeScript web/API control plane.
- The canonical Agent Run worker protocol schemas.
- Browser-facing Agent Run stream stability.
- Translation between worker events and frontend Agent Run events.

## Contract Direction

The Agent Run worker protocol starts in this repository and is consumed by the Python runtime
repository through the schema sharing path selected by the migration split. The Python runtime must
not expose raw LangGraph chunks to the frontend, and this repository must not load Python graph
objects directly.

For the first integration path, Python should consume the checked-in JSON Schema artifacts from
`packages/shared/json-schema/`:

- `agent-run-worker-command.schema.json`
- `agent-run-worker-event.schema.json`

## Development Layout

During local development, keep the repositories checked out as siblings when practical:

```text
workspace/
  agent-workbench/
  agent-runtime-python/
```

The exact discovery mechanism for the TS API to invoke the Python worker is tracked separately.
