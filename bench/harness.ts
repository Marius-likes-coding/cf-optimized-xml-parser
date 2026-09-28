import { bench, type BenchOptions } from "vitest";
import { parse } from "../src/index.js";

/** Any parser under test: the library's own `parse`, a spike variant, or a competitor. */
export type ParseFunction = (xml: string) => unknown;

/**
 * workerd's clock ticks in whole milliseconds, so one small parse reads as 0 or 1 ms.
 * Each sample repeats its input until it spans about TARGET_SAMPLE_MS of ticks. The repeat
 * count goes in the case name as `[×N]`, and scripts/bench-save.mjs divides it back out,
 * so saved results are per pass and stay comparable across runs even when N differs.
 */
const TARGET_SAMPLE_MS = 25;
const CALIBRATION_MS = 20;

/**
 * Holds the last result so the optimizing tiers can't prove a parse unused and drop it.
 * Exported only so it counts as escaping; nothing reads it.
 */
export let sink: unknown;

/** Parses every doc once; returns whether any parse threw. */
function parseAll(parser: ParseFunction, docs: readonly string[]): boolean {
  let threw = false;
  for (const doc of docs) {
    try {
      sink = parser(doc);
    } catch {
      threw = true;
    }
  }
  return threw;
}

function calibrate(
  parser: ParseFunction,
  docs: readonly string[],
): { repeats: number; threw: boolean } {
  const start = performance.now();
  let runs = 0;
  let elapsed = 0;
  let threw = false;
  do {
    threw = parseAll(parser, docs) || threw;
    runs++;
    elapsed = performance.now() - start;
  } while (elapsed < CALIBRATION_MS);
  return { repeats: Math.max(1, Math.ceil((TARGET_SAMPLE_MS * runs) / elapsed)), threw };
}

/**
 * Registers a bench where one pass parses every doc in `docs` once with `parser`
 * (the library's `parse` unless given). A case whose parser throws is named "<name> (throws)":
 * it then measures only call overhead, and the different name keeps scripts/bench-compare.mjs
 * from comparing it with a case that really parses (e.g. the placeholder vs the first parser).
 */
export function benchParse(
  name: string,
  docs: readonly string[],
  options?: BenchOptions,
  parser: ParseFunction = parse,
): void {
  const { repeats, threw } = calibrate(parser, docs);
  bench(
    `${name}${threw ? " (throws)" : ""} [×${repeats}]`,
    () => {
      for (let repeat = 0; repeat < repeats; repeat++) parseAll(parser, docs);
    },
    options,
  );
}
