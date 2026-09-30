#!/usr/bin/env node
/**
 * Print trend of a named case across the `bench-history` branch (local/ and remote/ runs).
 * Paired reports print the candidate's absolute value and its change against that run's base.
 * Usage: node scripts/bench-trend.mjs ["substring of case name"]
 */
import { execFileSync } from "node:child_process";

const filter = process.argv[2] ?? "";
const ref = "origin/bench-history";
const git = (args) => execFileSync("git", args, { stdio: "pipe" }).toString();

try {
  git(["fetch", "--quiet", "origin", "bench-history:refs/remotes/origin/bench-history"]);
} catch {
  // offline or no branch yet: fall back to whatever was fetched before
}

let files = [];
try {
  files = git(["ls-tree", "-r", "--name-only", ref])
    .split("\n")
    .filter((f) => f.endsWith(".json"))
    .sort();
} catch {
  console.log(`No ${ref} yet.`);
  process.exit(0);
}

for (const f of files) {
  const data = JSON.parse(git(["show", `${ref}:${f}`]));
  // Paired reports (scripts/bench-pr.mjs, bench-remote.mjs): the candidate's absolute value.
  for (const r of data.rows ?? []) {
    const name = `${r.metric} > ${r.fixture}`;
    if (filter && !name.includes(filter)) continue;
    console.log(
      `${f}  ${name}  ${r.cand.toFixed(2)} ${r.unit}  (${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(1)}% vs ${data.base.sha})`,
    );
  }
  // Older vitest-bench and remote results.
  for (const r of data.results ?? []) {
    if (filter && !r.name.includes(filter)) continue;
    console.log(
      `${f}  ${r.name}  ${r.hz?.toFixed(1) ?? "?"} ops/s  avgMs=${r.avgMs?.toFixed(3) ?? "?"}`,
    );
  }
}
