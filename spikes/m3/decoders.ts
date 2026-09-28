/** M3: TextDecoder cost with and without fatal: true (run with INPUT=bytes). */
const loose = new TextDecoder();
const strict = new TextDecoder("utf-8", { fatal: true });

export function decodeLoose(bytes: Uint8Array): number {
  return loose.decode(bytes).length;
}

export function decodeFatal(bytes: Uint8Array): number {
  return strict.decode(bytes).length;
}
