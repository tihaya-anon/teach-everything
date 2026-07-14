# Agent Run Identifier for diagnosis

Every Agent Run receives an opaque Agent Run Identifier, returned by the API and used as the canonical lookup key for Agent Run Diagnosis. The identifier correlates root spans and structured logs but is excluded from metric labels, so the user-facing diagnostic contract remains independent of Tempo's trace IDs and Prometheus retains bounded cardinality.
