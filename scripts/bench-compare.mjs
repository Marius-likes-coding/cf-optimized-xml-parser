#!/usr/bin/env node
/**
 * Compare baseline vs current benchmark JSON.
 * - Reads bench/results/baseline.json + bench/results/current.json
 * - Prints markdown table (also to $GITHUB_STEP_SUMMARY when present)
 * - Exits 1 when any case regresses more than REGRESSION_THRESHOLD (default 10%)
 *   and more than the two runs' combined relative margin of error (rme).
 *
 * Schema per file: { sha, timestamp, results: [{ name, hz, rme, avgMs, ... }] }
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const baselinePath = process.argv[2] ?? "bench/results/baseline.json";
const currentPath = process.argv[3] ?? "bench/results/current.json";
const threshold = Number(process.env.REGRESSION_THRESHOLD ?? "10");

function load(p) {
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

const baseline = load(baselinePath);
const current = load(currentPath);

if (!current) {
  console.error(`No current results at ${currentPath}. Run bench first.`);
  process.exit(2);
}
if (!baseline) {
  console.log(`No baseline at ${baselinePath} — skipping comparison (first run).`);
  process.exit(0);
}

const baseByName = new Map(baseline.results.map((r) => [r.name, r]));
let regressions = 0;
const rows = [];
for (const cur of current.results) {
  const base = baseByName.get(cur.name);
  if (!base || base.hz == null || cur.hz == null) {
    rows.push(`| ${cur.name} | n/a | ${cur.hz?.toFixed(1) ?? "n/a"} | n/a | ⚪ no-baseline |`);
    continue;
  }
  const deltaPct = ((cur.hz - base.hz) / base.hz) * 100;
  // A drop only counts when it also exceeds both runs' error margins combined.
  const noisePct = (base.rme ?? 0) + (cur.rme ?? 0);
  const regressed = deltaPct <= -threshold && -deltaPct > noisePct;
  const status = regressed
    ? "🔴 regression"
    : deltaPct <= -threshold
      ? `🟡 within noise (±${noisePct.toFixed(1)}%)`
      : deltaPct <= -5
        ? "🟡 warn"
        : deltaPct >= 5
          ? "🟢 faster"
          : "⚪ same";
  if (regressed) regressions++;
  rows.push(
    `| ${cur.name} | ${base.hz.toFixed(1)} | ${cur.hz.toFixed(1)} | ${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}% | ${status} |`,
  );
}

const md = [
  `## Benchmark compare (threshold: ${threshold}%)`,
  ``,
  `baseline \`${baseline.sha}\` → current \`${current.sha}\``,
  ``,
  `| case | baseline ops/s | current ops/s | Δ | status |`,
  `|---|---|---|---|---|`,
  ...rows,
  ``,
].join("\n");

console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");

if (regressions > 0) {
  console.error(`${regressions} benchmark(s) regressed beyond ${threshold}%.`);
  process.exit(1);
}
console.log("No regressions beyond threshold.");
