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

export const COMPATIBILITY_DATE = "2026-08-01";
export const GATES = JSON.parse(
  readFileSync(new URL("../bench/gates.json", import.meta.url), "utf8"),
);
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

export const mean = (values) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
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
 * Warm per-parse cost: interleaved ~burstMs bursts of every variant in one isolate, production
 * JIT flags. `warmupRounds` rounds run first and are discarded, so tier-up compiles stay out of
 * the samples. Returns µs per parse for each measured round.
 */
export async function measureWarm({
  script,
  keys,
  fixtures,
  rounds,
  burstMs,
  warmupRounds = 3,
  input = "string",
}) {
  const mf = await startWorkerd({ script, flags: PROD_FLAGS });
  const results = [];
  try {
    const worker = await mf.getWorker("main");
    for (const fixture of fixtures) {
      const counts = [];
      for (const key of keys) {
        let count = 1;
        let { ms } = await run(worker, { v: key, fixture, count, input });
        while (ms < burstMs / 4 && count < 1_000_000) {
          count *= 4;
          ({ ms } = await run(worker, { v: key, fixture, count, input }));
        }
        counts.push(Math.max(1, Math.round((count * burstMs) / Math.max(ms, 1))));
      }
      const samples = Object.fromEntries(keys.map((key) => [key, []]));
      for (let round = 0; round < warmupRounds + rounds; round++) {
        for (let step = 0; step < keys.length; step++) {
          const slot = (round + step) % keys.length;
          const { ms } = await run(worker, { v: keys[slot], fixture, count: counts[slot], input });
          if (round >= warmupRounds) samples[keys[slot]].push((ms * 1000) / counts[slot]);
        }
      }
      results.push({ fixture, samples });
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

/** Deterministic PRNG, so a report's confidence intervals (and the remote order) are reproducible. */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Percentile-bootstrap interval of `statistic(groups)` at `CONFIDENCE`. Each group is resampled
 * on its own (a group of pairs keeps its pairs together). 99%, because one run gates about 20
 * rows: at 95%, noise alone would trip one of them too often.
 */
export const CONFIDENCE = 0.99;
export function bootstrap(groups, statistic, iterations = 4000, seed = 20_260_929) {
  const random = mulberry32(seed);
  const values = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const resampled = groups.map((group) =>
      group.map(() => group[Math.floor(random() * group.length)]),
    );
    values.push(statistic(resampled));
  }
  values.sort((a, b) => a - b);
  const tail = (1 - CONFIDENCE) / 2;
  return [values[Math.floor(tail * iterations)], values[Math.ceil((1 - tail) * iterations) - 1]];
}

/** Change of the candidate against the base in % (positive = slower or larger), with its CI. */
export function change(groups, ratio) {
  const point = ratio(groups);
  const [low, high] = bootstrap(groups, ratio);
  return { changePct: (point - 1) * 100, lowPct: (low - 1) * 100, highPct: (high - 1) * 100 };
}

/** Mean without the lowest and highest `share` of the values (robust to outlier isolates). */
export function trimmedMean(values, share = 0.2) {
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * share);
  return mean(sorted.slice(cut, sorted.length - cut));
}
/** Unpaired: ratio of trimmed means (cold totals, one value per isolate). */
export const ratioOfTrimmedMeans = ([base, cand]) => trimmedMean(cand) / trimmedMean(base);
/** Paired: trimmed mean of per-round ratios (warm bursts; each element is [base, cand]). */
export const pairedTrimmedRatio = ([pairs]) =>
  trimmedMean(pairs.map(([base, cand]) => cand / base));

export const STATUS = {
  regression: "🔴 regression",
  accepted: "🔴 accepted",
  inconclusive: "🟡 inconclusive",
  slower: "🟡 slower",
  faster: "🟢 faster",
  same: "⚪ same",
};

/**
 * A regression needs both: a change at or above the threshold, and a CI that excludes 0 (so
 * noise alone can't trip the gate). Over the threshold but not significant is "inconclusive";
 * significant and at least half the threshold is "slower"; "faster" mirrors the regression rule.
 * Smaller significant changes show as "same": A/A runs produce those from clock quantization.
 */
export function classify({ changePct, lowPct, highPct }, thresholdPct) {
  if (lowPct > 0 && changePct >= thresholdPct) return "regression";
  if (highPct < 0 && changePct <= -thresholdPct) return "faster";
  if (changePct >= thresholdPct) return "inconclusive";
  if (lowPct > 0 && changePct >= thresholdPct / 2) return "slower";
  return "same";
}

/** Builds a report row and applies the gate. */
export function row({ metric, fixture, unit, base, cand, stats, thresholdPct, gated }) {
  return {
    metric,
    fixture,
    unit,
    base,
    cand,
    ...stats,
    thresholdPct,
    gated,
    status: classify(stats, thresholdPct),
  };
}

/** Marks gated regressions as accepted when the PR carries the override label. */
export function finalize(report) {
  const accepted = process.env.PERF_REGRESSION_ACCEPTED === "true";
  const regressions = report.rows.filter((r) => r.gated && r.status === "regression");
  if (accepted) for (const r of regressions) r.status = "accepted";
  return { ...report, accepted, regressions: regressions.length };
}

const fmt = (value, unit) =>
  unit === "KB" || value >= 100
    ? value.toFixed(0)
    : value >= 10
      ? value.toFixed(1)
      : value.toFixed(2);
const pct = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;

const METRIC_TITLES = {
  "total-100": "Cold: total of the first 100 parses in a fresh isolate (one parse per request)",
  warm: "Warm: time per parse after tier-up",
  memory: "Retained tree (lab measurement, not gated)",
  "remote-warm": "Warm: CPU per parse on Cloudflare (tail cpuTime, several fresh Workers)",
};

/** Markdown for one report (local or remote). */
export function renderReport(report) {
  const where =
    report.kind === "local"
      ? `Local workerd ${report.workerd}, production JIT flags only`
      : `Cloudflare Worker \`${report.worker}\``;
  const lines = [
    `### ${report.kind === "local" ? "Local" : "Remote"}: base \`${report.base.sha}\` → candidate \`${report.candidate.sha}\``,
    "",
    `${where} · bench Worker \`${report.bundleHash}\` · regression = change ≥ threshold and ${CONFIDENCE * 100}% CI above 0`,
  ];
  for (const metric of Object.keys(METRIC_TITLES)) {
    const rows = report.rows.filter((r) => r.metric === metric);
    if (rows.length === 0) continue;
    const gate = rows[0].gated
      ? `gate ${rows[0].thresholdPct}%`
      : rows[0].lowPct === undefined
        ? "information only"
        : "report only, not a gate";
    const detail = rows.some((r) => r.detail !== undefined);
    lines.push(
      "",
      `**${METRIC_TITLES[metric]}** (${rows[0].unit}, ${gate})`,
      "",
      `| fixture | base | candidate | change | ${CONFIDENCE * 100}% CI | status |${detail ? " per Worker |" : ""}`,
      `|---|---:|---:|---:|---|---|${detail ? "---|" : ""}`,
    );
    for (const r of rows) {
      const ci = r.lowPct === undefined ? "" : `${pct(r.lowPct)} … ${pct(r.highPct)}`;
      const status = r.lowPct === undefined ? "" : STATUS[r.status];
      lines.push(
        `| ${r.fixture} | ${fmt(r.base, r.unit)} | ${fmt(r.cand, r.unit)} | ${pct(r.changePct)} | ${ci} | ${status} |${detail ? ` ${r.detail ?? ""} |` : ""}`,
      );
    }
  }
  if (report.notes?.length) lines.push("", ...report.notes.map((note) => `> ${note}`));
  lines.push(
    "",
    !report.rows.some((r) => r.gated)
      ? "Report only: this check never fails on performance."
      : report.regressions === 0
        ? "No gated regressions."
        : report.accepted
          ? `${report.regressions} gated regression(s), accepted by the \`perf-regression-accepted\` label.`
          : `**${report.regressions} gated regression(s).** Fix them, or add the \`perf-regression-accepted\` label if the slowdown is intended.`,
  );
  return lines.join("\n");
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
