#!/usr/bin/env node
/**
 * Parse cost in fresh isolates, measured in local workerd with the production JIT flags
 * (compilation on the request thread). For each fixture and parser, SAMPLES new isolates each
 * load the document and parse it RUNS times in one request. Reports mean ms for parse #1
 * (includes compiling the parser), #2–10 and #11–RUNS, plus the total over all RUNS parses.
 * Parsers are interleaved per fixture so machine drift hits them alike. The local clock ticks
 * in whole ms, so parse #1 is averaged over isolates; treat small differences as noise.
 *
 * Usage: node scripts/bench-cold.mjs <module#export>[,<module#export>…] [fixture names...]
 *   env: SAMPLES (isolates per fixture and parser, default 20), RUNS (parses per isolate, default 100)
 */
import { readFileSync } from "node:fs";

import { PROD_FLAGS } from "./v8-profiles.mjs";
import {
  bundleWorker,
  MATRIX_DIR,
  matrixFixtures,
  parserSpec,
  startWorkerd,
} from "./workerd-run.mjs";

/** INPUT=bytes hands the parser a Uint8Array (from arrayBuffer()) instead of a string. */
const INPUT_EXPR =
  process.env.INPUT === "bytes"
    ? "new Uint8Array(await request.arrayBuffer())"
    : "await request.text()";

const [specList, ...wanted] = process.argv.slice(2);
if (!specList) {
  console.error("usage: node scripts/bench-cold.mjs <module#export>[,…] [fixture names...]");
  process.exit(2);
}
const samples = Number(process.env.SAMPLES ?? "20");
const runs = Number(process.env.RUNS ?? "100");
const names = wanted.length > 0 ? wanted : matrixFixtures();

async function workerScript(spec) {
  const parser = parserSpec(spec);
  return bundleWorker(`
import { ${parser.exportName} as parse } from ${JSON.stringify(parser.path)};
let input = null;
// Not exported: workerd treats every named export of the main module as an entrypoint.
let sink = null;
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/load") { input = ${INPUT_EXPR}; return new Response("ok"); }
    const runs = Number(url.searchParams.get("runs"));
    const times = [];
    try {
      for (let index = 0; index < runs; index++) {
        const start = performance.now();
        sink = parse(input);
        times.push(performance.now() - start);
      }
    } catch (error) {
      return new Response(String(error), { status: 500 });
    }
    return Response.json({ times, result: typeof sink });
  },
};`);
}

const specs = specList.split(",");
const scripts = await Promise.all(specs.map((spec) => workerScript(spec)));
const mean = (values) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
const isolates = Array.from({ length: samples }, (_, index) => `cold${index}`);

async function measure(script, xml) {
  const mf = await startWorkerd({ script, names: isolates, flags: PROD_FLAGS });
  try {
    const first = [];
    const early = [];
    const later = [];
    const totals = [];
    for (const isolate of isolates) {
      const worker = await mf.getWorker(isolate);
      const loaded = await worker.fetch("http://cold/load", { method: "POST", body: xml });
      await loaded.text();
      const response = await worker.fetch(`http://cold/run?runs=${runs}`);
      if (!response.ok) throw new Error(await response.text());
      const { times } = await response.json();
      first.push(times[0]);
      early.push(...times.slice(1, 10));
      later.push(...times.slice(10));
      totals.push(times.reduce((a, b) => a + b, 0));
    }
    return [mean(first), mean(early), mean(later), mean(totals)].map((v) => v.toFixed(2));
  } catch (error) {
    return [`error: ${String(error.message).slice(0, 60)}`, "", "", ""];
  } finally {
    await mf.dispose();
  }
}

const lines = [
  `${samples} isolates × ${runs} parses per fixture and parser, production JIT flags`,
  "",
  `| fixture | parser | parse #1 ms | #2–10 ms | #11–${runs} ms | total ms |`,
  "|---|---|---:|---:|---:|---:|",
];
for (const name of names) {
  const xml = readFileSync(`${MATRIX_DIR}/${name}.xml`, "utf8");
  for (const [index, spec] of specs.entries()) {
    const cells = await measure(scripts[index], xml);
    lines.push(`| ${name} | ${spec} | ${cells.join(" | ")} |`);
  }
}
console.log(lines.join("\n"));
