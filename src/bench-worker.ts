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
    for (let a = 0; a < attrsPerElement; a++) attributes += ` a${a}="value-${index}-${a}"`;
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

function buildFixture(name: string): string | undefined {
  switch (name) {
    case "tiny-1k": {
      return rssFeed(5, 60);
    }
    case "rss-100k": {
      return rssFeed(300, 200);
    }
    case "attrs-heavy-100k": {
      return attrsHeavy(1200, 8);
    }
    case "deep-nesting-100k": {
      return `<root>${"<level>".repeat(40)}leaf${"</level>".repeat(40)}</root>`;
    }
    case "cdata-heavy-100k": {
      return cdataHeavy(300, 250);
    }
    case "large-1mb": {
      return rssFeed(3000, 220);
    }
    default: {
      return undefined;
    }
  }
}

const FIXTURE_NAMES = [
  "tiny-1k",
  "rss-100k",
  "attrs-heavy-100k",
  "deep-nesting-100k",
  "cdata-heavy-100k",
  "large-1mb",
];

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, version: "remote-bench-v1" });
    }

    if (url.pathname === "/fixtures") {
      return Response.json({ fixtures: FIXTURE_NAMES });
    }

    if (url.pathname === "/bench") {
      const fixtureName = url.searchParams.get("fixture") ?? "rss-100k";
      const iterations = Math.min(
        Math.max(Number(url.searchParams.get("iterations") ?? "50"), 1),
        500,
      );
      const warmup = Math.min(Math.max(Number(url.searchParams.get("warmup") ?? "5"), 0), 50);
      const xml = buildFixture(fixtureName);
      if (xml === undefined) {
        return Response.json({ error: `unknown fixture: ${fixtureName}` }, { status: 400 });
      }

      for (let index = 0; index < warmup; index++) {
        try {
          parse(xml);
        } catch {
          // Placeholder parser throws; timing harness still works once implemented.
          break;
        }
      }

      const samples: number[] = [];
      for (let index = 0; index < iterations; index++) {
        const start = performance.now();
        try {
          parse(xml);
        } catch {
          // Until the parser is implemented, record the overhead only.
        }
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      const bytes = xml.length;
      const medianMs = quantile(samples, 0.5);
      const mbPerSec = medianMs > 0 ? bytes / 1024 / 1024 / (medianMs / 1000) : 0;

      return Response.json({
        fixture: fixtureName,
        bytes,
        iterations,
        warmup,
        avgMs: mean(samples),
        medianMs,
        p95Ms: quantile(samples, 0.95),
        p99Ms: quantile(samples, 0.99),
        minMs: samples[0] ?? 0,
        maxMs: samples.at(-1) ?? 0,
        mbPerSec,
        timestamp: new Date().toISOString(),
      });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
};
