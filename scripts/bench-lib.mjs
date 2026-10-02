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

import { mulberry32 } from "./bench-stats.mjs";
import { PROD_FLAGS, PROFILES } from "./v8-profiles.mjs";
import { bundleWorker, inspect, startBenchWorkerd, startWorkerd } from "./workerd-run.mjs";

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

/** Requests without a parse after each cold isolate's parses; their median is the request overhead. */
const OVERHEAD_REQUESTS = 10;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * Cold cost in fresh isolates, production JIT flags. Per fixture it runs batches; each batch is
 * a fresh workerd process with `isolates` isolates per variant, interleaved, and batch b loads
 * `scripts[b % scripts.length]` (pass both copy orders). Each isolate gets one request without a
 * parse (it builds the input as a fetch() body and compiles the bench Worker's own code), then
 * `parses` sequential requests with one parse each, as real traffic sends them, then
 * OVERHEAD_REQUESTS requests without a parse.
 *
 * Timing: the CPU time of workerd's JavaScript thread per request, read from /proc between
 * requests (Linux), minus the batch's median request without a parse. That is the CPU the parse
 * itself cost, including its compiles and GC on that thread, which is how Cloudflare bills a
 * request. The Worker's own clock ticks in whole ms, which gave each isolate's total 5–10% noise
 * and biased single parses; it stays in `clock` as a cross-check, and is the fallback off Linux.
 *
 * Runs `batches` batches per fixture, then more while `more(batchesSoFar, seconds)` returns true.
 * Returns per fixture { fixture, shape, timing, batches: [{ order, overheadMs, seconds, byKey }] },
 * byKey[key] = { totals, clock, first, early, later } (ms; totals and clock per isolate).
 */
export async function measureCold({
  scripts,
  keys,
  fixtures,
  isolates,
  parses,
  input = "string",
  batches = 1,
  more,
}) {
  const results = [];
  for (const fixture of fixtures) {
    const list = [];
    let shape;
    let timing;
    const started = Date.now();
    for (let batch = 0; batch < batches || more?.(list, (Date.now() - started) / 1000); batch++) {
      const batchStart = Date.now();
      const order = batch % scripts.length;
      const names = Array.from({ length: isolates * keys.length }, (_, index) => `cold${index}`);
      const spares = keys.map((_, index) => `spare${index}`);
      const workerd = await startBenchWorkerd({
        workers: [...spares, ...names].map((name) => ({ name, script: scripts[order] })),
        flags: PROD_FLAGS,
      });
      const { cpuNs } = workerd;
      timing = cpuNs ? "thread-cpu" : "worker-clock";
      const raw = [];
      const overhead = [];
      try {
        // A fresh process's first isolate runs 2–5% slower (rss-small: ~30%), and it used to be a
        // base isolate in every batch, which made A/A runs lean −0.1…−0.5%. One discarded
        // isolate per variant warms the process up first.
        for (const [index, key] of keys.entries()) {
          await workerd.call(spares[index], { v: key, fixture, count: 0, input });
          for (let run = 0; run < parses; run++) {
            await workerd.call(spares[index], { v: key, fixture, count: 1, input });
          }
        }
        for (let sample = 0; sample < isolates; sample++) {
          for (let step = 0; step < keys.length; step++) {
            // Rotate the order, the worker slot and, between batches, the variant that starts.
            const key = keys[(sample + step + batch) % keys.length];
            const name = names[sample * keys.length + step];
            await workerd.call(name, { v: key, fixture, count: 0, input });
            const cpu = [];
            const clock = [];
            for (let index = 0; index < parses; index++) {
              const before = cpuNs?.();
              const body = await workerd.call(name, { v: key, fixture, count: 1, input });
              cpu.push(cpuNs ? (cpuNs() - before) / 1e6 : body.ms);
              clock.push(body.ms);
              shape ??= { length: body.length, twoByte: body.twoByte };
            }
            if (cpuNs) {
              for (let index = 0; index < OVERHEAD_REQUESTS; index++) {
                const before = cpuNs();
                await workerd.call(name, { v: key, fixture, count: 0, input });
                overhead.push((cpuNs() - before) / 1e6);
              }
            }
            raw.push({ key, cpu, clock });
          }
        }
      } finally {
        await workerd.dispose();
      }
      // One overhead estimate per batch, from all its isolates: it is the same for every variant,
      // and a per-isolate median of 10 requests would add noise.
      const overheadMs = overhead.length > 0 ? median(overhead) : 0;
      const byKey = Object.fromEntries(
        keys.map((key) => [key, { totals: [], clock: [], first: [], early: [], later: [] }]),
      );
      for (const { key, cpu, clock } of raw) {
        const net = cpu.map((value) => value - overheadMs);
        const target = byKey[key];
        target.totals.push(net.reduce((a, b) => a + b, 0));
        target.clock.push(clock.reduce((a, b) => a + b, 0));
        target.first.push(net[0]);
        target.early.push(...net.slice(1, 10));
        target.later.push(...net.slice(10));
      }
      list.push({ order, overheadMs, seconds: (Date.now() - batchStart) / 1000, byKey });
    }
    results.push({ fixture, shape, timing, batches: list });
  }
  return results;
}

/**
 * Warm per-parse cost, production JIT flags. Two copies of the same parser in one isolate can
 * settle a few percent apart (their JIT and GC state differs; far more on Cloudflare), so the
 * isolate is the unit of replication: `scripts` are bench Workers with different copy orders,
 * isolate i loads `scripts[i % scripts.length]`, and each measures every fixture with
 * interleaved ~burstMs bursts. `warmupRounds` rounds run first and are discarded, so tier-up
 * compiles stay out of the samples. Bursts are timed like cold parses: the CPU time of workerd's
 * JavaScript thread minus the isolate's median request without a parse, or the Worker's 1 ms
 * clock off Linux. Returns, per fixture, the µs per parse of each variant and round in each
 * isolate.
 *
 * The schedule is random: each round runs the variants in random order, and each burst's size
 * varies by ±`jitter`. With a fixed order and fixed burst sizes, the garbage collector can fall
 * into step with the schedule and keep charging one variant: A/A runs on GitHub runners showed
 * per-fixture leans of 1–2% that repeated from run to run and reached ±6% in all 4 isolates.
 */
export async function measureWarm({
  scripts,
  keys,
  fixtures,
  isolates,
  rounds,
  burstMs,
  jitter = 0,
  warmupRounds = 3,
  input = "string",
}) {
  const workers = Array.from({ length: isolates }, (_, index) => ({
    name: `warm${index}`,
    script: scripts[index % scripts.length],
  }));
  const workerd = await startBenchWorkerd({ workers, flags: PROD_FLAGS });
  const { cpuNs } = workerd;
  const results = [];
  try {
    // Request overhead per isolate (CPU timing only; the Worker's clock excludes it).
    const overheadMs = [];
    for (const { name } of workers) {
      const samples = [];
      for (let index = 0; index < 3 * OVERHEAD_REQUESTS && cpuNs; index++) {
        const before = cpuNs();
        await workerd.call(name, { v: keys[0], fixture: fixtures[0], count: 0, input });
        samples.push((cpuNs() - before) / 1e6);
      }
      overheadMs.push(samples.length > 0 ? median(samples.slice(OVERHEAD_REQUESTS)) : 0);
    }
    const timed = async (index, query) => {
      const before = cpuNs?.();
      const body = await workerd.call(workers[index].name, query);
      return cpuNs ? (cpuNs() - before) / 1e6 - overheadMs[index] : body.ms;
    };
    for (const fixture of fixtures) {
      const random = mulberry32(
        [...fixture].reduce((hash, char) => Math.imul(hash, 31) + char.codePointAt(0), 7),
      );
      // Burst size per isolate and variant, so one burst takes about burstMs.
      const counts = [];
      for (const index of workers.keys()) {
        const perKey = {};
        for (const key of random() < 0.5 ? keys : keys.toReversed()) {
          let count = 1;
          let ms = await timed(index, { v: key, fixture, count, input });
          while (ms < burstMs / 4 && count < 1_000_000) {
            count *= 4;
            ms = await timed(index, { v: key, fixture, count, input });
          }
          perKey[key] = Math.max(1, Math.round((count * burstMs) / Math.max(ms, 1)));
        }
        counts.push(perKey);
      }
      const perIsolate = workers.map(() => Object.fromEntries(keys.map((key) => [key, []])));
      // Round-robin over isolates too, so machine drift hits all of them alike.
      for (let round = 0; round < warmupRounds + rounds; round++) {
        for (const index of workers.keys()) {
          for (const key of random() < 0.5 ? keys : keys.toReversed()) {
            const scale = 1 + jitter * (2 * random() - 1);
            const count = Math.max(1, Math.round(counts[index][key] * scale));
            const ms = await timed(index, { v: key, fixture, count, input });
            if (round >= warmupRounds) perIsolate[index][key].push((ms * 1000) / count);
          }
        }
      }
      results.push({ fixture, perIsolate, timing: cpuNs ? "thread-cpu" : "worker-clock" });
    }
  } finally {
    await workerd.dispose();
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
