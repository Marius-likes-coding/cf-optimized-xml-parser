#!/usr/bin/env node
/**
 * Benchmark the deployed remote Worker from the CPU time Cloudflare reports per request.
 *
 * Deployed Workers can't time their own JavaScript (see src/bench-worker.ts), and timing
 * requests from outside buries a few ms of work in network jitter. `wrangler tail` streams
 * one event per invocation with Cloudflare's own `cpuTime` (whole ms), so each request is
 * tagged, and parse cost = (mean CPU of count-parse requests - mean CPU of count=0 requests)
 * / count. Averaging many samples smooths out the 1 ms rounding.
 *
 * Env:
 *   BENCH_URL             base URL e.g. https://cf-optimized-xml-parser-bench.<subdomain>.workers.dev
 *   CLOUDFLARE_API_TOKEN  for `wrangler tail` (needs Workers Tail Read); a local `wrangler login` works too
 *   FIXTURES              comma list (default: tiny-1k,rss-100k,attrs-heavy-100k,deep-nesting-100k,cdata-heavy-100k,large-1mb)
 *   SAMPLES               request pairs per fixture, default 40
 *   TARGET_MS             parse CPU per request, default 8: the Workers Free plan allows 10 ms
 *                         CPU per request and rejects sustained overruns with error 1102.
 * Output: bench/results/remote.json (record it with scripts/bench-record.mjs).
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const SCRIPT_NAME = "cf-optimized-xml-parser-bench"; // `name` in wrangler.toml
const base = (process.env.BENCH_URL ?? "").replace(/\/$/, "");
if (!base) {
  console.error("Set BENCH_URL to the deployed bench Worker URL.");
  process.exit(2);
}
const fixtures = (
  process.env.FIXTURES ??
  "tiny-1k,rss-100k,attrs-heavy-100k,deep-nesting-100k,cdata-heavy-100k,large-1mb"
).split(",");
const samples = Number(process.env.SAMPLES ?? "40");
const targetMs = Number(process.env.TARGET_MS ?? "8");
const MAX_COUNT = 2 ** 20; // same cap as src/bench-worker.ts
const CALIBRATION_SAMPLES = 3;
const EVENT_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const runId = randomUUID().slice(0, 8);
let sequence = 0;

const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const variance = (values) => {
  const m = mean(values);
  return values.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, values.length - 1);
};

/** Streams invocation events from `wrangler tail` and hands out CPU time by request tag. */
function startTail() {
  // Own process group: `npx` runs wrangler as a grandchild, and killing only npx left it
  // running with our pipes open, so this script never exited.
  const child = spawn("npx", ["wrangler", "tail", SCRIPT_NAME, "--format", "json"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const cpuByTag = new Map();
  const waiters = new Map();
  let failure;
  let stopping = false;
  let stderr = "";
  let partial = "";
  let eventLines = [];

  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop();
    for (const line of lines) {
      eventLines.push(line);
      if (line !== "}") continue; // each pretty-printed event ends with "}" at column 0
      const event = JSON.parse(eventLines.join("\n"));
      eventLines = [];
      const url = event.event?.request?.url;
      const tag = url ? new URL(url).searchParams.get("tag") : null;
      if (tag === null) continue;
      cpuByTag.set(tag, event.cpuTime);
      waiters.get(tag)?.resolve(event.cpuTime);
      waiters.delete(tag);
    }
  });
  child.on("exit", (code) => {
    if (stopping) return;
    failure = new Error(`wrangler tail exited (${code}): ${stderr.slice(-500)}`);
    for (const { reject } of waiters.values()) reject(failure);
  });

  return {
    get failure() {
      return failure;
    },
    cpuFor(tag, timeoutMs = EVENT_TIMEOUT_MS) {
      if (cpuByTag.has(tag)) return Promise.resolve(cpuByTag.get(tag));
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        waiters.set(tag, { resolve, reject });
        setTimeout(() => reject(new Error(`no tail event for ${tag}`)), timeoutMs).unref();
      });
    },
    stop() {
      stopping = true;
      try {
        process.kill(-child.pid, "SIGKILL"); // the whole group; Cloudflare drops the tail on disconnect
      } catch {
        // already gone
      }
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    },
  };
}

