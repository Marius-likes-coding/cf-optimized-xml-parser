/**
 * M3: for callers holding a Response, is `await response.text()` + parse(string) cheaper than
 * `await response.arrayBuffer()` + parse(bytes)? Both paths include the Response machinery.
 * Usage: node spikes/m3/response.mjs rss-ascii rss-poison …
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROD_FLAGS } from "../../scripts/v8-profiles.mjs";
import { bundleWorker, MATRIX_DIR, startWorkerd } from "../../scripts/workerd-run.mjs";

const script = await bundleWorker(`
import { parse } from ${JSON.stringify(resolve("src/index.ts"))};
let bytes = null;
let sink = null;
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/load") { bytes = new Uint8Array(await request.arrayBuffer()); return new Response("ok"); }
    const mode = url.searchParams.get("mode");
    const n = Number(url.searchParams.get("n"));
    const start = performance.now();
    for (let index = 0; index < n; index++) {
      const response = new Response(bytes);
      sink = mode === "text" ? parse(await response.text()) : parse(await response.arrayBuffer());
    }
    return Response.json({ ms: performance.now() - start, kind: typeof sink });
  },
};`);
const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];
const mf = await startWorkerd({ script, flags: PROD_FLAGS });
const worker = await mf.getWorker("main");
console.log("| fixture | text() + parse(string) µs | arrayBuffer() + parse(bytes) µs |\n|---|---:|---:|");
for (const name of process.argv.slice(2)) {
  await (await worker.fetch("http://r/load", { method: "POST", body: readFileSync(`${MATRIX_DIR}/${name}.xml`) })).text();
  const samples = { text: [], bytes: [] };
  const n = 40;
  for (let round = 0; round < 12; round++) {
    for (const mode of round % 2 ? ["text", "bytes"] : ["bytes", "text"]) {
      const { ms } = await (await worker.fetch(`http://r/run?mode=${mode}&n=${n}`)).json();
      if (round > 1) samples[mode].push((ms * 1000) / n);
    }
  }
  console.log(`| ${name} | ${median(samples.text).toFixed(0)} | ${median(samples.bytes).toFixed(0)} |`);
}
await mf.dispose();
