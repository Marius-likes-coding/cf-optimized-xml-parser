import { defineConfig } from "tsdown";

export default defineConfig({
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
