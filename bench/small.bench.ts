import { describe } from "vitest";
import { benchParse } from "./harness.js";

// Inline small fixtures so bench files run without generation step.
// Large fixtures are loaded from generated files (see bench/large.bench.ts).
const TINY = `<rss version="2.0"><channel><title>B</title><item id="1"><title>T</title></item></channel></rss>`;
const ATTRS = `<root>${'<node a="1" b="2" c="3">x</node>'.repeat(200)}</root>`;
const DEEP = `<a>${"<b>".repeat(30)}leaf${"</b>".repeat(30)}</a>`;
const CDATA_DOC = `<root>${"<e><![CDATA[x <>&]]></e>".repeat(200)}</root>`;

describe("parse: small shapes", () => {
  benchParse("tiny rss", [TINY], { time: 500 });
  benchParse("attrs-heavy", [ATTRS], { time: 500 });
  benchParse("deep-nesting", [DEEP], { time: 500 });
  benchParse("cdata-heavy", [CDATA_DOC], { time: 500 });
});
