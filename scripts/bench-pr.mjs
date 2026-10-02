#!/usr/bin/env node
/**
 * Paired local benchmark: base (default: merge-base with origin/main) against the working tree,
 * both in the same local workerd, interleaved, with production JIT flags only. Gates cold
 * (total of the first 100 parses, one per request, fresh isolates) and warm per-parse time;
 * reports retained memory as information. Thresholds, fixtures and sample sizes:
 * bench/gates.json.
 *
 * Cold runs in batches (one workerd process each). On one machine it adds batches until the 99%
 * interval is within `cold.local.targetHalfWidthPct`, or the fixture's time budget is used up.
 * With SHARD=i/n (CI), every shard measures every fixture with a fixed number of batches and one
 * warm isolate, and scripts/bench-merge.mjs combines the shards, one machine per unit.
 *
 * Usage: npm run bench:pr   (on Linux, pin it for steadier numbers: taskset -c 4,5 npm run bench:pr)
 *   env: BASE (ref), FIXTURES (comma list), METRICS (cold,warm,memory), ISOLATES (cold, per
 *        batch and variant), BATCHES (cold: fixed count, no adaptive stop), COLD_BUDGET_SEC (per
 *        fixture), WARM_ISOLATES, ROUNDS (warm), SHARD=i/n, PERF_REGRESSION_ACCEPTED=true
 *        (report regressions, exit 0)
 * Writes bench/results/perf-local.json; prints markdown (also to $GITHUB_STEP_SUMMARY).
 * Exits 1 on a gated regression.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";

import {
  batchLogRatio,
  buildBenchWorker,
  candidateInfo,
  coldRow,
  COMPATIBILITY_DATE,
  confirmColdWins,
  finalize,
  GATES,
  mean,
  measureCold,
  measureMemory,
  measureWarm,
  prepareBase,
  renderReport,
  resolveBase,
  trimmedMean,
  unitsChange,
  warmRow,
  workerdVersion,
} from "./bench-lib.mjs";
import { PROD_FLAGS } from "./v8-profiles.mjs";
import { cpuAffinity } from "./workerd-run.mjs";

const gates = GATES.local;
const shard = process.env.SHARD;
const sharded = shard !== undefined;
const [shardIndex, shardCount] = (shard ?? "1/1").split("/").map(Number);
if (!(shardIndex >= 1 && shardIndex <= shardCount)) throw new Error(`bad SHARD ${shard}`);
const fixtures = process.env.FIXTURES ? process.env.FIXTURES.split(",") : gates.fixtures;
const metrics = new Set((process.env.METRICS ?? "cold,warm,memory").split(","));
const envNumber = (name) => (process.env[name] ? Number(process.env[name]) : undefined);
/** Cold settings for one fixture: the defaults, then its entry in `cold.perFixture`. */
const coldGates = (fixture) => {
  const { perFixture, local, ...defaults } = gates.cold;
  const own = perFixture?.[fixture] ?? {};
  return { ...defaults, ...own, local: { ...local, ...own.local } };
};
/** Shards alternate which copy order they start with. */
const rotate = (list) => list.map((_, index) => list[(index + shardIndex - 1) % list.length]);

/** What a shard report keeps of one cold batch (scripts/bench-merge.mjs recomputes from it). */
function summarize(batch) {
  return {
    logRatio: batchLogRatio(batch.byKey.base.totals, batch.byKey.cand.totals),
    base: trimmedMean(batch.byKey.base.totals),
    cand: trimmedMean(batch.byKey.cand.totals),
    isolates: batch.byKey.base.totals.length,
    overheadMs: batch.overheadMs,
    order: batch.order,
    breakdown: Object.fromEntries(
      ["base", "cand"].map((key) => [
        key,
        {
          first: mean(batch.byKey[key].first),
          early: mean(batch.byKey[key].early),
          later: mean(batch.byKey[key].later),
        },
      ]),
    ),
  };
}
/**
 * The adaptive stop for one machine: another batch while the 99% half-width (one batch per unit)
 * is above the target and the budget lasts. It stops on precision, never on the result, so the
 * interval stays valid.
 */
const whileWide =
  ({ maxBatches, budget, targetHalfWidthPct }) =>
  (batches, seconds) =>
    batches.length < maxBatches &&
    seconds < budget &&
    unitsChange(batches.map((batch) => [summarize(batch).logRatio])).halfWidthPct >
      targetHalfWidthPct;

