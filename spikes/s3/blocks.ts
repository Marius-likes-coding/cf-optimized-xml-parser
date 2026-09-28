/**
 * S3 building blocks for a parser that works on the Uint8Array directly (run with INPUT=bytes).
 * Each export takes the bytes and does one primitive over the whole document, so the costs of
 * direct-bytes parsing can be compared with the string path without writing a third parser.
 */
const decoder = new TextDecoder();
const decoded = new WeakMap<Uint8Array, string>();

/** The document as a string, decoded once per input and cached (not part of the timing). */
function text(bytes: Uint8Array): string {
  let value = decoded.get(bytes);
  if (value === undefined) {
    value = decoder.decode(bytes);
    decoded.set(bytes, value);
  }
  return value;
}

/** Whole-document TextDecoder.decode (the decode-once path's fixed cost). */
export function decodeAll(bytes: Uint8Array): number {
  return decoder.decode(bytes).length;
}

/** Whole-document binary string via chunked String.fromCharCode (the hybrid's fixed cost). */
export function binaryString(bytes: Uint8Array): number {
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += 8192) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(index, index + 8192) as unknown as number[]));
  }
  return parts.join("").length;
}

/** Find every "<" with String.prototype.indexOf. */
export function scanString(bytes: Uint8Array): number {
  const xml = text(bytes);
  let count = 0;
  for (let at = xml.indexOf("<"); at !== -1; at = xml.indexOf("<", at + 1)) count++;
  return count;
}

/** Find every "<" with Uint8Array.prototype.indexOf. */
export function scanBytes(bytes: Uint8Array): number {
  let count = 0;
  for (let at = bytes.indexOf(60); at !== -1; at = bytes.indexOf(60, at + 1)) count++;
  return count;
}

/** Find every "<" with a plain JS loop over the bytes. */
export function scanBytesLoop(bytes: Uint8Array): number {
  let count = 0;
  for (let index = 0, length = bytes.length; index < length; index++) if (bytes[index] === 60) count++;
  return count;
}

/** Materialize every text run between ">" and "<" as a string slice. */
export function sliceValues(bytes: Uint8Array): number {
  const xml = text(bytes);
  let total = 0;
  for (let gt = xml.indexOf(">"); gt !== -1; ) {
    const lt = xml.indexOf("<", gt + 1);
    if (lt === -1) break;
    if (lt > gt + 1) total += xml.slice(gt + 1, lt).length;
    gt = xml.indexOf(">", lt + 1);
  }
  return total;
}

/** Materialize every text run between ">" and "<" by decoding its bytes with TextDecoder. */
export function decodeValues(bytes: Uint8Array): number {
  let total = 0;
  for (let gt = bytes.indexOf(62); gt !== -1; ) {
    const lt = bytes.indexOf(60, gt + 1);
    if (lt === -1) break;
    if (lt > gt + 1) total += decoder.decode(bytes.subarray(gt + 1, lt)).length;
    gt = bytes.indexOf(62, lt + 1);
  }
  return total;
}
