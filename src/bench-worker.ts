/**
 * Remote benchmark Worker, deployed nightly and timed from outside by scripts/bench-remote.mjs.
 *
 * GET /run?fixture=<name>&count=<n>   parse the fixture n times, then respond
 * GET /health
 * GET /fixtures
 *
 * Deployed Workers never count JavaScript execution in performance.now() or Date.now():
 * the clock moves only by time spent waiting on I/O, even across a fetch (probed in
 * production, 2026-09-26). Nothing in here can time parse(), so the client times each
 * request and subtracts a count=0 request, which leaves the parse time.
 */
import { FIXTURES } from "./bench-fixtures.js";
import { parse } from "./index.js";

/** Sanity cap only; the client sizes `count` so each request stays well under the CPU limit. */
const MAX_COUNT = 2 ** 20;

/** Built once per isolate, so count=0 and count=n requests do the same non-parse work. */
const built = new Map<string, string>();

function fixture(name: string): string | undefined {
  const build = FIXTURES[name];
  if (build === undefined) return undefined;
  let xml = built.get(name);
  if (xml === undefined) {
    xml = build();
    built.set(name, xml);
  }
  return xml;
}

function parseOnce(xml: string): void {
  try {
    parse(xml);
  } catch {
    // placeholder parser throws; until it lands this measures call overhead
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, version: "remote-bench-v3" });
    }

    if (url.pathname === "/fixtures") {
      return Response.json({ fixtures: Object.keys(FIXTURES) });
    }

    if (url.pathname === "/run") {
      const name = url.searchParams.get("fixture") ?? "";
      const count = Number(url.searchParams.get("count") ?? "0");
      const xml = fixture(name);
      if (xml === undefined) {
        return Response.json({ error: `unknown fixture: ${name}` }, { status: 400 });
      }
      if (!Number.isInteger(count) || count < 0 || count > MAX_COUNT) {
        return Response.json({ error: `count must be 0..${MAX_COUNT}` }, { status: 400 });
      }
      for (let index = 0; index < count; index++) parseOnce(xml);
      return Response.json({ fixture: name, bytes: xml.length, count });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
};
