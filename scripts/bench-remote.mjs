#!/usr/bin/env node
/**
 * Paired remote benchmark on real Cloudflare Workers, report-only: base (default: merge-base
 * with origin/main) against the working tree, in the same bench Worker that `npm run bench:pr`
 * runs locally (each variant's warmup() at module scope).
 *
 * Why report-only, and why several Workers: on Cloudflare, two identical copies of the parser in
 * one isolate settle at steady-state speeds up to ~35% apart, depending on the isolate's history
 * (A/A runs, 2026-09-30; bench/README.md). So one isolate can't resolve a 10% change. This
 * script deploys WORKERS fresh Workers in parallel, half with [base, cand] and half with
 * [cand, base], measures each, and combines the per-Worker ratios with a hierarchical bootstrap,
 * so the interval includes that isolate-to-isolate variance.
 *
 * Deployed Workers can't time their own JavaScript, so CPU per request comes from `wrangler
 * tail`, which delivers about one event per second per session (bursts of ~11; measured
 * 2026-09-30); each Worker has its own tail and paces its requests (paceMs). Per Worker and
 * fixture:
 *   1. warm both variants until the answering isolate has done warmParses parses of each;
 *   2. calibrate `count` on warm code, so one request parses for ~targetMs of CPU (Free plan:
 *      10 ms per request);
 *   3. emptySamples count=0 requests measure the per-request overhead;
 *   4. rounds of one base and one cand request in random order (a strict alternation can
 *      phase-lock with the garbage collector). A round counts only when both tail events arrived
 *      and both requests ran in the same warmed isolate; others are re-sent.
 *
 * Usage: npm run bench:pr:remote   (locally after `wrangler login`)
 *   env: BASE (ref), FIXTURES, WORKERS, ROUNDS, PACE_MS, BENCH_WORKER_NAME (prefix),
 *        KEEP_WORKER=1, CLOUDFLARE_ACCOUNT_ID (default: account_id in wrangler.toml),
 *        CLOUDFLARE_API_TOKEN (CI; needs Workers Scripts Edit and Workers Tail Read)
 * Writes bench/results/perf-remote.json (+ perf-remote-requests.json, every request); prints
 * markdown (also to $GITHUB_STEP_SUMMARY). Exits 2 when the measurement itself fails.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildBenchWorker,
  candidateInfo,
  classify,
  COMPATIBILITY_DATE,
  CONFIDENCE,
  finalize,
  GATES,
  mean,
  mulberry32,
  prepareBase,
  renderReport,
  resolveBase,
  trimmedMean,
} from "./bench-lib.mjs";

const gates = GATES.remote.warm;
const fixtures = process.env.FIXTURES ? process.env.FIXTURES.split(",") : GATES.remote.fixtures;
const workerCount = Number(process.env.WORKERS ?? GATES.remote.workers);
const rounds = Number(process.env.ROUNDS ?? gates.rounds);
const paceMs = Number(process.env.PACE_MS ?? gates.paceMs);
const prefix = process.env.BENCH_WORKER_NAME ?? `cfxp-bench-local-${Date.now().toString(36)}`;
const WORK_DIR = ".bench";
const WRANGLER = resolve("node_modules/.bin/wrangler");
const EVENT_WAIT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

const accountId =
  process.env.CLOUDFLARE_ACCOUNT_ID ??
  /account_id\s*=\s*"([^"]+)"/.exec(readFileSync("wrangler.toml", "utf8"))?.[1];
const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** Runs wrangler asynchronously (deploys run in parallel); resolves with its output. */
function wrangler(args) {
  return new Promise((ok, fail) => {
    const child = spawn(WRANGLER, args, { cwd: WORK_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("exit", (code) =>
      code === 0 ? ok(output) : fail(new Error(`wrangler ${args[0]} failed:\n${output}`)),
    );
  });
}

/** Streams `wrangler tail` for one Worker and hands out { cpu, wall } by request tag. */
function startTail(name) {
  // Own process group, so stopping it also stops wrangler's children.
  const child = spawn(WRANGLER, ["tail", name, "--format", "json"], {
    cwd: WORK_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const events = new Map();
  const waiters = new Map();
  let failure;
  let stopping = false;
  let stderr = "";
  let partial = "";
  let lines = [];
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    const parts = (partial + chunk).split("\n");
    partial = parts.pop();
    for (const line of parts) {
      lines.push(line);
      if (line !== "}") continue; // each pretty-printed event ends with "}" at column 0
      const event = JSON.parse(lines.join("\n"));
      lines = [];
      const url = event.event?.request?.url;
      const tag = url ? new URL(url).searchParams.get("tag") : null;
      if (tag === null) continue;
      const record = { cpu: event.cpuTime, wall: event.wallTime, outcome: event.outcome };
      events.set(tag, record);
      waiters.get(tag)?.(record);
      waiters.delete(tag);
    }
  });
  child.on("exit", (code) => {
    if (!stopping) failure = new Error(`wrangler tail exited (${code}): ${stderr.slice(-500)}`);
  });
  return {
    get failure() {
      return failure;
    },
    has: (tag) => events.has(tag),
    get: (tag) => events.get(tag),
    wait(tag, timeoutMs) {
      if (events.has(tag)) return Promise.resolve(events.get(tag));
      return new Promise((ok) => {
        waiters.set(tag, ok);
        setTimeout(ok, timeoutMs).unref(); // resolves with no event
      });
    },
    stop() {
      stopping = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    },
  };
}

const runId = randomUUID().slice(0, 8);

/** One deployed bench Worker with its own tail, pacing and request log. */
function workerContext(name, layout) {
  let sequence = 0;
  let lastRequest = 0;
  const ctx = { name, layout, url: undefined, tail: undefined, log: [] };

  /**
   * One paced, tagged request. A new workers.dev name propagates unevenly for a short while:
   * Cloudflare's own HTML 404 (not the Worker's JSON 404) and 5xx answers are retried.
   */
  ctx.request = async (path) => {
    for (let attempt = 1; ; attempt++) {
      const wait = lastRequest + paceMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequest = Date.now();
      const tag = `${runId}-${name.slice(-2)}-${sequence++}`;
      const response = await fetch(`${ctx.url}${path}${path.includes("?") ? "&" : "?"}tag=${tag}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      if (response.ok) return { tag, body: JSON.parse(text) };
      const transient =
        response.status >= 500 || (response.status === 404 && !text.trimStart().startsWith("{"));
      if (transient && attempt < 8) {
        await sleep(2000);
        continue;
      }
      const hint = text.includes("1102") ? " (CPU limit exceeded: lower targetMs)" : "";
      throw new Error(`${name}${path}: ${response.status} ${text.slice(0, 120)}${hint}`);
    }
  };

  ctx.run = async (variant, fixture, count) => {
    const result = await ctx.request(`/run?v=${variant}&fixture=${fixture}&count=${count}`);
    ctx.log.push({ worker: name, fixture, variant, count, tag: result.tag, ...result.body });
    return result;
  };

  /** Waits until the new name routes everywhere and tail delivers: 5 healthy answers in a row. */
  ctx.ready = async () => {
    let healthy = 0;
    for (let attempt = 0; attempt < 60 && healthy < 5; attempt++) {
      try {
        const { tag } = await ctx.request("/health");
        healthy = (await ctx.tail.wait(tag, 3000)) ? healthy + 1 : 0;
      } catch (error) {
        if (ctx.tail.failure) throw ctx.tail.failure;
        healthy = 0;
        console.error(`${name}: waiting for the Worker and tail: ${error.message.split("\n")[0]}`);
      }
    }
    if (healthy < 5) throw new Error(`${name}: the Worker or wrangler tail never became ready`);
  };
  return ctx;
}

/** Measures one fixture on one Worker; returns the per-request CPU pairs and overheads. */
async function measureFixture(ctx, fixture) {
  const { run, tail } = ctx;
  // 1. Warm both variants on this fixture in the answering isolate (the Worker counts parses
  //    per variant and fixture, so a new document shape gets its own tier-up here).
  let count = gates.warmupCount;
  for (let attempt = 0; attempt < 40; attempt++) {
    const base = await run("base", fixture, count);
    const cand = await run("cand", fixture, count);
    if (Math.min(base.body.parsesBefore, cand.body.parsesBefore) >= gates.warmParses) break;
  }
  // 2. Calibrate count on warm code.
  for (let attempt = 0; attempt < 5; attempt++) {
    const { tag } = await run("cand", fixture, count);
    const event = await tail.wait(tag, EVENT_WAIT_MS);
    if (!event) continue;
    const cpu = Math.max(event.cpu, 0.5);
    if (cpu >= gates.targetMs * 0.7 && cpu <= gates.targetMs * 1.3) break;
    count = Math.max(1, Math.round((count * gates.targetMs) / cpu));
  }
  // 3. Per-request overhead.
  const emptyTags = [];
  for (let index = 0; index < gates.emptySamples; index++) {
    const { tag } = await run("none", fixture, 0);
    emptyTags.push(tag);
  }
  // 4. Rounds in random order; re-send the ones that miss an event or hit another isolate.
  const random = mulberry32(fixture.length * 7919 + ctx.name.length);
  const sent = [];
  const validRounds = () =>
    sent.filter(
      (r) =>
        tail.has(r.base.tag) &&
        tail.has(r.cand.tag) &&
        r.base.body.parsesBefore >= gates.warmParses &&
        r.cand.body.parsesBefore >= gates.warmParses &&
        r.base.body.isolate === r.cand.body.isolate,
    );
  while (sent.length < rounds * 2) {
    const missing = rounds - validRounds().length;
    if (missing <= 0) break;
    for (let index = 0; index < missing; index++) {
      const order = random() < 0.5 ? ["base", "cand"] : ["cand", "base"];
      const pair = {};
      for (const variant of order) pair[variant] = await run(variant, fixture, count);
      sent.push(pair);
    }
    const last = sent.at(-1);
    await Promise.all([
      tail.wait(last.base.tag, EVENT_WAIT_MS),
      tail.wait(last.cand.tag, EVENT_WAIT_MS),
    ]);
  }
  const valid = validRounds();
  const empties = emptyTags.filter((tag) => tail.has(tag)).map((tag) => tail.get(tag).cpu);
  if (valid.length < rounds / 2 || empties.length < gates.emptySamples / 2) {
    throw new Error(
      `${ctx.name} ${fixture}: only ${valid.length}/${sent.length} rounds and ${empties.length}/${gates.emptySamples} overhead samples were usable`,
    );
  }
  return {
    fixture,
    count,
    pairs: valid.map((r) => [tail.get(r.base.tag).cpu, tail.get(r.cand.tag).cpu]),
    empties,
    sent: sent.length,
    shape: { length: valid[0].cand.body.length, twoByte: valid[0].cand.body.twoByte },
  };
}

/** cand/base per-parse CPU ratio of one Worker (trimmed: a GC or compile adds 30-60 ms). */
function workerRatio({ pairs, empties }) {
  const overhead = mean(empties);
  return (
    (trimmedMean(pairs.map(([, cand]) => cand)) - overhead) /
    (trimmedMean(pairs.map(([base]) => base)) - overhead)
  );
}

/** Geometric mean of per-Worker ratios, with a hierarchical bootstrap (Workers, then rounds). */
function combine(perWorker, iterations = 4000) {
  const geo = (ratios) => Math.exp(mean(ratios.map((ratio) => Math.log(ratio))));
  const random = mulberry32(20_260_930);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const values = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const ratios = perWorker.map(() => {
      const w = pick(perWorker);
      return workerRatio({
        pairs: w.pairs.map(() => pick(w.pairs)),
        empties: w.empties.map(() => pick(w.empties)),
      });
    });
    values.push(geo(ratios.filter((ratio) => ratio > 0)));
  }
  values.sort((a, b) => a - b);
  const tail = (1 - CONFIDENCE) / 2;
  const point = geo(perWorker.map((w) => workerRatio(w)));
  return {
    changePct: (point - 1) * 100,
    lowPct: (values[Math.floor(tail * iterations)] - 1) * 100,
    highPct: (values[Math.ceil((1 - tail) * iterations) - 1] - 1) * 100,
  };
}

const base = prepareBase(resolveBase());
const candidate = candidateInfo();
const variants = {
  base: { key: "base", path: base.path },
  cand: { key: "cand", path: candidate.path },
};
const layouts = [
  ["base", "cand"],
  ["cand", "base"],
];
mkdirSync(WORK_DIR, { recursive: true });
const bundles = [];
for (const [index, layout] of layouts.entries()) {
  const bundle = await buildBenchWorker(
    layout.map((key) => variants[key]),
    { warmup: true },
  );
  writeFileSync(`${WORK_DIR}/worker-${index}.mjs`, bundle.script);
  bundles.push(bundle);
}
console.error(
  `base ${base.ref} (${base.sha}) → candidate ${candidate.sha}, ${workerCount} Workers, bench Workers ${bundles.map((b) => b.hash).join(", ")}`,
);

const workers = Array.from({ length: workerCount }, (_, index) =>
  workerContext(`${prefix}-w${index}`, index % layouts.length),
);
let report;
try {
  console.error(`deploying ${workers.map((w) => w.name).join(", ")}`);
  await Promise.all(
    workers.map(async (w) => {
      const output = await wrangler([
        "deploy",
        `worker-${w.layout}.mjs`,
        "--name",
        w.name,
        "--compatibility-date",
        COMPATIBILITY_DATE,
        "--no-bundle",
      ]);
      w.url = /https:\/\/\S+\.workers\.dev/.exec(output)?.[0];
      if (!w.url) throw new Error(`no workers.dev URL for ${w.name}:\n${output}`);
      w.tail = startTail(w.name);
    }),
  );
  const measured = await Promise.all(
    workers.map(async (w) => {
      await w.ready();
      const results = [];
      for (const fixture of fixtures) {
        console.error(`${w.name}: ${fixture}`);
        results.push(await measureFixture(w, fixture));
      }
      return results;
    }),
  );
  const rows = fixtures.map((fixture, index) => {
    const perWorker = measured.map((results) => results[index]);
    const stats = combine(perWorker);
    const perParseUs = (w, pick) =>
      ((trimmedMean(w.pairs.map(pick)) - mean(w.empties)) * 1000) / w.count;
    return {
      metric: "remote-warm",
      fixture,
      unit: "µs",
      base: mean(perWorker.map((w) => perParseUs(w, ([b]) => b))),
      cand: mean(perWorker.map((w) => perParseUs(w, ([, c]) => c))),
      ...stats,
      thresholdPct: gates.thresholdPct,
      gated: false,
      status: classify(stats, gates.thresholdPct),
      detail: perWorker
        .map((w) => {
          const change = (workerRatio(w) - 1) * 100;
          return `${change >= 0 ? "+" : ""}${change.toFixed(0)}`;
        })
        .join(" / "),
      workers: perWorker.map((w) => ({ count: w.count, rounds: w.pairs.length, sent: w.sent })),
      shape: perWorker[0].shape,
    };
  });
  report = finalize({
    kind: "remote",
    timestamp: new Date().toISOString(),
    base,
    candidate,
    bundleHash: bundles.map((b) => b.hash).join(", "),
    worker: `${prefix}-w0…w${workerCount - 1}`,
    compatibilityDate: COMPATIBILITY_DATE,
    paceMs,
    rows,
    notes: [
      `Report only: on Cloudflare, identical parser copies in one isolate differ by up to ~35% depending on the isolate's history, so ${workerCount} fresh Workers (both copy orders) are combined; "per Worker" shows each Worker's change in %.`,
    ],
  });
} catch (error) {
  console.error(`remote bench failed: ${error.stack ?? error}`);
  process.exitCode = 2;
} finally {
  for (const w of workers) w.tail?.stop();
  mkdirSync("bench/results", { recursive: true });
  writeFileSync(
    "bench/results/perf-remote-requests.json",
    JSON.stringify(
      workers.flatMap((w) =>
        w.log.map((entry) => ({ ...entry, cpu: w.tail?.get(entry.tag)?.cpu })),
      ),
      null,
      1,
    ) + "\n",
  );
  if (process.env.KEEP_WORKER === "1") console.error(`kept ${prefix}-w*`);
  else {
    await Promise.all(
      workers.map((w) =>
        wrangler(["delete", "--name", w.name, "--force"]).then(
          () => console.error(`deleted ${w.name}`),
          (error) => console.error(`could not delete ${w.name}: ${error.message.split("\n")[0]}`),
        ),
      ),
    );
  }
}

if (report) {
  writeFileSync("bench/results/perf-remote.json", JSON.stringify(report, null, 2) + "\n");
  const markdown = renderReport(report);
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}
