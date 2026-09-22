import { bench, type BenchOptions } from "vitest";
import { parse } from "../src/index.js";

/**
 * workerd's clock ticks in whole milliseconds, so one small parse reads as 0 or 1 ms.
 * Each sample repeats its input until it spans about TARGET_SAMPLE_MS of ticks. The repeat
 * count goes in the case name as `[×N]`, and scripts/bench-save.mjs divides it back out,
 * so saved results are per pass and stay comparable across runs even when N differs.
 */
const TARGET_SAMPLE_MS = 25;
const CALIBRATION_MS = 20;

function parseAll(docs: readonly string[]): void {
  for (const doc of docs) {
    try {
      parse(doc);
    } catch {
      // placeholder parser throws; until it lands this measures call overhead
    }
  }
}

function calibrateRepeats(docs: readonly string[]): number {
  const start = performance.now();
  let runs = 0;
  let elapsed = 0;
  do {
    parseAll(docs);
    runs++;
    elapsed = performance.now() - start;
  } while (elapsed < CALIBRATION_MS);
  return Math.max(1, Math.ceil((TARGET_SAMPLE_MS * runs) / elapsed));
}

/** Registers a bench where one pass parses every doc in `docs` once. */
export function benchParse(name: string, docs: readonly string[], options?: BenchOptions): void {
  const repeats = calibrateRepeats(docs);
  bench(
    `${name} [×${repeats}]`,
    () => {
      for (let repeat = 0; repeat < repeats; repeat++) parseAll(docs);
    },
    options,
  );
}
