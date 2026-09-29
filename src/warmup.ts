import { decodeInput } from "./decode.js";
import { parseString, resetParser } from "./parse-string.js";

/**
 * Warm-up documents: together they run every path of the parser once, so V8 has type feedback
 * for all branches before it optimizes. "Every path" includes the last comparison of each
 * `&&`/`||` chain (e.g. an attribute value followed directly by "/>"): code that never ran has
 * no feedback, and optimized code deoptimizes when it first runs there. Without it, the first document of a new shape (say an
 * attribute-heavy SVG after RSS) hits a path with no feedback, deoptimizes the parser and pays
 * a second optimizing compile of 24–45 ms on the request thread (research/spikes/s5-jit-behavior.md,
 * confirmed on Cloudflare). One document is one-byte, the other two-byte (a character above
 * U+00FF), so both V8 string representations are seen.
 *
 * "Every path" also means every refresh of a memoized search and every rarely taken loop: the
 * "\r\n" after the top comment makes the PI branch search for the next "\r" (a CRLF feed with a
 * stylesheet PI deoptimized there on Cloudflare); the "&" in a comment makes the next attribute
 * value search for the next "&"; `p = "q"` and `<?p\r\n` run the whitespace loops and
 * comparisons that single spaces skip. Block coverage of parsing both documents should leave
 * only error paths and plain assignments unrun.
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
  '  <!-- & -->\n  <v p = "q"/>\n' +
  "  <!-- in -->\n  <?p\r\nin\r\ndata?>\n" +
  "  <n><m>deep</m><m/></n >\n" +
  "  mixed <b>bold</b> text\n" +
  "</k:root>\n<!-- end -->\n";

const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

/** Warm-up document with only one-byte characters. */
export const WARMUP_ONE_BYTE = DECLARATION + COMMON.replaceAll("TEXT", "café");

/** Warm-up document with characters above U+00FF (typographic quotes, euro sign). */
export const WARMUP_TWO_BYTE = DECLARATION + COMMON.replaceAll("TEXT", "“quoted” €");

/**
 * Enough parses for V8 to allocate the parser's feedback vector (after ~8 calls) and record
 * every path, few enough that it doesn't optimize on warm-up feedback alone (30 did, S5).
 */
const PARSES = 10;

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
      parseString(index % 2 === 0 ? WARMUP_ONE_BYTE : WARMUP_TWO_BYTE, 256, 200, 1000);
    }
    decodeInput(new TextEncoder().encode(WARMUP_TWO_BYTE));
  } finally {
    resetParser();
  }
}
