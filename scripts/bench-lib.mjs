/**
 * Shared core of the paired benchmarks: `npm run bench:pr` (local workerd), `npm run
 * bench:pr:remote` (a deployed Worker) and `npm run bench:cold`.
 *
 * Realism rules (bench/README.md): local and remote runs use the same generated bench Worker;
 * the parser gets its input the way a fetch() body delivers it (`new Response(xml).text()`);
 * "cold" means one parse per request in a fresh isolate, like real traffic; and gated local
 * runs use only PROD_FLAGS, which mirror what Cloudflare's production embedder sets. Lab-only
 * hooks (tier pinning, --expose-gc, the inspector) are limited to the memory report.
 *
 * Base and candidate always run in the same process or Worker, interleaved, so machine drift
 * and hardware differences hit both alike.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { PROD_FLAGS, PROFILES } from "./v8-profiles.mjs";
import { bundleWorker, inspect, startWorkerd } from "./workerd-run.mjs";

export * from "./bench-stats.mjs";

export const COMPATIBILITY_DATE = "2026-08-01";
const BASE_DIR = ".bench/base";
const FIXTURES_MODULE = resolve("src/bench-fixtures.ts");

export const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * The base of a comparison. BASE wins. In CI, pull_request checks out the merge commit and push
 * a commit on main, so their first parent is the base branch tip; scheduled and manual runs
 * compare against the latest release. Locally: the merge-base with origin/main.
 */
export function resolveBase() {
  if (process.env.BASE) return process.env.BASE;
  switch (process.env.GITHUB_EVENT_NAME) {
    case "pull_request":
    case "push": {
      return "HEAD^1";
    }
    case "schedule":
    case "workflow_dispatch": {
      return git("describe", "--tags", "--abbrev=0", "--match", "v*");
    }
    default: {
      return git("merge-base", "HEAD", "origin/main");
    }
  }
}

/** Checks the base ref out into .bench/base; the parser has no dependencies, so no npm ci. */
export function prepareBase(ref) {
  const sha = git("rev-parse", "--verify", `${ref}^{commit}`);
  try {
    git("worktree", "remove", "--force", BASE_DIR);
  } catch {
    // no worktree yet
  }
  rmSync(BASE_DIR, { recursive: true, force: true });
  git("worktree", "prune");
  git("worktree", "add", "--quiet", "--detach", BASE_DIR, sha);
  return { ref, sha: sha.slice(0, 7), path: resolve(BASE_DIR, "src/index.ts") };
}

/** The candidate is the working tree, including uncommitted changes. */
export function candidateInfo() {
  const dirty = git("status", "--porcelain", "--", "src").length > 0;
  return {
    ref: "working tree",
    sha: git("rev-parse", "--short=7", "HEAD") + (dirty ? "+dirty" : ""),
    path: resolve("src/index.ts"),
  };
}

/**
 * The bench Worker, the same for local workerd and a deployed Worker. `variants` is a list of
 * { key, path, exportName }. Endpoints:
 *   GET /health
 *   GET /run?v=<key>&fixture=<matrix name>&count=<n>[&input=string|bytes]
 * /run parses the fixture n times and returns the isolate id, the isolate's request index, how
 * many parses of this variant and fixture the isolate ran before, and the in-Worker ms (it only advances
 * locally; deployed Workers freeze the clock, so the remote client uses tail cpuTime instead).
 */
