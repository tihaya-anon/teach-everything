import { healthResponseSchema } from "@teach-everything/shared";
import { describe, expect, it } from "vitest";
import { app } from "./app";

describe("GET /api/health", () => {
  it("returns a successful health response", async () => {
    // Given
    const request = new Request("http://localhost/api/health");

    // When
    const response = await app.request(request);
    const body: unknown = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(healthResponseSchema.safeParse(body).success).toBe(true);
  });
});

describe("POST /api/agent-runs", () => {
  it("does not expose the Agent Run route when no executor is configured", async () => {
    // Given
    const request = new Request("http://localhost/api/agent-runs", { method: "POST" });

    // When
    const response = await app.request(request);

    // Then
    expect(response.status).toBe(404);
  });
});
