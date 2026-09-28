/** S3 check (node spikes/s3/check.ts): bytes variants must equal the S2 string parser. */
import { readdirSync, readFileSync } from "node:fs";
import { parse as stringParse } from "../s2/fold-text.ts";
import { parse as decodeOnce } from "./decode-once.ts";
import { parse as hybrid } from "./hybrid.ts";

const run = (f: () => unknown): string => {
  try {
    return JSON.stringify(f());
  } catch (error) {
    return `THROW ${(error as Error).message}`;
  }
};
const encoder = new TextEncoder();
const dir = "test/fixtures/generated/matrix";
const docs: [string, string][] = readdirSync(dir).sort().map((f) => [f, readFileSync(`${dir}/${f}`, "utf8")]);
docs.push(
  ["high in attr+entity", `<a t="é &amp; “x”">ü &lt; — <![CDATA[ß]]><!--ñ--><?p ö?></a>`],
  ["bom", `﻿<?xml version="1.0"?><a>é</a>`],
);
let failures = 0;
for (const [label, xml] of docs) {
  const expected = run(() => stringParse(xml));
  const bytes = encoder.encode(xml);
  const bad = [
    ["decode-once", run(() => decodeOnce(bytes))],
    ["hybrid", run(() => hybrid(bytes))],
  ].filter(([, got]) => got !== expected);
  if (bad.length > 0 || expected.startsWith("THROW")) failures++;
  console.log(`${label.padEnd(22)} ${expected.startsWith("THROW") ? expected : "ok"}${bad.length > 0 ? `  MISMATCH: ${bad.map(([n]) => n).join(",")}` : ""}`);
}
console.log(failures === 0 ? "\nOK" : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
