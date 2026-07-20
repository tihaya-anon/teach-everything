# Agent Run Worker Protocol

The Agent Run worker protocol is the language-neutral seam between this TypeScript repository and
an external LangGraph runtime worker. This repository owns the shared contract and browser-facing
Agent Run stream. A Python runtime repository owns LangGraph execution and experiment tooling.
The selected Python runtime repository is `tihaya-anon/agent-runtime-python`.

The initial transport is NDJSON over worker stdio. Each line is one complete JSON object, encoded
without embedded record delimiters. The protocol version is `1`.

```mermaid
flowchart LR
  Api[TS API gateway] -- run.start / run.cancel --> Worker[Python worker]
  Worker -- worker events --> Api
  Api -- AgentRunEvent stream --> Web[Frontend]
```

## Commands

The gateway sends commands to the worker.

### `run.start`

Starts one Agent Run.

Required fields:

- `version`: `1`
- `type`: `"run.start"`
- `agentRunId`: non-empty Agent Run identifier assigned by the TS gateway
- `input`: existing `AgentRunRequest`
- `runtimeProfile`: existing `RuntimeProfile`
- `behaviorVersion`: Agent Behavior Version values accepted by the supplied Runtime Profile

The worker must validate the command before graph execution. If validation fails after the worker
can emit events, it emits `run.failed` with `errorClassification: "validation"`.

### `run.cancel`

Requests cancellation for one Agent Run.

Required fields:

- `version`: `1`
- `type`: `"run.cancel"`
- `agentRunId`: non-empty Agent Run identifier

The worker should treat repeated cancellation requests as idempotent.

## Worker Events

The worker emits protocol events back to the TS gateway. The gateway translates these into the
browser-facing Agent Run stream and may suppress worker-only progress.

Reused Agent Run events:

- `run.started`
- `message.delta`
- `run.completed`
- `run.failed`
- `run.cancelled`

Worker progress event:

- `type`: `"progress.update"`
- `scope`: `"run"` or `"task"`
- `label`: stable, non-empty product-safe progress label
- `status`: optional `"started"`, `"running"`, `"completed"`, `"failed"`, or `"cancelled"`
- `message`: optional product-safe progress text

Progress events must not expose raw LangGraph chunk shapes, prompts, provider payloads, stack
traces, or other diagnostic-private data. Detailed diagnostics belong in OpenTelemetry and
OpenInference telemetry, not in the browser-facing product protocol.

## Browser-Facing Agent Run Stream

The browser-facing stream is narrower than the worker event stream. Its stable UI contract is:

- `run.started`: binds the response body to the gateway-assigned `agentRunId`.
- `message.delta`: carries product response text only.
- `run.completed`: terminal success.
- `run.failed`: terminal failure with sanitized `errorClassification`.
- `run.cancelled`: terminal cancellation.

The TS API gateway owns translation from worker events to this stream. In protocol version `1`,
worker `run.started` events are consumed by the gateway, and `progress.update` events are
intentionally suppressed because the current frontend has no progress UI contract. Raw LangGraph
chunks, prompts, provider payloads, stack traces, and diagnostic-private metadata must never be
forwarded to the browser stream. If they reach the frontend stream consumer, they are protocol
violations.

## Ownership

- This repository owns `packages/shared/src/schemas/agent-run-worker.ts`, the TS API gateway, and
  frontend stream stability.
- `tihaya-anon/agent-runtime-python` owns graph execution, Python LangGraph stream interpretation,
  and experiment performance.
- Shared protocol changes should start in this repository, then be consumed by the Python runtime
  repository through an explicit schema publication or vendoring path.

## Schema Sharing

The canonical schemas are the Zod definitions in
`packages/shared/src/schemas/agent-run-worker.ts`. Python consumers should use the checked-in JSON
Schema artifacts:

- `packages/shared/json-schema/agent-run-worker-command.schema.json`
- `packages/shared/json-schema/agent-run-worker-event.schema.json`

Regenerate those artifacts after protocol changes:

```bash
pnpm --filter @teach-everything/shared schema:agent-run-worker
```

The shared package tests compare the artifacts against the generator output so stale files are
caught before commit.

## Compatibility Policy

`AGENT_RUN_WORKER_PROTOCOL_VERSION` is the compatibility signal for the TS gateway and Python
worker. Both sides must reject unsupported protocol versions before graph execution.

Version `1` is compatible when:

- Existing command and event types keep the same required fields and meanings.
- New optional fields are safe for older consumers to ignore.
- New worker event types are either explicitly translated by the TS API adapter or rejected before
  they reach the frontend stream.
- Error classifications keep their existing meanings.
- `progress.update` remains product-safe and does not carry raw LangGraph chunks.

Bump `AGENT_RUN_WORKER_PROTOCOL_VERSION` for incompatible changes, including:

- Removing or renaming a command, event type, or required field.
- Changing the meaning of an existing field.
- Changing terminal event semantics.
- Requiring frontend-visible behavior that older TS gateways cannot translate.
- Changing Runtime Profile or Agent Behavior Version enforcement in a way that changes acceptance
  of previously valid `run.start` commands.

Compatibility is checked per message by strict schema validation. The first unsupported command or
worker event should fail the run with a sanitized `run.failed` event rather than leaking worker
internals.

## Migration Order

1. Define and test this shared protocol in this repository.
2. Create the separate Python runtime repository and document schema consumption.
3. Implement the Python worker against this protocol.
4. Add the TS API adapter that starts, cancels, and translates worker runs.
5. Verify the frontend stream remains stable before switching defaults.
