#!/usr/bin/env node
/**
 * Coverage of the cold interval (scripts/bench-stats.mjs unitsChange) on synthetic data with the
 * structure the runner probe measured: per-isolate noise, process-level and runner-level noise,
 * runners of different absolute speed, and optionally 5% slow outlier isolates. A 99% interval
 * should contain the true change in about 99% of trials.
 *
 * Usage: node spikes/precise-bench/coverage.mjs [trials]
 */
import { batchLogRatio, mulberry32, unitsChange } from "../../scripts/bench-stats.mjs";

const random = mulberry32(42);
const normal = () => {
  let u = 0;
  while (u === 0) u = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
};

function trial({ runners, batches, isolates, cv, tauProc, tauRun, effect, tails }) {
  const units = [];
  for (let runner = 0; runner < runners; runner++) {
    const speed = Math.exp(0.2 * normal());
    const runEffect = tauRun * normal();
    const unit = [];
    for (let batch = 0; batch < batches; batch++) {
      const procEffect = tauProc * normal();
      const draw = (shift) =>
        Array.from({ length: isolates }, () => {
          let noise = cv * normal();
          if (tails && random() < 0.05) noise += 0.3 * random();
          return 80 * speed * Math.exp(shift + noise);
        });
      unit.push(batchLogRatio(draw(0), draw(effect + runEffect + procEffect)));
    }
    units.push(unit);
  }
  const { lowPct, highPct, halfWidthPct } = unitsChange(units);
  const truth = (Math.exp(effect) - 1) * 100;
  return { covered: lowPct <= truth && truth <= highPct, halfWidthPct };
}

const trials = Number(process.argv[2] ?? 4000);
const configs = {
  "CI, 100 KB fixtures (A/A)": {
    runners: 16, batches: 2, isolates: 20, cv: 0.035, tauProc: 0.005, tauRun: 0.007, effect: 0,
  },
  "CI, 100 KB fixtures, −3%, outliers": {
    runners: 16, batches: 2, isolates: 20, cv: 0.035, tauProc: 0.005, tauRun: 0.007,
    effect: Math.log(0.97), tails: true,
  },
  "CI, rss-small, outliers": {
    runners: 16, batches: 6, isolates: 40, cv: 0.21, tauProc: 0.05, tauRun: 0.045, effect: 0,
    tails: true,
  },
  "one machine, 12 batches, outliers": {
    runners: 12, batches: 1, isolates: 20, cv: 0.06, tauProc: 0.01, tauRun: 0, effect: 0,
    tails: true,
  },
};
for (const [name, config] of Object.entries(configs)) {
  let covered = 0;
  let width = 0;
  for (let index = 0; index < trials; index++) {
    const result = trial(config);
    covered += result.covered ? 1 : 0;
    width += result.halfWidthPct;
  }
  console.log(
    `${name}: coverage ${((100 * covered) / trials).toFixed(2)}%, mean half-width ±${(width / trials).toFixed(2)}%`,
  );
}
