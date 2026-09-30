#!/usr/bin/env node
/**
 * Parse cost in fresh isolates, measured in local workerd with the production JIT flags
 * (compilation on the request thread). For each fixture and parser, SAMPLES new isolates each
 * receive RUNS requests with one parse each, as real traffic sends them (scripts/bench-lib.mjs).
 * Reports mean ms for parse #1 (includes compiling the parser), #2–10 and #11–RUNS, plus the
 * total over all RUNS parses. Parsers are interleaved per isolate so machine drift hits them
 * alike. The local clock ticks in whole ms, so small differences on small documents are noise.
 *
 * Usage: node scripts/bench-cold.mjs <module#export>[,<module#export>…] [fixture names...]
 *   env: SAMPLES (isolates per fixture and parser, default 20), RUNS (parses per isolate, default
 *   100), INPUT=bytes (hand the parser bytes from Response.arrayBuffer())
 */
import { buildBenchWorker, mean, measureCold, trimmedMean } from "./bench-lib.mjs";
import { matrixFixtures, parserSpec } from "./workerd-run.mjs";

const [specList, ...wanted] = process.argv.slice(2);
if (!specList) {
  console.error("usage: node scripts/bench-cold.mjs <module#export>[,…] [fixture names...]");
  process.exit(2);
}
const samples = Number(process.env.SAMPLES ?? "20");
const runs = Number(process.env.RUNS ?? "100");
const specs = specList.split(",");
const keys = specs.map((_, index) => `v${index}`);
const { script } = await buildBenchWorker(
  specs.map((spec, index) => ({ key: keys[index], ...parserSpec(spec) })),
);
const fixtures = wanted.length > 0 ? wanted : matrixFixtures();

const results = await measureCold({
  script,
  keys,
  fixtures,
  isolates: samples,
  parses: runs,
  input: process.env.INPUT === "bytes" ? "bytes" : "string",
});
const lines = [
  `${samples} isolates × ${runs} requests (one parse each) per fixture and parser, production JIT flags; total = 20% trimmed mean`,
  "",
  `| fixture | parser | parse #1 ms | #2–10 ms | #11–${runs} ms | total ms |`,
  "|---|---|---:|---:|---:|---:|",
];
for (const { fixture, byKey } of results) {
  for (const [index, key] of keys.entries()) {
    const v = byKey[key];
    const cells = [mean(v.first), mean(v.early), mean(v.later), trimmedMean(v.totals)];
    lines.push(`| ${fixture} | ${specs[index]} | ${cells.map((c) => c.toFixed(2)).join(" | ")} |`);
  }
}
console.log(lines.join("\n"));
