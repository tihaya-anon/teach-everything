# Agent Graph Specs are JSON Schema validated artifacts

Agent graph behavior will be described by versioned Agent Graph Specs rather than by serializing LangGraph runtime objects. The specs will use JSON or YAML artifacts validated by a schema, with TypeScript parsers in the execution runtime as the quality gate, because the stable contract is the limited set of LLM graph capabilities while the frequently changing part is graph shape.

LangGraph snapshots remain diagnostic evidence for a compiled run, not the source artifact promoted to production. Protobuf and Avro are not the first choice because compatibility, binary transfer, and compression are not important constraints for this workflow; readability, AI generation, easy trial mutation, and exact Graph Spec Hash recording matter more.

The schema and reusable graph definitions should be owned outside the execution runtime package so the runtime can stay focused on compiling specs, attaching OpenTelemetry, executing LangGraph, and recording run evidence. A separate workspace package is the likely first step; a separate repository remains available if graph specs need independent release cadence or ownership.
