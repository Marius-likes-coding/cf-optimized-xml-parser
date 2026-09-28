/**
 * S1 variant C: hybrid. Like A, indexOf finds text runs and comment/CDATA/PI ends (with the
 * memoized "&"); like B, charCodeAt loops walk everything inside a start tag, including
 * attribute values, checking for "<" and "&" in the same pass. Same output as A.
 */
export interface Element {
  name: string;
  attrs: string[] | null;
  children: Child[] | string | null;
}
export type Child = Element | string;
export interface Doc {
  root: Element | null;
  children: Child[];
}

/** Set by decodeEntities: the first "&" at or after the decoded range's end (or length). */
let ampAfter = 0;

function decodeEntities(xml: string, start: number, end: number, amp: number): string {
  let out = "";
  let pos = start;
  while (amp < end) {
    out += xml.slice(pos, amp);
    const semi = xml.indexOf(";", amp + 1);
    if (semi === -1 || semi >= end) throw new Error(`unterminated entity at ${amp}`);
    const size = semi - amp;
    if (xml.charCodeAt(amp + 1) === 35) {
      const hex = xml.charCodeAt(amp + 2) === 120;
      const code = Number.parseInt(xml.slice(amp + (hex ? 3 : 2), semi), hex ? 16 : 10);
      if (
        !(
          code === 9 ||
          code === 10 ||
          code === 13 ||
          (code >= 32 && code <= 0xd7ff) ||
          (code >= 0xe000 && code <= 0xfffd) ||
          (code >= 0x10000 && code <= 0x10ffff)
        )
      )
        throw new Error(`invalid character reference at ${amp}`);
      out += String.fromCodePoint(code);
    } else if (size === 3 && xml.startsWith("lt", amp + 1)) out += "<";
    else if (size === 3 && xml.startsWith("gt", amp + 1)) out += ">";
    else if (size === 4 && xml.startsWith("amp", amp + 1)) out += "&";
    else if (size === 5 && xml.startsWith("quot", amp + 1)) out += '"';
    else if (size === 5 && xml.startsWith("apos", amp + 1)) out += "'";
    else throw new Error(`unknown entity at ${amp}`);
    pos = semi + 1;
    amp = xml.indexOf("&", pos);
    if (amp === -1) amp = xml.length;
  }
  ampAfter = amp;
  return out + xml.slice(pos, end);
}

function skipDoctype(xml: string, p: number): number {
  let depth = 0;
  let quote = 0;
  for (const len = xml.length; p < len; p++) {
    const ch = xml.charCodeAt(p);
    if (quote !== 0) {
      if (ch === quote) quote = 0;
    } else if (ch === 34 || ch === 39) quote = ch;
    else if (ch === 91) depth++;
    else if (ch === 93) depth--;
    else if (ch === 62 && depth === 0) return p + 1;
  }
  throw new Error("unterminated DOCTYPE");
}

const scratch: Child[] = [];
const attrScratch: string[] = [];

