import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import unicorn from "eslint-plugin-unicorn";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".wrangler/**",
      "coverage/**",
      "bench/results/**",
      "bench/history/**",
      "test/fixtures/generated/**",
      "src/worker-configuration.d.ts",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  unicorn.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "unicorn/prefer-top-level-await": "off",
      "unicorn/no-array-callback-reference": "off",
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "node:buffer", message: "Use TextDecoder/TextEncoder instead (Workers-safe)." },
            { name: "node:fs", message: "No fs in library code." },
          ],
          patterns: [
            { group: ["node:*"], message: "Library must stay Workers-safe (Web APIs only)." },
          ],
        },
      ],
    },
  },
  {
    // Files outside any tsconfig have no type information — switch off typed rules.
    files: ["scripts/**/*.mjs", "eslint.config.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Node tooling runs outside workerd, so Node APIs and console are fine here.
    files: ["scripts/**/*.mjs", "bench/**/*.ts", "vitest.config.ts", "tsdown.config.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "unicorn/prevent-abbreviations": "off",
      "unicorn/no-array-sort": "off",
      "unicorn/no-null": "off",
      "unicorn/import-style": "off",
      "unicorn/no-negated-condition": "off",
    },
  },
  {
    // Tests run in workerd: browser-ish globals.
    files: ["test/**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      "unicorn/prevent-abbreviations": "off",
    },
  },
  {
    files: ["src/bench-worker.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "unicorn/prevent-abbreviations": "off",
    },
  },
);
