#!/usr/bin/env node
/**
 * Phase 0 probe of the precise-bench plan: A/A cold runs (src/ against a copy of it) in PROCS
 * workerd processes × B isolates per variant. Per isolate it records, for each of the 100
 * single-parse requests, workerd's main-thread CPU time (from /proc, through a direct socket)
 * and the Worker's own 1 ms clock, plus 10 overhead requests (count=0). Linux only.
 *
 * Usage: node spikes/precise-bench/aa.mjs <out.json> <fixture>...
 *   env: AA (path of the copy's index.ts, default /tmp/aa/index.ts), PROCS (8), B (15), LABEL
 */
import { cpus } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { Miniflare, convertV4MiniflareOptions } from "miniflare";

import { buildBenchWorker } from "../../scripts/bench-lib.mjs";
import { PROD_FLAGS } from "../../scripts/v8-profiles.mjs";
import { childPids, stealJiffies, threadNs, threads } from "./procfs.mjs";

const out = process.argv[2];
const fixtures = process.argv.slice(3);
const K = Number(process.env.PROCS ?? 8);
const B = Number(process.env.B ?? 15);
const PARSES = 100;
const OVERHEAD = 10;
const variants = [
  { key: "base", path: resolve("src/index.ts") },
  { key: "cand", path: resolve(process.env.AA ?? "/tmp/aa/index.ts") },
];
const bundles = [await buildBenchWorker(variants), await buildBenchWorker(variants.toReversed())];
const keys = ["base", "cand"];
process.env.MINIFLARE_WORKERD_V8_FLAGS = PROD_FLAGS;
const affinity = readFileSync("/proc/self/status", "utf8").match(/Cpus_allowed_list:\s*(\S+)/)?.[1];
const meta = { label: process.env.LABEL ?? "", cpu: cpus()[0]?.model, cpus: cpus().length, affinity };
const procs = [];
const isolates = [];
for (const fixture of fixtures) {
  for (let proc = 0; proc < K; proc++) {
    const script = bundles[proc % 2].script;
    const names = Array.from({ length: B * 2 }, (_, i) => `c${i}`);
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        workers: names.map((name) => ({
          name,
          modules: true,
          script,
          compatibilityDate: "2026-08-01",
          unsafeDirectSockets: [{ port: 0, proxy: false }],
        })),
      }),
    );
    await mf.ready;
    const pid = childPids().at(-1);
    const urls = await Promise.all(names.map((n) => mf.unsafeGetDirectURL(n)));
    const call = async (url, q) => {
      const r = await fetch(new URL(`/run?${new URLSearchParams(q)}`, url));
      const text = await r.text();
      if (!r.ok) throw new Error(text);
      return JSON.parse(text);
    };
    const steal0 = stealJiffies();
    const start = Date.now();
    for (let sample = 0; sample < B; sample++) {
      for (let step = 0; step < 2; step++) {
        const key = keys[(sample + step) % 2];
        const url = urls[sample * 2 + step];
        await call(url, { v: key, fixture, count: 0 }); // builds the input, compiles the harness
        const cpu = [];
        const clock = [];
        const p0 = [...threads(pid).values()].reduce((a, t) => a + t.ns, 0);
        const m0 = threadNs(pid, pid);
        for (let i = 0; i < PARSES; i++) {
          const t0 = threadNs(pid, pid);
          const body = await call(url, { v: key, fixture, count: 1 });
          cpu.push((threadNs(pid, pid) - t0) / 1e6);
          clock.push(body.ms);
        }
        const m1 = threadNs(pid, pid);
        const p1 = [...threads(pid).values()].reduce((a, t) => a + t.ns, 0);
        const overhead = [];
        for (let i = 0; i < OVERHEAD; i++) {
          const t0 = threadNs(pid, pid);
          await call(url, { v: key, fixture, count: 0 });
          overhead.push((threadNs(pid, pid) - t0) / 1e6);
        }
        isolates.push({ fixture, proc, sample, key, cpu, clock, overhead, helperMs: (p1 - p0 - (m1 - m0)) / 1e6 });
      }
    }
    const steal1 = stealJiffies();
    const steal = (steal1.steal - steal0.steal) / Math.max(1, steal1.total - steal0.total);
    procs.push({ fixture, proc, seconds: (Date.now() - start) / 1000, steal });
    console.error(`${meta.label} ${fixture} proc ${proc}: ${((Date.now() - start) / 1000).toFixed(1)} s, steal ${(100 * steal).toFixed(2)}%`);
    await mf.dispose();
  }
}
writeFileSync(out, JSON.stringify({ meta, procs, isolates }));
