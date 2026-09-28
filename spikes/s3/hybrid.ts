/**
 * S3 variant: hybrid binary string (research/non-ascii-xml-v8-workerd.md §5). The bytes become
 * one one-byte string with one character per byte (chunked String.fromCharCode), so the S2
 * string parser scans it with one-byte indexOf/slice and byte offsets equal string offsets.
 * Values that contain bytes >= 0x80 are re-decoded from the bytes with TextDecoder; a memoized
 * regex search finds the next such byte, like the "&" memo. Spike limitation: non-ASCII
 * element/attribute names throw.
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

/** Names: up to whitespace, "/", ">", "=" or a stray "<" (which then fails the tag). */
const NAME_RE = /[^\s/><=]+/y;


const decoder = new TextDecoder();
const CHUNK = 8192;
/** Next byte >= 0x80 in the binary string (global regex: test() + lastIndex, no allocation). */
const HIGH_RE = /[\x80-\xff]/g;

function binaryString(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(index, index + CHUNK) as unknown as number[]));
  }
  return parts.join("");
}

let src: Uint8Array = new Uint8Array(0);
let bin = "";
let high = 0;

function nextHigh(from: number): number {
  HIGH_RE.lastIndex = from;
  return HIGH_RE.test(bin) ? HIGH_RE.lastIndex - 1 : bin.length;
}

/** Real text of [start, end): a zero-copy slice when ASCII, else decoded from the bytes. */
function take(start: number, end: number): string {
  if (high < start) high = nextHigh(start);
  return high < end ? decoder.decode(src.subarray(start, end)) : bin.slice(start, end);
}

/** Like take(), for text that may contain entity references. */
function takeText(start: number, end: number, amp: number): string {
  if (high < start) high = nextHigh(start);
  if (high < end) {
    const raw = decoder.decode(src.subarray(start, end));
    const first = raw.indexOf("&");
    return first === -1 ? raw : decodeEntities(raw, 0, raw.length, first);
  }
  return amp < end ? decodeEntities(bin, start, end, amp) : bin.slice(start, end);
}

function checkName(start: number, end: number): void {
  if (high < start) high = nextHigh(start);
  if (high < end) throw new Error(`spike: non-ASCII name at ${start}`);
}

const scratch: Child[] = [];
const attrScratch: string[] = [];

export function parse(bytes: Uint8Array): Doc {
  src = bytes;
  bin = binaryString(bytes);
  high = nextHigh(0);
  const xml = bin;
  const len = xml.length;
  const bom = xml.startsWith("\xEF\xBB\xBF") ? 3 : 0;
  const frames: number[] = [];
  const open: Element[] = [];
  let top = 0;
  let root: Element | null = null;
  let lastText = false;
  let amp = xml.indexOf("&");
  if (amp === -1) amp = len;
  let lt = xml.indexOf("<");
  if (lt === -1) throw new Error("no root element");
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
        if (amp < textStart) {
          amp = xml.indexOf("&", textStart);
          if (amp === -1) amp = len;
        }
        const value = takeText(textStart, textEnd, amp);
        if (amp < textEnd) {
          amp = xml.indexOf("&", textEnd);
          if (amp === -1) amp = len;
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
        scratch[top++] = { name: "#comment", attrs: null, children: take(lt + 4, end) };
        lastText = false;
        textStart = end + 3;
      } else if (xml.startsWith("[CDATA[", lt + 2)) {
        if (open.length === 0) throw new Error(`CDATA outside the root element at ${lt}`);
        const end = xml.indexOf("]]>", lt + 9);
        if (end === -1) throw new Error(`unterminated CDATA at ${lt}`);
        const value = take(lt + 9, end);
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
        if (lt !== bom) throw new Error("misplaced XML declaration");
      } else {
        while (p < end && (ch === 32 || ch === 10 || ch === 9 || ch === 13)) ch = xml.charCodeAt(++p);
        scratch[top++] = { name: `?${target}`, attrs: null, children: take(p, end) };
        lastText = false;
      }
      textStart = end + 2;
      lt = xml.indexOf("<", textStart);
      continue;
    }

    // start tag
    NAME_RE.lastIndex = lt + 1;
    if (!NAME_RE.test(xml)) throw new Error(`missing element name at ${lt}`);
    let p = NAME_RE.lastIndex;
    let ch = xml.charCodeAt(p);
    checkName(lt + 1, p);
    const name = xml.slice(lt + 1, p);
    let aTop = 0;
    for (;;) {
      while (ch === 32 || ch === 10 || ch === 9 || ch === 13) ch = xml.charCodeAt(++p);
      if (ch === 62 || ch === 47) break;
      const ns = p;
      NAME_RE.lastIndex = p;
      if (!NAME_RE.test(xml)) throw new Error(`missing attribute name at ${p}`);
      p = NAME_RE.lastIndex;
      ch = xml.charCodeAt(p);
      checkName(ns, p);
      const attrName = xml.slice(ns, p);
      while (ch === 32 || ch === 10 || ch === 9 || ch === 13) ch = xml.charCodeAt(++p);
      if (ch !== 61) throw new Error(`missing = after attribute at ${p}`);
      ch = xml.charCodeAt(++p);
      while (ch === 32 || ch === 10 || ch === 9 || ch === 13) ch = xml.charCodeAt(++p);
      if (ch !== 34 && ch !== 39) throw new Error(`unquoted attribute value at ${p}`);
      const vs = p + 1;
      const ve = xml.indexOf(ch === 34 ? '"' : "'", vs);
      if (ve === -1) throw new Error(`unterminated attribute value at ${p}`);
      if (amp < vs) {
        amp = xml.indexOf("&", vs);
        if (amp === -1) amp = len;
      }
      const value = takeText(vs, ve, amp);
      if (amp < ve) {
        amp = xml.indexOf("&", ve);
        if (amp === -1) amp = len;
      }
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
  src = new Uint8Array(0);
  bin = "";
  return { root, children };
}