async function request(path) {
  const tag = `${runId}-${sequence++}`;
  const res = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}tag=${tag}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await res.text();
  if (!res.ok) {
    const hint = body.includes("1102") ? " (Worker CPU limit exceeded: lower TARGET_MS)" : "";
    throw new Error(`${path} failed: ${res.status} ${body.slice(0, 200)}${hint}`);
  }
  return { tag, body: JSON.parse(body) };
}

/** Tail needs a few seconds to attach; requests sent before that produce no events. */
async function waitForTail(tail) {
  console.log("waiting for wrangler tail to attach");
  for (let attempt = 0; attempt < 30; attempt++) {
    const { tag } = await request("/health");
    try {
      await tail.cpuFor(tag, 2000);
      return;
    } catch (error) {
      if (tail.failure) throw error; // wrangler tail died, e.g. the token lacks Workers Tail Read
    }
  }
  throw new Error("wrangler tail never delivered events (token needs Workers Tail Read)");
}

/** Interleaved count=0 / count=n requests; returns the parse CPU per request and its spread. */
async function measure(tail, fixture, count, n) {
  const emptyTags = [];
  const fullTags = [];
  for (let index = 0; index < n; index++) {
    const empty = await request(`/run?fixture=${fixture}&count=0`);
    const full = await request(`/run?fixture=${fixture}&count=${count}`);
    emptyTags.push(empty.tag);
    fullTags.push(full.tag);
  }
  const emptyCpu = await Promise.all(emptyTags.map((tag) => tail.cpuFor(tag)));
  const fullCpu = await Promise.all(fullTags.map((tag) => tail.cpuFor(tag)));
  return {
    workMs: mean(fullCpu) - mean(emptyCpu),
    workStdErrMs: Math.sqrt(variance(fullCpu) / n + variance(emptyCpu) / n),
    overheadMs: mean(emptyCpu),
  };
}

async function bench(tail, fixture) {
  const {
    body: { bytes },
  } = await request(`/run?fixture=${fixture}&count=0`); // warm the isolate, learn the size

  // Double until one request's parse CPU reaches the target, then scale back onto it.
  let count = 1;
  let { workMs } = await measure(tail, fixture, count, CALIBRATION_SAMPLES);
  while (workMs < targetMs) {
    if (count >= MAX_COUNT)
      throw new Error(`parse CPU for ${fixture} never reached ${targetMs} ms`);
    count = Math.min(count * 2, MAX_COUNT);
    ({ workMs } = await measure(tail, fixture, count, CALIBRATION_SAMPLES));
  }
  count = Math.max(1, Math.round((count * targetMs) / workMs));

  const measured = await measure(tail, fixture, count, samples);
  const cpuMs = measured.workMs / count;
  return {
    fixture,
    bytes,
    count,
    samples,
    cpuMs,
    stdErrPct: (100 * measured.workStdErrMs) / measured.workMs,
    overheadCpuMs: measured.overheadMs,
    mbPerSec: cpuMs > 0 ? bytes / 1024 / 1024 / (cpuMs / 1000) : 0,
    timestamp: new Date().toISOString(),
  };
}

const tail = startTail();
const results = [];
try {
  await waitForTail(tail);
  for (const fixture of fixtures) {
    console.log(`bench ${fixture}`);
    const result = await bench(tail, fixture);
    // Never record a non-positive time as a result.
    if (!(result.cpuMs > 0)) {
      throw new Error(`bench for ${fixture} returned no timing: ${JSON.stringify(result)}`);
    }
    console.log(
      ` - cpuMs=${result.cpuMs.toPrecision(4)} ±${result.stdErrPct.toFixed(1)}% mbPerSec=${result.mbPerSec.toFixed(2)} count=${result.count}`,
    );
    results.push({ name: `remote > ${fixture}`, hz: 1000 / result.cpuMs, ...result });
  }
} finally {
  tail.stop();
}

mkdirSync("bench/results", { recursive: true });
const out = "bench/results/remote.json";
writeFileSync(
  out,
  JSON.stringify({ url: base, timestamp: new Date().toISOString(), results }, null, 2) + "\n",
);
console.log(`Saved remote results to ${out}`);
