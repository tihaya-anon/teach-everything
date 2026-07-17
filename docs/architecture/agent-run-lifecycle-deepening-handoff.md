# Agent Run Lifecycle Deepening Handoff

Status: ready to implement.

Source review: `docs/architecture/agent-run-diagnosis-review.md`

## Shared decisions

- The new seam lives inside `apps/api`, not `packages/agent` or `packages/shared`.
- The module is scoped to the basic Agent Run protocol lifecycle, not future lesson, tutoring, or other business lifecycles.
- The module name is `apps/api/src/agent-run-lifecycle.ts`.
- The main interface is `createAgentRunLifecycle(options)`, returning domain events and a cancellation handle:

```ts
export type AgentRunLifecycle = {
  cancel: () => Promise<void>;
  events: AsyncIterable<AgentRunEvent>;
};
```

- `apps/api/src/routes/agent-runs.ts` remains a transport adapter. It owns Hono validation, response headers, `ReadableStream`, and NDJSON encoding.
- The lifecycle module owns Agent Run terminal selection and telemetry finishing. Route code must not reconstruct telemetry outcomes from emitted events.
- Cancellation confirmation timeout is configurable at the lifecycle module seam, with the default exported from `apps/api/src/agent-run-lifecycle.defaults.ts`.
- The default export name is `defaultAgentRunCancellationConfirmationTimeoutMs`.
- Lifecycle behavior tests move to `apps/api/src/agent-run-lifecycle.test.ts`.
- Route tests shrink to adapter behavior: validation, headers/content type, NDJSON encoding, request-signal wiring, `ReadableStream.cancel()` wiring, and one real Node HTTP abort integration test.
- A new ADR records the broader rule: telemetry decisions stay inside the logic module that owns the behavior unless an external seam requires transporting them.

## Lifecycle responsibilities

The lifecycle module owns:

- `run.started` emission
- executor iteration
- executor event validation
- exactly one terminal event
- request abort and client cancellation handling
- executor cleanup confirmation
- cancellation deadline handling
- Agent Run terminal telemetry finishing

It does not own:

- Hono route registration
- JSON request validation
- HTTP response construction
- NDJSON byte encoding
- future higher-level business lifecycles built on Agent Runs

## Implementation notes

- Keep the API package export surface unchanged.
- Preserve the existing production cancellation timeout of `10_000` ms.
- Prefer replacing lifecycle assertions in route tests with tests through the lifecycle interface, rather than layering duplicated coverage.
