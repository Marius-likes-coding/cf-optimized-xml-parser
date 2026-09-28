/**
 * M6: what enforcing the Char production (XML 1.0 §2.2, decision D10: not checked) would cost
 * as one regex pass over the whole document before parsing.
 */
import { parse } from "../../src/index.ts";

const FORBIDDEN_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export { parse };

export function parseCheckingChars(xml: string): unknown {
  if (FORBIDDEN_CHAR.test(xml)) throw new Error("forbidden character");
  return parse(xml);
}
