/**
 * Remote benchmark Worker.
 * Deployed nightly to measure parser performance in the real Cloudflare runtime.
 *
 * GET /bench?fixture=<name>&iterations=<n>&warmup=<n>
 * GET /health
 * GET /fixtures
 *
 * Fixtures are synthesized at runtime (no file imports) so the Worker stays
 * self-contained and deployable without custom loader rules.
 */
import { parse } from "./index.js";

function rssFeed(items: number, textLength: number): string {
  const lorem = "Lorem ipsum dolor sit amet "
    .repeat(Math.ceil(textLength / 27))
    .slice(0, textLength);
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>Bench</title>`;
  for (let index = 0; index < items; index++) {
    out += `<item id="${index}"><title>Item ${index}</title><link>https://example.com/${index}</link><description>${lorem}</description></item>`;
  }
  return out + `</channel></rss>`;
}

function attrsHeavy(elements: number, attrsPerElement: number): string {
  let out = `<root>`;
  for (let index = 0; index < elements; index++) {
    let attributes = "";
    for (let attr = 0; attr < attrsPerElement; attr++)
      attributes += ` a${attr}="value-${index}-${attr}"`;
    out += `<node${attributes}>text-${index}</node>`;
  }
  return out + `</root>`;
}

function cdataHeavy(sections: number, sectionLength: number): string {
  const payload = "x <>&'\" ".repeat(Math.ceil(sectionLength / 8)).slice(0, sectionLength);
  let out = `<root>`;
  for (let index = 0; index < sections; index++)
    out += `<entry id="${index}"><![CDATA[${payload}]]></entry>`;
  return out + `</root>`;
}

const FIXTURES: Record<string, () => string> = {
  "tiny-1k": () => rssFeed(5, 60),
  "rss-100k": () => rssFeed(300, 200),
  "attrs-heavy-100k": () => attrsHeavy(1200, 8),
  "deep-nesting-100k": () => `<root>${"<level>".repeat(40)}leaf${"</level>".repeat(40)}</root>`,
  "cdata-heavy-100k": () => cdataHeavy(300, 250),
  "large-1mb": () => rssFeed(3000, 220),
};

function quantile(sorted: number[], probability: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(probability * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Time one parse; exceptions only measure harness overhead until the parser lands. */
function timeParse(xml: string): number {
  const start = performance.now();
  try {
    parse(xml);
  } catch {
    // ignore — placeholder parser throws
  }
  return performance.now() - start;
}

function clampParam(value: string | null, fallback: number, min: number, max: number): number {
  return Math.min(Math.max(Number(value ?? fallback), min), max);
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, version: "remote-bench-v1" });
    }

    if (url.pathname === "/fixtures") {
      return Response.json({ fixtures: Object.keys(FIXTURES) });
    }

    if (url.pathname === "/bench") {
      const fixtureName = url.searchParams.get("fixture") ?? "rss-100k";
      const iterations = clampParam(url.searchParams.get("iterations"), 50, 1, 500);
      const warmup = clampParam(url.searchParams.get("warmup"), 5, 0, 50);
      const build = FIXTURES[fixtureName];
      if (build === undefined) {
        return Response.json({ error: `unknown fixture: ${fixtureName}` }, { status: 400 });
      }
      const xml = build();

      for (let index = 0; index < warmup; index++) timeParse(xml);

      const samples: number[] = [];
      for (let index = 0; index < iterations; index++) samples.push(timeParse(xml));
      samples.sort((a, b) => a - b);
      const medianMs = quantile(samples, 0.5);

      return Response.json({
        fixture: fixtureName,
        bytes: xml.length,
        iterations,
        warmup,
        avgMs: mean(samples),
        medianMs,
        p95Ms: quantile(samples, 0.95),
        p99Ms: quantile(samples, 0.99),
        minMs: samples[0] ?? 0,
        maxMs: samples.at(-1) ?? 0,
        mbPerSec: medianMs > 0 ? xml.length / 1024 / 1024 / (medianMs / 1000) : 0,
        timestamp: new Date().toISOString(),
      });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
};