const base = prepareBase(resolveBase());
const candidate = candidateInfo();
const variants = [
  { key: "base", path: base.path },
  { key: "cand", path: candidate.path },
];
// Cold measures the first parses as a Worker without warmup() sees them; warm runs each
// variant's warmup() at module scope, as the remote check does. Both use both copy orders.
const coldBundles = [
  await buildBenchWorker(variants),
  await buildBenchWorker(variants.toReversed()),
];
const warmBundles = [
  await buildBenchWorker(variants, { warmup: true }),
  await buildBenchWorker(variants.toReversed(), { warmup: true }),
];
const hash = warmBundles.map((bundle) => bundle.hash).join(", ");
console.error(
  `base ${base.ref} (${base.sha}) → candidate ${candidate.sha}, bench Workers ${hash} (cold ${coldBundles.map((bundle) => bundle.hash).join(", ")})`,
);

const rows = [];
const notes = [];
const timings = new Set();

if (metrics.has("cold")) {
  for (const fixture of fixtures) {
    const settings = coldGates(fixture);
    const isolates = envNumber("ISOLATES") ?? settings.isolatesPerBatch;
    const fixed = envNumber("BATCHES") ?? (sharded ? settings.batchesPerShard : undefined);
    const { minBatches, maxBatches, targetHalfWidthPct, budgetSec } = settings.local;
    const budget = envNumber("COLD_BUDGET_SEC") ?? budgetSec;
    const [result] = await measureCold({
      scripts: rotate(coldBundles.map((bundle) => bundle.script)),
      keys: ["base", "cand"],
      fixtures: [fixture],
      isolates,
      parses: settings.parses,
      batches: fixed ?? minBatches,
      more: fixed === undefined ? whileWide({ maxBatches, budget, targetHalfWidthPct }) : undefined,
    });
    timings.add(result.timing);
    const batches = result.batches.map((batch) => summarize(batch));
    const seconds = result.batches.reduce((total, batch) => total + batch.seconds, 0);
    console.error(
      `cold ${fixture}: ${batches.length} batches × ${isolates} isolates per variant, ${seconds.toFixed(0)} s`,
    );
    rows.push({
      ...coldRow({
        fixture,
        units: batches.map((batch) => [batch]),
        gates,
        shape: result.shape,
        timing: result.timing,
        detail: `${batches.length} × ${isolates}`,
      }),
      detailLabel: "batches × isolates",
      raw: { batches },
    });
  }
}

if (metrics.has("warm")) {
  const isolates =
    envNumber("WARM_ISOLATES") ?? (sharded ? gates.warm.isolatesPerShard : gates.warm.isolates);
  const rounds = envNumber("ROUNDS") ?? gates.warm.rounds;
  console.error(`warm: ${fixtures.length} fixtures × ${isolates} isolates × ${rounds} rounds`);
  const warm = await measureWarm({
    scripts: rotate(warmBundles.map((bundle) => bundle.script)),
    keys: ["base", "cand"],
    fixtures,
    isolates,
    rounds,
    burstMs: gates.warm.burstMs,
    jitter: gates.warm.jitter,
  });
  for (const { fixture, perIsolate, timing } of warm) {
    timings.add(timing);
    rows.push({
      ...warmRow({ fixture, perIsolate, gates, timing }),
      detailLabel: "per isolate",
      raw: { perIsolate },
    });
  }
}

// After warm, so that cold wins below the threshold can be checked against their warm row.
confirmColdWins(rows);
if (sharded) {
  // One shard sees one machine and one warm isolate, whose two parser copies can settle several
  // percent apart; the gate applies to the merged report (scripts/bench-merge.mjs) only.
  for (const r of rows) r.gated = false;
  notes.push(
    `Shard ${shard}: report only. The gate applies to the merged report of all shards (perf-local).`,
  );
}

if (metrics.has("memory") && gates.memory.report && shardIndex === 1) {
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
  affinity: cpuAffinity(),
  metricVersion: 2,
  timing: [...timings].join(", "),
  bundleHash: hash,
  coldBundleHash: coldBundles.map((bundle) => bundle.hash).join(", "),
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
