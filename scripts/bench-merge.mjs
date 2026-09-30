#!/usr/bin/env node
/**
 * Merges the reports of the CI shards (`SHARD=i/n npm run bench:pr`, one per runner) into one
 * bench/results/perf-local.json. Each fixture's base and candidate ran on the same runner, so
 * the comparisons stay paired; only absolute numbers differ between fixtures.
 *
 * Usage: node scripts/bench-merge.mjs <shard report.json>...
 * Prints markdown (also to $GITHUB_STEP_SUMMARY). Exits 1 on a gated regression (unless
 * PERF_REGRESSION_ACCEPTED=true) or when a shard report is missing or doesn't match the others.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { finalize, GATES, renderReport } from "./bench-stats.mjs";

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
const rows = shards
  .flatMap((shard) => shard.rows)
  // finalize() below applies the override label again and counts the regressions.
  .map((r) => (r.status === "accepted" ? { ...r, status: "regression" } : r))
  .toSorted(
    (a, b) =>
      rank(a.metric, metricOrder) - rank(b.metric, metricOrder) ||
      rank(a.fixture, fixtureOrder) - rank(b.fixture, fixtureOrder),
  );
const cpus = [...new Set(shards.map((shard) => shard.cpu))];

const report = finalize({
  ...first,
  timestamp: new Date().toISOString(),
  shard: null,
  shards: shards.map(({ shard, fixtures, cpu, bundleHash }) => ({
    shard,
    fixtures,
    cpu,
    bundleHash,
  })),
  fixtures: shards.flatMap((shard) => shard.fixtures),
  cpu: cpus.join(" | "),
  rows,
  notes: [
    ...problems,
    `Measured on ${shards.length} runner${shards.length === 1 ? "" : "s"} in parallel, each fixture's base and candidate on the same one (${cpus.join("; ")}).`,
  ],
});

mkdirSync("bench/results", { recursive: true });
writeFileSync("bench/results/perf-local.json", JSON.stringify(report, null, 2) + "\n");
const markdown = renderReport(report);
console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
if ((report.regressions > 0 && !report.accepted) || problems.length > 0) process.exitCode = 1;
