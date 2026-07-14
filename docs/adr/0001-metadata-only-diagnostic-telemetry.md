# Metadata-only diagnostic telemetry

Diagnostic Telemetry excludes user messages, model responses, prompts, tool arguments, tool results, and authorization data by default. Agent Run Diagnosis relies on identifiers, timing, model and provider metadata, token counts, tools, outcomes, error classifications, traces, and correlated logs; content, if later required, will live in a separately designed redacted artifact with explicit retention and access controls.
