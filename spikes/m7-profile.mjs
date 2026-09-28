/**
 * M7: line-level CPU profile of parse() in local workerd (DevTools Profiler over the inspector),
 * production JIT flags, after warm-up. Prints self time per source line of the bundled parser.
 * Usage: node spikes/m7-profile.mjs <fixture> [parses]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROD_FLAGS } from "../scripts/v8-profiles.mjs";
import { bundleWorker, MATRIX_DIR, startWorkerd } from "../scripts/workerd-run.mjs";

const [fixture = "rss-ascii", parses = "3000"] = process.argv.slice(2);
const script = await bundleWorker(`
import { parse } from ${JSON.stringify(resolve("src/index.ts"))};
let input = null;
let sink = null;
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/load") { input = await request.text(); return new Response("ok"); }
    const n = Number(url.searchParams.get("n"));
    for (let index = 0; index < n; index++) sink = parse(input);
    return new Response(typeof sink);
  },
};`);
const PORT = 9261;
const mf = await startWorkerd({
  script,
  flags: `${PROD_FLAGS} --no-lazy-source-positions`,
  inspectorPort: PORT,
});
const worker = await mf.getWorker("main");
await (await worker.fetch("http://p/load", { method: "POST", body: readFileSync(`${MATRIX_DIR}/${fixture}.xml`, "utf8") })).text();
await (await worker.fetch("http://p/run?n=200")).text(); // warm up to the optimized tiers

const listing = await fetch(`http://127.0.0.1:${PORT}/json/list`);
const target = (await listing.json()).find((t) => t.webSocketDebuggerUrl.endsWith("/core:user:main"));
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok) => ws.addEventListener("open", ok));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  pending.get(message.id)?.(message.result);
});
const call = (method, params = {}) =>
  new Promise((ok) => {
    id++;
    pending.set(id, ok);
    ws.send(JSON.stringify({ id, method, params }));
  });
await call("Profiler.enable");
await call("Profiler.setSamplingInterval", { interval: 50 });
await call("Profiler.start");
await (await worker.fetch(`http://p/run?n=${parses}`)).text();
const { profile } = await call("Profiler.stop");
ws.close();
await mf.dispose();

const total = profile.samples.length;
const byLine = new Map();
const byFunction = new Map();
const lines = script.split("\n");
for (const node of profile.nodes) {
  const name = node.callFrame.functionName || "(anonymous)";
  byFunction.set(name, (byFunction.get(name) ?? 0) + (node.hitCount ?? 0));
  for (const tick of node.positionTicks ?? []) {
    const key = `${name}:${tick.line}`;
    byLine.set(key, (byLine.get(key) ?? 0) + tick.ticks);
  }
}
const pct = (n) => ((100 * n) / total).toFixed(1).padStart(5);
console.log(`${fixture}: ${total} samples`);
for (const [name, hits] of [...byFunction].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`${pct(hits)}%  ${name}`);
console.log("\nhottest lines:");
for (const [key, ticks] of [...byLine].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  const line = Number(key.split(":").at(-1));
  console.log(`${pct(ticks)}%  ${key.padEnd(22)} ${(lines[line - 1] ?? "").trim().slice(0, 100)}`);
}
