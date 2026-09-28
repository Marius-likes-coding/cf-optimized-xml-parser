/**
 * cf-optimized-xml-parser: a fast, spec-correct XML parser for Cloudflare Workers.
 * Web APIs only: no `node:*` imports, no `Buffer`. Target: workerd (ES2025).
 */
import { parseString, resetParser } from "./parse-string.js";
import type { XmlDocument } from "./types.js";

export { XmlError } from "./errors.js";
export {
  attributes,
  childNodes,
  getAttribute,
  isComment,
  isElement,
  isProcessingInstruction,
  textContent,
} from "./helpers.js";
export type {
  XmlComment,
  XmlDocument,
  XmlElement,
  XmlNode,
  XmlProcessingInstruction,
} from "./types.js";

/** Package version (set by the release). */
export const VERSION = "0.0.0-development";

/**
 * Parses an XML document into `{ root, children }`. Throws `XmlError` if the input isn't
 * well-formed. Strings in the result are slices of `xml`: keep the result only as long as the
 * input may stay in memory (typically one request).
 */
export function parse(xml: string): XmlDocument {
  if (typeof xml !== "string") throw new TypeError("parse() expects a string");
  try {
    return parseString(xml);
  } catch (error) {
    resetParser();
    throw error;
  }
}
