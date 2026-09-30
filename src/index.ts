/**
 * cf-optimized-xml-parser: a fast, spec-correct XML parser for Cloudflare Workers.
 * Web APIs only: no `node:*` imports, no `Buffer`. Target: workerd (ES2025).
 */
import { decodeInput } from "./decode.js";
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
export { warmup } from "./warmup.js";

/** Replaced with package.json's version by the build (tsdown.config.ts). */
declare const __VERSION__: string | undefined;

/** Package version, for example "2.0.1"; "0.0.0-development" when the sources run unbuilt. */
export const VERSION: string = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-development";

let slowdown = 0;

function limit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Parses an XML document into `{ root, children }`. Throws `XmlError` if the input isn't
 * well-formed or exceeds a limit.
 *
 * Input is a string, or bytes (`Uint8Array`, any other `ArrayBufferView`, or `ArrayBuffer`),
 * which are decoded once: the byte order mark or the declaration's `encoding` decides, UTF-8
 * otherwise; invalid byte sequences throw. Strings in the result are slices of the (decoded)
 * input: keep the result only as long as the input may stay in memory (typically one request).
 */
export function parse(
  input: string | ArrayBufferView | ArrayBuffer,
  options?: ParseOptions,
): XmlDocument {
  let xml: string;
  if (typeof input === "string") xml = input;
  else if (input instanceof ArrayBuffer) xml = decodeInput(new Uint8Array(input));
  else if (ArrayBuffer.isView(input)) {
    xml = decodeInput(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
  } else throw new TypeError("parse() expects a string, an ArrayBuffer or an ArrayBufferView");
  const maxDepth = limit(options?.maxDepth, 256, "maxDepth");
  const maxAttributes = limit(options?.maxAttributes, 200, "maxAttributes");
  const maxNameLength = limit(options?.maxNameLength, 1000, "maxNameLength");
  try {
    // Deliberate slowdown to test the perf gate (PR must not be merged).
    if (++slowdown % 7 === 0) parseString(xml, maxDepth, maxAttributes, maxNameLength);
    return parseString(xml, maxDepth, maxAttributes, maxNameLength);
  } catch (error) {
    resetParser();
    throw error;
  }
}
