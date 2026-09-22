/**
 * Remote benchmark Worker.
 * Deployed nightly to measure parser performance in the real Cloudflare runtime.
 *
 * GET /bench?fixture=<name>&samples=<n>
 * GET /health
 * GET /fixtures
 *
 * Deployed Workers only advance performance.now() after I/O (Spectre mitigation), so
 * timing a synchronous parse() directly always reads 0. Each sample therefore runs a
 * batch of parses between two subrequests, and the subrequest round-trip, measured
 * with empty batches, is subtracted.
 */
import { FIXTURES } from "./bench-fixtures.js";
import { parse } from "./index.js";

/** Small, fast response fetched only so the clock catches up. */
const CLOCK_URL = "https://cloudflare.com/cdn-cgi/trace";
/** Net parse time per sample; far above the clock's millisecond resolution and fetch jitter. */
const TARGET_SAMPLE_MS = 50;
/** Calibration stops here: a real parse can't be this fast, so the clock isn't advancing. */
const MAX_BATCH = 2 ** 18;
const OVERHEAD_SAMPLES = 5;

function quantile(sorted: number[], probability: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(probability * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function parseOnce(xml: string): void {
  try {
    parse(xml);
  } catch {
    // placeholder parser throws; until it lands this measures call overhead
  }
}

/** Awaits a subrequest so the frozen clock catches up, then reads it. */
async function tick(): Promise<number> {
  const response = await fetch(CLOCK_URL);
  await response.arrayBuffer();
  return performance.now();
}

/** Returns a timer whose laps each cover `count` parses plus one subrequest round-trip. */
async function startLaps(xml: string): Promise<(count: number) => Promise<number>> {
  let last = await tick();
  return async (count) => {
    for (let index = 0; index < count; index++) parseOnce(xml);
    const now = await tick();
    const elapsed = now - last;
    last = now;
    return elapsed;
  };
}

async function measure(xml: string, samples: number) {
  const lap = await startLaps(xml);

  const overheads: number[] = [];
  for (let index = 0; index < OVERHEAD_SAMPLES; index++) overheads.push(await lap(0));
  const overheadMs = quantile(
    overheads.toSorted((a, b) => a - b),
    0.5,
  );

  // Double the batch until one sample reaches the target. This also warms up the JIT.
  let batch = 1;
  while ((await lap(batch)) - overheadMs < TARGET_SAMPLE_MS) {
    if (batch >= MAX_BATCH) {
      throw new Error(
        `clock did not advance across ${batch} parses; ${CLOCK_URL} may no longer count as I/O`,
      );
    }
    batch *= 2;
  }

  const perParseMs: number[] = [];
  for (let index = 0; index < samples; index++) {
    perParseMs.push(Math.max(0, (await lap(batch)) - overheadMs) / batch);
  }
  return { batch, overheadMs, perParseMs: perParseMs.toSorted((a, b) => a - b) };
}

function clampParam(value: string | null, fallback: number, min: number, max: number): number {
  return Math.min(Math.max(Number(value ?? fallback), min), max);
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, version: "remote-bench-v2" });
    }

    if (url.pathname === "/fixtures") {
      return Response.json({ fixtures: Object.keys(FIXTURES) });
    }

    if (url.pathname === "/bench") {
      const fixtureName = url.searchParams.get("fixture") ?? "rss-100k";
      const samples = clampParam(url.searchParams.get("samples"), 20, 1, 50);
      const build = FIXTURES[fixtureName];
      if (build === undefined) {
        return Response.json({ error: `unknown fixture: ${fixtureName}` }, { status: 400 });
      }
      const xml = build();

      let result: Awaited<ReturnType<typeof measure>>;
      try {
        result = await measure(xml, samples);
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
      const { batch, overheadMs, perParseMs } = result;
      const medianMs = quantile(perParseMs, 0.5);

      return Response.json({
        fixture: fixtureName,
        bytes: xml.length,
        samples,
        batch,
        overheadMs,
        avgMs: mean(perParseMs),
        medianMs,
        p95Ms: quantile(perParseMs, 0.95),
        p99Ms: quantile(perParseMs, 0.99),
        minMs: perParseMs[0] ?? 0,
        maxMs: perParseMs.at(-1) ?? 0,
        mbPerSec: medianMs > 0 ? xml.length / 1024 / 1024 / (medianMs / 1000) : 0,
        timestamp: new Date().toISOString(),
      });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
};
