#!/usr/bin/env node
/**
 * Generate synthetic XML fixtures of various sizes and shapes.
 * Run: npm run fixtures:generate
 * Output: test/fixtures/generated/*.xml + manifest.json (excluded from prettier/eslint).
 * Builders live in src/bench-fixtures.ts, shared with the remote bench Worker.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BURST_COUNT, burstDocument, FIXTURES } from "../src/bench-fixtures.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "generated");
mkdirSync(root, { recursive: true });

function sha256(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

const manifest = {};
for (const [name, build] of Object.entries(FIXTURES)) {
  const content = build();
  writeFileSync(join(root, `${name}.xml`), content);
  manifest[`${name}.xml`] = { bytes: content.length, sha: sha256(content) };
}

// many/ burst corpus: small files for throughput testing
const manyDir = join(root, "many");
mkdirSync(manyDir, { recursive: true });
for (let i = 0; i < BURST_COUNT; i++) {
  writeFileSync(join(manyDir, `doc-${String(i).padStart(4, "0")}.xml`), burstDocument(i));
}
manifest["many/"] = { count: BURST_COUNT, note: "burst corpus, ~2KB each" };

writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote ${Object.keys(FIXTURES).length} fixtures + many/ corpus to ${root}`);
for (const [k, v] of Object.entries(manifest)) console.log(` - ${k}: ${JSON.stringify(v)}`);
