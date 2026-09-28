/* eslint-disable unicorn/prefer-code-point -- compares UTF-16 code units, like the scanner. */
/** Thrown for input that isn't well-formed XML or exceeds a limit. */
export class XmlError extends Error {
  override readonly name = "XmlError";
  /** Offset of the problem in the input, in UTF-16 code units. */
  readonly offset: number;
  /** 1-based line of `offset` (`\r\n`, `\r` and `\n` all end a line). */
  readonly line: number;
  /** 1-based column of `offset`, in UTF-16 code units. */
  readonly column: number;

  constructor(message: string, offset: number, line: number, column: number) {
    super(`${message} (line ${String(line)}, column ${String(column)})`);
    this.offset = offset;
    this.line = line;
    this.column = column;
  }
}

/**
 * Throws an XmlError for `message` at `offset` in `xml`. Line and column are computed here, on
 * the error path only. Messages never include input text: a slice would keep the whole input
 * alive for as long as the error is.
 */
export function fail(message: string, xml: string, offset: number): never {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(offset, xml.length);
  for (let index = 0; index < end; index++) {
    const code = xml.charCodeAt(index);
    if (code === 10 || (code === 13 && xml.charCodeAt(index + 1) !== 10)) {
      line++;
      lineStart = index + 1;
    }
  }
  throw new XmlError(message, offset, line, offset - lineStart + 1);
}
