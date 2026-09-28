/* eslint-disable unicorn/prefer-code-point -- UTF-16 code units are what the scanner compares; codePointAt adds a surrogate branch per read. */
/**
 * The parser's one hot function. Design and measurements: research/spikes/ (S1 scanner, S2 tree
 * building, S5 JIT behavior) and docs/implementation-plan.md.
 *
 * - Scanning is builtin-driven: indexOf finds text runs, markup ends and attribute-value ends;
 *   names are skipped with a sticky regex's test(); "&" is found by one memoized search.
 * - Nodes are one object-literal shape. Children are collected on a module-level scratch stack
 *   and copied out with slice() at the end tag; a lone text child is stored as the string.
 * - Module-level arrays keep one elements kind for the life of the isolate, so optimized code
 *   never deopts on them (S5). Nothing is left in them after a parse (see resetParser).
 */
import { ampAfter, decodeEntities } from "./entities.js";
import { fail } from "./errors.js";
import type { XmlDocument, XmlElement, XmlNode } from "./types.js";

/** Names: up to whitespace, "/", ">", "=" or a stray "<" (which then fails the tag). */
const NAME_RE = /[^\s/<=>]+/y;

const scratch: XmlNode[] = [""];
const attributeScratch: string[] = [""];
const openStack: XmlElement[] = [{ name: "", attrs: null, children: null }];
const frameStack: number[] = [0];

/** Drops every reference the module-level stacks hold (after a parse or a thrown error). */
export function resetParser(): void {
  scratch.length = 0;
  attributeScratch.length = 0;
  openStack.length = 0;
  frameStack.length = 0;
}

function skipDoctype(xml: string, start: number): number {
  let depth = 0;
  let quote = 0;
  const limit = Math.min(xml.length, start + 65_536);
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

export function parseString(xml: string): XmlDocument {
  const length = xml.length;
  const open = openStack;
  const frames = frameStack;
  open.length = 0;
  frames.length = 0;
  let top = 0;
  let root: XmlElement | null = null;
  let lastText = false;
  let amp = xml.indexOf("&");
  if (amp === -1) amp = length;
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
        if (amp < textStart) {
          amp = xml.indexOf("&", textStart);
          if (amp === -1) amp = length;
        }
        let value: string;
        if (amp < textEnd) {
          value = decodeEntities(xml, textStart, textEnd, amp);
          amp = ampAfter;
        } else value = xml.slice(textStart, textEnd);
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
        scratch[top++] = { name: "#comment", attrs: null, children: xml.slice(lt + 4, end) };
        lastText = false;
        textStart = end + 3;
      } else if (xml.startsWith("[CDATA[", lt + 2)) {
        if (open.length === 0) fail("CDATA section outside the root element", xml, lt);
        const end = xml.indexOf("]]>", lt + 9);
        if (end === -1) fail("unterminated CDATA section", xml, lt);
        const value = xml.slice(lt + 9, end);
        if (lastText) scratch[top - 1] = (scratch[top - 1] as string) + value;
        else {
          scratch[top++] = value;
          lastText = true;
        }
        textStart = end + 3;
      } else if (xml.startsWith("DOCTYPE", lt + 2)) {
        textStart = skipDoctype(xml, lt + 9);
      } else fail("unknown markup declaration", xml, lt);
      lt = xml.indexOf("<", textStart);
      continue;
    }
    if (c === 63) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) fail("unterminated processing instruction", xml, lt);
      let p = lt + 2;
      let ch = xml.charCodeAt(p);
      while (p < end && ch !== 32 && ch !== 10 && ch !== 9 && ch !== 13) ch = xml.charCodeAt(++p);
      if (p === lt + 2) fail("processing instruction without a target", xml, lt);
      const target = xml.slice(lt + 2, p);
      if (target === "xml") {
        if (lt !== bom) fail("XML declaration not at the start of the document", xml, lt);
      } else {
        while (p < end && (ch === 32 || ch === 10 || ch === 9 || ch === 13))
          ch = xml.charCodeAt(++p);
        scratch[top++] = { name: `?${target}`, attrs: null, children: xml.slice(p, end) };
        lastText = false;
      }
      textStart = end + 2;
      lt = xml.indexOf("<", textStart);
      continue;
    }

    // Start tag.
    NAME_RE.lastIndex = lt + 1;
    if (!NAME_RE.test(xml)) fail("missing element name", xml, lt);
    let p = NAME_RE.lastIndex;
    let ch = xml.charCodeAt(p);
    const name = xml.slice(lt + 1, p);
    let aTop = 0;
    for (;;) {
      while (ch === 32 || ch === 10 || ch === 9 || ch === 13) ch = xml.charCodeAt(++p);
      if (ch === 62 || ch === 47) break;
      const nameStart = p;
      NAME_RE.lastIndex = p;
      if (!NAME_RE.test(xml)) fail("missing attribute name", xml, p);
      p = NAME_RE.lastIndex;
      ch = xml.charCodeAt(p);
      const attributeName = xml.slice(nameStart, p);
      while (ch === 32 || ch === 10 || ch === 9 || ch === 13) ch = xml.charCodeAt(++p);
      if (ch !== 61) fail('missing "=" after attribute name', xml, p);
      ch = xml.charCodeAt(++p);
      while (ch === 32 || ch === 10 || ch === 9 || ch === 13) ch = xml.charCodeAt(++p);
      if (ch !== 34 && ch !== 39) fail("attribute value not quoted", xml, p);
      const valueStart = p + 1;
      const valueEnd = xml.indexOf(ch === 34 ? '"' : "'", valueStart);
      if (valueEnd === -1) fail("unterminated attribute value", xml, p);
      if (amp < valueStart) {
        amp = xml.indexOf("&", valueStart);
        if (amp === -1) amp = length;
      }
      let value: string;
      if (amp < valueEnd) {
        value = decodeEntities(xml, valueStart, valueEnd, amp);
        amp = ampAfter;
      } else value = xml.slice(valueStart, valueEnd);
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
