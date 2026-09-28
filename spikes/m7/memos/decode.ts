/* eslint-disable unicorn/text-encoding-identifier-case -- "utf-8" is the canonical WHATWG label and how XML declarations spell it; comparisons need that spelling. */
import { XmlError } from "./errors.js";

/**
 * Byte input: pick the encoding (XML 1.0 §4.3.3 and Appendix F), decode once with a cached
 * fatal TextDecoder, and hand the string to the string parser (research/spikes/s3-bytes-input.md:
 * one decode beats every byte-level alternative in workerd).
 *
 * - A byte order mark decides: EF BB BF = UTF-8, FF FE = UTF-16LE, FE FF = UTF-16BE.
 * - Without one, "<?" as UTF-16 means UTF-16 without a BOM, and an ASCII "<?xml" declaration
 *   may name the encoding. Otherwise the document is UTF-8.
 * - Invalid byte sequences, unsupported encodings and a declaration that contradicts the BOM
 *   throw XmlError. Offsets in later errors refer to the decoded string.
 */
const decoders = new Map<string, TextDecoder>();
/** The EncodingDecl inside an XML declaration (§4.3.3 [80]). */
const ENCODING_RE = /^<\?xml\s[^>]*?\sencoding\s*=\s*(["'])([A-Za-z][\w.-]*)\1/;

function decoderFor(label: string): TextDecoder {
  let decoder = decoders.get(label);
  if (decoder === undefined) {
    try {
      // ignoreBOM: false (the default) drops a leading BOM for UTF-8 and UTF-16.
      decoder = new TextDecoder(label, { fatal: true });
    } catch {
      throw new XmlError(`unsupported encoding "${label.slice(0, 40)}"`, 0, 1, 1);
    }
    decoders.set(label, decoder);
  }
  return decoder;
}

/** The encoding named in an ASCII `<?xml … encoding="…"?>` declaration, or undefined. */
function declaredEncoding(bytes: Uint8Array): string | undefined {
  // "<?xml" followed by whitespace
  if (
    bytes.length < 6 ||
    bytes[0] !== 0x3c ||
    bytes[1] !== 0x3f ||
    bytes[2] !== 0x78 ||
    bytes[3] !== 0x6d ||
    bytes[4] !== 0x6c
  ) {
    return undefined;
  }
  const end = Math.min(bytes.length, 256);
  let head = "";
  for (let index = 0; index < end; index++) {
    const byte = bytes[index] as number;
    if (byte === 0x3e || byte >= 0x80) break; // ">" ends the declaration; stay ASCII-only
    head += String.fromCodePoint(byte);
  }
  return ENCODING_RE.exec(head)?.[2];
}

function sameEncoding(bomEncoding: string, declared: string): boolean {
  const lower = declared.toLowerCase();
  if (bomEncoding === "utf-8") return lower === "utf-8" || lower === "utf8";
  return lower === "utf-16" || lower === bomEncoding;
}

export function decodeInput(bytes: Uint8Array): string {
  let label = "utf-8";
  const b0 = bytes[0];
  const b1 = bytes[1];
  let bomEncoding: string | undefined;
  if (b0 === 0xef && b1 === 0xbb && bytes[2] === 0xbf) bomEncoding = "utf-8";
  else if (b0 === 0xff && b1 === 0xfe) {
    if (bytes[2] === 0 && bytes[3] === 0) throw new XmlError("UTF-32 is not supported", 0, 1, 1);
    bomEncoding = "utf-16le";
  } else if (b0 === 0xfe && b1 === 0xff) bomEncoding = "utf-16be";

  if (bomEncoding === undefined) {
    if (b0 === 0x3c && b1 === 0 && bytes[2] === 0x3f && bytes[3] === 0) label = "utf-16le";
    else if (b0 === 0 && b1 === 0x3c && bytes[2] === 0 && bytes[3] === 0x3f) label = "utf-16be";
    else label = declaredEncoding(bytes) ?? "utf-8";
  } else {
    label = bomEncoding;
    if (bomEncoding === "utf-8") {
      const declared = declaredEncoding(bytes.subarray(3));
      if (declared !== undefined && !sameEncoding("utf-8", declared)) {
        throw new XmlError("the encoding declaration contradicts the byte order mark", 0, 1, 1);
      }
    }
  }

  let text: string;
  try {
    text = decoderFor(label).decode(bytes);
  } catch (error) {
    if (error instanceof XmlError) throw error;
    throw new XmlError(`invalid byte sequence for ${label}`, 0, 1, 1);
  }
  // UTF-16 input can't be sniffed as ASCII, so its declaration is checked after decoding.
  if (label === "utf-16le" || label === "utf-16be") {
    const declared = ENCODING_RE.exec(text.slice(0, 256).split("?>", 1)[0] ?? "")?.[2];
    if (declared !== undefined && !sameEncoding(label, declared)) {
      throw new XmlError("the encoding declaration contradicts the byte order", 0, 1, 1);
    }
  }
  return text;
}
