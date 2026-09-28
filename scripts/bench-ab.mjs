#!/usr/bin/env node
/**
 * Drift-resistant A/B comparison of parser variants in local workerd.
 *
 * Machine drift here reaches 20–50% between minutes, larger than the effects design spikes
 * look for. So all variants live in one isolate, and each round runs a ~BURST_MS burst of
 * every variant back to back in rotating order. Drift then hits every variant alike; the
 * median over ROUNDS bursts is reported. Round 1 is a warm-up and is discarded.
 *
 * Usage: node scripts/bench-ab.mjs <module#export>,<module#export>[,…] [fixture names...]
 *   env: PROFILES (comma list from scripts/v8-profiles.mjs, default all), ROUNDS (default 11),
 *        BURST_MS (default 30)
 * The first module is the baseline; other columns show the median change against it.
 */
import { readFileSync } from "node:fs";

import { PROFILES } from "./v8-profiles.mjs";
import {
  bundleWorker,
  MATRIX_DIR,
  matrixFixtures,
  parserSpec,
  startWorkerd,
} from "./workerd-run.mjs";

/** INPUT=bytes hands the parser a Uint8Array (from arrayBuffer()) instead of a string. */
const INPUT_EXPR =
  process.env.INPUT === "bytes"
    ? "new Uint8Array(await request.arrayBuffer())"
    : "await request.text()";

const [specList, ...wanted] = process.argv.slice(2);
if (!specList) {
  console.error(
    "usage: node scripts/bench-ab.mjs <module#export>,<module#export>[,…] [fixtures...]",
  );
  process.exit(2);
}
const specs = specList.split(",");
const names = wanted.length > 0 ? wanted : matrixFixtures();
const profiles = (process.env.PROFILES ?? Object.keys(PROFILES).join(",")).split(",");
const rounds = Number(process.env.ROUNDS ?? "11");
const burstMs = Number(process.env.BURST_MS ?? "30");

const imports = specs
  .map((spec, index) => {
    const parser = parserSpec(spec);
    return `import { ${parser.exportName} as p${index} } from ${JSON.stringify(parser.path)};`;
  })
  .join("\n");
const script = await bundleWorker(`${imports}
const parsers = [${specs.map((_, index) => `p${index}`).join(", ")}];
let input = null;
// Not exported: workerd treats every named export of the main module as an entrypoint.
let sink = null;
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/load") { input = ${INPUT_EXPR}; return new Response("ok"); }
    const parse = parsers[Number(url.searchParams.get("v"))];
    const n = Number(url.searchParams.get("n"));
    try {
      const start = performance.now();
      for (let index = 0; index < n; index++) sink = parse(input);
      return Response.json({ ms: performance.now() - start, result: typeof sink });
    } catch (error) {
      return new Response(String(error), { status: 500 });
    }
  },
};`);

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Runs `n` parses of one variant in the isolate and returns the elapsed ms. */
async function burst(worker, variant, n) {
  const response = await worker.fetch(`http://ab/burst?v=${variant}&n=${n}`);
  if (!response.ok) throw new Error(await response.text());
  const { ms } = await response.json();
  return ms;
}

for (const profile of profiles) {
  const mf = await startWorkerd({ script, flags: PROFILES[profile] });
  const worker = await mf.getWorker("main");
  const header = `| fixture | ${specs.map((spec, index) => (index === 0 ? `${spec} µs` : spec)).join(" | ")} |`;
  const lines = [
    `\nProfile ${profile}: median of ${rounds - 1} rounds × ~${burstMs} ms bursts`,
    "",
    header,
    `|---|${specs.map(() => "---:").join("|")}|`,
  ];
  for (const name of names) {
    const xml = readFileSync(`${MATRIX_DIR}/${name}.xml`, "utf8");
    const loaded = await worker.fetch("http://ab/load", { method: "POST", body: xml });
    await loaded.text();
    try {
      // Calibrate each variant's burst size so one burst takes about burstMs.
      const counts = [];
      for (let variant = 0; variant < specs.length; variant++) {
        let n = 1;
        let ms = await burst(worker, variant, n);
        while (ms < burstMs / 4 && n < 1_000_000) {
          n *= 4;
          ms = await burst(worker, variant, n);
        }
        counts.push(Math.max(1, Math.round((n * burstMs) / Math.max(ms, 1))));
      }
      const samples = specs.map(() => []);
      for (let round = 0; round < rounds; round++) {
        for (let step = 0; step < specs.length; step++) {
          const variant = (round + step) % specs.length;
          const ms = await burst(worker, variant, counts[variant]);
          if (round > 0) samples[variant].push((ms * 1000) / counts[variant]);
        }
      }
      const medians = samples.map((values) => median(values));
      const cells = medians.map((value, index) =>
        index === 0
          ? value.toFixed(1)
          : `${value.toFixed(1)} (${((value / medians[0] - 1) * 100).toFixed(0).replace(/^(?!-)/, "+")}%)`,
      );
      lines.push(`| ${name} | ${cells.join(" | ")} |`);
    } catch (error) {
      lines.push(`| ${name} | error: ${String(error.message).slice(0, 80)} |`);
    }
  }
  await mf.dispose();
  console.log(lines.join("\n"));
}
