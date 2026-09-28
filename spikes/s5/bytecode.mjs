/**
 * S5: print a parser's bytecode in local workerd (--print-bytecode, filtered to `parse`).
 * Usage: node spikes/s5/bytecode.mjs <module.ts> > bytecode.txt
 */
import { resolve } from "node:path";
import { PROD_FLAGS } from "../../scripts/v8-profiles.mjs";
import { bundleWorker, startWorkerd } from "../../scripts/workerd-run.mjs";

const script = await bundleWorker(`
import { parse as target } from ${JSON.stringify(resolve(process.argv[2]))};
export default {
  fetch() {
    target('<?xml version="1.0"?><!DOCTYPE a><!--c--><?p d?><a x="1&amp;">t<![CDATA[c]]><b/></a>');
    return new Response("ok");
  },
};`);
const mf = await startWorkerd({ script, flags: `${PROD_FLAGS} --print-bytecode --print-bytecode-filter=parse` });
const worker = await mf.getWorker("main");
await (await worker.fetch("http://bytecode/")).text();
await mf.dispose();
