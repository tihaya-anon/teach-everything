# Python Runtime Internal API

Status: target architecture guidance.

`agent-workbench` owns the browser/API control plane. Python owns LangGraph runtime execution. The
gateway should call Python through a language-neutral internal runtime protocol and translate the
result into the browser-facing Agent Run stream.

## Recommended Boundary

```text
Frontend
  -> TS API /api/agent-runs
    -> Python runtime internal API
      -> Python LangGraph graph registry
    <- Agent Run worker events
  <- browser-facing Agent Run stream
```

TS must not import Python graph objects, inspect LangGraph state, or depend on raw LangGraph stream
chunks. Python must not expose a product API directly to the frontend.

## Transport

For long-running agent calls, use HTTP streaming between TS and Python.

Recommended internal shape:

```text
POST /internal/agent-runs
Content-Type: application/json
Accept: application/x-ndjson

AgentRunWorkerCommand run.start

200 OK
Content-Type: application/x-ndjson

AgentRunWorkerEvent lines
```

Use the existing Agent Run worker command and event schemas for the body and stream. NDJSON is the
lowest-friction transport because the current stdio worker protocol already uses one JSON object per
line. SSE is acceptable later if the runtime needs event IDs, standard event names, or reconnect
semantics, but it should still carry the same logical event contract.

Do not choose WebSocket by default. Use it only when a live run needs meaningful bidirectional
interaction beyond cancellation, such as human approvals, realtime collaboration, or continuous
audio.

Do not use callbacks or webhooks for the primary interactive agent call. They fit offline jobs and
batch reports, not live token/progress streaming.

## Gateway Responsibilities

The TS gateway owns:

- `POST /api/agent-runs` and every browser-facing route.
- Request validation, authentication, authorization, and tenant policy.
- Agent Run id creation.
- Runtime Profile loading and Agent Behavior Version acceptance.
- Cancellation semantics for frontend disconnects and explicit aborts.
- Translation from worker events to browser-safe Agent Run events.
- Product telemetry names and log correlation.

The gateway sends only accepted runtime commands to Python. If behavior-version acceptance fails,
TS should return or stream a product-safe validation failure without invoking Python.

## Python Responsibilities

Python owns:

- Graph registry and graph selection by accepted behavior identifiers such as
  `behaviorVersion.graph`.
- LangGraph execution, graph/node/tool/model streaming, and runtime cleanup.
- Worker event emission: `run.started`, `progress.update`, `message.delta`, and exactly one
  terminal event.
- Runtime-internal telemetry for graph execution.

Python must not emit raw LangGraph chunks, prompts, provider payloads, stack traces, credentials, or
tool arguments across the API boundary.

## Cancellation

The internal API needs an explicit cancellation path:

```text
POST /internal/agent-runs/{agentRunId}/cancel
```

TS should call it when the frontend aborts or disconnects after the run starts. Python should treat
repeated cancellation as idempotent and emit `run.cancelled` only after runtime cleanup is complete.
If cleanup cannot be confirmed, TS should keep using the existing `cancellation_failed`
classification.

## Testing Scope

Product-path tests belong in this repository because `/api/agent-runs` is a TypeScript API contract.
Python runtime tests should exercise the worker/internal protocol directly. Do not require the
Python experiment performer to call the TS product route just to measure end-to-end behavior.
