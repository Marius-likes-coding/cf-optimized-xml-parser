#!/usr/bin/env node
/**
 * Convert `vitest bench --run --outputJson` output into the canonical
 * bench/results/current.json schema used by compare/trend.
 *
 * Usage:
 *   vitest bench --run --outputJson=bench/results/vitest-bench.json
 *   node scripts/bench-save.mjs [input] [output]
 *
 * Vitest bench JSON shape: { files: [{ filepath, groups: [{ fullName, benchmarks: [{
 *   name, hz, rme (%), mean (ms), min, max, median, p75, p99, sampleCount }] }] }] }
 */
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const input = process.argv[2] ?? "bench/results/vitest-bench.json";
const output = process.argv[3] ?? "bench/results/current.json";

function gitSha() {
  try {
    return execSync("git rev-parse --short HEAD 2>/dev/null").toString().trim() || "unknown";
  } catch {
    return "unknown";
  }
}

const raw = JSON.parse(readFileSync(input, "utf8"));
const results = [];
for (const f of raw.files ?? []) {
  for (const group of f.groups ?? []) {
    for (const b of group.benchmarks ?? []) {
      // bench/harness.ts names cases `<name> [×N]`, one sample = N passes; store per-pass numbers.
      const match = /^(.*) \[×(\d+)\]$/.exec(b.name);
      const repeats = match ? Number(match[2]) : 1;
      const perPass = (ms) => (ms == null ? null : ms / repeats);
      results.push({
        name: `${group.fullName ?? f.filepath ?? ""} > ${match ? match[1] : b.name}`,
        hz: b.hz == null ? null : b.hz * repeats,
        rme: b.rme ?? null,
        avgMs: perPass(b.mean),
        minMs: perPass(b.min),
        maxMs: perPass(b.max),
        p50Ms: perPass(b.median),
        p99Ms: perPass(b.p99),
        samples: b.sampleCount ?? null,
        repeats,
      });
    }
  }
}

mkdirSync("bench/results", { recursive: true });
writeFileSync(
  output,
  JSON.stringify({ sha: gitSha(), timestamp: new Date().toISOString(), results }, null, 2) + "\n",
);
console.log(`Saved ${results.length} results to ${output}`);
