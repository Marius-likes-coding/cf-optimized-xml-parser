/* eslint-disable unicorn/prefer-code-point -- compares UTF-16 code units, like the scanner. */
import { fail } from "./errors.js";

/** Literal text is kept as is. */
export const RAW = 0;
/** Line endings normalized: `\r\n` and `\r` become `\n` (XML 1.0 §2.11). */
export const LINE_ENDS = 1;
/** Attribute value: `\r\n` and each literal tab, newline or CR become one space (§3.3.3). */
export const ATTRIBUTE = 2;

const LINE_END_RE = /\r\n?/g;
const ATTRIBUTE_WS_RE = /\r\n|[\t\n\r]/g;

/** Applies a normalization mode to literal text (never to text produced by a reference). */
export function normalize(text: string, mode: number): string {
  if (mode === RAW) return text;
  return mode === LINE_ENDS
    ? text.replaceAll(LINE_END_RE, "\n")
    : text.replaceAll(ATTRIBUTE_WS_RE, " ");
}

/**
 * Set by decodeEntities: the first "&" at or after the end of the decoded range (or the
 * string's length), so the parser's memoized "&" position stays valid without a new search.
 */
export let ampAfter = 0;

function isXmlChar(code: number): boolean {
  return (
    code === 9 ||
    code === 10 ||
    code === 13 ||
    (code >= 0x20 && code <= 0xd7_ff) ||
    (code >= 0xe0_00 && code <= 0xff_fd) ||
    (code >= 0x1_00_00 && code <= 0x10_ff_ff)
  );
}

/**
 * Text of `source[start, end)` with the five predefined entities and character references
 * expanded, and the literal text between them normalized per `mode`. `amp` is the first "&" in
 * the range. Any other entity is an error: DTD entities are never expanded (DOCTYPE is
 * skipped). Characters produced by references are never normalized, as the spec requires.
 */
export function decodeEntities(
  source: string,
  start: number,
  end: number,
  amp: number,
  mode: number,
): string {
  let out = "";
  let pos = start;
  while (amp < end) {
    out += normalize(source.slice(pos, amp), mode);
    const semi = source.indexOf(";", amp + 1);
    if (semi === -1 || semi >= end) fail("unterminated entity reference", source, amp);
    const size = semi - amp;
    if (source.charCodeAt(amp + 1) === 35) {
      const hex = source.charCodeAt(amp + 2) === 120;
      let digit = amp + (hex ? 3 : 2);
      if (digit === semi) fail("empty character reference", source, amp);
      let code = 0;
      for (; digit < semi; digit++) {
        const d = source.charCodeAt(digit);
        if (d >= 48 && d <= 57) code = code * (hex ? 16 : 10) + d - 48;
        else if (hex && ((d >= 97 && d <= 102) || (d >= 65 && d <= 70)))
          code = code * 16 + (d | 32) - 87;
        else fail("invalid character reference", source, amp);
        if (code > 0x10_ff_ff) fail("character reference out of range", source, amp);
      }
      if (!isXmlChar(code)) fail("character reference to a character XML forbids", source, amp);
      out += String.fromCodePoint(code);
    } else if (size === 3 && source.startsWith("lt", amp + 1)) out += "<";
    else if (size === 3 && source.startsWith("gt", amp + 1)) out += ">";
    else if (size === 4 && source.startsWith("amp", amp + 1)) out += "&";
    else if (size === 5 && source.startsWith("quot", amp + 1)) out += '"';
    else if (size === 5 && source.startsWith("apos", amp + 1)) out += "'";
    else
      fail(
        "unknown entity (only &lt; &gt; &amp; &quot; &apos; and character references)",
        source,
        amp,
      );
    pos = semi + 1;
    amp = source.indexOf("&", pos);
    if (amp === -1) amp = source.length;
  }
  ampAfter = amp;
  return out + normalize(source.slice(pos, end), mode);
}
