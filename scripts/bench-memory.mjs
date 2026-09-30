#!/usr/bin/env node
/**
 * Retained heap of one parse result per matrix fixture, measured in local workerd.
 *
 * The Worker reads the fixture through Response.text() (as a fetch() body arrives), keeps the
 * input string, then the parsed tree, in globals and forces full GCs (--expose-gc) after each
 * step; DevTools `Runtime.getHeapUsage` between steps gives the input's size (which also shows
 * one-byte vs two-byte storage) and the tree's size. Each fixture is parsed once before
 * measuring, so lazily compiled bytecode isn't counted as tree. The run is pinned to Ignition
 * with eager feedback vectors: optimized code and feedback are heap objects too, and a tier-up
 * during the measured parse would otherwise count as tree. Object layout is the same in every
 * tier. Lab measurement: a deployed Worker has none of these hooks (scripts/bench-lib.mjs).
 *
 * Usage: node scripts/bench-memory.mjs <module#export> [fixture names...]
 *   e.g. node scripts/bench-memory.mjs bench/compare/parsers.ts#txml rss-ascii rss-poison
 */
import { measureMemory } from "./bench-lib.mjs";
import { matrixFixtures, parserSpec } from "./workerd-run.mjs";

const [spec, ...wanted] = process.argv.slice(2);
if (!spec) {
  console.error("usage: node scripts/bench-memory.mjs <module#export> [fixture names...]");
  process.exit(2);
}
const fixtures = wanted.length > 0 ? wanted : matrixFixtures();
const results = await measureMemory({ variants: [{ key: "p", ...parserSpec(spec) }], fixtures });

const lines = [
  `Parser: ${spec}`,
  "",
  "| fixture | chars | input KB | bytes/char | tree KB | tree bytes/char |",
  "|---|---:|---:|---:|---:|---:|",
];
for (const { fixture, length, byKey } of results) {
  const { inputKb, treeKb } = byKey.p;
  lines.push(
    `| ${fixture} | ${length} | ${inputKb.toFixed(1)} | ${((inputKb * 1024) / length).toFixed(2)} | ${treeKb.toFixed(1)} | ${((treeKb * 1024) / length).toFixed(2)} |`,
  );
}
console.log(lines.join("\n"));
