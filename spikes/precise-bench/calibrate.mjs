#!/usr/bin/env node
/**
 * Calibration of A/A runs (base = candidate): for each metric, the median 99% half-width per
 * fixture, how many intervals exclude 0 (expected: 1% of rows), and the standard deviation of
 * z = change / (half-width / 2.576), which is about 1 when the intervals are honest (larger: too
 * narrow, smaller: too wide). Also prints the mean change per fixture over the runs, to spot a
 * lean that repeats.
 *
 * Usage: node spikes/precise-bench/calibrate.mjs <merged perf-local.json>...
 */
import { readFileSync } from "node:fs";

const z99 = 2.576;
const reports = process.argv.slice(2).map((path) => JSON.parse(readFileSync(path, "utf8")));
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

for (const metric of ["total-100", "warm"]) {
  const rows = reports.flatMap((report) => report.rows.filter((r) => r.metric === metric));
  const zs = rows.map((r) => r.changePct / ((r.highPct - r.lowPct) / 2 / z99));
  const excluding = rows.filter((r) => r.lowPct > 0 || r.highPct < 0);
  console.log(
    `${metric}: ${rows.length} rows from ${reports.length} runs · sd(z) ${Math.sqrt(mean(zs.map((z) => z * z))).toFixed(2)} · intervals excluding 0: ${excluding.length} (expected ${(rows.length / 100).toFixed(1)}) · statuses: ${[...new Set(rows.map((r) => r.status))].join(", ")}`,
  );
  for (const fixture of new Set(rows.map((r) => r.fixture))) {
    const own = rows.filter((r) => r.fixture === fixture);
    console.log(
      `  ${fixture.padEnd(12)} half-width ±${median(own.map((r) => (r.highPct - r.lowPct) / 2)).toFixed(2)}% · mean change ${mean(own.map((r) => r.changePct)).toFixed(2)}% · changes ${own.map((r) => r.changePct.toFixed(1)).join(" ")}`,
    );
  }
}
