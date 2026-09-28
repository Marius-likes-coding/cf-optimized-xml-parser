/**
 * cf-optimized-xml-parser: a fast, spec-correct XML parser for Cloudflare Workers.
 * Web APIs only: no `node:*` imports, no `Buffer`. Target: workerd (ES2025).
 */
import { parseString, resetParser } from "./parse-string.js";
import type { ParseOptions, XmlDocument } from "./types.js";

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
  ParseOptions,
  XmlComment,
  XmlDocument,
  XmlElement,
  XmlNode,
  XmlProcessingInstruction,
} from "./types.js";

/** Package version (set by the release). */
export const VERSION = "0.0.0-development";

function limit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Parses an XML document into `{ root, children }`. Throws `XmlError` if the input isn't
 * well-formed or exceeds a limit. Strings in the result are slices of `xml`: keep the result
 * only as long as the input may stay in memory (typically one request).
 */
export function parse(xml: string, options?: ParseOptions): XmlDocument {
  if (typeof xml !== "string") throw new TypeError("parse() expects a string");
  const maxDepth = limit(options?.maxDepth, 256, "maxDepth");
  const maxAttributes = limit(options?.maxAttributes, 200, "maxAttributes");
  const maxNameLength = limit(options?.maxNameLength, 1000, "maxNameLength");
  try {
    return parseString(xml, maxDepth, maxAttributes, maxNameLength);
  } catch (error) {
    resetParser();
    throw error;
  }
}
