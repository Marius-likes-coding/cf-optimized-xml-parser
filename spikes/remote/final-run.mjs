#!/usr/bin/env node
/**
 * Remote check of the released parser's warmup(): Cloudflare's per-request CPU (wrangler tail
 * cpuTime, whole ms) for sequential single parses across several document shapes, in a freshly
 * deployed Worker. Deploy spikes/remote/final-worker.ts first:
 *   npx wrangler deploy --config spikes/remote/final.toml --define WARM:0   (or WARM:1)
 *   BENCH_URL=https://… OUT=result.json node spikes/remote/final-run.mjs
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, writeFileSync } from "node:fs";

const base = (process.env.BENCH_URL ?? "").replace(/\/$/, "");
if (!base) throw new Error("set BENCH_URL");
const pace = Number(process.env.PACE_MS ?? "1000");
/** [code, fixture, input, parses] in request order. */
const plan = [
  ["R", "rss-ascii", "string", 40],
  ["S", "svg", "string", 25],
  ["P", "soap", "string", 15],
  ["O", "ooxml-cjk", "string", 15],
  ["B", "s3-ascii", "bytes", 15],
  ["C", "rss-crlf", "string", 15],
  ["E", "entities", "string", 15],
];
const runId = randomUUID().slice(0, 8);
let sequence = 0;

function startTail() {
  const child = spawn("npx", ["wrangler", "tail", "cf-optimized-xml-parser-bench", "--format", "json"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  if (process.env.TAIL_LOG) {
    const log = createWriteStream(process.env.TAIL_LOG);
    child.stderr.on("data", (chunk) => log.write(chunk));
  }
  const events = new Map();
  const waiters = new Map();
  let partial = "";
  let lines = [];
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    const parts = (partial + chunk).split("\n");
    partial = parts.pop();
    for (const line of parts) {
      lines.push(line);
      if (line !== "}") continue;
      const event = JSON.parse(lines.join("\n"));
      lines = [];
      const url = event.event?.request?.url;
      const tag = url ? new URL(url).searchParams.get("tag") : null;
      if (tag === null) continue;
      const record = { cpu: event.cpuTime, wall: event.wallTime, outcome: event.outcome };
      if (process.env.TAIL_LOG && events.size % 20 === 0) console.error(`${events.size} tail events`);
      events.set(tag, record);
      waiters.get(tag)?.(record);
      waiters.delete(tag);
    }
  });
  return {
    eventFor(tag, timeoutMs = 30_000) {
      if (events.has(tag)) return Promise.resolve(events.get(tag));
      return new Promise((resolve, reject) => {
        waiters.set(tag, resolve);
        setTimeout(() => reject(new Error(`no tail event for ${tag}`)), timeoutMs).unref();
      });
    },
    stop() {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
      child.unref();
    },
  };
}

async function request(path) {
  const tag = `${runId}-${sequence++}`;
  const response = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}tag=${tag}`);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 120) };
  }
  return { tag, status: response.status, body };
}

const tail = startTail();
try {
  for (let attempt = 0; ; attempt++) {
    const { tag } = await request("/health");
    try {
      await tail.eventFor(tag, 2000);
      break;
    } catch (error) {
      if (attempt > 30) throw error;
    }
  }
  const rows = [];
  for (const [code, fixture, input, n] of plan) {
    for (let index = 1; index <= n; index++) {
      rows.push({ code, ...(await request(`/parse?fixture=${fixture}&input=${input}`)) });
      // Tail samples bursts (~20 events, then a few): pace requests so every event arrives.
      await new Promise((resolve) => setTimeout(resolve, pace));
      if (rows.length % 20 === 0) console.error(`${rows.length} requests sent`);
    }
  }
  // Tail events can lag or get lost: one shared deadline instead of a timeout per event.
  const deadline = Date.now() + 60_000;
  const records = [];
  for (const { code, tag, status, body } of rows) {
    const event = await tail.eventFor(tag, Math.max(1, deadline - Date.now())).catch(() => ({}));
    records.push({ code, status, isolate: body.isolate ?? "?", parse: body.parses, warm: body.warm, cpu: event.cpu, wall: event.wall, outcome: event.outcome });
  }
  if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(records, null, 1) + "\n");
  const byIsolate = new Map();
  for (const r of records) {
    if (!byIsolate.has(r.isolate)) byIsolate.set(r.isolate, []);
    byIsolate.get(r.isolate).push(`${r.code}${r.parse ?? "?"}:${r.status === 200 ? (r.cpu ?? "?") : r.status}${r.outcome && r.outcome !== "ok" ? `(${r.outcome})` : ""}`);
  }
  console.log(`WARM=${records[0]?.warm}: per isolate, "<code><parse index>:<cpu ms>" in request order`);
  console.log(`codes: ${plan.map(([c, f, i]) => `${c}=${f}${i === "bytes" ? " (bytes)" : ""}`).join(", ")}`);
  for (const [key, cells] of byIsolate) console.log(`${key} (${cells.length}): ${cells.join(" ")}`);
} finally {
  tail.stop();
}
