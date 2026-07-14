# Teach Everything

Teach Everything is an agent engineering environment for improving agent behavior through observable, repeatable experiments, validated through learning experiences.

## Language

**Agent Improvement Workbench**:
The environment in which an engineer connects an agent's operating context and behavior to measured outcomes, then compares changes through repeatable experiments.
_Avoid_: Observability dashboard, monitoring stack

**Agent Run Diagnosis**:
The initial Agent Improvement Workbench workflow in which an engineer inspects one agent run's execution path, correlated logs, timing, token use, and outcome to explain its behavior.
_Avoid_: Monitoring, service health dashboard

**Agent Run**:
A single user-initiated invocation through a dedicated agent-run endpoint, beginning when the API accepts the user's message and ending when a final result or terminal error is returned to that user. An Agent Run can contain many lower-level LangChain or LangGraph runs; ordinary HTTP requests, including authentication, are not Agent Runs.
_Avoid_: Trace, span, request (when referring to the user-visible unit of work)

**Agent Run Identifier**:
An opaque identifier assigned to an Agent Run. It is the canonical key for locating an Agent Run Diagnosis and correlating that run's traces and logs.
_Avoid_: Trace ID, request ID

**Agent Run Stream**:
The versioned streamed response to a single Agent Run request. It starts with the Agent Run Identifier, carries user-visible progress or output, and closes with exactly one terminal event.
_Avoid_: Raw LangGraph stream, event source

**Agent Run Outcome**:
The terminal result of an Agent Run: `succeeded` when a final result reaches the user, `failed` when one cannot be returned, or `cancelled` when the caller intentionally stops the run. Failed runs carry a bounded Error Classification.
_Avoid_: Status, result

**Error Classification**:
A bounded category explaining why an Agent Run failed, such as validation, provider, tool, timeout, or internal.
_Avoid_: Error message, exception

**Cancellation Confirmation**:
Evidence that all cancellable Agent Run work has stopped after the client requests cancellation. Only a confirmed stop gives an Agent Run the `cancelled` outcome.
_Avoid_: Disconnected client, aborted response

**Diagnostic Evidence Window**:
The configured local-development retention period during which every Agent Run's unsampled trace and correlated logs are available for Agent Run Diagnosis. It makes no production or long-term retention promise.
_Avoid_: Audit retention, historical archive

**Telemetry Harness**:
A development-only deterministic fixture that exercises Agent Run telemetry through the existing LangGraph instrumentation wrapper without defining product graph behavior, prompts, tools, or state.
_Avoid_: Demo agent, prototype graph

**Telemetry Scenario**:
A deterministic Telemetry Harness execution mode that creates a known Agent Run outcome or operation pattern for validating Agent Run Diagnosis.
_Avoid_: Product behavior, test case

**Diagnostic Telemetry**:
Metadata emitted about an Agent Run for diagnosis, including identifiers, timing, model or provider names, token counts, tool names, outcomes, error classifications, and correlated structured logs. It excludes user and model content by default.
_Avoid_: Run content, debug payload
