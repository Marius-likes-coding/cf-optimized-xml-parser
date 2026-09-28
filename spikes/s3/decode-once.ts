/**
 * S3 variant: decode the whole buffer once with TextDecoder, then run the S2 string parser.
 * workerd returns a one-byte string for pure ASCII (simdutf fast path) and for Latin-1-only
 * content (V8 downgrades), and a two-byte string once any character is above U+00FF.
 */
import { parse as parseString } from "../s2/fold-text.ts";

const decoder = new TextDecoder();

export function parse(bytes: Uint8Array): ReturnType<typeof parseString> {
  return parseString(decoder.decode(bytes));
}
