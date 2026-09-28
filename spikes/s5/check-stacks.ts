/**
 * S4 check (node spikes/s4/check.ts): the strict parser equals the S2 winner where the new
 * rules don't apply, normalizes where the spec says so, and rejects what it must.
 */
import { readdirSync, readFileSync } from "node:fs";
import { parse as lenient } from "../s2/fold-text.ts";
import { parse as strict } from "../s5/strict-stacks.ts";

const run = (f: () => unknown): string => {
  try {
    return JSON.stringify(f());
  } catch (error) {
    return `THROW ${(error as Error).message}`;
  }
};
let failures = 0;
const expect = (label: string, ok: boolean, detail: string): void => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(34)} ${detail}`);
};

const dir = "test/fixtures/generated/matrix";
for (const file of readdirSync(dir).sort()) {
  const xml = readFileSync(`${dir}/${file}`, "utf8");
  const a = run(() => lenient(xml));
  const b = run(() => strict(xml));
  if (file === "rss-crlf.xml") {
    expect(file, b === run(() => lenient(xml.replaceAll("\r\n", "\n"))), "equals the LF version after normalization");
  } else expect(file, a === b, a === b ? "" : b.slice(0, 120));
}

const same: [string, string, string][] = [
  ["CRLF in text", "<a>x\r\ny\rz</a>", '"children":"x\\ny\\nz"'],
  ["CRLF in attr → one space", '<a t="x\r\ny\tz\nw"/>', '["t","x y z w"]'],
  ["&#13; and &#10; survive", '<a t="x&#13;&#10;y">p&#13;q</a>', '["t","x\\r\\ny"]'],
  ["CRLF in comment", "<a><!--x\r\ny--></a>", '"x\\ny"'],
];
for (const [label, xml, fragment] of same) {
  const out = run(() => strict(xml));
  expect(label, out.includes(fragment), out.slice(0, 120));
}

const bad: [string, string][] = [
  ["duplicate attribute", '<a x="1" x="2"/>'],
  ["]]> in text", "<a>x ]]> y</a>"],
  ["-- in comment", "<a><!-- x -- y --></a>"],
  ["---> ending", "<a><!-- x ---></a>"],
  ["uppercase XML PI", '<?XML version="1.0"?><a/>'],
  ["declaration not first", ' <?xml version="1.0"?><a/>'],
  ["XML 1.1", '<?xml version="1.1"?><a/>'],
  ["bad declaration", '<?xml encoding="UTF-8"?><a/>'],
  ["name starts with digit", "<1a/>"],
  ["invalid char in name", "<a$b/>"],
  ["DOCTYPE after root", "<a/><!DOCTYPE a>"],
  ["too deep", `${"<a>".repeat(300)}${"</a>".repeat(300)}`],
  ["bad char ref digits", "<a>&#12a;</a>"],
  ["char ref out of range", "<a>&#x110000;</a>"],
];
for (const [label, xml] of bad) {
  const out = run(() => strict(xml));
  expect(label, out.startsWith("THROW"), out.slice(0, 100));
}
const good: [string, string][] = [
  ["declaration with encoding+standalone", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a/>'],
  ["unicode names", "<ü:ñ ç='1'>x</ü:ñ>"],
  ["empty comment", "<a><!----></a>"],
  ["depth 256", `${"<a>".repeat(256)}${"</a>".repeat(256)}`],
];
for (const [label, xml] of good) {
  const out = run(() => strict(xml));
  expect(label, !out.startsWith("THROW"), out.slice(0, 100));
}
console.log(failures === 0 ? "\nOK" : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
