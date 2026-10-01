/**
 * Pure part of the paired benchmarks: gates, statistics (bootstrap CIs, the regression rule) and
 * the markdown report. No dependencies beyond Node, so the report job needs no npm ci.
 */
import { readFileSync } from "node:fs";

export const GATES = JSON.parse(
  readFileSync(new URL("../bench/gates.json", import.meta.url), "utf8"),
);

export const mean = (values) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
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

/**
 * Change across independent isolates (or Workers): each group holds one isolate's paired rounds
 * ([base, cand] per round). The point estimate is the geometric mean of the per-isolate ratios
 * (trimmed means of the round ratios); the interval comes from a hierarchical bootstrap that
 * resamples isolates, then rounds within each, so it includes isolate-to-isolate variance.
 */
const roundRatio = (pairs) => trimmedMean(pairs.map(([base, cand]) => cand / base));
const geometricMean = (ratios) => Math.exp(mean(ratios.map((value) => Math.log(value))));

export function isolateChange(groups, iterations = 4000, seed = 20_260_930) {
  const ratio = roundRatio;
  const geo = geometricMean;
  const random = mulberry32(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const values = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    values.push(
      geo(
        groups.map(() => {
          const group = pick(groups);
          return ratio(group.map(() => pick(group)));
        }),
      ),
    );
  }
  values.sort((a, b) => a - b);
  const tail = (1 - CONFIDENCE) / 2;
  const perIsolate = groups.map((group) => ratio(group));
  return {
    changePct: (geo(perIsolate) - 1) * 100,
    lowPct: (values[Math.floor(tail * iterations)] - 1) * 100,
    highPct: (values[Math.ceil((1 - tail) * iterations) - 1] - 1) * 100,
    perIsolatePct: perIsolate.map((value) => (value - 1) * 100),
  };
}

