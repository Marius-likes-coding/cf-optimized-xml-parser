/**
 * Equivalence check for the S2 variants (run in Node: node spikes/s2/check.ts). Output shapes
 * differ by design (attrs object vs array, folded text), so trees are normalized to the base
 * shape before comparing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { parse as attrsObject } from "./attrs-object.ts";
import { parse as base } from "./base.ts";
import { parse as childrenPush } from "./children-push.ts";
import { parse as classNode } from "./class-node.ts";
import { parse as foldText } from "./fold-text.ts";
import { parse as intern } from "./intern.ts";
import { parse as comboFlat } from "./combo-flat.ts";
import { parse as comboObject } from "./combo-object.ts";

interface Loose {
  name: string;
  attrs: unknown;
  children: unknown;
}

function normalize(value: unknown): unknown {
  if (typeof value === "string") return value;
  const node = value as Loose;
  const attrs =
    node.attrs === null || Array.isArray(node.attrs)
      ? node.attrs
      : Object.entries(node.attrs as Record<string, string>).flat();
  const leaf = node.name.startsWith("#") || node.name.startsWith("?");
  const children =
    node.children === null
      ? null
      : typeof node.children === "string" && !leaf
        ? [node.children]
        : Array.isArray(node.children)
          ? node.children.map(normalize)
          : node.children;
  return { name: node.name, attrs, children };
}

function run(parse: (xml: string) => unknown, xml: string): string {
  try {
    const doc = parse(xml) as { children: unknown[] };
    return JSON.stringify(doc.children.map(normalize));
  } catch (error) {
    return `THROW ${(error as Error).message}`;
  }
}

const variants = { attrsObject, childrenPush, classNode, foldText, intern, comboFlat, comboObject };
const dir = "test/fixtures/generated/matrix";
const docs: [string, string][] = readdirSync(dir)
  .sort()
  .map((file) => [file, readFileSync(`${dir}/${file}`, "utf8")]);
docs.push(
  ["cdata merge", `<a>x <![CDATA[<y>&]]> z<b/>tail<!--c-->more</a>`],
  ["proto attr", `<a __proto__="p" constructor="c"/>`],
  ["nested text", `<a>1<b>2<c>3</c>4</b>5</a>`],
  ["comment + pi", `<!-- top --><?pi data?><a><!--in--><?x y?></a><!-- after -->`],
);
let failures = 0;
for (const [label, xml] of docs) {
  const expected = run(base, xml);
  const bad = Object.entries(variants)
    .filter(([, parse]) => run(parse, xml) !== expected)
    .map(([name]) => name);
  if (bad.length > 0 || expected.startsWith("THROW")) failures++;
  console.log(`${label.padEnd(22)} ${expected.startsWith("THROW") ? expected : "ok"}${bad.length > 0 ? `  MISMATCH: ${bad.join(",")}` : ""}`);
}
console.log(failures === 0 ? "\nOK" : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
