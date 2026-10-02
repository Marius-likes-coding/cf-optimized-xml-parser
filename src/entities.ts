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
  // Read once per call: the "no further &" branch below runs only at a document's last
  // reference, so a length read there had no type feedback when Maglev compiled this function
  // during the first parse, and it deoptimized (s3, sitemap, entities).
  const length = source.length;
  let out = "";
  let pos = start;
  while (amp < end) {
    // The characters after "&" are read once and shared by the five names: every read site is
    // a loop over V8's string representations in Turbofan's compile.
    const head = source.charCodeAt(amp + 1);
    const c2 = source.charCodeAt(amp + 2);
    const c3 = source.charCodeAt(amp + 3);
    const c4 = source.charCodeAt(amp + 4);
    let semi: number;
    // Named references pin the position of ";", so they need no indexOf(): no name character is
    // ";", so the first ";" after "&" is right after the name, as the search would find. `end` is
    // a "<", a quote or the end of the input, so a match never runs past it. Integer compares,
    // not startsWith() calls, as for numeric references.
    if (head === 97 && c2 === 109 && c3 === 112 && c4 === 59) {
      // "&amp;" stands for its own first character: the slice takes it along, one
      // concatenation less.
      out += normalize(source.slice(pos, amp + 1), mode);
      semi = amp + 4;
    } else {
      out += normalize(source.slice(pos, amp), mode);
      if (
        head === 113 &&
        c2 === 117 &&
        c3 === 111 &&
        c4 === 116 &&
        source.charCodeAt(amp + 5) === 59
      ) {
        out += '"';
        semi = amp + 5;
      } else if ((head === 108 || head === 103) && c2 === 116 && c3 === 59) {
        out += head === 108 ? "<" : ">";
        semi = amp + 3;
      } else if (
        head === 97 &&
        c2 === 112 &&
        c3 === 111 &&
        c4 === 115 &&
        source.charCodeAt(amp + 5) === 59
      ) {
        out += "'";
        semi = amp + 5;
      } else {
        semi = source.indexOf(";", amp + 1);
        if (semi === -1 || semi >= end) fail("unterminated entity reference", source, amp);
        if (head !== 35)
          fail(
            "unknown entity (only &lt; &gt; &amp; &quot; &apos; and character references)",
            source,
            amp,
          );
        // The isXmlChar() range check is inlined: it runs once per numeric reference and the call
        // overhead shows next to the digit loop.
        const hex = c2 === 120;
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
        if (!(
          code === 9 ||
          code === 10 ||
          code === 13 ||
          (code >= 0x20 && code <= 0xd7_ff) ||
          (code >= 0xe0_00 && code <= 0xff_fd) ||
          (code >= 0x1_00_00 && code <= 0x10_ff_ff)
        ))
          fail("character reference to a character XML forbids", source, amp);
        out += String.fromCodePoint(code);
      }
    }
    pos = semi + 1;
    amp = source.indexOf("&", pos);
    if (amp === -1) amp = length;
  }
  ampAfter = amp;
  // A value that ends with a reference needs no empty last piece.
  return pos < end ? out + normalize(source.slice(pos, end), mode) : out;
}
