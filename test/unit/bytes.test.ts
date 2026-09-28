/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { parse, XmlError } from "../../src/index.js";

const encoder = new TextEncoder();
const utf8 = (text: string): Uint8Array => encoder.encode(text);
const concat = (...parts: (Uint8Array | number[])[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((part) => [...part]));

/** UTF-16 bytes of `text` (code units), optionally with a byte order mark. */
function utf16(text: string, littleEndian: boolean, bom: boolean): Uint8Array {
  const units = (bom ? String.fromCodePoint(0xfe_ff) : "") + text;
  const out = new Uint8Array(units.length * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < units.length; index++) {
    // eslint-disable-next-line unicorn/prefer-code-point -- UTF-16 code units are what gets encoded
    view.setUint16(index * 2, units.charCodeAt(index), littleEndian);
  }
  return out;
}

describe("bytes input", () => {
  const text = "<a t='ü'>é € 😀</a>";
  const expected = parse(text).root;

  it("decodes UTF-8 with and without a byte order mark", () => {
    expect(parse(utf8(text)).root).toEqual(expected);
    const withBom = parse(concat([0xef, 0xbb, 0xbf], utf8(`<?xml version="1.0"?>${text}`)));
    expect(withBom.root).toEqual(expected);
    expect(withBom.children).toEqual([expected]);
  });

  it("decodes UTF-16 with a byte order mark, both byte orders", () => {
    expect(parse(utf16(text, true, true)).root).toEqual(expected);
    expect(parse(utf16(text, false, true)).root).toEqual(expected);
  });

  it("recognizes UTF-16 without a byte order mark from the declaration", () => {
    const declared = `<?xml version="1.0" encoding="UTF-16"?>${text}`;
    expect(parse(utf16(declared, true, false)).root).toEqual(expected);
    expect(parse(utf16(declared, false, false)).root).toEqual(expected);
  });

  it("uses the encoding the declaration names", () => {
    const latin1 = concat(
      utf8('<?xml version="1.0" encoding="ISO-8859-1"?><a>'),
      [0xe9],
      utf8("</a>"),
    );
    expect(parse(latin1).root.children).toBe("é");
    const cyrillic = concat(
      utf8("<?xml version='1.0' encoding='windows-1251'?><a>"),
      [0xe0],
      utf8("</a>"),
    );
    expect(parse(cyrillic).root.children).toBe("а");
  });

  it("accepts ArrayBuffer, typed-array views with an offset, and DataView", () => {
    const bytes = utf8(`xx${text}yy`);
    const view = bytes.subarray(2, -2);
    expect(parse(view).root).toEqual(expected);
    expect(parse(new DataView(bytes.buffer, 2, view.length)).root).toEqual(expected);
    expect(parse(utf8(text).buffer).root).toEqual(expected);
  });

  const rejects: [string, Uint8Array][] = [
    ["invalid UTF-8", concat(utf8("<a>"), [0xff, 0xfe], utf8("</a>"))],
    ["truncated UTF-8 sequence", concat(utf8("<a>"), [0xe2, 0x82], utf8("</a>"))],
    ["unsupported declared encoding", utf8('<?xml version="1.0" encoding="EBCDIC-US"?><a/>')],
    [
      "declaration contradicting the BOM",
      concat([0xef, 0xbb, 0xbf], utf8('<?xml version="1.0" encoding="ISO-8859-1"?><a/>')),
    ],
    ["UTF-32 byte order mark", concat([0xff, 0xfe, 0, 0], utf8("<a/>"))],
  ];
  for (const [label, bytes] of rejects) {
    it(`rejects: ${label}`, () => {
      expect(() => parse(bytes)).toThrow(XmlError);
    });
  }

  it("reports later errors at offsets in the decoded text", () => {
    expect(() => parse(utf8("<a>é😀</b>"))).toThrow(
      expect.objectContaining({ offset: 6 }) as XmlError,
    );
  });

  it("rejects other input types", () => {
    expect(() => parse({} as unknown as string)).toThrow(TypeError);
  });
});

describe("bytes input: matrix fixtures", () => {
  const files = import.meta.glob<string>("../fixtures/generated/matrix/*.xml", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  const entries = Object.entries(files);

  it("has fixtures (npm run fixtures:generate)", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  for (const [path, xml] of entries) {
    it(`parses ${/[^/]+$/.exec(path)?.[0] ?? path} from bytes like from a string`, () => {
      expect(parse(utf8(xml))).toEqual(parse(xml));
    });
  }
});
