# Stream Agent Runs over fetch

The dedicated `POST /api/agent-runs` endpoint accepts JSON and streams a versioned NDJSON Agent Run Stream consumed by `fetch`. It returns the Agent Run Identifier in `X-Agent-Run-Id` and the first stream event; failures before streaming use HTTP responses, while failures after streaming begins use a terminal stream event. Native EventSource, WebSockets, and polling are deferred until the product requires durable replay or live bidirectional interaction.
