/**
 * S4 ablation: strict.ts without attribute-value whitespace normalization.
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

const MAX_DEPTH = 256;
const MAX_ATTRS = 200;
const MAX_NAME = 1000;
const MAX_DOCTYPE = 65_536;

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
    const c1 = xml.charCodeAt(amp + 1);
    if (c1 === 35) {
      const hex = xml.charCodeAt(amp + 2) === 120;
      let code = 0;
      let q = amp + (hex ? 3 : 2);
      if (q === semi) throw new Error(`invalid character reference at ${amp}`);
      for (; q < semi; q++) {
        const d = xml.charCodeAt(q);
        if (d >= 48 && d <= 57) code = code * (hex ? 16 : 10) + d - 48;
        else if (hex && ((d >= 97 && d <= 102) || (d >= 65 && d <= 70))) code = code * 16 + (d | 32) - 87;
        else throw new Error(`invalid character reference at ${amp}`);
        if (code > 0x10ffff) throw new Error(`invalid character reference at ${amp}`);
      }
      if (
        !(
          code === 9 ||
          code === 10 ||
          code === 13 ||
          (code >= 32 && code <= 0xd7ff) ||
          (code >= 0xe000 && code <= 0xfffd) ||
          code >= 0x10000
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

function skipDoctype(xml: string, start: number): number {
  let depth = 0;
  let quote = 0;
  const limit = Math.min(xml.length, start + MAX_DOCTYPE);
  for (let p = start; p < limit; p++) {
    const ch = xml.charCodeAt(p);
    if (quote !== 0) {
      if (ch === quote) quote = 0;
    } else if (ch === 34 || ch === 39) quote = ch;
    else if (ch === 91) depth++;
    else if (ch === 93) depth--;
    else if (ch === 62 && depth === 0) return p + 1;
  }
  throw new Error(limit < xml.length ? "DOCTYPE larger than 64 KiB" : "unterminated DOCTYPE");
}

/** XML 1.0 (5th ed.) §2.3 Name: NameStartChar NameChar*. Sticky, `test()` only. */
const NAME_RE =
  /[:A-Z_a-z\xC0-\xD6\xD8-\xF6\xF8-˿Ͱ-ͽͿ-῿‌‍⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�\u{10000}-\u{EFFFF}][:A-Z_a-z\xC0-\xD6\xD8-\xF6\xF8-˿Ͱ-ͽͿ-῿‌‍⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�\u{10000}-\u{EFFFF}\-.0-9\xB7̀-ͯ‿⁀]*/uy;
/** Next tab/newline/CR, for attribute-value normalization (global: test() + lastIndex). */
const WS_RE = /[\t\n\r]/g;
const CRLF_RE = /\r\n?/g;
const ATTR_WS_RE = /\r\n|[\t\n\r]/g;
/** version, then optional encoding and standalone (§2.8 [23]–[26], [32], §4.3.3 [80]). */
const DECL_RE =
  /^version[ \t\n\r]*=[ \t\n\r]*(["'])(1\.[0-9]+)\1(?:[ \t\n\r]+encoding[ \t\n\r]*=[ \t\n\r]*(["'])[A-Za-z][\w.-]*\3)?(?:[ \t\n\r]+standalone[ \t\n\r]*=[ \t\n\r]*(["'])(?:yes|no)\4)?[ \t\n\r]*$/;

const scratch: Child[] = [];
const attrScratch: string[] = [];

