#!/usr/bin/env node
/**
 * Drive the deployed remote benchmark Worker and save results.
 * Env:
 *   BENCH_URL   base URL e.g. https://cf-optimized-xml-parser-bench.<subdomain>.workers.dev
 *   FIXTURES    comma list (default: tiny-1k,rss-100k,attrs-heavy-100k,deep-nesting-100k,cdata-heavy-100k,large-1mb)
 *   SAMPLES     timed batches per fixture, default 20 (max 50)
 * Output: bench/results/remote.json (record it with scripts/bench-record.mjs).
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
const samples = process.env.SAMPLES ?? "20";

const results = [];
for (const fixture of fixtures) {
  const url = `${base}/bench?fixture=${encodeURIComponent(fixture)}&samples=${samples}`;
  console.log(`GET ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`bench failed for ${fixture}: ${res.status} ${await res.text()}`);
  const json = await res.json();
  // A zero median means the Worker's clock never advanced; never record that as a result.
  if (!(json.medianMs > 0)) {
    throw new Error(`bench for ${fixture} returned no timing: ${JSON.stringify(json)}`);
  }
  console.log(
    ` - medianMs=${json.medianMs.toPrecision(4)} p99Ms=${json.p99Ms.toPrecision(4)} mbPerSec=${json.mbPerSec.toFixed(2)} batch=${json.batch}`,
  );
  results.push({
    name: `remote > ${fixture}`,
    hz: 1000 / json.medianMs,
    ...json,
  });
}

mkdirSync("bench/results", { recursive: true });
const out = "bench/results/remote.json";
writeFileSync(
  out,
  JSON.stringify({ url: base, timestamp: new Date().toISOString(), results }, null, 2) + "\n",
);
console.log(`Saved remote results to ${out}`);
