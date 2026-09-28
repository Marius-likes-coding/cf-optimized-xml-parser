#!/usr/bin/env node
/**
 * S5 remote confirmation: Cloudflare's per-request CPU (wrangler tail cpuTime, whole ms) for
 * sequential single parses in a freshly deployed isolate. Deploy spikes/remote first:
 *   npx wrangler deploy --config spikes/remote/wrangler.toml
 *   BENCH_URL=https://… WARM=0|1 node spikes/remote/run.mjs
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const base = (process.env.BENCH_URL ?? "").replace(/\/$/, "");
if (!base) throw new Error("set BENCH_URL");
const warm = process.env.WARM === "1";
const plan = [
  ["rss-ascii", Number(process.env.RSS ?? "40")],
  ["svg", Number(process.env.SVG ?? "30")],
];
const runId = randomUUID().slice(0, 8);
let sequence = 0;

function startTail() {
  const child = spawn("npx", ["wrangler", "tail", "cf-optimized-xml-parser-bench", "--format", "json"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
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
  for (const [fixture, n] of plan) {
    for (let index = 1; index <= n; index++) {
      rows.push([fixture, await request(`/spike?fixture=${fixture}&warm=${warm ? 1 : 0}`)]);
    }
  }
  const byIsolate = new Map();
  for (const [fixture, { tag, status, body }] of rows) {
    const event = await tail.eventFor(tag).catch(() => ({}));
    const key = body.isolate ?? "?";
    if (!byIsolate.has(key)) byIsolate.set(key, []);
    byIsolate.get(key).push(`${fixture === "svg" ? "S" : "R"}${body.parses ?? "?"}${body.didWarm ? "w" : ""}:${status === 200 ? (event.cpu ?? "?") : status}${event.outcome && event.outcome !== "ok" ? `(${event.outcome})` : ""}`);
  }
  console.log(`WARM=${warm ? 1 : 0}: per isolate, "<R|S><parse index>[w]:<cpu ms>" in request order (R = rss-ascii, S = svg, w = warm-up ran in that request)`);
  for (const [key, cells] of byIsolate) console.log(`${key} (${cells.length}): ${cells.join(" ")}`);
} finally {
  tail.stop();
}
