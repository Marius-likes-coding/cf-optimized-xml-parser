/**
 * Equivalence check for the S1 variants (run in Node: node spikes/s1/check.ts).
 * Every variant must produce the same tree as A on every matrix fixture, agree on a set of
 * edge cases, and throw on the same malformed inputs.
 */
import { readdirSync, readFileSync } from "node:fs";
import { parse as a } from "./a-indexof.ts";
import { parse as b } from "./b-charcode.ts";
import { parse as c } from "./c-hybrid.ts";
import { parse as d } from "./d-regex.ts";
import { parse as e } from "./e-regex-names.ts";

const variants = { a, b, c, d, e } as const;
const dir = "test/fixtures/generated/matrix";
let failures = 0;

function run(parse: (xml: string) => unknown, xml: string): string {
  try {
    return JSON.stringify(parse(xml));
  } catch (error) {
    return `THROW ${(error as Error).message}`;
  }
}

function count(json: string): string {
  const elements = (json.match(/"name":"[^#?]/g) ?? []).length;
  const comments = (json.match(/"name":"#comment"/g) ?? []).length;
  const pis = (json.match(/"name":"\?/g) ?? []).length;
  return `${elements} elements, ${comments} comments, ${pis} PIs`;
}

for (const file of readdirSync(dir).sort()) {
  const xml = readFileSync(`${dir}/${file}`, "utf8");
  const expected = run(a, xml);
  const mismatches = Object.entries(variants)
    .filter(([, parse]) => run(parse, xml) !== expected)
    .map(([name]) => name);
  if (mismatches.length > 0 || expected.startsWith("THROW")) failures++;
  console.log(
    `${file.padEnd(22)} ${expected.startsWith("THROW") ? expected : count(expected)}${mismatches.length > 0 ? `  MISMATCH: ${mismatches.join(",")}` : ""}`,
  );
}

const cases: [string, string][] = [
  ["entities", `<a t="x &amp; &#65;&#x42;">1 &lt; 2 &gt; 0 &quot;&apos;</a>`],
  ["cdata merge", `<a>x <![CDATA[<y>&]]> z</a>`],
  ["whitespace dropped", `<a>\n  <b/>\n  <c>t</c>\n</a>`],
  ["comment + pi", `<?xml version="1.0"?><!-- top --><?pi data here?><a><!--in--><?x y?></a><!-- after -->`],
  ["doctype", `<!DOCTYPE a [ <!ENTITY x "y>"> ]><a/>`],
  ["gt in attr", `<a x="1>2" y='it"s'/>`],
  ["bom", `﻿<a/>`],
];
const malformed: [string, string][] = [
  ["mismatch", `<a></b>`],
  ["prefix mismatch", `<ab></a>`],
  ["unclosed", `<a><b></a>`],
  ["lt in attr", `<a x="<"/>`],
  ["unknown entity", `<a>&nbsp;</a>`],
  ["second root", `<a/><b/>`],
  ["text after root", `<a/>x`],
  ["unterminated comment", `<a><!-- x</a>`],
  ["no whitespace between attrs", `<a x="1"y="2"/>`],
];
for (const [label, xml] of cases) {
  const expected = run(a, xml);
  const bad = Object.entries(variants).filter(([, parse]) => run(parse, xml) !== expected);
  if (bad.length > 0 || expected.startsWith("THROW")) failures++;
  console.log(`case ${label.padEnd(26)} ${expected}${bad.length > 0 ? `  MISMATCH: ${bad.map(([n]) => n).join(",")}` : ""}`);
}
for (const [label, xml] of malformed) {
  const results = Object.entries(variants).map(([name, parse]) => [name, run(parse, xml)] as const);
  const accepted = results.filter(([, result]) => !result.startsWith("THROW")).map(([name]) => name);
  if (accepted.length > 0) failures++;
  console.log(`bad  ${label.padEnd(26)} ${accepted.length === 0 ? "all throw" : `ACCEPTED BY: ${accepted.join(",")}`}`);
}
console.log(failures === 0 ? "\nOK" : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
