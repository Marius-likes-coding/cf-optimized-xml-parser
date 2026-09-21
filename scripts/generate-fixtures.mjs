#!/usr/bin/env node
/**
 * Generate synthetic XML fixtures of various sizes and shapes.
 * Run: npm run fixtures:generate
 * Output: test/fixtures/generated/*.xml + manifest.json (excluded from prettier/eslint).
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "generated");
mkdirSync(root, { recursive: true });

function sha256(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function rssFeed(items, textLen) {
  const lorem = "Lorem ipsum dolor sit amet ".repeat(Math.ceil(textLen / 27)).slice(0, textLen);
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>Bench</title>`;
  for (let i = 0; i < items; i++) {
    out += `<item id="${i}"><title>Item ${i}</title><link>https://example.com/${i}</link><description>${lorem}</description><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>`;
  }
  return out + `</channel></rss>`;
}

function attrsHeavy(elements, attrsPerElement) {
  let out = `<root>`;
  for (let i = 0; i < elements; i++) {
    let attrs = "";
    for (let a = 0; a < attrsPerElement; a++) attrs += ` a${a}="value-${i}-${a}"`;
    out += `<node${attrs}>text-${i}</node>`;
  }
  return out + `</root>`;
}

function deepNesting(levels, padLen) {
  const pad = "padding-text ".repeat(Math.ceil(padLen / 13)).slice(0, padLen);
  let inner = `leaf-${pad}`;
  for (let d = 0; d < levels; d++) inner = `<level${d} id="${d}">${pad}${inner}</level${d}>`;
  return `<?xml version="1.0"?><root>${inner}</root>`;
}

function cdataHeavy(sections, sectionLen) {
  const payload = "x <>&'\" ".repeat(Math.ceil(sectionLen / 8)).slice(0, sectionLen);
  let out = `<root>`;
  for (let i = 0; i < sections; i++) out += `<entry id="${i}"><![CDATA[${payload}]]></entry>`;
  return out + `</root>`;
}

const specs = [
  ["tiny-1k.xml", rssFeed(5, 60)],
  ["rss-100k.xml", rssFeed(300, 200)],
  ["attrs-heavy-100k.xml", attrsHeavy(1200, 8)],
  ["deep-nesting-100k.xml", deepNesting(1200, 60)],
  ["cdata-heavy-100k.xml", cdataHeavy(300, 250)],
  ["large-1mb.xml", rssFeed(3000, 220)],
  ["large-5mb.xml", rssFeed(14_000, 250)],
];

const manifest = {};
for (const [name, content] of specs) {
  writeFileSync(join(root, name), content);
  manifest[name] = { bytes: content.length, sha: sha256(content) };
}

// many/ burst corpus: 200 x ~2KB files for throughput testing
const manyDir = join(root, "many");
mkdirSync(manyDir, { recursive: true });
for (let i = 0; i < 200; i++) {
  const content = rssFeed(8, 120).replaceAll("Bench", `Bench-${i}`);
  writeFileSync(join(manyDir, `doc-${String(i).padStart(4, "0")}.xml`), content);
}
manifest["many/"] = { count: 200, note: "burst corpus, ~2KB each" };

writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote ${specs.length} fixtures + many/ corpus to ${root}`);
for (const [k, v] of Object.entries(manifest)) console.log(` - ${k}: ${JSON.stringify(v)}`);
