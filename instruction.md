现在做一个**纯 TypeScript 全栈项目**，我建议用：

> **pnpm Workspace + Vite + React/Vue（前端）+ Hono（后端）+ 共享类型包**

这套方案结构清晰、前后端都写 TypeScript，部署时也比较灵活。pnpm Workspace 原生支持一个仓库管理多个项目；Vite 负责前端开发和生产构建；Hono 本身使用 TypeScript，并且可运行在 Node.js、Bun、Cloudflare Workers、Vercel 等环境。([pnpm][1])

## 推荐目录结构

```text
my-fullstack-app/
├─ apps/
│  ├─ web/                 # 前端：Vite + React/Vue
│  │  ├─ src/
│  │  ├─ vite.config.ts
│  │  └─ package.json
│  │
│  └─ api/                 # 后端：Hono
│     ├─ src/
│     │  ├─ routes/
│     │  └─ index.ts
│     ├─ tsconfig.json
│     └─ package.json
│
├─ packages/
│  ├─ shared/              # 前后端共享类型、Schema、工具
│  │  ├─ src/
│  │  └─ package.json
│  │
│  └─ database/            # ORM、数据库 Schema
│     ├─ src/
│     └─ package.json
│
├─ package.json
├─ pnpm-workspace.yaml
└─ tsconfig.base.json
```

`pnpm-workspace.yaml`：

```yaml
packages:
  - apps/*
  - packages/*
```

pnpm 要求工作区根目录存在这个文件。([pnpm][1])

## 技术选型

### 前端

```text
Vite + React + TypeScript
```

或者：

```text
Vite + Vue + TypeScript
```

初始化 React：

```bash
pnpm create vite apps/web --template react-ts
```

初始化 Vue：

```bash
pnpm create vite apps/web --template vue-ts
```

Vite 开发时负责 TypeScript 转换和热更新，生产时负责生成优化后的静态资源。需要注意：Vite 的转换流程不等同于完整类型检查，因此通常另外执行 `tsc --noEmit`。([vitejs][2])

### 后端

推荐：

```text
Hono + TypeScript
```

创建：

```bash
pnpm create hono@latest apps/api
```

Node.js 部署时可以选择 Hono 的 Node.js 模板；想部署到 Cloudflare Workers，可以直接选择对应模板。Hono 的路由代码基本基于 Web 标准，在不同运行时之间迁移相对容易。([hono.dev][3])

简单后端：

```ts
import { Hono } from "hono";

const app = new Hono();

app.get("/api/health", (c) => {
  return c.json({
    success: true,
    message: "Server is running",
  });
});

export default app;
```

## 前后端类型共享

这是这套结构最有价值的部分。

后端：

```ts
import { Hono } from "hono";

const app = new Hono()
  .get("/api/users/:id", (c) => {
    const id = c.req.param("id");

    return c.json({
      id,
      name: "Alice",
    });
  });

export type AppType = typeof app;

export default app;
```

前端：

```ts
import { hc } from "hono/client";
import type { AppType } from "@my-app/api";

const client = hc<AppType>("http://localhost:3000");

const response = await client.api.users[":id"].$get({
  param: {
    id: "123",
  },
});

const user = await response.json();
```

Hono RPC 可以根据服务端导出的应用类型，推导客户端的请求参数和响应类型，因此很多项目不再需要手写一套重复的 API 类型。([hono.dev][4])

不过大型项目中，我仍建议把业务模型和验证 Schema 放进独立包：

```text
packages/shared
```

例如：

```ts
// packages/shared/src/user.ts

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface CreateUserInput {
  name: string;
  email: string;
}
```

然后前后端共同引用：

```ts
import type { User } from "@my-app/shared";
```

## 数据库

推荐组合：

```text
PostgreSQL + Drizzle ORM
```

或者：

```text
PostgreSQL + Prisma
```

更追求轻量、SQL 可控和 TypeScript 体验，可以用 Drizzle。

更希望有完整生成器、迁移工具和成熟生态，可以用 Prisma。

数据库相关代码放在：

```text
packages/database
```

例如：

```text
packages/database/
├─ src/
│  ├─ schema.ts
│  ├─ client.ts
│  └─ index.ts
└─ drizzle.config.ts
```

## 校验库

推荐：

```text
Zod
```

或者：

```text
Valibot
```

不要只写 TypeScript interface，因为 TypeScript 类型在编译后不会保留，无法验证真实的 HTTP 输入。

例如：

```ts
import { z } from "zod";

export const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
```

这样 Schema 和 TypeScript 类型只维护一份。

## 构建方式

根目录 `package.json`：

```json
{
  "name": "my-fullstack-app",
  "private": true,
  "scripts": {
    "dev": "pnpm --parallel --filter './apps/*' dev",
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint"
  },
  "packageManager": "pnpm@11"
}
```

前端：

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "typecheck": "tsc --noEmit"
  }
}
```

后端在 Node.js 环境下可以使用：

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsup src/index.ts --format esm --dts",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit"
  }
}
```

对应职责：

```text
tsx   → 开发时直接运行 TypeScript
tsc   → 类型检查
tsup  → 后端生产构建
Vite  → 前端开发和生产构建
pnpm  → Workspace 与依赖管理
```

## TypeScript 配置

根目录 `tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "esModuleInterop": true
  }
}
```

每个子项目继承：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src"]
}
```

项目规模扩大后，可以增加 TypeScript Project References，把各包拆成独立编译单元；官方文档说明它可以强化项目边界，并改善大型项目的构建和编辑器体验。([TypeScript][5])

## 最终建议

一般的后台系统、管理平台、SaaS 或前后端分离项目，直接采用：

```text
pnpm Workspace
├─ Vite + React
├─ Hono
├─ Zod
├─ Drizzle
├─ PostgreSQL
└─ Vitest
```

若项目强调 SEO、服务端渲染和页面级数据加载，则不需要自己拼 Vite 和 Hono，直接用：

```text
Next.js + TypeScript
```

但如果你的重点是“纯 TS、前后端边界明确、共享类型、以后可以换部署平台”，我更推荐 **Vite + Hono Monorepo**。

不要一开始上 Turborepo、Nx 或复杂微服务。先用 pnpm Workspace；等包数量、CI 时间和团队规模真的上来，再增加任务缓存和依赖图管理。

[1]: https://pnpm.io/workspaces?utm_source=chatgpt.com "Workspace"
[2]: https://vite.dev/guide/?utm_source=chatgpt.com "Getting Started"
[3]: https://hono.dev/?utm_source=chatgpt.com "Hono - Web framework built on Web Standards"
[4]: https://hono.dev/docs/guides/rpc?utm_source=chatgpt.com "RPC"
[5]: https://www.typescriptlang.org/tsconfig/?utm_source=chatgpt.com "TSConfig Reference - Docs on every TSConfig option"
