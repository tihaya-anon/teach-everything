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
- Agent Run Stream stability.
- Translation between worker events and frontend Agent Run events.
- Product-path and gateway acceptance tests for `POST /api/agent-runs`.

## Contract Direction

The Agent Run worker protocol starts in this repository and is consumed by the Python runtime
repository through the schema sharing path selected by the migration split. The Python runtime must
not expose raw LangGraph chunks to the frontend, and this repository must not load Python graph
objects directly.

For the target service boundary, see `docs/agents/python-runtime-internal-api.md`. The preferred
evolution is an internal HTTP streaming API that reuses the worker command and event schemas. Python
experiments should not call back into the TS product API; end-to-end product-path checks belong in
this repository or dedicated observability/test engineering.

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

## TS API Discovery

The TS API discovers a local Python worker checkout through process discovery settings, not Runtime
Profile policy:

- `AGENT_RUN_PYTHON_WORKER_REPO_PATH`: path to the checked-out `agent-runtime-python` repository.
  Relative paths resolve from the API startup working directory.
- `AGENT_RUN_PYTHON_WORKER_COMMAND`: optional JSON array of command arguments. Defaults to
  `["python3","-m","agent_runtime_python.worker"]`.

For the sibling layout above, run the API from `agent-workbench` with:

```bash
AGENT_RUN_PYTHON_WORKER_REPO_PATH=../agent-runtime-python pnpm --filter @teach-everything/api dev
```

The API validates the selected path and command at startup. When #19 adds the subprocess adapter,
it should run the command in `AGENT_RUN_PYTHON_WORKER_REPO_PATH` with `PYTHONPATH` set to the
checkout's `src` directory.
