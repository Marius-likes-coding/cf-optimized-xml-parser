/**
 * Remote check of the released parser (2.0.0): does `warmup()` at module scope, as the README
 * recommends, prevent the shape-change deopts and recompiles on Cloudflare? Each /parse request
 * parses one bundled fixture once, so tail's per-request cpuTime shows cold parses and compile
 * spikes. Deploy with `--define WARM:0` (control) or `--define WARM:1`.
 *   /health
 *   /parse?fixture=<name>&input=string|bytes
 */
// @ts-expect-error: wrangler bundles .xml as text modules (see final.toml [[rules]])
import RSS from "../../test/fixtures/generated/matrix/rss-ascii.xml";
// @ts-expect-error: as above
import SVG from "../../test/fixtures/generated/matrix/svg.xml";
// @ts-expect-error: as above
import SOAP from "../../test/fixtures/generated/matrix/soap.xml";
// @ts-expect-error: as above
import OOXML_CJK from "../../test/fixtures/generated/matrix/ooxml-cjk.xml";
// @ts-expect-error: as above
import S3 from "../../test/fixtures/generated/matrix/s3-ascii.xml";
// @ts-expect-error: as above
import RSS_CRLF from "../../test/fixtures/generated/matrix/rss-crlf.xml";
// @ts-expect-error: as above
import ENTITIES from "../../test/fixtures/generated/matrix/entities.xml";
import { parse, warmup } from "../../src/index.ts";

declare const WARM: number;

const FIXTURES: Record<string, string> = {
  "rss-ascii": RSS as string,
  svg: SVG as string,
  soap: SOAP as string,
  "ooxml-cjk": OOXML_CJK as string,
  "s3-ascii": S3 as string,
  "rss-crlf": RSS_CRLF as string,
  entities: ENTITIES as string,
};
const encoder = new TextEncoder();
const BYTES: Record<string, Uint8Array> = {};
for (const [name, xml] of Object.entries(FIXTURES)) BYTES[name] = encoder.encode(xml);

if (WARM) warmup();

let isolate: string | undefined;
let parses = 0;
let sink: unknown;

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    isolate ??= crypto.randomUUID().slice(0, 8);
    if (url.pathname === "/health") return Response.json({ ok: true, isolate, parses, warm: WARM });
    if (url.pathname !== "/parse") return Response.json({ isolate, error: "not found" }, { status: 404 });
    const name = url.searchParams.get("fixture") ?? "";
    const input = url.searchParams.get("input") === "bytes" ? BYTES[name] : FIXTURES[name];
    if (input === undefined) return Response.json({ isolate, error: "unknown fixture" }, { status: 400 });
    sink = parse(input);
    parses++;
    return Response.json({ isolate, parses, warm: WARM, result: typeof sink });
  },
};
