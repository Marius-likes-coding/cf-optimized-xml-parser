/* eslint-disable unicorn/prefer-code-point -- UTF-16 code units are what the scanner compares; codePointAt adds a surrogate branch per read. */
/**
 * The parser's one hot function. Design and measurements: research/spikes/ (S1 scanner, S2 tree
 * building, S4 correctness costs, S5 JIT behavior) and docs/implementation-plan.md.
 *
 * - Scanning is builtin-driven: indexOf finds text runs, markup ends and attribute-value ends;
 *   names are matched with a sticky regex's test(). Checks that need a search share memoized
 *   positions (next "&", "\r", "]]>", tab/newline/CR), so a document without them pays one
 *   failed search each.
 * - Nodes are one object-literal shape. Children are collected on a module-level scratch stack
 *   and copied out with slice() at the end tag; a lone text child is stored as the string.
 * - Module-level arrays keep one elements kind for the life of the isolate, so optimized code
 *   never deopts on them (S5). Nothing is left in them after a parse (see resetParser).
 */
import { ampAfter, ATTRIBUTE, decodeEntities, LINE_ENDS, normalize, RAW } from "./entities.js";
import { fail } from "./errors.js";
import type { XmlDocument, XmlElement, XmlNode } from "./types.js";

/** XML 1.0 (5th ed.) §2.3 Name = NameStartChar NameChar*. Sticky; used with test() only. */
const NAME_RE =
  /[:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}][\w.:\u00B7\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u037D\u037F-\u1FFF\u200C-\u200D\u203F-\u2040\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}-]*/uy;
/** Next tab, newline or CR, for attribute-value normalization (global: test() + lastIndex). */
const WS_RE = /[\t\n\r]/g;
/** XMLDecl content after "<?xml": version, then optional encoding and standalone (§2.8, §4.3.3). */
const DECLARATION_RE =
  /^version[\t\n\r ]*=[\t\n\r ]*(["'])(1\.\d+)\1(?:[\t\n\r ]+encoding[\t\n\r ]*=[\t\n\r ]*(["'])[A-Za-z][\w.-]*\3)?(?:[\t\n\r ]+standalone[\t\n\r ]*=[\t\n\r ]*(["'])(?:yes|no)\4)?[\t\n\r ]*$/;
const MAX_DOCTYPE = 65_536;
/**
 * doctypedecl up to the internal subset or ">" (§2.8 [28], [75], [12]): a Name, then an optional
 * SYSTEM or PUBLIC identifier. Checked once per document; the internal subset is skipped.
 */
const DOCTYPE_HEAD_RE = new RegExp(
  String.raw`[\t\n\r ]+(?:${NAME_RE.source})(?:[\t\n\r ]+(?:SYSTEM[\t\n\r ]+(?:"[^"]*"|'[^']*')|PUBLIC[\t\n\r ]+(?:"[-'()+,./:=?;!*#@$_%\n\r a-zA-Z0-9]*"|'[-()+,./:=?;!*#@$_%\n\r a-zA-Z0-9]*')[\t\n\r ]+(?:"[^"]*"|'[^']*')))?[\t\n\r ]*[[>]`,
  "uy",
);

const scratch: XmlNode[] = [""];
const attributeScratch: string[] = [""];
const openStack: XmlElement[] = [{ name: "", attrs: null, children: null }];
const frameStack: number[] = [0];
/** Attribute names of the current element once it has more than 16 (see the duplicate check). */
const seenNames = new Set<string>();

/** Drops every reference the module-level stacks hold (after a parse or a thrown error). */
export function resetParser(): void {
  scratch.length = 0;
  attributeScratch.length = 0;
  openStack.length = 0;
  frameStack.length = 0;
  seenNames.clear();
}

function skipDoctype(xml: string, start: number): number {
  let depth = 0;
  let quote = 0;
  const limit = Math.min(xml.length, start + MAX_DOCTYPE);
  for (let p = start; p < limit; p++) {
    const ch = xml.charCodeAt(p);
    if (quote !== 0) {
      if (ch === quote) quote = 0;
      continue;
    }
    // Comments and PIs in the internal subset may contain brackets and quotes.
    if (ch === 60 && depth > 0) {
      if (xml.startsWith("!--", p + 1)) {
        const end = xml.indexOf("-->", p + 4);
        if (end === -1) break;
        p = end + 2;
        continue;
      }
      if (xml.charCodeAt(p + 1) === 63) {
        const end = xml.indexOf("?>", p + 2);
        if (end === -1) break;
        p = end + 1;
        continue;
      }
    }
    switch (ch) {
      case 34:
      case 39: {
        quote = ch;
        break;
      }
      case 91: {
        depth++;
        break;
      }
      case 93: {
        depth--;
        break;
      }
      case 62: {
        if (depth === 0) return p + 1;
        break;
      }
    }
  }
  return fail(
    limit < xml.length ? "DOCTYPE larger than 64 KiB" : "unterminated DOCTYPE",
    xml,
    start,
  );
}

