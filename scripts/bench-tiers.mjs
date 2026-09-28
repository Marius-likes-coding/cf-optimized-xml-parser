#!/usr/bin/env node
/**
 * Run one vitest bench project under each tier-pinned V8 profile (scripts/v8-profiles.mjs)
 * and print per-pass times side by side, so a design can be judged where production actually
 * runs it: cold isolates in Ignition/Sparkplug, hot functions in Maglev/Turboshaft.
 *
 * Usage:
 *   node scripts/bench-tiers.mjs <project> [vitest filters...]
 *   PROFILES=ignition,full node scripts/bench-tiers.mjs spikes spikes/s1
 * Output: bench/results/tiers-<project>.json, plus a markdown table on stdout.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PROFILES } from "./v8-profiles.mjs";

const [project = "spikes", ...filters] = process.argv.slice(2);
const selected = (process.env.PROFILES ?? Object.keys(PROFILES).join(",")).split(",");
mkdirSync("bench/results", { recursive: true });

const byProfile = {};
for (const profile of selected) {
  const flags = PROFILES[profile];
  if (flags === undefined) {
    console.error(`unknown profile "${profile}"; known: ${Object.keys(PROFILES).join(", ")}`);
    process.exit(2);
  }
  const raw = `bench/results/tiers-${project}-${profile}.vitest.json`;
  const saved = `bench/results/tiers-${project}-${profile}.json`;
  console.error(`\n▶ profile ${profile}: ${flags}\n`);
  const run = spawnSync(
    "npx",
    ["vitest", "bench", "--run", "--project", project, `--outputJson=${raw}`, ...filters],
    { stdio: "inherit", env: { ...process.env, MINIFLARE_WORKERD_V8_FLAGS: flags } },
  );
  if (run.status !== 0) process.exit(run.status ?? 1);
  execFileSync("node", ["scripts/bench-save.mjs", raw, saved], { stdio: "inherit" });
  byProfile[profile] = JSON.parse(readFileSync(saved, "utf8")).results;
}

const names = [
  ...new Set(Object.values(byProfile).flatMap((results) => results.map((r) => r.name))),
];
const cell = (result) =>
  result?.avgMs == null
    ? "–"
    : `${(result.avgMs * 1000).toFixed(1)} ±${(result.rme ?? 0).toFixed(0)}%`;
const lines = [
  `| benchmark (µs per pass) | ${selected.join(" | ")} |`,
  `|---|${selected.map(() => "---:").join("|")}|`,
];
for (const name of names) {
  const cells = selected.map((profile) => cell(byProfile[profile].find((r) => r.name === name)));
  lines.push(`| ${name} | ${cells.join(" | ")} |`);
}

writeFileSync(
  `bench/results/tiers-${project}.json`,
  JSON.stringify(
    { timestamp: new Date().toISOString(), profiles: PROFILES, results: byProfile },
    null,
    2,
  ) + "\n",
);
console.log(`\n${lines.join("\n")}`);
