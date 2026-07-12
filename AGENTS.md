# Repository Guidelines

## Agent-Specific Instructions

Communicate with the repository owner in Chinese. Write all other content in English, including source code, comments, documentation, commit messages, UI copy, and generated artifacts. Preserve user-provided source material unless explicitly asked to translate it.

## Project Structure & Module Organization

This repository is a pnpm workspace containing two applications and three shared packages:

- `apps/web`: Vite + React frontend. UI code lives in `src/`; `vite.config.ts` proxies `/api` requests to the backend.
- `apps/api`: Hono API for Node.js. Define routes in `src/app.ts` and keep the server entry point in `src/index.ts`.
- `packages/agent`: LangGraph agent runtime. Keep LangGraph state and graph implementation behind the package's exported runtime interface.
- `packages/observability`: Structured logs, trace helpers, and Node.js OpenTelemetry lifecycle. Keep sink and formatter details behind the exported logger interface.
- `packages/shared`: Zod schemas and TypeScript types shared by both applications. Export public modules through `src/index.ts`.
- `packages/database`: Drizzle PostgreSQL schema, client factory, and migration configuration.

Generated `dist/`, `node_modules/`, and `.pnpm-store/` directories must not be committed. No test or static asset directories exist yet; colocate tests with source files when adding them.

## Build, Test, and Development Commands

Use Node.js 22 or newer and pnpm 11.

```bash
pnpm install       # Install all workspace dependencies
pnpm dev           # Run the web and API development servers in parallel
pnpm lint          # Lint the workspace with ESLint
pnpm format:check  # Check formatting with Prettier
pnpm typecheck     # Type-check every workspace package
pnpm build         # Build the API and production web assets
pnpm check         # Run formatting, linting, type checks, and builds
pnpm clean         # Remove generated workspace outputs
```

The default frontend URL is `http://localhost:5173`; the API defaults to port `3000`. If that port is occupied, run `API_PORT=3001 PORT=3001 pnpm dev`.

Database commands are scoped to `@teach-everything/database`, for example `pnpm --filter @teach-everything/database db:generate`. Set `DATABASE_URL` first; use `.env.example` as a reference and never commit credentials.

## Coding Style & Naming Conventions

Write strict TypeScript with two-space indentation, double quotes, semicolons, and trailing commas. Use `PascalCase` for React components and exported types, `camelCase` for functions and variables, and descriptive lowercase filenames for schemas. Prefer named exports and `import type` for type-only dependencies. Add shared validation to `packages/shared` rather than duplicating interfaces across apps.

Prefer arrow functions for ordinary helpers, array callbacks, Promise callbacks, factories, and React function components. Use method shorthand or `function` only when dynamic `this` is required, and use normal methods for classes and constructors.

ESLint and Prettier are configured at the workspace root. Run `pnpm check` before submitting changes.

## Testing Guidelines

There is currently no test runner or coverage requirement. New features should introduce focused tests once a runner is added, using `*.test.ts` or `*.test.tsx` beside the implementation. Until then, verify builds, type checks, API responses, and affected UI flows manually.

## Commit & Pull Request Guidelines

Use concise imperative commit subjects, optionally following Conventional Commits, such as `feat(api): add lesson routes`. Pull requests should explain behavior changes, list verification commands, link relevant issues, and include screenshots for visible UI changes. Keep each pull request limited to one coherent change.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The repository uses the default canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses the single-context layout. See `docs/agents/domain.md`.
