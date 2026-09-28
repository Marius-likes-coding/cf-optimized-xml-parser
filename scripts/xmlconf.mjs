#!/usr/bin/env node
/**
 * W3C XML Conformance Test Suite (xmlts20130923) runner, milestone M6.
 *
 * Downloads the suite once into .cache/xmlconf (checksum-pinned), reads the leaf catalogs with
 * our own parser, and runs every applicable test from bytes (so encoding detection is covered
 * too). Oracle for a non-validating parser: "valid" and "invalid" documents must parse,
 * "not-wf" must throw XmlError, "error" may do either.
 *
 * Skipped: XML 1.1 and Namespaces 1.1 tests, tests for editions before the 5th, and tests that
 * need external entities (ENTITIES != none); this parser never reads external entities.
 *
 * Usage: node scripts/xmlconf.mjs   env: MIN_PASS_RATE (0–100, default 0: report only)
 * Writes bench/results/xmlconf.json (every failure, with id, type, sections and reason).
 */
import { buildSync } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SUITE_URL = "https://www.w3.org/XML/Test/xmlts20130923.tar.gz";
const SUITE_SHA256 = "9b61db9f5dbffa545f4b8d78422167083a8568c59bd1129f94138f936cf6fc1f";
const CACHE = ".cache/xmlconf";
const ROOT = join(CACHE, "xmlconf");
const minPassRate = Number(process.env.MIN_PASS_RATE ?? "0");

/** Leaf catalogs, from the master xmlconf.xml. */
const CATALOGS = [
  "sun/sun-valid.xml",
  "sun/sun-invalid.xml",
  "sun/sun-not-wf.xml",
  "sun/sun-error.xml",
  "xmltest/xmltest.xml",
  "japanese/japanese.xml",
  "oasis/oasis.xml",
  "ibm/ibm_oasis_invalid.xml",
  "ibm/ibm_oasis_not-wf.xml",
  "ibm/ibm_oasis_valid.xml",
  "eduni/errata-2e/errata2e.xml",
  "eduni/errata-3e/errata3e.xml",
  "eduni/errata-4e/errata4e.xml",
  "eduni/namespaces/1.0/rmt-ns10.xml",
  "eduni/namespaces/errata-1e/errata1e.xml",
  "eduni/misc/ht-bh.xml",
];

async function ensureSuite() {
  if (existsSync(join(ROOT, "xmlconf.xml"))) return;
  mkdirSync(CACHE, { recursive: true });
  const archive = join(CACHE, "xmlts20130923.tar.gz");
  if (!existsSync(archive)) {
    console.log(`downloading ${SUITE_URL}`);
    const response = await fetch(SUITE_URL);
    if (!response.ok) throw new Error(`download failed: ${response.status}`);
    writeFileSync(archive, new Uint8Array(await response.arrayBuffer()));
  }
  const sha = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (sha !== SUITE_SHA256) throw new Error(`checksum mismatch for ${archive}: ${sha}`);
  execFileSync("tar", ["-xzf", archive, "-C", CACHE]);
}

await ensureSuite();
const bundle = buildSync({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  write: false,
  platform: "neutral",
});
const { parse, XmlError, getAttribute, isElement } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

/** Parses a catalog; the sun/ ones are fragments of <TEST> elements without a root. */
function readCatalog(path) {
  let text = readFileSync(path, "utf8");
  if (!text.includes("<TESTCASES")) {
    text = `<TESTCASES>${text.replace(/^\s*<\?xml[^?]*\?>/, "")}</TESTCASES>`;
  }
  return parse(text).root;
}

function* tests(node) {
  for (const child of Array.isArray(node.children) ? node.children : []) {
    if (!isElement(child)) continue;
    if (child.name === "TEST") yield child;
    else if (child.name === "TESTCASES") yield* tests(child);
  }
}

const results = [];
for (const catalog of CATALOGS) {
  const base = dirname(join(ROOT, catalog));
  for (const test of tests(readCatalog(join(ROOT, catalog)))) {
    const read = (name) => getAttribute(test, name);
    const entry = {
      catalog,
      id: read("ID"),
      type: read("TYPE"),
      sections: read("SECTIONS"),
      recommendation: read("RECOMMENDATION") ?? "XML1.0",
      uri: read("URI"),
    };
    const edition = read("EDITION");
    if (
      read("VERSION") === "1.1" ||
      entry.recommendation.includes("1.1") ||
      (edition !== undefined && !edition.split(" ").includes("5")) ||
      (read("ENTITIES") ?? "none") !== "none"
    ) {
      results.push({ ...entry, outcome: "skipped" });
      continue;
    }
    let failure;
    try {
      parse(readFileSync(join(base, entry.uri)));
    } catch (error) {
      failure = error;
    }
    if (failure !== undefined && !(failure instanceof XmlError)) {
      results.push({ ...entry, outcome: "fail", reason: `crash: ${String(failure)}` });
      continue;
    }
    const accepted = failure === undefined;
    const pass = entry.type === "error" || (entry.type === "not-wf" ? !accepted : accepted);
    results.push({
      ...entry,
      outcome: pass ? "pass" : "fail",
      reason: pass ? undefined : accepted ? "accepted a not-wf document" : failure.message,
    });
  }
}

const run = results.filter((r) => r.outcome !== "skipped");
const passed = run.filter((r) => r.outcome === "pass").length;
const rate = (100 * passed) / run.length;
const byType = {};
for (const r of run) {
  byType[r.type] ??= { pass: 0, fail: 0 };
  byType[r.type][r.outcome]++;
}
mkdirSync("bench/results", { recursive: true });
writeFileSync(
  "bench/results/xmlconf.json",
  JSON.stringify(
    {
      passed,
      run: run.length,
      skipped: results.length - run.length,
      byType,
      failures: run.filter((r) => r.outcome === "fail"),
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `xmlconf: ${passed}/${run.length} passed (${rate.toFixed(1)}%), ${results.length - run.length} skipped`,
);
for (const [type, counts] of Object.entries(byType)) {
  console.log(`  ${type.padEnd(8)} ${counts.pass} pass, ${counts.fail} fail`);
}
if (rate < minPassRate) {
  console.error(`pass rate ${rate.toFixed(1)}% is below MIN_PASS_RATE=${minPassRate}`);
  process.exit(1);
}