export function benchWorkerSource(variants, { warmup = false } = {}) {
  // With warmup, each variant's warmup() (if it exports one) runs at module scope, as the README
  // recommends for Workers that parse several document shapes. It records feedback for every
  // parser path before V8 optimizes, so two copies of the same parser in one isolate can't end
  // up in different JIT states after the bench's sequence of shapes (measured on Cloudflare:
  // up to 33% apart without it).
  const imports = variants
    .map(
      (variant, index) =>
        `import * as m${index} from ${JSON.stringify(variant.path)};\n` +
        `const v${index} = m${index}[${JSON.stringify(variant.exportName ?? "parse")}];` +
        (warmup ? `\nif (typeof m${index}.warmup === "function") m${index}.warmup();` : ""),
    )
    .join("\n");
  const table = variants
    .map((variant, index) => `${JSON.stringify(variant.key)}: v${index}`)
    .join(", ");
  return `${imports}
import { MATRIX } from ${JSON.stringify(FIXTURES_MODULE)};
const VARIANTS = { ${table} };
const inputs = new Map();
const parsesByVariant = new Map();
let isolate;
let requests = 0;
// Not exported: workerd treats every named export of the main module as an entrypoint.
let sink = null;

/** The fixture as a fetch() body delivers it: built once per isolate, then read through Response. */
async function input(name, kind) {
  const key = name + ":" + kind;
  let entry = inputs.get(key);
  if (entry === undefined) {
    const build = MATRIX[name];
    if (build === undefined) return undefined;
    const response = new Response(build());
    const value = kind === "bytes" ? new Uint8Array(await response.arrayBuffer()) : await response.text();
    let twoByte = false;
    if (typeof value === "string") {
      for (let index = 0; index < value.length; index++) {
        if (value.charCodeAt(index) > 255) { twoByte = true; break; }
      }
    }
    entry = { value, length: value.length, twoByte };
    inputs.set(key, entry);
  }
  return entry;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    isolate ??= crypto.randomUUID().slice(0, 8);
    const index = requests++;
    if (url.pathname === "/health") return Response.json({ ok: true, isolate, index });
    if (url.pathname !== "/run") return Response.json({ error: "not found" }, { status: 404 });
    const key = url.searchParams.get("v") ?? "";
    const count = Number(url.searchParams.get("count") ?? "1");
    if (!Number.isInteger(count) || count < 0 || count > 1000000) {
      return Response.json({ error: "count must be 0..1000000" }, { status: 400 });
    }
    const parse = VARIANTS[key];
    if (count > 0 && parse === undefined) {
      return Response.json({ error: "unknown variant " + key }, { status: 400 });
    }
    const entry = await input(url.searchParams.get("fixture") ?? "", url.searchParams.get("input") ?? "string");
    if (entry === undefined) return Response.json({ error: "unknown fixture" }, { status: 400 });
    const counter = key + ":" + url.searchParams.get("fixture");
    const parsesBefore = parsesByVariant.get(counter) ?? 0;
    try {
      const start = performance.now();
      for (let run = 0; run < count; run++) sink = parse(entry.value);
      const ms = performance.now() - start;
      if (count > 0) parsesByVariant.set(counter, parsesBefore + count);
      return Response.json({ isolate, index, parsesBefore, ms, length: entry.length, twoByte: entry.twoByte, result: typeof sink });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};`;
}

/** Bundles the bench Worker; the hash identifies the exact code a report measured. */
export async function buildBenchWorker(variants, options) {
  const script = await bundleWorker(benchWorkerSource(variants, options));
  const hash = createHash("sha256").update(script).digest("hex").slice(0, 12);
  return { script, hash };
}

