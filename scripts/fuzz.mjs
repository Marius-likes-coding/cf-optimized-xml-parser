#!/usr/bin/env node
/**
 * Seeded mutation fuzzer for parse(). Mutates small documents (the matrix's small fixtures plus
 * hand-written ones covering every construct) with XML-significant fragments and random bytes,
 * and checks that parse() either returns a document or throws XmlError: never another error
 * type, a stack overflow, or a slow parse. Runs in Node on the bundled source (the parser is
 * pure JS; workerd isn't needed to find crashes).
 *
 * Usage: node scripts/fuzz.mjs   env: ITERATIONS (default 20000), SEED (default random)
 * On failure it prints the seed and writes the input to bench/results/fuzz-failure.xml.
 */
import { buildSync } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const iterations = Number(process.env.ITERATIONS ?? "20000");
const seed = Number(process.env.SEED ?? Math.floor(Math.random() * 2 ** 31));

const bundle = buildSync({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  write: false,
  platform: "neutral",
});
const { parse, XmlError } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

/** mulberry32: small, fast, seedable. */
function random32(state) {
  let s = state;
  return () => {
    // eslint-disable-next-line unicorn/prefer-math-trunc -- `| 0` wraps to int32, which the PRNG needs
    s = (s + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const random = random32(seed);
const pick = (items) => items[Math.floor(random() * items.length)];
const int = (max) => Math.floor(random() * max);

const corpus = [
  readFileSync("test/fixtures/generated/matrix/rss-small.xml", "utf8"),
  readFileSync("test/fixtures/generated/matrix/s3-small.xml", "utf8"),
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<!DOCTYPE r [<!ENTITY e "x>y"><!-- ] -->]>` +
    `<!--c--><?p d?><r a="1" b='&amp;&#65;&#x42;' c="t\tu\r\nv"><e/><g h="1"/><x></x>` +
    `t &lt; &gt; &quot; &apos;<![CDATA[x <y> &]]>é“q”😀<n><m>deep</m></n ></r><!--end-->`,
  `<a:b xmlns:a="u"><a:c d="1" e="2" f="3" g="4" h="5" i="6" j="7" k="8" l="9" m="10" n="11" o="12" p="13" q="14" r="15" s="16" t="17"/></a:b>`,
];
const fragments = [
  "<",
  ">",
  "/",
  "=",
  '"',
  "'",
  "&",
  ";",
  "&amp;",
  "&#",
  "&#x",
  "&#xD800;",
  "&#0;",
  "&unknown;",
  "<!--",
  "-->",
  "--",
  "<![CDATA[",
  "]]>",
  "<?",
  "?>",
  "<?xml ",
  "<!DOCTYPE a [",
  "]>",
  "[",
  "]",
  "\r",
  "\n",
  "\t",
  " ",
  "\u0000",
  "￾",
  "\uD800",
  "é",
  "€",
  "😀",
  "<a>",
  "</a>",
  "<a/>",
  "a",
];

function mutate(text) {
  let out = text;
  const count = 1 + int(4);
  for (let step = 0; step < count; step++) {
    const at = int(out.length + 1);
    switch (int(4)) {
      case 0: {
        out = out.slice(0, at) + out.slice(at + 1 + int(8));
        break;
      }
      case 1: {
        out = out.slice(0, at) + pick(fragments) + out.slice(at);
        break;
      }
      case 2: {
        const from = int(out.length);
        out = out.slice(0, at) + out.slice(from, from + 1 + int(16)) + out.slice(at);
        break;
      }
      default: {
        out = out.slice(0, at) + String.fromCodePoint(int(0x1_00)) + out.slice(at + 1);
      }
    }
  }
  return out;
}

let accepted = 0;
let rejected = 0;
let slowest = 0;
const start = performance.now();
for (let iteration = 0; iteration < iterations; iteration++) {
  const input = mutate(pick(corpus));
  const asBytes = iteration % 5 === 0;
  const t0 = performance.now();
  let failure;
  try {
    const doc = parse(asBytes ? new TextEncoder().encode(input) : input);
    if (typeof doc?.root?.name !== "string") failure = "returned no root";
    accepted++;
  } catch (error) {
    if (error instanceof XmlError) rejected++;
    else failure = `${error?.constructor?.name ?? "throw"}: ${error?.message}`;
  }
  const elapsed = performance.now() - t0;
  slowest = Math.max(slowest, elapsed);
  if (elapsed > 250) failure ??= `slow parse: ${elapsed.toFixed(0)} ms`;
  if (failure !== undefined) {
    mkdirSync("bench/results", { recursive: true });
    writeFileSync("bench/results/fuzz-failure.xml", input);
    console.error(
      `FAIL at iteration ${iteration} (SEED=${seed}${asBytes ? ", bytes" : ""}): ${failure}`,
    );
    console.error("input written to bench/results/fuzz-failure.xml");
    process.exit(1);
  }
}
console.log(
  `fuzz ok: ${iterations} inputs (SEED=${seed}), ${accepted} parsed, ${rejected} rejected with XmlError, ` +
    `slowest ${slowest.toFixed(1)} ms, total ${((performance.now() - start) / 1000).toFixed(1)} s`,
);
