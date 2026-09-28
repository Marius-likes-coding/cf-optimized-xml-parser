/**
 * S5: JIT trace of the strict parser in local workerd with the production flags.
 * Prints V8's --trace-opt/--trace-deopt lines interleaved with "@@parse <label> <n>" markers,
 * so tier-ups, compile times and deopts can be tied to the parse that triggered them.
 * Usage: node spikes/s5/trace.mjs [extra V8 flags] > trace.log
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROD_FLAGS } from "../../scripts/v8-profiles.mjs";
import { bundleWorker, MATRIX_DIR, startWorkerd } from "../../scripts/workerd-run.mjs";

const extra = process.argv.slice(2).join(" ");
const script = await bundleWorker(`
import { parse as strictParse } from ${JSON.stringify(resolve(process.env.PARSER ?? "spikes/s4/strict.ts"))};
let input = null;
let sink = null;
// Kitchen-sink warm-up (WARM=1): one small document that runs every parser path once, so
// type feedback exists for all branches before V8 optimizes the parser.
const KITCHEN_SINK = '<?xml version="1.0" encoding="UTF-8"?>\\r\\n<!DOCTYPE k [<!ENTITY e "x">]>\\n<!-- c -->\\n<?pi data?>\\n' +
  '<k a="1" b="x &amp; &#65; &#x42;" c="t\\tu\\r\\nv"><e/><e x="1" y="2" z="3">t &lt; &gt; &quot; &apos; “q” —</e>' +
  '<f>line\\r\\nbreak<![CDATA[c <d> &]]>after</f><!-- in --><?p in?><g h="é"/>\\n  <n><m>deep</m></n></k>\\n<!-- end -->';
for (let warm = 0; warm < ${Number(process.env.WARM ?? "0")}; warm++) strictParse(KITCHEN_SINK);
${process.env.WARM === "src" ? `import { warmup } from ${JSON.stringify(resolve("src/index.ts"))};\nwarmup();` : ""}
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/load") { input = await request.text(); return new Response("ok"); }
    const n = Number(url.searchParams.get("n"));
    const label = url.searchParams.get("label");
    for (let index = 1; index <= n; index++) {
      console.log("@@parse " + label + " " + index);
      sink = strictParse(input);
    }
    return new Response(typeof sink);
  },
};`);

const plan = [
  ["rss-ascii", 40],
  ["rss-poison", 20],
  ["svg", 20],
  ["s3-cjk", 20],
  ["rss-small", 400],
  ["rss-1mb-ascii", 3],
];
const mf = await startWorkerd({ script, flags: `${PROD_FLAGS} --trace-opt --trace-deopt ${extra}` });
const worker = await mf.getWorker("main");
for (const [name, n] of plan) {
  const loaded = await worker.fetch("http://trace/load", {
    method: "POST",
    body: readFileSync(`${MATRIX_DIR}/${name}.xml`, "utf8"),
  });
  await loaded.text();
  const response = await worker.fetch(`http://trace/run?n=${n}&label=${name}`);
  await response.text();
}
await mf.dispose();