/** Checks the XML declaration's content (between "<?xml" and "?>"). */
function checkDeclaration(xml: string, start: number, end: number): void {
  const declaration = DECLARATION_RE.exec(xml.slice(start, end));
  if (declaration === null) fail("malformed XML declaration", xml, start);
  // A 1.0 processor treats any 1.x as 1.0 (§2.8); XML 1.1 has different rules and is refused.
  if (declaration[2] === "1.1") fail("XML 1.1 is not supported", xml, start);
}

export function parseString(
  xml: string,
  maxDepth: number,
  maxAttributes: number,
  maxNameLength: number,
): XmlDocument {
  const length = xml.length;
  const open = openStack;
  const frames = frameStack;
  open.length = 0;
  frames.length = 0;
  let top = 0;
  let root: XmlElement | null = null;
  let lastText = false;
  let seenDoctype = false;
  let amp = xml.indexOf("&");
  if (amp === -1) amp = length;
  let cr = xml.indexOf("\r");
  if (cr === -1) cr = length;
  let cdataEnd = xml.indexOf("]]>");
  if (cdataEnd === -1) cdataEnd = length;
  let newline = -1;
  let tab = -1;
  let lt = xml.indexOf("<");
  if (lt === -1) fail("no root element", xml, 0);
  const bom = xml.charCodeAt(0) === 0xfe_ff ? 1 : 0;
  let textStart = bom;

  for (;;) {
    // Text up to the next "<": dropped when whitespace-only, merged with adjacent text/CDATA.
    const textEnd = lt === -1 ? length : lt;
    if (textEnd > textStart) {
      let p = textStart;
      let c = xml.charCodeAt(p);
      while (c === 32 || c === 10 || c === 9 || c === 13) {
        if (++p === textEnd) break;
        c = xml.charCodeAt(p);
      }
      if (p < textEnd) {
        if (open.length === 0) fail("text outside the root element", xml, p);
        if (cdataEnd < textStart) {
          cdataEnd = xml.indexOf("]]>", textStart);
          if (cdataEnd === -1) cdataEnd = length;
        }
        if (cdataEnd < textEnd) fail('"]]>" in text', xml, cdataEnd);
        if (amp < textStart) {
          amp = xml.indexOf("&", textStart);
          if (amp === -1) amp = length;
        }
        if (cr < textStart) {
          cr = xml.indexOf("\r", textStart);
          if (cr === -1) cr = length;
        }
        const mode = cr < textEnd ? LINE_ENDS : RAW;
        let value: string;
        if (amp < textEnd) {
          value = decodeEntities(xml, textStart, textEnd, amp, mode);
          amp = ampAfter;
        } else {
          value = xml.slice(textStart, textEnd);
          if (mode !== RAW) value = normalize(value, mode);
        }
        if (lastText) scratch[top - 1] = (scratch[top - 1] as string) + value;
        else {
          scratch[top++] = value;
          lastText = true;
        }
      }
    }
    if (lt === -1) break;

    const c = xml.charCodeAt(lt + 1);
    if (c === 47) {
      // End tag.
      const node = open.pop();
      if (node === undefined) return fail("end tag without a start tag", xml, lt);
      const name = node.name;
      if (!xml.startsWith(name, lt + 2)) fail("end tag doesn't match the open element", xml, lt);
      let p = lt + 2 + name.length;
      let ch = xml.charCodeAt(p);
      while (ch === 32 || ch === 10 || ch === 9 || ch === 13) ch = xml.charCodeAt(++p);
      if (ch !== 62) fail("end tag doesn't match the open element", xml, lt);
      const start = frames.pop() as number;
      if (top > start) {
        const only = scratch[start];
        node.children =
          top - start === 1 && typeof only === "string" ? only : scratch.slice(start, top);
        top = start;
      }
      lastText = false;
      textStart = p + 1;
      lt = xml.indexOf("<", textStart);
      continue;
    }
    if (c === 33) {
      if (xml.charCodeAt(lt + 2) === 45 && xml.charCodeAt(lt + 3) === 45) {
        const end = xml.indexOf("-->", lt + 4);
        if (end === -1) fail("unterminated comment", xml, lt);
        if (xml.indexOf("--", lt + 4) < end || (end > lt + 4 && xml.charCodeAt(end - 1) === 45))
          fail('"--" inside a comment', xml, lt);
        if (cr < lt) {
          cr = xml.indexOf("\r", lt);
          if (cr === -1) cr = length;
        }
        scratch[top++] = {
          name: "#comment",
          attrs: null,
          children: normalize(xml.slice(lt + 4, end), cr < end ? LINE_ENDS : RAW),
        };
        lastText = false;
        textStart = end + 3;
      } else if (xml.startsWith("[CDATA[", lt + 2)) {
        if (open.length === 0) fail("CDATA section outside the root element", xml, lt);
        const end = xml.indexOf("]]>", lt + 9);
        if (end === -1) fail("unterminated CDATA section", xml, lt);
        if (cr < lt) {
          cr = xml.indexOf("\r", lt);
          if (cr === -1) cr = length;
        }
        const value = normalize(xml.slice(lt + 9, end), cr < end ? LINE_ENDS : RAW);
        if (lastText) scratch[top - 1] = (scratch[top - 1] as string) + value;
        else {
          scratch[top++] = value;
          lastText = true;
        }
        textStart = end + 3;
      } else if (xml.startsWith("DOCTYPE", lt + 2)) {
        if (root !== null || seenDoctype) fail("DOCTYPE after the root or repeated", xml, lt);
        seenDoctype = true;
        DOCTYPE_HEAD_RE.lastIndex = lt + 9;
        if (!DOCTYPE_HEAD_RE.test(xml)) fail("malformed DOCTYPE", xml, lt);
        textStart = skipDoctype(xml, lt + 9);
      } else fail("unknown markup declaration", xml, lt);
      lt = xml.indexOf("<", textStart);
      continue;
    }
    if (c === 63) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) fail("unterminated processing instruction", xml, lt);
      NAME_RE.lastIndex = lt + 2;
      if (!NAME_RE.test(xml)) fail("invalid processing instruction target", xml, lt);
      let p = NAME_RE.lastIndex;
      let ch = xml.charCodeAt(p);
      if (p !== end && ch !== 32 && ch !== 10 && ch !== 9 && ch !== 13)
        fail("invalid processing instruction target", xml, lt);
      if (p - lt - 2 > maxNameLength) fail("name longer than maxNameLength", xml, lt);
      const target = xml.slice(lt + 2, p);
      while (p < end && (ch === 32 || ch === 10 || ch === 9 || ch === 13)) ch = xml.charCodeAt(++p);
      if (
        target.length === 3 &&
        (target.charCodeAt(0) | 32) === 120 &&
        (target.charCodeAt(1) | 32) === 109 &&
        (target.charCodeAt(2) | 32) === 108
      ) {
        if (target !== "xml") fail('processing instruction target "xml" is reserved', xml, lt);
        if (lt !== bom) fail("XML declaration not at the start of the document", xml, lt);
        checkDeclaration(xml, p, end);
      } else {
        if (cr < lt) {
          cr = xml.indexOf("\r", lt);
          if (cr === -1) cr = length;
        }
        scratch[top++] = {
          name: `?${target}`,
          attrs: null,
          children: normalize(xml.slice(p, end), cr < end ? LINE_ENDS : RAW),
        };
        lastText = false;
      }
      textStart = end + 2;
      lt = xml.indexOf("<", textStart);
      continue;
    }

    // Start tag.
    NAME_RE.lastIndex = lt + 1;
    if (!NAME_RE.test(xml)) fail("invalid or missing element name", xml, lt);
    let p = NAME_RE.lastIndex;
    if (p - lt - 1 > maxNameLength) fail("name longer than maxNameLength", xml, lt);
    let ch = xml.charCodeAt(p);
    if (ch !== 32 && ch !== 10 && ch !== 9 && ch !== 13 && ch !== 62 && ch !== 47)
      fail("invalid character in element name", xml, p);
    const name = xml.slice(lt + 1, p);
    let aTop = 0;
    for (;;) {
      while (ch === 32 || ch === 10 || ch === 9 || ch === 13) ch = xml.charCodeAt(++p);
      if (ch === 62 || ch === 47) break;
      const nameStart = p;
      NAME_RE.lastIndex = p;
      if (!NAME_RE.test(xml)) fail("invalid or missing attribute name", xml, p);
      p = NAME_RE.lastIndex;
      if (p - nameStart > maxNameLength) fail("name longer than maxNameLength", xml, nameStart);
      ch = xml.charCodeAt(p);
      const attributeName = xml.slice(nameStart, p);
      // Duplicate check: a linear scan up to 16 attributes, a Set beyond, so raised limits
      // can't make it quadratic (20k attributes: 1.2 s linear).
      if (aTop < 32) {
        for (let k = 0; k < aTop; k += 2) {
          if (attributeScratch[k] === attributeName) fail("duplicate attribute", xml, nameStart);
        }
      } else {
        if (aTop === 32) {
          seenNames.clear();
          for (let k = 0; k < 32; k += 2) seenNames.add(attributeScratch[k] as string);
        }
        if (seenNames.has(attributeName)) fail("duplicate attribute", xml, nameStart);
        seenNames.add(attributeName);
      }
      if (aTop === maxAttributes * 2) fail("more attributes than maxAttributes", xml, lt);
      while (ch === 32 || ch === 10 || ch === 9 || ch === 13) ch = xml.charCodeAt(++p);
      if (ch !== 61) fail('missing "=" after attribute name', xml, p);
      ch = xml.charCodeAt(++p);
      while (ch === 32 || ch === 10 || ch === 9 || ch === 13) ch = xml.charCodeAt(++p);
      if (ch !== 34 && ch !== 39) fail("attribute value not quoted", xml, p);
      const valueStart = p + 1;
      const valueEnd = xml.indexOf(ch === 34 ? '"' : "'", valueStart);
      if (valueEnd === -1) fail("unterminated attribute value", xml, p);
      if (newline < valueStart) {
        newline = xml.indexOf("\n", valueStart);
        if (newline === -1) newline = length;
      }
      if (tab < valueStart) {
        tab = xml.indexOf("\t", valueStart);
        if (tab === -1) tab = length;
      }
      if (cr < valueStart) {
        cr = xml.indexOf("\r", valueStart);
        if (cr === -1) cr = length;
      }
      if (amp < valueStart) {
        amp = xml.indexOf("&", valueStart);
        if (amp === -1) amp = length;
      }
      const mode = newline < valueEnd || tab < valueEnd || cr < valueEnd ? ATTRIBUTE : RAW;
      let value: string;
      if (amp < valueEnd) {
        value = decodeEntities(xml, valueStart, valueEnd, amp, mode);
        amp = ampAfter;
      } else {
        value = xml.slice(valueStart, valueEnd);
        if (mode !== RAW) value = normalize(value, mode);
      }
      attributeScratch[aTop++] = attributeName;
      attributeScratch[aTop++] = value;
      p = valueEnd + 1;
      ch = xml.charCodeAt(p);
      if (ch !== 32 && ch !== 10 && ch !== 9 && ch !== 13 && ch !== 62 && ch !== 47)
        fail("missing whitespace between attributes", xml, p);
    }
    let selfClosing = false;
    if (ch === 47) {
      if (xml.charCodeAt(++p) !== 62) fail('expected ">" after "/"', xml, p);
      selfClosing = true;
    }
    const node: XmlElement = {
      name,
      attrs: aTop > 0 ? attributeScratch.slice(0, aTop) : null,
      children: null,
    };
    if (open.length === 0) {
      if (root !== null) fail("more than one root element", xml, lt);
      root = node;
    }
    scratch[top++] = node;
    lastText = false;
    if (!selfClosing) {
      if (open.length === maxDepth) fail("nesting deeper than maxDepth", xml, lt);
      open.push(node);
      frames.push(top);
    }
    textStart = p + 1;
    // Searching from the tag's own start doubles as the "no < inside a tag" check.
    lt = xml.indexOf("<", lt + 1);
    if (lt !== -1 && lt < textStart) fail('"<" inside a tag', xml, lt);
  }

  if (open.length > 0) fail("unclosed element at end of input", xml, length);
  if (root === null) return fail("no root element", xml, length);
  const children = scratch.slice(0, top);
  resetParser();
  return { root, children };
}
