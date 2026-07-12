# Teach Everything

Pure TypeScript full-stack workspace with React, Hono, LangGraph, OpenTelemetry, Zod, and Drizzle.

## Workspace

- `apps/web`: Vite and React frontend
- `apps/api`: Hono API with OpenTelemetry instrumentation
- `packages/agent`: LangGraph agent runtime
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

TypeScript is pinned to 6.x because the current stable `typescript-eslint` release supports
TypeScript versions below 6.1. Upgrade TypeScript and `typescript-eslint` together.

Database commands read `DATABASE_URL` from the environment:

```bash
pnpm --filter @teach-everything/database db:generate
pnpm --filter @teach-everything/database db:migrate
pnpm --filter @teach-everything/database db:studio
```
