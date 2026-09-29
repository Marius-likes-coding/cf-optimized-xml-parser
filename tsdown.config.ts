import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

// semantic-release writes the new version to package.json before `npm publish` runs prepack
// (this build), so the published VERSION export matches the package.
const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

export default defineConfig({
  define: { __VERSION__: JSON.stringify(version) },
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "esnext",
  dts: true,
  sourcemap: true,
  minify: false,
  clean: true,
  treeshake: true,
  platform: "neutral",
  outDir: "dist",
});