/** One /run request against a local workerd Worker. */
async function run(worker, query) {
  const response = await worker.fetch(`http://bench/run?${new URLSearchParams(query)}`);
  const text = await response.text();
  if (!response.ok) throw new Error(`/run ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/**
 * Cold cost in fresh isolates, production JIT flags. Per fixture, `isolates` fresh isolates per
 * variant, interleaved; each gets `parses` sequential requests with one parse each, as real
 * traffic sends them. The Worker times each parse with its 1 ms clock; the ticks are unbiased on
 * average, and the total over 100 parses and 20 isolates is precise to about 1%.
 */
export async function measureCold({ script, keys, fixtures, isolates, parses, input = "string" }) {
  const results = [];
  for (const fixture of fixtures) {
    const names = Array.from({ length: isolates * keys.length }, (_, index) => `cold${index}`);
    const mf = await startWorkerd({ script, names, flags: PROD_FLAGS });
    try {
      const byKey = Object.fromEntries(
        keys.map((key) => [key, { totals: [], first: [], early: [], later: [] }]),
      );
      let shape;
      for (let sample = 0; sample < isolates; sample++) {
        for (let step = 0; step < keys.length; step++) {
          // Rotate both the order and the worker slot, so no variant is tied to one of them.
          const slot = (sample + step) % keys.length;
          const worker = await mf.getWorker(names[sample * keys.length + step]);
          const times = [];
          for (let index = 0; index < parses; index++) {
            const body = await run(worker, { v: keys[slot], fixture, count: 1, input });
            times.push(body.ms);
            shape ??= { length: body.length, twoByte: body.twoByte };
          }
          const target = byKey[keys[slot]];
          target.totals.push(times.reduce((a, b) => a + b, 0));
          target.first.push(times[0]);
          target.early.push(...times.slice(1, 10));
          target.later.push(...times.slice(10));
        }
      }
      results.push({ fixture, shape, byKey });
    } finally {
      await mf.dispose();
    }
  }
  return results;
}

/**
 * Warm per-parse cost, production JIT flags. Two copies of the same parser in one isolate can
 * settle a few percent apart (their JIT and GC state differs; far more on Cloudflare), so the
 * isolate is the unit of replication: `scripts` are bench Workers with different copy orders,
 * `isolates` isolates alternate between them, and each measures every fixture with interleaved
 * ~burstMs bursts. `warmupRounds` rounds run first and are discarded, so tier-up compiles stay
 * out of the samples. Returns, per fixture, the µs per parse of each variant and round in each
 * isolate.
 */
export async function measureWarm({
  scripts,
  keys,
  fixtures,
  isolates,
  rounds,
  burstMs,
  warmupRounds = 3,
  input = "string",
}) {
  const workers = Array.from({ length: isolates }, (_, index) => ({
    name: `warm${index}`,
    script: scripts[index % scripts.length],
  }));
  const mf = await startWorkerd({ workers, flags: PROD_FLAGS });
  const results = [];
  try {
    const handles = await Promise.all(workers.map((w) => mf.getWorker(w.name)));
    for (const fixture of fixtures) {
      // Burst size per isolate and variant, so one burst takes about burstMs.
      const counts = [];
      for (const worker of handles) {
        const perKey = [];
        for (const key of keys) {
          let count = 1;
          let { ms } = await run(worker, { v: key, fixture, count, input });
          while (ms < burstMs / 4 && count < 1_000_000) {
            count *= 4;
            ({ ms } = await run(worker, { v: key, fixture, count, input }));
          }
          perKey.push(Math.max(1, Math.round((count * burstMs) / Math.max(ms, 1))));
        }
        counts.push(perKey);
      }
      const perIsolate = handles.map(() => Object.fromEntries(keys.map((key) => [key, []])));
      // Round-robin over isolates too, so machine drift hits all of them alike.
      for (let round = 0; round < warmupRounds + rounds; round++) {
        for (const [index, worker] of handles.entries()) {
          for (let step = 0; step < keys.length; step++) {
            const slot = (round + step) % keys.length;
            const count = counts[index][slot];
            const { ms } = await run(worker, { v: keys[slot], fixture, count, input });
            if (round >= warmupRounds) perIsolate[index][keys[slot]].push((ms * 1000) / count);
          }
        }
      }
      results.push({ fixture, perIsolate });
    }
  } finally {
    await mf.dispose();
  }
  return results;
}

/**
 * Retained heap of one parse result (lab measurement: --expose-gc, the inspector and an
 * Ignition pin, none of which a deployed Worker has; object layout is the same in every tier).
 * Returns KB of input and tree per fixture and variant.
 */
export async function measureMemory({ variants, fixtures, port = 9250 }) {
  const imports = variants
    .map(
      (variant, index) =>
        `import { ${variant.exportName ?? "parse"} as v${index} } from ${JSON.stringify(variant.path)};`,
    )
    .join("\n");
  const table = variants
    .map((variant, index) => `${JSON.stringify(variant.key)}: v${index}`)
    .join(", ");
  const script = await bundleWorker(`${imports}
import { MATRIX } from ${JSON.stringify(FIXTURES_MODULE)};
const VARIANTS = { ${table} };
let input = null;
let tree = null;
function settle() { gc(); gc(); }
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/load") {
      input = await new Response(MATRIX[url.searchParams.get("fixture")]()).text();
      tree = null; settle(); return new Response(String(input.length));
    }
    if (path === "/drop") { tree = null; settle(); return new Response("ok"); }
    if (path === "/clear") { input = null; tree = null; settle(); return new Response("ok"); }
    try { tree = VARIANTS[url.searchParams.get("v")](input); } catch (error) { return new Response(String(error), { status: 500 }); }
    settle();
    return new Response("ok");
  },
};`);
  const mf = await startWorkerd({
    script,
    flags: `${PROFILES.ignition} --no-lazy-feedback-allocation --expose-gc`,
    inspectorPort: port,
  });
  const results = [];
  try {
    const worker = await mf.getWorker("main");
    const session = await inspect(port, "main");
    let text = "";
    const step = async (path) => {
      const response = await worker.fetch(`http://memory${path}`);
      text = await response.text();
      if (!response.ok) throw new Error(text);
      return session.heapUsed();
    };
    for (const fixture of fixtures) {
      const byKey = {};
      let length = 0;
      for (const variant of variants) {
        const empty = await step("/clear");
        const loaded = await step(`/load?fixture=${fixture}`);
        length = Number(text);
        await step(`/parse?v=${variant.key}`); // compiles the parser's code; drop that tree
        await step("/drop");
        const before = await session.heapUsed();
        const parsed = await step(`/parse?v=${variant.key}`);
        byKey[variant.key] = { inputKb: (loaded - empty) / 1024, treeKb: (parsed - before) / 1024 };
      }
      results.push({ fixture, length, byKey });
    }
    session.close();
  } finally {
    await mf.dispose();
  }
  return results;
}

/** The workerd version the local runs use (the one Miniflare resolves). */
export function workerdVersion() {
  try {
    const require = createRequire(import.meta.resolve("miniflare"));
    return JSON.parse(readFileSync(require.resolve("workerd/package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}
