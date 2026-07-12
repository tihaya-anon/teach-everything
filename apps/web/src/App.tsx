import { useEffect, useState } from "react";
import type { HealthResponse } from "@teach-everything/shared";
import { api } from "./api";

type ApiState =
  { status: "loading" } | { status: "ready"; data: HealthResponse } | { status: "error" };

export function App() {
  const [apiState, setApiState] = useState<ApiState>({ status: "loading" });

  useEffect(() => {
    let active = true;

    async function checkApi() {
      try {
        const response = await api.api.health.$get();
        if (!response.ok) throw new Error("API request failed");
        const data = await response.json();
        if (active) setApiState({ status: "ready", data });
      } catch {
        if (active) setApiState({ status: "error" });
      }
    }

    void checkApi();
    return () => {
      active = false;
    };
  }, []);

  const statusLabel =
    apiState.status === "loading"
      ? "Connecting to API"
      : apiState.status === "ready"
        ? apiState.data.message
        : "API unavailable";

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/">
          Teach Everything
        </a>
        <span className={`status status--${apiState.status}`}>
          <span className="status__dot" aria-hidden="true" />
          {statusLabel}
        </span>
      </header>

      <section className="workspace">
        <p className="eyebrow">FULL-STACK TYPESCRIPT WORKSPACE</p>
        <h1>Start with a clear structure.</h1>
        <p className="intro">
          React, Hono, shared schemas, and the database layer are connected. This page also verifies
          end-to-end RPC type inference.
        </p>

        <div className="module-grid">
          <article className="module">
            <span className="module__index">01</span>
            <h2>Web</h2>
            <p>Vite + React</p>
            <code>apps/web</code>
          </article>
          <article className="module">
            <span className="module__index">02</span>
            <h2>API</h2>
            <p>Hono + Node.js</p>
            <code>apps/api</code>
          </article>
          <article className="module">
            <span className="module__index">03</span>
            <h2>Shared</h2>
            <p>Zod + TypeScript</p>
            <code>packages/shared</code>
          </article>
          <article className="module">
            <span className="module__index">04</span>
            <h2>Database</h2>
            <p>Drizzle + PostgreSQL</p>
            <code>packages/database</code>
          </article>
        </div>
      </section>
    </main>
  );
}
