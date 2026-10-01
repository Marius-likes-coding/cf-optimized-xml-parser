#!/usr/bin/env node
/**
 * Analysis of spikes/precise-bench/aa.mjs output (one file per runner and mode). Per fixture,
 * mode and metric:
 *   CV        per-isolate coefficient of variation (pooled; within-process in parentheses)
 *   sdProc    sd of the per-process A/A log ratio; expProc: expected from isolate noise alone
 *   tauProc   process-level component, sqrt(max(0, sdProc² − expProc²))
 *   tauRun    runner-level component, from the spread of runner means (files)
 *   hw16x2    99% half-width of a t-interval over 16 runners with 2 processes × 20 isolates each,
 *             predicted from the fitted components
 * Metrics: clock (Worker's 1 ms clock), cpu (thread CPU), net (thread CPU minus 100 × the
 * process's median overhead request).
 *
 * Usage: node spikes/precise-bench/analyze.mjs <file.json>...
 */
import { readFileSync } from "node:fs";

import { tQuantile } from "./tq.mjs";

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => sum(xs) / xs.length;
const variance = (xs) => {
  const m = mean(xs);
  return sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1);
};
const sd = (xs) => Math.sqrt(variance(xs));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
const trimmed = (xs, share = 0.2) => {
  const s = [...xs].sort((a, b) => a - b);
  const c = Math.floor(s.length * share);
  return mean(s.slice(c, s.length - c));
};
const pct = (x, digits = 2) => (100 * x).toFixed(digits);

const files = process.argv.slice(2).map((path) => {
  const data = JSON.parse(readFileSync(path, "utf8"));
  // The scratch version wrote a bare array of isolates.
  return Array.isArray(data) ? { meta: { label: "laptop", cpu: "laptop" }, procs: [], isolates: data } : data;
});
const modes = [...new Set(files.map((f) => f.meta.label))];
const fixtures = [...new Set(files.flatMap((f) => f.isolates.map((d) => d.fixture)))];

/** Per-process records: log ratio, its expected sd, CVs, for one file, fixture and metric. */
function processes(file, fixture, metric) {
  const rows = file.isolates.filter((d) => d.fixture === fixture);
  const out = [];
  for (const proc of new Set(rows.map((d) => d.proc))) {
    const inProc = rows.filter((d) => d.proc === proc);
    const overhead = median(inProc.flatMap((d) => d.overhead));
    const value = (d) =>
      metric === "clock" ? sum(d.clock) : metric === "cpu" ? sum(d.cpu) : sum(d.cpu) - d.cpu.length * overhead;
    const base = inProc.filter((d) => d.key === "base").map(value);
    const cand = inProc.filter((d) => d.key === "cand").map(value);
    const cvB = sd(base) / mean(base);
    const cvC = sd(cand) / mean(cand);
    out.push({
      r: Math.log(trimmed(cand) / trimmed(base)),
      se: Math.sqrt(cvB ** 2 / base.length + cvC ** 2 / cand.length),
      cv: Math.sqrt((cvB ** 2 + cvC ** 2) / 2),
      all: [...base, ...cand],
      n: base.length,
    });
  }
  return out;
}

console.log(
  "mode       fixture      metric  mean ms   CV% (within)  sdProc% expProc% tauProc%  tauRun%  hw16x2%  A/A mean%  runners",
);
for (const mode of modes) {
  const group = files.filter((f) => f.meta.label === mode);
  for (const fixture of fixtures) {
    for (const metric of ["clock", "cpu", "net"]) {
      const perFile = group.map((f) => processes(f, fixture, metric)).filter((p) => p.length > 0);
      if (perFile.length === 0) continue;
      const procs = perFile.flat();
      const all = procs.flatMap((p) => p.all);
      // Process level: deviations of each process from its runner's mean, pooled over runners.
      const within = perFile.filter((p) => p.length > 1);
      const sdProc = Math.sqrt(mean(within.map((p) => variance(p.map((x) => x.r)))));
      const expProc = Math.sqrt(mean(procs.map((p) => p.se ** 2)));
      const tauProc = Math.sqrt(Math.max(0, sdProc ** 2 - expProc ** 2));
      // Runner level: spread of runner means beyond what process-level noise explains.
      let tauRun = Number.NaN;
      if (perFile.length > 2) {
        const runnerMeans = perFile.map((p) => mean(p.map((x) => x.r)));
        const k = mean(perFile.map((p) => p.length));
        tauRun = Math.sqrt(Math.max(0, variance(runnerMeans) - sdProc ** 2 / k));
      }
      // Predicted CI: 16 runners × 2 processes × 20 isolates per variant.
      const cv = mean(procs.map((p) => p.cv));
      const procVar = (2 * cv ** 2) / 20 + tauProc ** 2;
      const runnerVar = procVar / 2 + (Number.isNaN(tauRun) ? 0 : tauRun ** 2);
      const hw = (tQuantile(0.995, 15) * Math.sqrt(runnerVar)) / 4;
      console.log(
        mode.padEnd(10),
        fixture.padEnd(12),
        metric.padEnd(6),
        mean(all).toFixed(1).padStart(8),
        `${pct(sd(all) / mean(all), 1).padStart(6)} (${pct(cv, 1)})`.padEnd(14),
        pct(sdProc).padStart(7),
        pct(expProc).padStart(8),
        pct(tauProc).padStart(8),
        (Number.isNaN(tauRun) ? "–" : pct(tauRun)).padStart(8),
        pct(hw).padStart(8),
        pct(mean(procs.map((p) => p.r))).padStart(10),
        String(perFile.length).padStart(8),
      );
    }
  }
}
for (const f of files) {
  if (f.procs.length === 0) continue;
  const steal = f.procs.map((p) => p.steal);
  console.log(`${f.meta.label.padEnd(10)} ${f.meta.cpu} · steal mean ${pct(mean(steal))}% max ${pct(Math.max(...steal))}%`);
}
