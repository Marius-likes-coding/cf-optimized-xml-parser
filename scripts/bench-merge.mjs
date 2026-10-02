#!/usr/bin/env node
/**
 * Merges the reports of the CI shards (`SHARD=i/n npm run bench:pr`, one per runner) into one
 * bench/results/perf-local.json. Every shard measures every fixture, base and candidate paired on
 * the same runner, so each row is recomputed from all runners: cold as a t-interval over runners
 * (each runner's mean batch log ratio), warm over all runners' isolates. Differences between
 * machines (GitHub assigns several CPU models) are inside the intervals instead of deciding a
 * row through the one machine it happened to run on. The last column splits the change by CPU
 * vendor.
 *
 * Usage: node scripts/bench-merge.mjs <shard report.json>...
 * Prints markdown (also to $GITHUB_STEP_SUMMARY). Exits 1 on a gated regression (unless
 * PERF_REGRESSION_ACCEPTED=true) or when a shard report is missing or doesn't match the others.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  coldRow,
  confirmColdWins,
  finalize,
  GATES,
  mean,
  renderReport,
  vendorOf,
  warmRow,
} from "./bench-stats.mjs";

const paths = process.argv.slice(2).filter((path) => existsSync(path));
const shards = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));
const expected = GATES.local.shards;
const problems = [];
if (shards.length !== expected) {
  problems.push(`Expected ${expected} shard reports, found ${shards.length}: see the shard jobs.`);
}
const [first] = shards;
if (!first) {
  console.error(problems.join("\n"));
  process.exit(1);
}
for (const shard of shards) {
  if (shard.base.sha !== first.base.sha || shard.candidate.sha !== first.candidate.sha) {
    problems.push(
      `Shard ${shard.shard} compared ${shard.base.sha} → ${shard.candidate.sha}, not ${first.base.sha} → ${first.candidate.sha}.`,
    );
  }
}

const metricOrder = ["total-100", "warm", "memory"];
const fixtureOrder = GATES.local.fixtures;
const rank = (value, order) => (order.includes(value) ? order.indexOf(value) : order.length);
const pct = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
/** Change per CPU vendor, e.g. "AMD −2.1% (12) · Intel −3.0% (4)". */
function byVendor(entries) {
  const groups = new Map();
  for (const { cpu, changePct } of entries) {
    const vendor = vendorOf(cpu);
    groups.set(vendor, [...(groups.get(vendor) ?? []), changePct]);
  }
  return [...groups]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([vendor, values]) => `${vendor} ${pct(mean(values))} (${values.length})`)
    .join(" · ");
}

const rows = [];
const fixtures = [...new Set(shards.flatMap((shard) => shard.fixtures))];
for (const fixture of fixtures) {
  const cold = shards
    .map((shard) => ({
      shard,
      row: shard.rows.find((r) => r.metric === "total-100" && r.fixture === fixture),
    }))
    .filter(({ row }) => row?.raw);
  if (cold.length > 0) {
    const units = cold.map(({ row }) => row.raw.batches);
    rows.push({
      ...coldRow({
        fixture,
        units,
        gates: GATES.local,
        shape: cold[0].row.shape,
        timing: cold[0].row.timing,
        detail: byVendor(
          cold.map(({ shard, row }) => ({
            cpu: shard.cpu,
            changePct: (Math.exp(mean(row.raw.batches.map((b) => b.logRatio))) - 1) * 100,
          })),
        ),
      }),
      detailLabel: "by CPU vendor (runners)",
    });
  }
  const warm = shards
    .map((shard) => ({
      shard,
      row: shard.rows.find((r) => r.metric === "warm" && r.fixture === fixture),
    }))
    .filter(({ row }) => row?.raw);
  if (warm.length > 0) {
    const perIsolate = warm.flatMap(({ row }) => row.raw.perIsolate);
    const merged = warmRow({ fixture, perIsolate, gates: GATES.local, timing: warm[0].row.timing });
    rows.push({
      ...merged,
      detail: byVendor(
        warm.map(({ shard, row }) => ({
          cpu: shard.cpu,
          changePct: warmRow({ fixture, perIsolate: row.raw.perIsolate, gates: GATES.local })
            .changePct,
        })),
      ),
      detailLabel: "by CPU vendor (runners)",
    });
  }
  rows.push(
    ...shards.flatMap((shard) =>
      shard.rows.filter((r) => r.metric === "memory" && r.fixture === fixture),
    ),
  );
}
rows.sort(
  (a, b) =>
    rank(a.metric, metricOrder) - rank(b.metric, metricOrder) ||
    rank(a.fixture, fixtureOrder) - rank(b.fixture, fixtureOrder),
);
confirmColdWins(rows);
const cpus = [...new Set(shards.map((shard) => shard.cpu))];
const vendorCounts = new Map();
for (const shard of shards) {
  const vendor = vendorOf(shard.cpu);
  vendorCounts.set(vendor, (vendorCounts.get(vendor) ?? 0) + 1);
}
const vendors = [...vendorCounts].map(([vendor, count]) => `${count} ${vendor}`).join(", ");

const report = finalize({
  ...first,
  timestamp: new Date().toISOString(),
  shard: null,
  shards: shards.map(({ shard, cpu, affinity, bundleHash }) => ({
    shard,
    cpu,
    affinity,
    bundleHash,
  })),
  fixtures,
  cpu: cpus.join(" | "),
  rows,
  notes: [
    ...problems,
    `Measured on ${shards.length} runner${shards.length === 1 ? "" : "s"} in parallel (${vendors}), every fixture on every runner, base and candidate paired on each: ${cpus.join("; ")}.`,
  ],
});

mkdirSync("bench/results", { recursive: true });
writeFileSync("bench/results/perf-local.json", JSON.stringify(report, null, 2) + "\n");
const markdown = renderReport(report);
console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
if ((report.regressions > 0 && !report.accepted) || problems.length > 0) process.exitCode = 1;
