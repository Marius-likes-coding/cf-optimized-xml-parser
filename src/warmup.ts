import { decodeInput } from "./decode.js";
import { parseDocument, resetParser } from "./parse-string.js";

/**
 * Warm-up documents: together they run every path of the parser once, so V8 has type feedback
 * for all branches before it optimizes. "Every path" includes the last comparison of each
 * `&&`/`||` chain (e.g. an attribute value followed directly by "/>"): code that never ran has
 * no feedback, and optimized code deoptimizes when it first runs there. Without it, the first document of a new shape (say an
 * attribute-heavy SVG after RSS) hits a path with no feedback, deoptimizes the parser and pays
 * a second optimizing compile of 24–45 ms on the request thread (research/spikes/s5-jit-behavior.md,
 * confirmed on Cloudflare). parse() reads long ASCII documents with parseAscii() and the others
 * with parseString(); the warm-up sends its short ASCII document to parseAscii() too. Of the
 * other two, one is one-byte with a non-ASCII character, one two-byte (a character above
 * U+00FF), so both parsers and both V8 string representations are seen.
 *
 * "Every path" also means every refresh of a memoized search and every rarely taken loop: the
 * "\r\n" after the top comment makes the PI branch search for the next "\r" (a CRLF feed with a
 * stylesheet PI deoptimized there on Cloudflare); the "&" in a comment makes the next attribute
 * value search for the next "&"; `p = "q"` and `<?p\r\n` run the whitespace loops and
 * comparisons that single spaces skip. Block coverage of parsing both documents should leave
 * only error paths and plain assignments unrun.
 *
 * The name cache in parseString needs hits and every kind of miss: repeated start tags with and
 * without attributes (`<v>`, `<c>`, `<abcd>`), an attribute name that differs from the predicted
 * one, extends it or goes past the predicted list, and element names that extend the cached name
 * or differ from it after the four hashed characters (`<abcde>`, `<abcdf>`).
 */
const COMMON =
  '<!DOCTYPE k:root [\n  <!ENTITY e "x>y">\n  <!-- ] in a comment -->\n  <?pi ] in the subset?>\n]>\n' +
  "<!-- top -->\r\n<?pi top data?>\n" +
  '<k:root xmlns:k="urn:k" a="1" b=\'x &amp; &#65;&#x42;\' c="t\tu\r\nv &lt;" d="TEXT">\n' +
  '  <e/>\n  <g h="1"/><x></x>\n' +
  `  <w ${Array.from({ length: 18 }, (_, index) => `a${String(index)}="${String(index)}"`).join(" ")}/>\n` +
  '  <e x="1" y="2" z="3">t &lt; &gt; &quot; &apos; TEXT</e>\n' +
  "  <f>line\r\nbreak &amp; more<![CDATA[c <d> &]]>after &#xE9;&#xe9;&#x1F600;</f>\n" +
  "  <h><![CDATA[first]]></h>\n" +
  '  <!-- & -->\n  <v p = "q"/><v p = "q"/>\n' +
  "  <!-- in -->\n  <?p\r\nin\r\ndata?>\n" +
  "  <n><m>deep</m><m/></n >\n" +
  '  <c x="1" y="2"/><c x="1" y="2"/><c x="1" q="2" z="3"/><c x="1" yy="2"/>\n' +
  '  <abcd/><abcd/><abcd x="1"/><abcde/><abcdf/>\n' +
  "  mixed <b>bold</b> text\n" +
  "</k:root>\n<!-- end -->\n";

const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

/** Warm-up document with only ASCII characters. */
export const WARMUP_ASCII = DECLARATION + COMMON.replaceAll("TEXT", "cafe");

/** Warm-up document with only one-byte characters. */
export const WARMUP_ONE_BYTE = DECLARATION + COMMON.replaceAll("TEXT", "café");

/** Warm-up document with characters above U+00FF (typographic quotes, euro sign). */
export const WARMUP_TWO_BYTE = DECLARATION + COMMON.replaceAll("TEXT", "“quoted” €");

/**
 * Parses with parseString(): enough for V8 to allocate its feedback vector and record every path,
 * few enough that it doesn't optimize on warm-up feedback alone (30 did, S5).
 */
const PARSES = 10;

/**
 * Parses with parseAscii(), whose loop allocates its feedback vector during the first parse. Its
 * bytecode is smaller, so 10 warm-up parses already compiled it in Maglev, and the first real
 * document deoptimized that code (workerd 1.20260815); with 4, 6 or 8 neither happened.
 */
const ASCII_PARSES = 6;

let warmed = false;

/**
 * Primes V8's type feedback for the parser, once per isolate. Call it at module scope, where
 * Cloudflare runs it under the startup budget instead of a request's CPU time:
 *
 *   import { parse, warmup } from "cf-optimized-xml-parser";
 *   warmup();
 *
 * Worth it when one Worker parses documents of different shapes. Later calls do nothing.
 */
export function warmup(): void {
  if (warmed) return;
  warmed = true;
  try {
    for (let index = 0; index < PARSES; index++) {
      if (index < ASCII_PARSES) parseDocument(WARMUP_ASCII, 256, 200, 1000, 0);
      parseDocument(index % 2 === 0 ? WARMUP_ONE_BYTE : WARMUP_TWO_BYTE, 256, 200, 1000, 0);
    }
    decodeInput(new TextEncoder().encode(WARMUP_TWO_BYTE));
  } finally {
    resetParser();
  }
}
