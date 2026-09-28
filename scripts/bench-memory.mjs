#!/usr/bin/env node
/**
 * Retained heap of one parse result per matrix fixture, measured in local workerd.
 *
 * The Worker keeps the input string, then the parsed tree, in globals and forces full GCs
 * (--expose-gc) after each step; DevTools `Runtime.getHeapUsage` between steps gives the
 * input's size (which also shows one-byte vs two-byte storage) and the tree's size. Each
 * fixture is parsed once before measuring, so lazily compiled bytecode isn't counted as tree.
 * The run is pinned to Ignition with eager feedback vectors: optimized code and feedback are
 * heap objects too, and a tier-up during the measured parse would otherwise count as tree
 * (seen as ±15% swings depending on fixture order). Object layout is the same in every tier.
 *
 * Usage: node scripts/bench-memory.mjs <module#export> [fixture names...]
 *   e.g. node scripts/bench-memory.mjs bench/compare/parsers.ts#txml rss-ascii rss-poison
 */
import { readFileSync } from "node:fs";

import { PROFILES } from "./v8-profiles.mjs";
import {
  bundleWorker,
  inspect,
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

const [spec, ...wanted] = process.argv.slice(2);
if (!spec) {
  console.error("usage: node scripts/bench-memory.mjs <module#export> [fixture names...]");
  process.exit(2);
}
const parser = parserSpec(spec);
const names = wanted.length > 0 ? wanted : matrixFixtures();

const script = await bundleWorker(`
import { ${parser.exportName} as parse } from ${JSON.stringify(parser.path)};
let input = null;
let tree = null;
function settle() { gc(); gc(); }
export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/load") { input = ${INPUT_EXPR}; tree = null; settle(); return new Response("ok"); }
    if (pathname === "/drop") { tree = null; settle(); return new Response("ok"); }
    if (pathname === "/clear") { input = null; tree = null; settle(); return new Response("ok"); }
    try { tree = parse(input); } catch (error) { return new Response(String(error), { status: 500 }); }
    settle();
    return new Response("ok");
  },
};`);

const PORT = 9250;
const mf = await startWorkerd({
  script,
  flags: `${PROFILES.ignition} --no-lazy-feedback-allocation --expose-gc`,
  inspectorPort: PORT,
});
const worker = await mf.getWorker("main");
const session = await inspect(PORT, "main");
const step = async (path, body) => {
  const response = await worker.fetch(`http://memory${path}`, body ? { method: "POST", body } : {});
  const text = await response.text();
  if (!response.ok) throw new Error(text);
  return session.heapUsed();
};

const kb = (bytes) => (bytes / 1024).toFixed(1);
const lines = [
  `Parser: ${spec}`,
  "",
  "| fixture | chars | input KB | bytes/char | tree KB | tree bytes/char |",
  "|---|---:|---:|---:|---:|---:|",
];
for (const name of names) {
  const xml = readFileSync(`${MATRIX_DIR}/${name}.xml`, "utf8");
  try {
    const empty = await step("/clear");
    const loaded = await step("/load", xml);
    await step("/parse"); // warm: compiles the parser's code, then drop that tree
    await step("/drop");
    const before = await session.heapUsed();
    const parsed = await step("/parse");
    const input = loaded - empty;
    const tree = parsed - before;
    lines.push(
      `| ${name} | ${xml.length} | ${kb(input)} | ${(input / xml.length).toFixed(2)} | ${kb(tree)} | ${(tree / xml.length).toFixed(2)} |`,
    );
  } catch (error) {
    lines.push(`| ${name} | ${xml.length} | error: ${String(error.message).slice(0, 80)} | | | |`);
  }
}
session.close();
await mf.dispose();
console.log(lines.join("\n"));
