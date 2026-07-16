# Agent Run Diagnosis Acceptance Evidence

This file records the repeatable local acceptance path for GitHub issue #11. It uses the
application executor seam in `createApp` to generate controlled Agent Run telemetry; production
startup still does not register a fixture executor.

## Local Stack

Use a clean PGL stack from the sibling checkout:

```bash
cd ../prometheus-grafana-loki
docker compose down -v
docker compose up -d
./scripts/smoke-test.sh
```

Load `ops/observability/dashboards/agent-run-diagnosis.dashboard.json` into Grafana without editing
the dashboard datasource references. The dashboard must keep using the PGL-owned datasource UIDs
`tempo` and `loki`.

```bash
node -e 'const fs=require("node:fs"); const dashboard=JSON.parse(fs.readFileSync("ops/observability/dashboards/agent-run-diagnosis.dashboard.json","utf8")); fetch("http://127.0.0.1:3000/api/dashboards/db", { method: "POST", headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from("admin:admin").toString("base64")}` }, body: JSON.stringify({ dashboard, overwrite: true }) }).then(async (response) => { console.log(response.status, await response.text()); if (!response.ok) process.exit(1); });'
```

## Controlled Runs

Run the acceptance executor in a container attached to PGL's `observability` network so Alloy
collects the Teach Everything API JSON stdout logs and the API exports OTLP telemetry to Alloy:

```bash
docker run --rm --name teach-everything-agent-run-diagnosis-acceptance \
  --label com.docker.compose.service=teach-everything-api \
  --network observability \
  -v "$PWD":/workspace \
  -w /workspace \
  -e NODE_ENV=production \
  -e OTEL_SDK_DISABLED=false \
  -e OTEL_SERVICE_NAME=teach-everything-api \
  -e OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy:4318 \
  -e LOG_SINKS=stdout \
  -e LOG_STDOUT_FORMAT=json \
  -e AGENT_RUN_DIAGNOSIS_ACCEPTANCE_PREFIX=ar_acceptance_labeled \
  node:22.23.1-slim \
  node --import tsx ops/observability/acceptance/agent-run-diagnosis.ts
```

Expected scenarios:

| Scenario              | Expected Agent Run outcome          | Notes                                                              |
| --------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| `succeeded`           | `succeeded`                         | Emits graph, model, tool, run-duration, and token-usage telemetry. |
| `slow`                | `succeeded`                         | Emits a child tool operation lasting longer than one second.       |
| `failed`              | `failed` with `tool`                | Emits a failed child tool operation.                               |
| `cancelled`           | `cancelled`                         | Confirms executor cleanup after client cancellation.               |
| `cancellation-failed` | `failed` with `cancellation_failed` | Leaves cleanup unconfirmed past the ten-second deadline.           |

## Observed Results

Date: 2026-07-16

PGL datasource provisioning:

- Confirmed via Grafana API: datasource `Tempo` exists with UID `tempo`, type `tempo`, and
  `jsonData.streamingEnabled.search=false`.
- Confirmed health endpoint: `GET /api/datasources/uid/tempo/health` returned
  `{"message":"Data source is working","status":"OK"}`.

Dashboard load:

- Imported `ops/observability/dashboards/agent-run-diagnosis.dashboard.json` through Grafana
  without editing datasource references; the import API returned HTTP 200 and status `success`.
- Confirmed dashboard URL: `/d/agent-run-diagnosis/agent-run-diagnosis`.
- Confirmed the loaded dashboard kept only `tempo` and `loki` datasource references and no
  Prometheus or aggregate metric panels.

Controlled Agent Run IDs:

- `ar_acceptance_labeled_01`: succeeded; trace `3003a914d0e90ae7932540e7178916a8`.
- `ar_acceptance_labeled_02`: slow operation; trace `83f45331d37cf88026e368ece512fa21`.
- `ar_acceptance_labeled_03`: failed with `tool`; trace `647787dec3d0323ad7a6fce00a1ff43c`.
- `ar_acceptance_labeled_04`: confirmed cancelled; trace
  `62a05e3c74c49c4e2f766a72cf568729`.
- `ar_acceptance_labeled_05`: unconfirmed cancellation failed with `cancellation_failed`; trace
  `ca6bb0fd1b8adf62b76b3acd66695f95`.

Grafana diagnosis checks:

- The selected-run summary query
  `{ span:name = "agent.run" && span."agent.run.id" = "ar_acceptance_labeled_01" } | select(span:name, trace:id, span:duration, span."agent.run.outcome", span."error.type")`
  found the root `agent.run` span for `ar_acceptance_labeled_01`.
- `GET /api/traces/3003a914d0e90ae7932540e7178916a8` returned the complete trace with root, graph,
  model, and tool spans.
- Slow-operation TraceQL for `ar_acceptance_labeled_02` found a descendant tool span with duration
  about 1.25 seconds.
- Failed-operation TraceQL for `ar_acceptance_labeled_03` found a descendant tool span with
  `status=error`.
- Cancellation TraceQL found `ar_acceptance_labeled_04` with `agent.run.outcome=cancelled`.
- Cancellation-failure TraceQL found `ar_acceptance_labeled_05` with
  `agent.run.outcome=failed` and `error.type=cancellation_failed`.
- Loki query
  `{service_name="teach-everything-api"} | json | __error__="" | attributes_agent_run_id != "" | attributes_agent_run_id="ar_acceptance_labeled_01"`
  returned only the two lifecycle records for that Agent Run, each with trace ID
  `3003a914d0e90ae7932540e7178916a8`.
- Grafana's Loki datasource has the PGL-provisioned `TraceID` derived field pointing at datasource
  UID `tempo`, and the correlated log records include `traceId`, so the selected-run log view
  permits trace navigation.

Prometheus metric checks:

- `agent_run_duration_seconds_count{job="teach-everything-api"}` was present for outcomes
  `succeeded`, `cancelled`, `failed/error_type=tool`, and
  `failed/error_type=cancellation_failed`.
- `gen_ai_client_token_usage_count{job="teach-everything-api"}` was present for input and output
  token types with provider/model metadata.
- `GET /api/v1/label/agent_run_id/values` returned an empty list, confirming no per-run metric
  label was exported.
