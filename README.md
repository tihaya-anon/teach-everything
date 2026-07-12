# Teach Everything

Pure TypeScript full-stack workspace with React, Hono, Zod, and Drizzle.

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
pnpm typecheck
pnpm build
```

Database commands read `DATABASE_URL` from the environment:

```bash
pnpm --filter @teach-everything/database db:generate
pnpm --filter @teach-everything/database db:migrate
pnpm --filter @teach-everything/database db:studio
```
