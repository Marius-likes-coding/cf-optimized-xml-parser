#!/usr/bin/env node
/**
 * Print trend of a named case across bench/history/*.json
 * Usage: node scripts/bench-trend.mjs ["substring of case name"]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const filter = process.argv[2] ?? "";
const dir = "bench/history";
let files = [];
try {
  files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
} catch {
  console.log("No bench/history yet.");
  process.exit(0);
}

for (const f of files) {
  const data = JSON.parse(readFileSync(join(dir, f), "utf8"));
  for (const r of data.results ?? []) {
    if (filter && !r.name.includes(filter)) continue;
    console.log(
      `${f}  ${r.name}  ${r.hz?.toFixed(1) ?? "?"} ops/s  avgMs=${r.avgMs?.toFixed(3) ?? "?"}`,
    );
  }
}
