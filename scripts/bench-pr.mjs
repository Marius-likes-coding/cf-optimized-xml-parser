#!/usr/bin/env node
/**
 * Paired local benchmark: base (default: merge-base with origin/main) against the working tree,
 * both in the same local workerd, interleaved, with production JIT flags only. Gates cold
 * (total of the first 100 parses, one per request, fresh isolates) and warm per-parse time;
 * reports retained memory as information. Thresholds and fixtures: bench/gates.json.
 *
 * Usage: npm run bench:pr
 *   env: BASE (ref), FIXTURES (comma list), METRICS (cold,warm,memory), ISOLATES (cold),
 *        WARM_ISOLATES, ROUNDS (warm), SHARD=i/n (every n-th fixture from the i-th; CI runs the
 *        shards on parallel runners and merges them with scripts/bench-merge.mjs),
 *        PERF_REGRESSION_ACCEPTED=true (report regressions, exit 0)
 * Writes bench/results/perf-local.json; prints markdown (also to $GITHUB_STEP_SUMMARY).
 * Exits 1 on a gated regression.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";

import {
  buildBenchWorker,
  candidateInfo,
  change,
  COMPATIBILITY_DATE,
  confirmColdWins,
  finalize,
  GATES,
  isolateChange,
  mean,
  measureCold,
  measureMemory,
  measureWarm,
  prepareBase,
  ratioOfTrimmedMeans,
  renderReport,
  resolveBase,
  row,
  trimmedMean,
  workerdVersion,
} from "./bench-lib.mjs";
import { PROD_FLAGS } from "./v8-profiles.mjs";

const gates = GATES.local;
const shard = process.env.SHARD;
const [shardIndex, shardCount] = (shard ?? "1/1").split("/").map(Number);
if (!(shardIndex >= 1 && shardIndex <= shardCount)) throw new Error(`bad SHARD ${shard}`);
const fixtures = (process.env.FIXTURES ? process.env.FIXTURES.split(",") : gates.fixtures).filter(
  (_, index) => index % shardCount === shardIndex - 1,
);
const metrics = new Set((process.env.METRICS ?? "cold,warm,memory").split(","));
const isolates = Number(process.env.ISOLATES ?? gates.cold.isolates);
const warmIsolates = Number(process.env.WARM_ISOLATES ?? gates.warm.isolates);
const rounds = Number(process.env.ROUNDS ?? gates.warm.rounds);

const base = prepareBase(resolveBase());
const candidate = candidateInfo();
const variants = [
  { key: "base", path: base.path },
  { key: "cand", path: candidate.path },
];
// Cold measures the first parses as a Worker without warmup() sees them. Warm uses the same
// bundles as the remote check: each variant's warmup() at module scope, both copy orders.
const cold = await buildBenchWorker(variants);
const warmBundles = [
  await buildBenchWorker(variants, { warmup: true }),
  await buildBenchWorker(variants.toReversed(), { warmup: true }),
];
const hash = warmBundles.map((bundle) => bundle.hash).join(", ");
console.error(
  `base ${base.ref} (${base.sha}) → candidate ${candidate.sha}, bench Workers ${hash} (cold ${cold.hash})`,
);

const rows = [];
const notes = [];

if (metrics.has("cold")) {
  console.error(`cold: ${fixtures.length} fixtures × ${isolates} isolates per variant`);
  const coldResults = await measureCold({
    script: cold.script,
    keys: ["base", "cand"],
    fixtures,
    isolates,
    parses: gates.cold.parses,
  });
  for (const { fixture, shape, byKey } of coldResults) {
    rows.push(
      row({
        metric: "total-100",
        fixture,
        unit: "ms",
        base: trimmedMean(byKey.base.totals),
        cand: trimmedMean(byKey.cand.totals),
        stats: change([byKey.base.totals, byKey.cand.totals], ratioOfTrimmedMeans),
        thresholdPct: gates.cold.thresholdPct,
        improvementPct: gates.cold.improvementPct,
        gated: true,
      }),
    );
    rows.at(-1).shape = shape;
    rows.at(-1).breakdown = Object.fromEntries(
      Object.entries(byKey).map(([key, v]) => [
        key,
        { first: mean(v.first), early: mean(v.early), later: mean(v.later) },
      ]),
    );
  }
}

if (metrics.has("warm")) {
  console.error(`warm: ${fixtures.length} fixtures × ${warmIsolates} isolates × ${rounds} rounds`);
  const warm = await measureWarm({
    scripts: warmBundles.map((bundle) => bundle.script),
    keys: ["base", "cand"],
    fixtures,
    isolates: warmIsolates,
    rounds,
    burstMs: gates.warm.burstMs,
    jitter: gates.warm.jitter,
  });
  for (const { fixture, perIsolate } of warm) {
    const groups = perIsolate.map((samples) =>
      samples.base.map((value, index) => [value, samples.cand[index]]),
    );
    const { perIsolatePct, ...stats } = isolateChange(groups);
    rows.push({
      ...row({
        metric: "warm",
        fixture,
        unit: "µs",
        base: mean(perIsolate.map((samples) => trimmedMean(samples.base))),
        cand: mean(perIsolate.map((samples) => trimmedMean(samples.cand))),
        stats,
        thresholdPct: gates.warm.thresholdPct,
        improvementPct: gates.warm.improvementPct,
        gated: true,
      }),
      detail: perIsolatePct
        .map((value) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}`)
        .join(" / "),
    });
  }
}

// After warm, so that cold wins below the threshold can be checked against their warm row.
confirmColdWins(rows);

if (metrics.has("memory") && gates.memory.report) {
  console.error("memory (lab measurement, not gated)");
  const memory = await measureMemory({ variants, fixtures });
  for (const { fixture, byKey } of memory) {
    const baseKb = byKey.base.treeKb;
    const candKb = byKey.cand.treeKb;
    rows.push({
      metric: "memory",
      fixture,
      unit: "KB",
      base: baseKb,
      cand: candKb,
      changePct: (candKb / baseKb - 1) * 100,
      gated: false,
      status: "info",
    });
  }
}

const report = finalize({
  kind: "local",
  timestamp: new Date().toISOString(),
  base,
  candidate,
  shard: shard ?? null,
  fixtures,
  cpu: cpus()[0]?.model ?? "unknown",
  bundleHash: hash,
  coldBundleHash: cold.hash,
  workerd: workerdVersion(),
  flags: PROD_FLAGS,
  compatibilityDate: COMPATIBILITY_DATE,
  rows,
  notes,
});

mkdirSync("bench/results", { recursive: true });
writeFileSync("bench/results/perf-local.json", JSON.stringify(report, null, 2) + "\n");
const markdown = renderReport(report);
console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
if (report.regressions > 0 && !report.accepted) process.exitCode = 1;
