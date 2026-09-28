/**
 * S1 variant B: charCodeAt state machine. Every scan is a JS loop over char codes (text runs
 * track "&" and whitespace-only in the same pass; attribute values track "&" and "<"); no
 * indexOf, no regex. Same output and semantics as variant A.
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

function decodeEntities(xml: string, start: number, end: number, amp: number): string {
  let out = "";
  let pos = start;
  while (amp !== -1) {
    out += xml.slice(pos, amp);
    let semi = amp + 1;
    while (semi < end && xml.charCodeAt(semi) !== 59) semi++;
    if (semi >= end) throw new Error(`unterminated entity at ${amp}`);
    const size = semi - amp;
    const c1 = xml.charCodeAt(amp + 1);
    if (c1 === 35) {
      const hex = xml.charCodeAt(amp + 2) === 120;
      let code = 0;
      let digits = 0;
      for (let q = amp + (hex ? 3 : 2); q < semi; q++, digits++) {
        const d = xml.charCodeAt(q);
        if (d >= 48 && d <= 57) code = code * (hex ? 16 : 10) + d - 48;
        else if (hex && ((d >= 97 && d <= 102) || (d >= 65 && d <= 70))) code = code * 16 + (d | 32) - 87;
        else throw new Error(`invalid character reference at ${amp}`);
      }
      if (
        digits === 0 ||
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
    } else if (size === 3 && c1 === 108 && xml.charCodeAt(amp + 2) === 116) out += "<";
    else if (size === 3 && c1 === 103 && xml.charCodeAt(amp + 2) === 116) out += ">";
    else if (size === 4 && c1 === 97 && xml.charCodeAt(amp + 2) === 109 && xml.charCodeAt(amp + 3) === 112)
      out += "&";
    else if (
      size === 5 &&
      c1 === 113 &&
      xml.charCodeAt(amp + 2) === 117 &&
      xml.charCodeAt(amp + 3) === 111 &&
      xml.charCodeAt(amp + 4) === 116
    )
      out += '"';
    else if (
      size === 5 &&
      c1 === 97 &&
      xml.charCodeAt(amp + 2) === 112 &&
      xml.charCodeAt(amp + 3) === 111 &&
      xml.charCodeAt(amp + 4) === 115
    )
      out += "'";
    else throw new Error(`unknown entity at ${amp}`);
    pos = semi + 1;
    amp = -1;
    for (let q = pos; q < end; q++) {
      if (xml.charCodeAt(q) === 38) {
        amp = q;
        break;
      }
    }
  }
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
  let p = xml.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (p < len) {
    // text run up to the next "<"
    const textStart = p;
    let amp = -1;
    let blank = true;
    let ch = 0;
    for (; p < len; p++) {
      ch = xml.charCodeAt(p);
      if (ch === 60) break;
      if (blank && ch !== 32 && ch !== 10 && ch !== 9 && ch !== 13) blank = false;
      if (ch === 38 && amp === -1) amp = p;
    }
    if (!blank) {
      if (open.length === 0) throw new Error(`text outside the root element at ${textStart}`);
      const value = amp === -1 ? xml.slice(textStart, p) : decodeEntities(xml, textStart, p, amp);
      if (lastText) scratch[top - 1] = (scratch[top - 1] as string) + value;
      else {
        scratch[top++] = value;
        lastText = true;
      }
    }
    if (p >= len) break;

    const lt = p;
    const c = xml.charCodeAt(lt + 1);
    if (c === 47) {
      const node = open.pop();
      if (node === undefined) throw new Error(`unexpected end tag at ${lt}`);
      const name = node.name;
      const nameLength = name.length;
      p = lt + 2;
      for (let k = 0; k < nameLength; k++, p++) {
        if (xml.charCodeAt(p) !== name.charCodeAt(k)) throw new Error(`mismatched end tag at ${lt}`);
      }
      ch = xml.charCodeAt(p);
      while (ch === 32 || ch === 10 || ch === 9 || ch === 13) ch = xml.charCodeAt(++p);
      if (ch !== 62) throw new Error(`mismatched end tag at ${lt}`);
      const start = frames.pop() as number;
      if (top > start) {
        node.children = scratch.slice(start, top);
        top = start;
      }
      lastText = false;
      p++;
      continue;
    }
    if (c === 33) {
      if (xml.charCodeAt(lt + 2) === 45 && xml.charCodeAt(lt + 3) === 45) {
        p = lt + 4;
        while (
          p + 2 < len &&
          !(xml.charCodeAt(p) === 45 && xml.charCodeAt(p + 1) === 45 && xml.charCodeAt(p + 2) === 62)
        )
          p++;
        if (p + 2 >= len) throw new Error(`unterminated comment at ${lt}`);
        scratch[top++] = { name: "#comment", attrs: null, children: xml.slice(lt + 4, p) };
        lastText = false;
        p += 3;
      } else if (
        xml.charCodeAt(lt + 2) === 91 &&
        xml.charCodeAt(lt + 3) === 67 &&
        xml.charCodeAt(lt + 4) === 68 &&
        xml.charCodeAt(lt + 5) === 65 &&
        xml.charCodeAt(lt + 6) === 84 &&
        xml.charCodeAt(lt + 7) === 65 &&
        xml.charCodeAt(lt + 8) === 91
      ) {
        if (open.length === 0) throw new Error(`CDATA outside the root element at ${lt}`);
        p = lt + 9;
        while (
          p + 2 < len &&
          !(xml.charCodeAt(p) === 93 && xml.charCodeAt(p + 1) === 93 && xml.charCodeAt(p + 2) === 62)
        )
          p++;
        if (p + 2 >= len) throw new Error(`unterminated CDATA at ${lt}`);
        const value = xml.slice(lt + 9, p);
        if (lastText) scratch[top - 1] = (scratch[top - 1] as string) + value;
        else {
          scratch[top++] = value;
          lastText = true;
        }
        p += 3;
      } else if (xml.charCodeAt(lt + 2) === 68) {
        p = skipDoctype(xml, lt + 9);
      } else throw new Error(`unknown markup at ${lt}`);
      continue;
    }
    if (c === 63) {
      p = lt + 2;
      ch = xml.charCodeAt(p);
      while (p < len && ch !== 32 && ch !== 10 && ch !== 9 && ch !== 13 && ch !== 63) ch = xml.charCodeAt(++p);
      const target = xml.slice(lt + 2, p);
      while (ch === 32 || ch === 10 || ch === 9 || ch === 13) ch = xml.charCodeAt(++p);
      const dataStart = p;
      while (p + 1 < len && !(xml.charCodeAt(p) === 63 && xml.charCodeAt(p + 1) === 62)) p++;
      if (p + 1 >= len) throw new Error(`unterminated processing instruction at ${lt}`);
      if (target === "xml") {
        if (lt > 1 || (lt === 1 && xml.charCodeAt(0) !== 0xfeff)) throw new Error("misplaced XML declaration");
      } else {
        scratch[top++] = { name: `?${target}`, attrs: null, children: xml.slice(dataStart, p) };
        lastText = false;
      }
      p += 2;
      continue;
    }

    // start tag
    p = lt + 1;
    ch = c;
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
      let amp = -1;
      for (p = vs; ; p++) {
        if (p >= len) throw new Error(`unterminated attribute value at ${vs}`);
        ch = xml.charCodeAt(p);
        if (ch === quote) break;
        if (ch === 60) throw new Error(`"<" inside a tag at ${p}`);
        if (ch === 38 && amp === -1) amp = p;
      }
      attrScratch[aTop++] = attrName;
      attrScratch[aTop++] = amp === -1 ? xml.slice(vs, p) : decodeEntities(xml, vs, p, amp);
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
    p++;
  }

  if (open.length > 0) throw new Error(`unclosed element <${open.at(-1)?.name ?? ""}>`);
  if (root === null) throw new Error("no root element");
  return { root, children: scratch.slice(0, top) };
}