/** Student's t quantile (regularized incomplete beta, Numerical Recipes' betacf; bisection). */
// Lanczos approximation of ln Γ(x), x > 0.
function logGamma(x) {
  const c = [
    76.180_091_729_471_46, -86.505_320_329_416_78, 24.014_098_240_830_91, -1.231_739_572_450_155,
    0.001_208_650_973_866_179, -5.395_239_384_953e-6,
  ];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let series = 1.000_000_000_190_015;
  for (const value of c) series += value / ++y;
  return -tmp + Math.log((2.506_628_274_631_000_7 * series) / x);
}
function betaFraction(a, b, x) {
  let c = 1;
  let d = 1 / (1 - ((a + b) * x) / (a + 1));
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 / (1 + aa * d);
    c = 1 + aa / c;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 / (1 + aa * d);
    c = 1 + aa / c;
    h *= d * c;
    if (Math.abs(d * c - 1) < 1e-12) break;
  }
  return h;
}
function incompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaFraction(a, b, x)) / a
    : 1 - (front * betaFraction(b, a, 1 - x)) / b;
}
export function tQuantile(p, df) {
  const cdf = (t) => 1 - 0.5 * incompleteBeta(df / 2, 0.5, df / (df + t * t));
  let low = 0;
  let high = 1e4;
  for (let index = 0; index < 100; index++) {
    const middle = (low + high) / 2;
    if (cdf(middle) < p) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

const sd = (values) => {
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
};

/** Log ratio of one cold batch (one workerd process): trimmed means of the per-isolate totals. */
export const batchLogRatio = (base, cand) => Math.log(trimmedMean(cand) / trimmedMean(base));

/**
 * Cold change from batches. Each unit is a list of batch log ratios: one batch per unit when all
 * batches ran on one machine, or one unit per CI runner. The point estimate is the mean of the
 * unit means; the interval is a t-interval over units, so differences between workerd
 * processes and between machines are inside it (a bootstrap over the isolates of one process
 * missed about 1% of run-to-run noise). Needs at least 2 units.
 */
export function unitsChange(units) {
  const values = units.map((unit) => mean(unit));
  const center = mean(values);
  const half =
    values.length > 1
      ? (tQuantile(1 - (1 - CONFIDENCE) / 2, values.length - 1) * sd(values)) /
        Math.sqrt(values.length)
      : Number.POSITIVE_INFINITY;
  const pct = (log) => (Math.exp(log) - 1) * 100;
  return {
    changePct: pct(center),
    lowPct: Number.isFinite(half) ? pct(center - half) : -100,
    highPct: Number.isFinite(half) ? pct(center + half) : 1e6,
    halfWidthPct: Number.isFinite(half) ? (pct(half) - pct(-half)) / 2 : 1e6,
  };
}

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
 * significant and at least half the threshold is "slower". "faster" mirrors the regression rule
 * at `improvementPct` (default: the threshold). Smaller significant changes show as "same": A/A
 * runs produce those from clock quantization.
 */
export function classify(
  { changePct, lowPct, highPct },
  thresholdPct,
  improvementPct = thresholdPct,
) {
  if (lowPct > 0 && changePct >= thresholdPct) return "regression";
  if (highPct < 0 && changePct <= -improvementPct) return "faster";
  if (changePct >= thresholdPct) return "inconclusive";
  if (lowPct > 0 && changePct >= thresholdPct / 2) return "slower";
  return "same";
}

/** Builds a report row and applies the gate. */
export function row({
  metric,
  fixture,
  unit,
  base,
  cand,
  stats,
  thresholdPct,
  improvementPct = thresholdPct,
  gated,
}) {
  return {
    metric,
    fixture,
    unit,
    base,
    cand,
    ...stats,
    thresholdPct,
    improvementPct,
    gated,
    status: classify(stats, thresholdPct, improvementPct),
  };
}

/**
 * The cold row of one fixture. `units` are lists of batch summaries ({ logRatio, base, cand,
 * isolates, breakdown }), one list per machine in CI or one batch per unit on one machine.
 */
export function coldRow({ fixture, units, gates, shape, timing, detail }) {
  const batches = units.flat();
  const stats = unitsChange(units.map((unit) => unit.map((batch) => batch.logRatio)));
  const breakdown = {};
  for (const key of ["base", "cand"]) {
    const parts = batches.map((batch) => batch.breakdown[key]);
    breakdown[key] = Object.fromEntries(
      ["first", "early", "later"].map((part) => [part, mean(parts.map((p) => p[part]))]),
    );
  }
  return {
    ...row({
      metric: "total-100",
      fixture,
      unit: "ms",
      base: mean(batches.map((batch) => batch.base)),
      cand: mean(batches.map((batch) => batch.cand)),
      stats,
      thresholdPct: gates.cold.thresholdPct,
      improvementPct: gates.cold.improvementPct,
      gated: true,
    }),
    isolates: batches.reduce((total, batch) => total + batch.isolates, 0),
    batches: batches.length,
    shape,
    timing,
    breakdown,
    detail,
  };
}

/** The warm row of one fixture from per-isolate rounds ({ base: [µs…], cand: [µs…] }). */
export function warmRow({ fixture, perIsolate, gates, timing, detail }) {
  const groups = perIsolate.map((samples) =>
    samples.base.map((value, index) => [value, samples.cand[index]]),
  );
  const { perIsolatePct, ...stats } = isolateChange(groups);
  return {
    ...row({
      metric: "warm",
      fixture,
      unit: "µs",
      base: mean(perIsolate.map((samples) => trimmedMean(samples.base))),
      cand: mean(perIsolate.map((samples) => trimmedMean(samples.cand))),
      stats,
      thresholdPct: gates.warm.thresholdPct,
      improvementPct: gates.warm.improvementPct,
      gated: true,
    }),
    isolates: perIsolate.length,
    timing,
    detail:
      detail ??
      perIsolatePct.map((value) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}`).join(" / "),
  };
}

/** "AMD", "Intel" or "other", from a CPU model string. */
export const vendorOf = (cpu = "") =>
  /\bamd\b/i.test(cpu) ? "AMD" : /\bintel\b/i.test(cpu) ? "Intel" : "other";

/**
 * A cold win below the regression threshold counts as "faster" only if the same fixture's warm
 * row is faster too (CI below 0, any size); otherwise it shows as "same". Cold CIs miss about 1%
 * of run-to-run noise (A/A runs, 2026-10-01), and changes in code shape alone move cold totals by
 * 3–8% without moving warm (bench/README.md, calibration). Cold-only wins still need the
 * threshold. Mutates and returns `rows`.
 */
export function confirmColdWins(rows) {
  for (const r of rows) {
    if (r.metric !== "total-100" || r.status !== "faster" || r.changePct <= -r.thresholdPct) {
      continue;
    }
    const warm = rows.find((w) => w.metric === "warm" && w.fixture === r.fixture);
    if (!(warm?.highPct < 0)) r.status = "same";
  }
  return rows;
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
  warm: "Warm: time per parse after tier-up (several isolates, both copy orders, random order)",
  memory: "Retained tree (lab measurement, not gated)",
  "remote-warm": "Warm: CPU per parse on Cloudflare (tail cpuTime, several fresh Workers)",
};

/** Markdown for one report (local or remote). */
export function renderReport(report) {
  const where =
    report.kind === "local"
      ? `Local workerd ${report.workerd}, production JIT flags only, ${report.timing?.startsWith("thread-cpu") ? "CPU time of workerd's JavaScript thread" : "the Worker's 1 ms clock"}`
      : `Cloudflare Worker \`${report.worker}\``;
  const lines = [
    `### ${report.kind === "local" ? "Local" : "Remote"}: base \`${report.base.sha}\` → candidate \`${report.candidate.sha}\``,
    "",
    `${where} · bench Worker \`${report.bundleHash}\` · regression = change ≥ threshold and ${CONFIDENCE * 100}% CI above 0`,
  ];
  if (report.rows.some((r) => r.gated && r.improvementPct < r.thresholdPct)) {
    lines.push(
      "",
      `faster = change ≤ −improvement and CI below 0; a cold win smaller than the threshold also needs the fixture's warm CI below 0`,
    );
  }
  for (const metric of Object.keys(METRIC_TITLES)) {
    const rows = report.rows.filter((r) => r.metric === metric);
    if (rows.length === 0) continue;
    const gate = rows[0].gated
      ? `gate ${rows[0].thresholdPct}%${rows[0].improvementPct < rows[0].thresholdPct ? `, faster from ${rows[0].improvementPct}%` : ""}`
      : rows[0].lowPct === undefined
        ? "information only"
        : "report only, not a gate";
    const detail = rows.some((r) => r.detail !== undefined);
    lines.push(
      "",
      `**${METRIC_TITLES[metric]}** (${rows[0].unit}, ${gate})`,
      "",
      `| fixture | base | candidate | change | ${CONFIDENCE * 100}% CI | status |${detail ? ` ${rows.find((r) => r.detailLabel)?.detailLabel ?? (report.kind === "remote" ? "per Worker" : "per isolate")} |` : ""}`,
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
