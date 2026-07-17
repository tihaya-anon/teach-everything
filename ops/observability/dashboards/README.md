# Teach Everything Grafana Dashboards

This directory is the Git Sync source of truth for Grafana dashboards that encode Teach Everything's business, product, and agent-improvement semantics.

The Teach Everything repository owns business and product dashboard definitions. The sibling observability stack owns Grafana deployment, data sources, telemetry storage, and synchronization infrastructure.

Do not store credentials, private keys, access tokens, or environment-specific secrets in this directory.

## Agent Run Diagnosis

`agent-run-diagnosis.dashboard.json` is the Grafana/Git Sync runtime artifact. Its
authoring source is the TypeScript dashboard and query modules in this directory.

Regenerate the committed artifact after intentional dashboard changes:

```sh
pnpm dashboards:agent-run-diagnosis:generate
```

Dashboard tests compare the generated model with the committed JSON structurally,
so tests detect stale artifacts without mutating files.
