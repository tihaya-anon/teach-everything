# Python Runtime Migration Handoff

Last updated: 2026-07-20.

## Current Stage

The TypeScript gateway to Python runtime migration has completed the protocol, worker scaffold,
TS adapter, and frontend stream contract slices.

Completed GitHub issues:

- #17 Define Agent Run worker protocol for Python runtime migration.
- #18 Scaffold Python LangGraph runtime worker.
- #19 Add TS API adapter for Python Agent Run worker.
- #20 Preserve frontend Agent Run streaming UX across Python runtime.
- #24 Create separate Python LangGraph runtime repository.
- #25 Decide Python runtime repo name/ownership.
- #26 Define schema sharing path.
- #27 Add local TS API discovery.
- #28 Define compatibility policy.
- #29 Scaffold external Python runtime repo.

Open GitHub issues:

- #21 Add Python experiment performer for Optuna-style trials.
- #22 Deprecate TS LangGraph runtime after Python parity.
- #23 Migrate LangGraph execution to Python runtime behind TS gateway.

## Local Repositories

TypeScript workspace:

- Path: `/home/yxluo/workspace/personal/agent-workbench`
- Recent commits:
  - `72289f2 test(web): preserve agent run stream contract`
  - `ddce61a feat(api): add python worker executor adapter`
  - `032cb0c feat(api): add python worker discovery config`
  - `bc4cd3d docs: define worker protocol compatibility policy`
  - `477bf2c feat(shared): publish agent run worker json schemas`
  - `d7e65e0 docs: record python runtime repository ownership`
  - `5decd2e feat(shared): define agent run worker protocol`

Python runtime repository:

- Path: `/home/yxluo/workspace/personal/agent-runtime-python`
- Remote: `tihaya-anon/agent-runtime-python`
- Recent commits:
  - `958adc5 feat: emit agent run telemetry attributes`
  - `c2fa16c feat: add protocol-validating smoke worker`
  - `e57e71f chore: scaffold python runtime repository`

## Verification Already Run

For #19:

- `pnpm exec vitest run packages/agent/src/agent-run-executor.test.ts apps/api/src/python-worker-agent-run-executor.test.ts apps/api/src/agent-run-lifecycle.test.ts apps/api/src/python-worker-discovery.test.ts apps/api/src/routes/agent-runs.test.ts`
- `pnpm --filter @teach-everything/api typecheck`
- `pnpm --filter @teach-everything/agent typecheck`

For #20:

- `pnpm exec vitest run apps/api/src/routes/agent-runs.test.ts apps/api/src/python-worker-agent-run-executor.test.ts apps/web/src/lib/agent-run-stream-consumer.test.ts`
- `pnpm --filter @teach-everything/api typecheck`
- `pnpm --filter @teach-everything/web typecheck`

For the Python worker:

- `PYTHONDONTWRITEBYTECODE=1 uv run python -m unittest discover -s tests`
- `PYTHONDONTWRITEBYTECODE=1 uv run python -m agent_runtime_python.worker < /dev/null`

## Next Recommended Slice

Start #21 in the sibling Python repository, not in the TypeScript workspace.

Use `uv` for Python dependency and command execution. A narrow first slice should add a simple
parameter sweep performer with:

- Trial-plan generation from a small matrix.
- Direct Python worker target using the existing in-process worker/protocol validation.
- TS gateway target interface or placeholder adapter, without requiring an external model call.
- Result records containing run id, trial id, selected parameters, terminal outcome, and response
  summary.
- Tests for trial request generation and result recording.

Do not start #22 until #21 is complete and Python parity criteria are explicit.
