import { describe, expect, it } from "vitest";
import { parse, XmlError } from "../../src/index.js";
import {
  asciiBytes,
  MIN_ASCII_LENGTH,
  parseAscii,
  parseString,
  resetParser,
} from "../../src/parse-string.js";
import { WARMUP_ASCII } from "../../src/warmup.js";

const sources = import.meta.glob<string>("../../src/parse-string.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});
const source = Object.values(sources)[0] ?? "";

/** The text of a top-level `export function`, up to its closing brace. */
function functionText(name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  const end = source.indexOf("\n}\n", start);
  if (start === -1 || end === -1) throw new Error(`no function ${name} in parse-string.ts`);
  return source.slice(start, end + 2);
}

/** Without comments, whitespace, parentheses and `as number` casts. */
function normalized(text: string): string {
  return text
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/\/\/[^\n]*/g, "")
    .replaceAll(" as number", "")
    .replaceAll(/[\s()]/g, "");
}

const ascii = (length: number): string =>
  Array.from({ length }, (_, index) => String.fromCodePoint(32 + (index % 95))).join("");

/** The result, or the error's message and offset. Resets the parser after an error. */
function outcome(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    resetParser();
    if (!(error instanceof XmlError)) throw error;
    return { message: error.message, offset: error.offset };
  }
}

/** asciiBytes() for input the test knows is ASCII. */
function bytesOf(xml: string): Uint8Array {
  const bytes = asciiBytes(xml);
  if (bytes === null) throw new Error("not ASCII");
  return bytes;
}

function expectSameParse(xml: string, limits: [number, number, number] = [256, 200, 1000]): void {
  const viaString = outcome(() => parseString(xml, ...limits));
  const bytes = bytesOf(xml);
  expect(outcome(() => parseAscii(xml, bytes, ...limits))).toEqual(viaString);
}

describe("parseAscii", () => {
  it("stays a copy of parseString that reads bytes instead of charCodeAt()", () => {
    const expected = functionText("parseString")
      .replace("export function parseString(", "export function parseAscii(")
      .replace("xml: string,", "xml: string, bytes: Uint8Array,")
      .replaceAll(/xml\.charCodeAt\(([^()]*)\)/g, "bytes[$1]");
    expect(normalized(functionText("parseAscii"))).toBe(normalized(expected));
  });

  const fixtures = import.meta.glob<string>("../fixtures/generated/matrix/*.xml", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  const documents = [
    WARMUP_ASCII,
    ...Object.values(fixtures).filter((xml) => asciiBytes(xml) !== null && xml.length < 300_000),
  ];

  it("parses ASCII documents like parseString", () => {
    expect(documents.length).toBeGreaterThan(5);
    for (const xml of documents) {
      expectSameParse(xml);
      expectSameParse(xml, [3, 2, 3]);
    }
  });

  it("rejects truncated and mutated documents like parseString", () => {
    for (const xml of documents) {
      const step = Math.max(1, Math.floor(xml.length / 150));
      for (let at = 0; at <= xml.length; at += step) {
        expectSameParse(xml.slice(0, at));
        expectSameParse(`${xml.slice(0, at)}<>="'/ ${xml.slice(at + 3)}`.slice(0, xml.length));
      }
    }
  });

  it("ignores an earlier, longer input's bytes past the end", () => {
    for (const fill of [">", " ", "=", "/", '"', "-", "?"]) {
      for (let at = 0; at <= WARMUP_ASCII.length; at++) {
        asciiBytes(fill.repeat(40_000));
        expectSameParse(WARMUP_ASCII.slice(0, at));
      }
    }
  });

  it("is what parse() uses for long ASCII input", () => {
    const xml = `<a>${"<b c='1'>d &amp; e</b>".repeat(MIN_ASCII_LENGTH / 16)}</a>`;
    expect(xml.length).toBeGreaterThan(MIN_ASCII_LENGTH);
    expect(parse(xml)).toEqual(parseString(xml, 256, 200, 1000));
  });
});

describe("asciiBytes", () => {
  it("copies ASCII input of any length, also into a buffer kept from a longer input", () => {
    for (const length of [0, 1, 1023, 1024, 1025, 3072, 3073, 40_000, 1500, 7, 1_100_000, 2000]) {
      const xml = ascii(length);
      const bytes = bytesOf(xml);
      const copy = bytes.subarray(0, length);
      expect(copy).toEqual(Uint8Array.from(xml, (char) => char.codePointAt(0) ?? -1));
      // Past the end: zero, or nothing when the buffer is exactly as long.
      expect(bytes[length]).toBe(length < bytes.length ? 0 : undefined);
    }
  });

  it("returns null for a non-ASCII character anywhere", () => {
    for (const length of [40_000, 2000, 100]) {
      for (const at of [0, 99, 1023, 1024, 1999, 3071, 3072, 20_000, length - 1]) {
        if (at >= length) continue;
        for (const char of ["é", "\u0080", "ÿ", "€", "\uD800"]) {
          asciiBytes(ascii(40_000));
          expect(asciiBytes(ascii(at) + char + ascii(length - at - 1))).toBeNull();
        }
      }
    }
  });
});
