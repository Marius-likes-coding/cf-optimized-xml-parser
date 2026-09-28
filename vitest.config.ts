import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
    }),
  ],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "workers",
          pool: "@cloudflare/vitest-pool-workers",
          include: ["test/**/*.test.ts"],
          // Top-level bench/ only: this project feeds the CI regression gate.
          benchmark: { include: ["bench/*.bench.ts"] },
        },
      },
      {
        // Competitor parsers on the fixture matrix. Reference numbers, not a CI gate.
        extends: true,
        test: {
          name: "compare",
          pool: "@cloudflare/vitest-pool-workers",
          include: [],
          benchmark: { include: ["bench/compare/**/*.bench.ts"] },
        },
      },
      {
        // Throwaway design experiments (see research/spikes/). Never shipped.
        extends: true,
        test: {
          name: "spikes",
          pool: "@cloudflare/vitest-pool-workers",
          include: [],
          benchmark: { include: ["spikes/**/*.bench.ts"] },
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
    },
  },
});
