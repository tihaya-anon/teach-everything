# Domain dashboards live with Teach Everything

Teach Everything owns Grafana dashboard definitions that encode its business, product, and Agent Improvement Workbench semantics in `ops/observability/dashboards/`. The sibling PGL repository owns deployment, Grafana data sources, telemetry storage, and Git Sync infrastructure, keeping reusable operational infrastructure separate from this application's domain-specific diagnostic views.
