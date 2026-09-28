/**
 * S5: per-parse CPU for the first RUNS parses in fresh isolates (production JIT flags), as the
 * median over SAMPLES isolates per parse index. Shows compile spikes on the request thread.
 * Usage: PARSER=spikes/s4/strict.ts node spikes/s5/timeline.mjs rss-ascii svg
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROD_FLAGS } from "../../scripts/v8-profiles.mjs";
import { bundleWorker, MATRIX_DIR, startWorkerd } from "../../scripts/workerd-run.mjs";

const runs = Number(process.env.RUNS ?? "30");
const samples = Number(process.env.SAMPLES ?? "9");
const script = await bundleWorker(`
import { parse } from ${JSON.stringify(resolve(process.env.PARSER ?? "spikes/s4/strict.ts"))};
let input = null;
let sink = null;
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/load") { input = await request.text(); return new Response("ok"); }
    const times = [];
    for (let index = 0; index < ${runs}; index++) {
      const start = performance.now();
      sink = parse(input);
      times.push(performance.now() - start);
    }
    return Response.json({ times, kind: typeof sink });
  },
};`);
const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];
const isolates = Array.from({ length: samples }, (_, index) => `t${index}`);
for (const name of process.argv.slice(2)) {
  const xml = readFileSync(`${MATRIX_DIR}/${name}.xml`, "utf8");
  const mf = await startWorkerd({ script, names: isolates, flags: PROD_FLAGS });
  const perIndex = Array.from({ length: runs }, () => []);
  for (const isolate of isolates) {
    const worker = await mf.getWorker(isolate);
    await (await worker.fetch("http://t/load", { method: "POST", body: xml })).text();
    const { times } = await (await worker.fetch("http://t/run")).json();
    times.forEach((ms, index) => perIndex[index].push(ms));
  }
  await mf.dispose();
  console.log(`${name}: median ms per parse #1..#${runs} over ${samples} fresh isolates`);
  console.log(perIndex.map((values, index) => `#${index + 1}:${median(values)}`).join(" "));
}
