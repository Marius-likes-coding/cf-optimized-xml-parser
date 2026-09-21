#!/usr/bin/env node
/**
 * Drive the deployed remote benchmark Worker and save results.
 * Env:
 *   BENCH_URL   base URL e.g. https://cf-optimized-xml-parser-bench.<subdomain>.workers.dev
 *   FIXTURES    comma list (default: tiny-1k,rss-100k,attrs-heavy-100k,deep-nesting-100k,cdata-heavy-100k,large-1mb)
 *   ITERATIONS  default 50
 *   WARMUP      default 5
 */
import { mkdirSync, writeFileSync } from "node:fs";

const base = (process.env.BENCH_URL ?? "").replace(/\/$/, "");
if (!base) {
  console.error("Set BENCH_URL to the deployed bench Worker URL.");
  process.exit(2);
}
const fixtures = (
  process.env.FIXTURES ??
  "tiny-1k,rss-100k,attrs-heavy-100k,deep-nesting-100k,cdata-heavy-100k,large-1mb"
).split(",");
const iterations = process.env.ITERATIONS ?? "50";
const warmup = process.env.WARMUP ?? "5";

const results = [];
for (const fixture of fixtures) {
  const url = `${base}/bench?fixture=${encodeURIComponent(fixture)}&iterations=${iterations}&warmup=${warmup}`;
  console.log(`GET ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`bench failed for ${fixture}: ${res.status} ${await res.text()}`);
  const json = await res.json();
  console.log(
    ` - medianMs=${json.medianMs.toFixed(3)} p99Ms=${json.p99Ms.toFixed(3)} mbPerSec=${json.mbPerSec.toFixed(2)}`,
  );
  results.push({
    name: `remote > ${fixture}`,
    hz: json.medianMs > 0 ? 1000 / json.medianMs : null,
    ...json,
  });
}

mkdirSync("bench/results", { recursive: true });
const out = `bench/results/remote-${new Date().toISOString().replaceAll(":", "-").split(".")[0]}.json`;
writeFileSync(
  out,
  JSON.stringify({ url: base, timestamp: new Date().toISOString(), results }, null, 2) + "\n",
);
console.log(`Saved remote results to ${out}`);
