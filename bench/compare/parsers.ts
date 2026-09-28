import { XMLParser } from "fast-xml-parser";
import { parse as txmlParse } from "txml/txml";
import type { ParseFunction } from "../harness.js";

/**
 * Parsers under comparison, each as a plain `(xml) => tree` function. Used by the competitor
 * bench and by scripts/bench-memory.mjs and scripts/bench-cold.mjs (`bench/compare/parsers.ts#txml`).
 */
export { parse as ours } from "../../src/index.js";

/**
 * Keeps comments. Decodes no entities and skips most well-formedness checks. `noChildNodes: []`
 * turns off txml's HTML void-element list, which otherwise rejects RSS `<link>…</link>`.
 */
export const txml: ParseFunction = (xml) =>
  txmlParse(xml, { keepComments: true, noChildNodes: [] });

// preserveOrder is fast-xml-parser's closest output to ours: document order, attributes and
// comments kept, no value coercion. It still trims every text value.
const fxp = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  commentPropName: "#comment",
  parseTagValue: false,
  parseAttributeValue: false,
});

export const fastXmlParser: ParseFunction = (xml) => fxp.parse(xml);
