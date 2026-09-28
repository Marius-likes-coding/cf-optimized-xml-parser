/**
 * S5 remote confirmation Worker. Each /spike request parses one bundled matrix fixture with
 * the strict spike parser, so tail's per-request cpuTime shows cold parses and compile spikes.
 * Requests spread over several isolates, so every response reports its isolate and how many
 * parses that isolate has done (the per-isolate parse index).
 *   /health
 *   /spike?fixture=rss-ascii|svg&warm=0|1   warm=1 runs the S5 warm-up once per isolate first
 */
// @ts-expect-error: wrangler bundles .xml as text modules (see wrangler.toml [[rules]])
import RSS from "../../test/fixtures/generated/matrix/rss-ascii.xml";
// @ts-expect-error: as above
import SVG from "../../test/fixtures/generated/matrix/svg.xml";
import { parse } from "../s5/strict-stacks.ts";

const FIXTURES: Record<string, string> = { "rss-ascii": RSS as string, svg: SVG as string };
const KITCHEN_SINK =
  '<?xml version="1.0" encoding="UTF-8"?>\r\n<!DOCTYPE k [<!ENTITY e "x">]>\n<!-- c -->\n<?pi data?>\n' +
  '<k a="1" b="x &amp; &#65; &#x42;" c="t\tu\r\nv"><e/><e x="1" y="2" z="3">t &lt; &gt; &quot; &apos; “q” —</e>' +
  '<f>line\r\nbreak<![CDATA[c <d> &]]>after</f><!-- in --><?p in?><g h="é"/>\n  <n><m>deep</m></n></k>\n<!-- end -->';

let isolate: string | undefined;
let parses = 0;
let warmed = false;
let sink: unknown;

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    isolate ??= crypto.randomUUID().slice(0, 8);
    if (url.pathname === "/health") return Response.json({ ok: true, isolate, parses });
    if (url.pathname !== "/spike") return Response.json({ isolate, error: "not found" }, { status: 404 });
    const xml = FIXTURES[url.searchParams.get("fixture") ?? ""];
    if (xml === undefined) return Response.json({ isolate, error: "unknown fixture" }, { status: 400 });
    let didWarm = false;
    if (url.searchParams.get("warm") === "1" && !warmed) {
      for (let index = 0; index < 10; index++) sink = parse(KITCHEN_SINK);
      warmed = true;
      didWarm = true;
    }
    sink = parse(xml);
    parses++;
    return Response.json({ isolate, parses, didWarm, result: typeof sink });
  },
};
