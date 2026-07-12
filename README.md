# Teach Everything

Pure TypeScript full-stack workspace with React, Hono, LangGraph, OpenTelemetry, Zod, and Drizzle.

## Workspace

- `apps/web`: Vite and React frontend
- `apps/api`: Hono API with OpenTelemetry instrumentation
- `packages/agent`: LangGraph agent runtime
- `packages/observability`: Structured logging, tracing helpers, and Node.js telemetry lifecycle
- `packages/shared`: Shared Zod schemas and TypeScript types
- `packages/database`: Drizzle schema and PostgreSQL client

## Start

```bash
pnpm install
pnpm dev
```

- Web: http://localhost:5173
- API: http://localhost:3000/api/health

## Commands

```bash
pnpm dev
pnpm check
pnpm lint
pnpm format
pnpm typecheck
pnpm build
```

OpenTelemetry is disabled in `.env.example`. Set `OTEL_SDK_DISABLED=false` and configure
`OTEL_EXPORTER_OTLP_ENDPOINT` to export traces and metrics to an OTLP collector.

Application logs use the OpenTelemetry log data model field names and automatically include the
active `traceId`, `spanId`, and `traceFlags`. Configure logging with `LOG_LEVEL`, `LOG_SINKS`, and
`LOG_FORMAT`. Supported sinks are `stdout` and `file`; supported formats are `json` and
`plaintext`. In development, logging defaults to plaintext on stdout and JSON in
`logs/application.log`. Use `LOG_STDOUT_FORMAT`, `LOG_FILE_FORMAT`, or `LOG_FILE_PATH` to override
the development defaults.

TypeScript is pinned to 6.0.x because the current stable `typescript-eslint` release supports
TypeScript versions below 6.1. Upgrade TypeScript and `typescript-eslint` together.

Database commands read `DATABASE_URL` from the environment:

```bash
pnpm --filter @teach-everything/database db:generate
pnpm --filter @teach-everything/database db:migrate
pnpm --filter @teach-everything/database db:studio
```
