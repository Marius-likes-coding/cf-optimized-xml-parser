import { bench, describe } from "vitest";
import { parse } from "../src/index.js";

// Inline small fixtures so bench files run without generation step.
// Large fixtures are loaded from generated files (see bench/large.bench.ts).
const TINY = `<rss version="2.0"><channel><title>B</title><item id="1"><title>T</title></item></channel></rss>`;
const ATTRS = `<root>${'<node a="1" b="2" c="3">x</node>'.repeat(200)}</root>`;
const DEEP = `<a>${"<b>".repeat(30)}leaf${"</b>".repeat(30)}</a>`;
const CDATA_DOC = `<root>${"<e><![CDATA[x <>&]]></e>".repeat(200)}</root>`;

/** Returns the parse result (or null until the parser lands) so callbacks stay one-liners. */
function safeParse(xml: string): unknown {
  try {
    return parse(xml);
  } catch {
    // Parser not implemented yet — measures harness overhead until then.
    return null;
  }
}

describe("parse: small shapes", () => {
  bench("tiny rss", () => void safeParse(TINY), { time: 500 });
  bench("attrs-heavy", () => void safeParse(ATTRS), { time: 500 });
  bench("deep-nesting", () => void safeParse(DEEP), { time: 500 });
  bench("cdata-heavy", () => void safeParse(CDATA_DOC), { time: 500 });
});
