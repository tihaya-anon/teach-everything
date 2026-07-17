# Telemetry stays inside logic modules

Telemetry decisions that belong to business or lifecycle behavior are made inside the logic module that owns that behavior. Transport adapters do not receive or reconstruct telemetry decisions unless crossing an external system seam requires it.

For Agent Runs, the basic lifecycle module owns the terminal Agent Run telemetry because terminal event selection and telemetry finishing are one invariant. Future business modules built on top of Agent Runs should own telemetry for their own outcomes instead of pushing those decisions into HTTP, stream, or UI adapters.

This keeps observability behavior local to the module that understands the invariant, and keeps transport adapters shallow.
