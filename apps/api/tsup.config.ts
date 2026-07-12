import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  entry: ["src/index.ts", "src/instrumentation.ts"],
  format: ["esm"],
  noExternal: ["@teach-everything/observability", "@teach-everything/shared"],
  sourcemap: true,
});
