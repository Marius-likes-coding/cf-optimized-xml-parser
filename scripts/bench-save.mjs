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
 *   name, hz, mean (ms), min, max, median, p75, p99, sampleCount }] }] }] }
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
      results.push({
        name: `${group.fullName ?? f.filepath ?? ""} > ${b.name}`,
        hz: b.hz ?? null,
        avgMs: b.mean ?? null,
        minMs: b.min ?? null,
        maxMs: b.max ?? null,
        p50Ms: b.median ?? b.p50 ?? null,
        p99Ms: b.p99 ?? null,
        samples: b.sampleCount ?? null,
      });
    }
  }
  // Fallback for alternate shapes (tasks / flat benchmarks)
  for (const task of f.tasks ?? []) {
    const r = task.result?.benchmark ?? task.result ?? {};
    results.push({
      name: `${f.name ?? f.filepath ?? ""} > ${task.name ?? "unknown"}`,
      hz: r.hz ?? null,
      avgMs: r.mean ?? null,
      minMs: r.min ?? null,
      maxMs: r.max ?? null,
      p50Ms: r.median ?? r.p50 ?? null,
      p99Ms: r.p99 ?? null,
      samples: r.sampleCount ?? null,
    });
  }
}

mkdirSync("bench/results", { recursive: true });
writeFileSync(
  output,
  JSON.stringify({ sha: gitSha(), timestamp: new Date().toISOString(), results }, null, 2) + "\n",
);
console.log(`Saved ${results.length} results to ${output}`);
