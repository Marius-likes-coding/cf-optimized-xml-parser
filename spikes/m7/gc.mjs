/**
 * M7: GC events during N consecutive parses (result kept until the next parse, as a request
 * would), local workerd with the production flags plus --trace-gc. Pass extra V8 flags as args.
 * Usage: node spikes/m7/gc.mjs <fixture> <parses> [extra flags...]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROD_FLAGS } from "../../scripts/v8-profiles.mjs";
import { bundleWorker, MATRIX_DIR, startWorkerd } from "../../scripts/workerd-run.mjs";

const [fixture, parses, ...extra] = process.argv.slice(2);
const script = await bundleWorker(`
import { parse } from ${JSON.stringify(resolve("src/index.ts"))};
let input = null;
let sink = null;
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/load") { input = await request.text(); return new Response("ok"); }
    sink = parse(input);
    return new Response(typeof sink);
  },
};`);
const mf = await startWorkerd({ script, flags: `${PROD_FLAGS} --trace-gc ${extra.join(" ")}` });
const worker = await mf.getWorker("main");
await (await worker.fetch("http://g/load", { method: "POST", body: readFileSync(`${MATRIX_DIR}/${fixture}.xml`, "utf8") })).text();
console.log("@@start");
for (let index = 0; index < Number(parses); index++) await (await worker.fetch("http://g/parse")).text();
console.log("@@end");
await mf.dispose();
