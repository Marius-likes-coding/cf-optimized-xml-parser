#!/usr/bin/env node
/**
 * Paired local benchmark: base (default: merge-base with origin/main) against the working tree,
 * both in the same local workerd, interleaved, with production JIT flags only. Gates cold
 * (total of the first 100 parses, one per request, fresh isolates) and warm per-parse time;
 * reports retained memory as information. Thresholds and fixtures: bench/gates.json.
 *
 * Usage: npm run bench:pr
 *   env: BASE (ref), FIXTURES (comma list), METRICS (cold,warm,memory), ISOLATES, ROUNDS,
 *        PERF_REGRESSION_ACCEPTED=true (report regressions, exit 0)
 * Writes bench/results/perf-local.json; prints markdown (also to $GITHUB_STEP_SUMMARY).
 * Exits 1 on a gated regression.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

import {
  buildBenchWorker,
  candidateInfo,
  change,
  COMPATIBILITY_DATE,
  finalize,
  GATES,
  mean,
  measureCold,
  measureMemory,
  measureWarm,
  pairedTrimmedRatio,
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
const fixtures = process.env.FIXTURES ? process.env.FIXTURES.split(",") : gates.fixtures;
const metrics = new Set((process.env.METRICS ?? "cold,warm,memory").split(","));
const isolates = Number(process.env.ISOLATES ?? gates.cold.isolates);
const rounds = Number(process.env.ROUNDS ?? gates.warm.rounds);

const base = prepareBase(resolveBase());
const candidate = candidateInfo();
const variants = [
  { key: "base", path: base.path },
  { key: "cand", path: candidate.path },
];
// Cold measures the first parses as a Worker without warmup() sees them; warm uses the same
// bundle as the remote check, with each variant's warmup() at module scope.
const cold = await buildBenchWorker(variants);
const warmBundle = await buildBenchWorker(variants, { warmup: true });
const hash = warmBundle.hash;
console.error(
  `base ${base.ref} (${base.sha}) → candidate ${candidate.sha}, bench Worker ${hash} (cold ${cold.hash})`,
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
  console.error(`warm: ${fixtures.length} fixtures × ${rounds} rounds`);
  const warm = await measureWarm({
    script: warmBundle.script,
    keys: ["base", "cand"],
    fixtures,
    rounds,
    burstMs: gates.warm.burstMs,
  });
  for (const { fixture, samples } of warm) {
    const pairs = samples.base.map((value, index) => [value, samples.cand[index]]);
    rows.push(
      row({
        metric: "warm",
        fixture,
        unit: "µs",
        base: trimmedMean(samples.base),
        cand: trimmedMean(samples.cand),
        stats: change([pairs], pairedTrimmedRatio),
        thresholdPct: gates.warm.thresholdPct,
        gated: true,
      }),
    );
  }
}

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
