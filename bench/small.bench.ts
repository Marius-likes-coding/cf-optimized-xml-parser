import { bench, describe } from "vitest";
import { parse } from "../src/index.js";

// Inline small fixtures so bench files run without generation step.
// Large fixtures are loaded from generated files (see bench/large.bench.ts).
const TINY = `<rss version="2.0"><channel><title>B</title><item id="1"><title>T</title></item></channel></rss>`;
const ATTRS = `<root>${'<node a="1" b="2" c="3">x</node>'.repeat(200)}</root>`;
const DEEP = `<a>${"<b>".repeat(30)}leaf${"</b>".repeat(30)}</a>`;
const CDATA_DOC = `<root>${"<e><![CDATA[x <>&]]></e>".repeat(200)}</root>`;

function safeParse(xml: string): void {
  try {
    parse(xml);
  } catch {
    // Parser not implemented yet — measures harness overhead until then.
  }
}

describe("parse: small shapes", () => {
  bench(
    "tiny rss",
    () => {
      safeParse(TINY);
    },
    { time: 500 },
  );
  bench(
    "attrs-heavy",
    () => {
      safeParse(ATTRS);
    },
    { time: 500 },
  );
  bench(
    "deep-nesting",
    () => {
      safeParse(DEEP);
    },
    { time: 500 },
  );
  bench(
    "cdata-heavy",
    () => {
      safeParse(CDATA_DOC);
    },
    { time: 500 },
  );
});
