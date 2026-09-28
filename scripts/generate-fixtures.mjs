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
import { BURST_COUNT, burstDocument, FIXTURES, MATRIX } from "../src/bench-fixtures.ts";

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

// matrix/: workload × encoding fixtures for spikes and competitor benches
const matrixDir = join(root, "matrix");
mkdirSync(matrixDir, { recursive: true });
const encoder = new TextEncoder();
for (const [name, build] of Object.entries(MATRIX)) {
  const content = build();
  writeFileSync(join(matrixDir, `${name}.xml`), content);
  let nonAscii = 0;
  let aboveLatin1 = 0;
  for (let index = 0; index < content.length; index++) {
    // Per UTF-16 unit; for a surrogate pair both units count, and both are above 0xFF.
    const code = content.codePointAt(index);
    if (code > 0x7f) nonAscii++;
    if (code > 0xff) aboveLatin1++;
  }
  manifest[`matrix/${name}.xml`] = {
    bytes: encoder.encode(content).length,
    chars: content.length,
    tags: content.split("<").length - 1,
    nonAscii,
    aboveLatin1,
    v8String: aboveLatin1 > 0 ? "two-byte" : "one-byte",
    sha: sha256(content),
  };
}

writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote ${Object.keys(FIXTURES).length} fixtures + many/ corpus to ${root}`);
for (const [k, v] of Object.entries(manifest)) console.log(` - ${k}: ${JSON.stringify(v)}`);
