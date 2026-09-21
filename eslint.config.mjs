import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import importX from "eslint-plugin-import-x";
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
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
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
      // import-x resolver is noisy with TS project service + ?raw + .js->.ts mapping.
      // TypeScript itself validates imports; keep only stylistic import rules.
      "import-x/no-unresolved": "off",
      "import-x/namespace": "off",
      "import-x/no-duplicates": "off",
      "import-x/default": "off",
      "import-x/no-named-as-default": "off",
      "import-x/no-named-as-default-member": "off",
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
    files: ["scripts/**/*.mjs", "scripts/**/*.ts"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Node tooling: scripts, bench loaders, configs run in Node/CI.
    files: [
      "scripts/**/*.mjs",
      "bench/**/*.ts",
      "vitest.config.ts",
      "tsdown.config.ts",
      "eslint.config.mjs",
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "no-restricted-imports": "off",
      "unicorn/prevent-abbreviations": "off",
      "unicorn/no-array-sort": "off",
      "unicorn/no-null": "off",
      "unicorn/import-style": "off",
      "unicorn/no-negated-condition": "off",
      "no-console": "off",
    },
  },
  {
    // Tests run in workerd: browser-ish globals + console for debugging.
    files: ["test/**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser, console: "readonly" },
    },
    rules: {
      "no-restricted-imports": "off",
      "unicorn/prevent-abbreviations": "off",
    },
  },
  {
    files: ["src/bench-worker.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
      "unicorn/prevent-abbreviations": "off",
      "unicorn/prefer-at": "off",
    },
  },
  {
    files: ["**/*.d.ts"],
    rules: {
      "unicorn/prevent-abbreviations": "off",
    },
  },
  {
    files: ["eslint.config.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
);