export function parse(xml: string): Doc {
  const len = xml.length;
  const frames: number[] = [];
  const open: Element[] = [];
  let top = 0;
  let root: Element | null = null;
  let lastText = false;
  let amp = xml.indexOf("&");
  if (amp === -1) amp = len;
  let lt = xml.indexOf("<");
  if (lt === -1) throw new Error("no root element");
  let textStart = xml.charCodeAt(0) === 0xfeff ? 1 : 0;

  for (;;) {
    const textEnd = lt === -1 ? len : lt;
    if (textEnd > textStart) {
      let p = textStart;
      let c = xml.charCodeAt(p);
      while (c === 32 || c === 10 || c === 9 || c === 13) {
        if (++p === textEnd) break;
        c = xml.charCodeAt(p);
      }
      if (p < textEnd) {
        if (open.length === 0) throw new Error(`text outside the root element at ${textStart}`);
        if (amp < textStart) {
          amp = xml.indexOf("&", textStart);
          if (amp === -1) amp = len;
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
      // end tag
      const node = open.pop();
      if (node === undefined) throw new Error(`unexpected end tag at ${lt}`);
      const name = node.name;
      if (!xml.startsWith(name, lt + 2)) throw new Error(`mismatched end tag at ${lt}`);
      let p = lt + 2 + name.length;
      let ch = xml.charCodeAt(p);
      while (ch === 32 || ch === 10 || ch === 9 || ch === 13) ch = xml.charCodeAt(++p);
      if (ch !== 62) throw new Error(`mismatched end tag at ${lt}`);
      const start = frames.pop() as number;
      if (top > start) {
        node.children = scratch.slice(start, top);
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
        if (end === -1) throw new Error(`unterminated comment at ${lt}`);
        scratch[top++] = { name: "#comment", attrs: null, children: xml.slice(lt + 4, end) };
        lastText = false;
        textStart = end + 3;
      } else if (xml.startsWith("[CDATA[", lt + 2)) {
        if (open.length === 0) throw new Error(`CDATA outside the root element at ${lt}`);
        const end = xml.indexOf("]]>", lt + 9);
        if (end === -1) throw new Error(`unterminated CDATA at ${lt}`);
        const value = xml.slice(lt + 9, end);
        if (lastText) scratch[top - 1] = (scratch[top - 1] as string) + value;
        else {
          scratch[top++] = value;
          lastText = true;
        }
        textStart = end + 3;
      } else if (xml.startsWith("DOCTYPE", lt + 2)) {
        textStart = skipDoctype(xml, lt + 9);
      } else throw new Error(`unknown markup at ${lt}`);
      lt = xml.indexOf("<", textStart);
      continue;
    }
    if (c === 63) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) throw new Error(`unterminated processing instruction at ${lt}`);
      let p = lt + 2;
      let ch = xml.charCodeAt(p);
      while (p < end && ch !== 32 && ch !== 10 && ch !== 9 && ch !== 13) ch = xml.charCodeAt(++p);
      const target = xml.slice(lt + 2, p);
      if (target === "xml") {
        if (lt > 1 || (lt === 1 && textStart !== 1)) throw new Error("misplaced XML declaration");
      } else {
        while (p < end && (ch === 32 || ch === 10 || ch === 9 || ch === 13)) ch = xml.charCodeAt(++p);
        scratch[top++] = { name: `?${target}`, attrs: null, children: xml.slice(p, end) };
        lastText = false;
      }
      textStart = end + 2;
      lt = xml.indexOf("<", textStart);
      continue;
    }

    // start tag: charCodeAt loops only
    let p = lt + 1;
    let ch = c;
    if (ch === 62 || ch === 32 || ch === 10 || ch === 9 || ch === 13 || ch === 47)
      throw new Error(`missing element name at ${lt}`);
    for (;;) {
      if (++p >= len) throw new Error(`unterminated start tag at ${lt}`);
      ch = xml.charCodeAt(p);
      if (ch === 62 || ch === 32 || ch === 47 || ch === 10 || ch === 9 || ch === 13) break;
      if (ch === 60) throw new Error(`"<" inside a tag at ${p}`);
    }
    const name = xml.slice(lt + 1, p);
    let aTop = 0;
    for (;;) {
      while (ch === 32 || ch === 10 || ch === 9 || ch === 13) ch = xml.charCodeAt(++p);
      if (ch === 62 || ch === 47) break;
      const ns = p;
      while (ch !== 61 && ch !== 32 && ch !== 10 && ch !== 9 && ch !== 13 && ch !== 62 && ch !== 47) {
        if (ch === 60) throw new Error(`"<" inside a tag at ${p}`);
        if (++p >= len) throw new Error(`unterminated start tag at ${lt}`);
        ch = xml.charCodeAt(p);
      }
      if (p === ns) throw new Error(`missing attribute name at ${p}`);
      const attrName = xml.slice(ns, p);
      while (ch === 32 || ch === 10 || ch === 9 || ch === 13) ch = xml.charCodeAt(++p);
      if (ch !== 61) throw new Error(`missing = after attribute at ${p}`);
      ch = xml.charCodeAt(++p);
      while (ch === 32 || ch === 10 || ch === 9 || ch === 13) ch = xml.charCodeAt(++p);
      if (ch !== 34 && ch !== 39) throw new Error(`unquoted attribute value at ${p}`);
      const quote = ch;
      const vs = p + 1;
      let valueAmp = -1;
      for (p = vs; ; p++) {
        if (p >= len) throw new Error(`unterminated attribute value at ${vs}`);
        ch = xml.charCodeAt(p);
        if (ch === quote) break;
        if (ch === 60) throw new Error(`"<" inside a tag at ${p}`);
        if (ch === 38 && valueAmp === -1) valueAmp = p;
      }
      let value: string;
      if (valueAmp === -1) value = xml.slice(vs, p);
      else {
        value = decodeEntities(xml, vs, p, valueAmp);
        amp = ampAfter;
      }
      attrScratch[aTop++] = attrName;
      attrScratch[aTop++] = value;
      ch = xml.charCodeAt(++p);
      if (ch !== 32 && ch !== 10 && ch !== 9 && ch !== 13 && ch !== 62 && ch !== 47)
        throw new Error(`missing whitespace between attributes at ${p}`);
    }
    let selfClosing = false;
    if (ch === 47) {
      if (xml.charCodeAt(++p) !== 62) throw new Error(`expected /> at ${p}`);
      selfClosing = true;
    }
    const node: Element = {
      name,
      attrs: aTop > 0 ? attrScratch.slice(0, aTop) : null,
      children: null,
    };
    if (open.length === 0) {
      if (root !== null) throw new Error(`second root element at ${lt}`);
      root = node;
    }
    scratch[top++] = node;
    lastText = false;
    if (!selfClosing) {
      open.push(node);
      frames.push(top);
    }
    textStart = p + 1;
    lt = xml.indexOf("<", textStart);
  }

  if (open.length > 0) throw new Error(`unclosed element <${open.at(-1)?.name ?? ""}>`);
  if (root === null) throw new Error("no root element");
  return { root, children: scratch.slice(0, top) };
}
