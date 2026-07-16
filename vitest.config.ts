import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "apps/*",
      "packages/*",
      {
        test: {
          environment: "node",
          include: ["ops/**/*.test.ts"],
          name: "ops-observability",
        },
      },
    ],
  },
});
