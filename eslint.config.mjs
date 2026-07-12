import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import betterTailwindcss from "eslint-plugin-better-tailwindcss";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import path from "node:path";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint-define-config";

export default defineConfig(
  {
    ignores: ["**/dist/**", "**/node_modules/**", ".pnpm-store/**", "packages/database/drizzle/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: {
      globals: globals.es2025,
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "func-style": [
        "error",
        "expression",
        {
          allowArrowFunctions: true,
          overrides: { namedExports: "expression" },
        },
      ],
    },
  },
  {
    files: [
      ".codex/hooks/**/*.{js,mjs}",
      "apps/api/**/*.{ts,js}",
      "packages/database/**/*.{ts,js}",
      "**/*.config.{js,mjs,ts}",
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["apps/**/src/**/*.{ts,tsx}", "packages/**/src/**/*.{ts,tsx}", "**/*.config.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-deprecated": "error",
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    ...reactHooks.configs.flat["recommended-latest"],
    plugins: {
      "better-tailwindcss": betterTailwindcss,
      ...reactHooks.configs.flat["recommended-latest"].plugins,
      "react-refresh": reactRefresh,
    },
    languageOptions: {
      globals: globals.browser,
    },
    settings: {
      "better-tailwindcss": {
        cwd: path.join(import.meta.dirname, "apps/web"),
        entryPoint: "./src/styles.css",
      },
    },
    rules: {
      ...reactHooks.configs.flat["recommended-latest"].rules,
      "better-tailwindcss/enforce-canonical-classes": "error",
      "better-tailwindcss/no-conflicting-classes": "error",
      "better-tailwindcss/no-deprecated-classes": "error",
      "better-tailwindcss/no-duplicate-classes": "error",
      "better-tailwindcss/no-unnecessary-whitespace": "error",
      "better-tailwindcss/no-unknown-classes": [
        "error",
        {
          ignore: ["^aui-", "^shimmer$"],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  prettier,
);