export function parse(xml: string): Doc {
  const len = xml.length;
  const frames: number[] = [];
  const open: Element[] = [];
  let top = 0;
  let root: Element | null = null;
  let lastText = false;
  let seenDoctype = false;
  let amp = xml.indexOf("&");
  if (amp === -1) amp = len;
  let cr = xml.indexOf("\r");
  if (cr === -1) cr = len;
  let cdEnd = xml.indexOf("]]>");
  if (cdEnd === -1) cdEnd = len;
  let wsc = -1;
  let lt = xml.indexOf("<");
  if (lt === -1) throw new Error("no root element");
  const bom = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  let textStart = bom;

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
        if (cdEnd < textStart) {
          cdEnd = xml.indexOf("]]>", textStart);
          if (cdEnd === -1) cdEnd = len;
        }
        if (cdEnd < textEnd) throw new Error(`"]]>" in text at ${cdEnd}`);
        if (amp < textStart) {
          amp = xml.indexOf("&", textStart);
          if (amp === -1) amp = len;
        }
        if (cr < textStart) {
          cr = xml.indexOf("\r", textStart);
          if (cr === -1) cr = len;
        }
        let value: string;
        if (cr < textEnd) {
          const raw = xml.slice(textStart, textEnd).replace(CRLF_RE, "\n");
          const first = raw.indexOf("&");
          value = first === -1 ? raw : decodeEntities(raw, 0, raw.length, first);
          if (amp < textEnd) {
            amp = xml.indexOf("&", textEnd);
            if (amp === -1) amp = len;
          }
        } else if (amp < textEnd) {
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
        const only = scratch[start];
        node.children = top - start === 1 && typeof only === "string" ? only : scratch.slice(start, top);
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
        if (xml.indexOf("--", lt + 4) < end || (end > lt + 4 && xml.charCodeAt(end - 1) === 45))
          throw new Error(`"--" inside a comment at ${lt}`);
        if (cr < lt) {
          cr = xml.indexOf("\r", lt);
          if (cr === -1) cr = len;
        }
        const data = cr < end ? xml.slice(lt + 4, end).replace(CRLF_RE, "\n") : xml.slice(lt + 4, end);
        scratch[top++] = { name: "#comment", attrs: null, children: data };
        lastText = false;
        textStart = end + 3;
      } else if (xml.startsWith("[CDATA[", lt + 2)) {
        if (open.length === 0) throw new Error(`CDATA outside the root element at ${lt}`);
        const end = xml.indexOf("]]>", lt + 9);
        if (end === -1) throw new Error(`unterminated CDATA at ${lt}`);
        if (cr < lt) {
          cr = xml.indexOf("\r", lt);
          if (cr === -1) cr = len;
        }
        const value = cr < end ? xml.slice(lt + 9, end).replace(CRLF_RE, "\n") : xml.slice(lt + 9, end);
        if (lastText) scratch[top - 1] = (scratch[top - 1] as string) + value;
        else {
          scratch[top++] = value;
          lastText = true;
        }
        textStart = end + 3;
      } else if (xml.startsWith("DOCTYPE", lt + 2)) {
        if (root !== null || seenDoctype) throw new Error(`misplaced DOCTYPE at ${lt}`);
        seenDoctype = true;
        textStart = skipDoctype(xml, lt + 9);
      } else throw new Error(`unknown markup at ${lt}`);
      lt = xml.indexOf("<", textStart);
      continue;
    }
    if (c === 63) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) throw new Error(`unterminated processing instruction at ${lt}`);
      NAME_RE.lastIndex = lt + 2;
      if (!NAME_RE.test(xml)) throw new Error(`invalid processing instruction target at ${lt}`);
      let p = NAME_RE.lastIndex;
      let ch = xml.charCodeAt(p);
      if (p !== end && ch !== 32 && ch !== 10 && ch !== 9 && ch !== 13)
        throw new Error(`invalid processing instruction target at ${lt}`);
      const target = xml.slice(lt + 2, p);
      while (p < end && (ch === 32 || ch === 10 || ch === 9 || ch === 13)) ch = xml.charCodeAt(++p);
      if (
        target.length === 3 &&
        (target.charCodeAt(0) | 32) === 120 &&
        (target.charCodeAt(1) | 32) === 109 &&
        (target.charCodeAt(2) | 32) === 108
      ) {
        if (target !== "xml" || lt !== bom) throw new Error(`misplaced or misnamed XML declaration at ${lt}`);
        const declaration = DECL_RE.exec(xml.slice(p, end));
        if (declaration === null) throw new Error("malformed XML declaration");
        if (declaration[2] !== "1.0") throw new Error(`XML ${declaration[2] ?? ""} is not supported`);
      } else {
        if (cr < lt) {
          cr = xml.indexOf("\r", lt);
          if (cr === -1) cr = len;
        }
        const data = cr < end ? xml.slice(p, end).replace(CRLF_RE, "\n") : xml.slice(p, end);
        scratch[top++] = { name: `?${target}`, attrs: null, children: data };
        lastText = false;
      }
      textStart = end + 2;
      lt = xml.indexOf("<", textStart);
      continue;
    }

    // start tag
    NAME_RE.lastIndex = lt + 1;
    if (!NAME_RE.test(xml)) throw new Error(`invalid element name at ${lt}`);
    let p = NAME_RE.lastIndex;
    if (p - lt - 1 > MAX_NAME) throw new Error(`element name longer than ${MAX_NAME} at ${lt}`);
    let ch = xml.charCodeAt(p);
    if (ch !== 32 && ch !== 10 && ch !== 9 && ch !== 13 && ch !== 62 && ch !== 47)
      throw new Error(`invalid character in element name at ${p}`);
    const name = xml.slice(lt + 1, p);
    let aTop = 0;
    for (;;) {
      while (ch === 32 || ch === 10 || ch === 9 || ch === 13) ch = xml.charCodeAt(++p);
      if (ch === 62 || ch === 47) break;
      const ns = p;
      NAME_RE.lastIndex = p;
      if (!NAME_RE.test(xml)) throw new Error(`invalid attribute name at ${p}`);
      p = NAME_RE.lastIndex;
      if (p - ns > MAX_NAME) throw new Error(`attribute name longer than ${MAX_NAME} at ${ns}`);
      ch = xml.charCodeAt(p);
      const attrName = xml.slice(ns, p);
      for (let k = 0; k < aTop; k += 2) {
        if (attrScratch[k] === attrName) throw new Error(`duplicate attribute "${attrName}" at ${ns}`);
      }
      if (aTop === MAX_ATTRS * 2) throw new Error(`more than ${MAX_ATTRS} attributes at ${lt}`);
      while (ch === 32 || ch === 10 || ch === 9 || ch === 13) ch = xml.charCodeAt(++p);
      if (ch !== 61) throw new Error(`missing = after attribute at ${p}`);
      ch = xml.charCodeAt(++p);
      while (ch === 32 || ch === 10 || ch === 9 || ch === 13) ch = xml.charCodeAt(++p);
      if (ch !== 34 && ch !== 39) throw new Error(`unquoted attribute value at ${p}`);
      const vs = p + 1;
      const ve = xml.indexOf(ch === 34 ? '"' : "'", vs);
      if (ve === -1) throw new Error(`unterminated attribute value at ${p}`);
      wsc = len;
      if (amp < vs) {
        amp = xml.indexOf("&", vs);
        if (amp === -1) amp = len;
      }
      let value: string;
      if (wsc < ve) {
        const raw = xml.slice(vs, ve).replace(ATTR_WS_RE, " ");
        const first = raw.indexOf("&");
        value = first === -1 ? raw : decodeEntities(raw, 0, raw.length, first);
        if (amp < ve) {
          amp = xml.indexOf("&", ve);
          if (amp === -1) amp = len;
        }
      } else if (amp < ve) {
        value = decodeEntities(xml, vs, ve, amp);
        amp = ampAfter;
      } else value = xml.slice(vs, ve);
      attrScratch[aTop++] = attrName;
      attrScratch[aTop++] = value;
      p = ve + 1;
      ch = xml.charCodeAt(p);
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
      if (open.length === MAX_DEPTH) throw new Error(`nesting deeper than ${MAX_DEPTH} at ${lt}`);
      open.push(node);
      frames.push(top);
    }
    textStart = p + 1;
    lt = xml.indexOf("<", lt + 1);
    if (lt !== -1 && lt < textStart) throw new Error(`"<" inside a tag at ${lt}`);
  }

  if (open.length > 0) throw new Error(`unclosed element <${open.at(-1)?.name ?? ""}>`);
  if (root === null) throw new Error("no root element");
  const children = scratch.slice(0, top);
  scratch.length = 0;
  attrScratch.length = 0;
  return { root, children };
}
