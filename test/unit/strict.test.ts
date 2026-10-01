import { describe, expect, it } from "vitest";
import { parse, XmlError } from "../../src/index.js";

const nested = (depth: number): string => `${"<a>".repeat(depth)}${"</a>".repeat(depth)}`;
const attributes = (count: number): string =>
  `<a ${Array.from({ length: count }, (_, index) => `a${String(index)}="1"`).join(" ")}/>`;
const name = (length: number): string => "n".repeat(length);
const doctype = (size: number): string => `<!DOCTYPE a [${" ".repeat(size)}]><a/>`;
const many = (count: number): string =>
  Array.from({ length: count }, (_, index) => `a${String(index)}="1"`).join(" ");

describe("normalization", () => {
  it(String.raw`turns \r\n and \r into \n in text, CDATA, comments and PI data`, () => {
    const doc = parse("<a>x\r\ny\rz<![CDATA[1\r\n2]]><!--c\r\nd--><?p e\rf?></a>");
    expect(doc.root.children).toEqual([
      "x\ny\nz1\n2",
      { name: "#comment", attrs: null, children: "c\nd" },
      { name: "?p", attrs: null, children: "e\nf" },
    ]);
  });

  it(
    String.raw`turns literal tabs, newlines and \r\n in attribute values into single spaces`,
    () => {
      expect(parse('<a t="x\r\ny\tz\nw\rv"/>').root.attrs).toEqual(["t", "x y z w v"]);
    },
  );

  it("never normalizes characters produced by references", () => {
    const doc = parse('<a t="x&#13;&#10;&#9;y\n&amp;">p&#13;q\r\n&lt;</a>');
    expect(doc.root.attrs).toEqual(["t", "x\r\n\ty &"]);
    expect(doc.root.children).toBe("p\rq\n<");
  });

  it("reports entity errors at their real position inside normalized text", () => {
    expect(() => parse("<a>x\r\n&bogus;</a>")).toThrow(
      expect.objectContaining({ offset: 6, line: 2, column: 1 }) as XmlError,
    );
  });
});

describe("well-formedness", () => {
  const rejects: [string, string][] = [
    ["duplicate attribute", '<a x="1" x="2"/>'],
    ["]]> in text", "<a>x ]]> y</a>"],
    ["-- inside a comment", "<a><!-- x -- y --></a>"],
    ["comment ending in --->", "<a><!-- x ---></a>"],
    ["PI target XML in another case", "<a><?XML x?></a>"],
    ["declaration target in another case", '<?Xml version="1.0"?><a/>'],
    ["declaration without version", '<?xml encoding="UTF-8"?><a/>'],
    ["declaration with a bad version", '<?xml version="2.0"?><a/>'],
    ["XML 1.1", '<?xml version="1.1"?><a/>'],
    ["standalone other than yes/no", '<?xml version="1.0" standalone="maybe"?><a/>'],
    ["declaration attributes out of order", '<?xml encoding="UTF-8" version="1.0"?><a/>'],
    ["DOCTYPE after the root", "<a/><!DOCTYPE a>"],
    ["second DOCTYPE", "<!DOCTYPE a><!DOCTYPE a><a/>"],
    ["name starting with a digit", "<1a/>"],
    ["name starting with -", "<-a/>"],
    ["invalid character in an element name", "<a$b/>"],
    ["invalid character in an attribute name", '<a b$c="1"/>'],
    ["invalid PI target", "<a><?1x y?></a>"],
    ["DOCTYPE without a name", '<!DOCTYPE SYSTEM "a.dtd"><a/>'],
    ["DOCTYPE with a literal but no SYSTEM/PUBLIC", '<!DOCTYPE a "a.dtd"><a/>'],
    ["public id with a character PubidChar forbids", '<!DOCTYPE a PUBLIC "{x}" "a.dtd"><a/>'],
  ];
  for (const [label, xml] of rejects) {
    it(`rejects: ${label}`, () => {
      expect(() => parse(xml)).toThrow(XmlError);
    });
  }

  const accepts: [string, string][] = [
    [
      "declaration with encoding and standalone",
      `<?xml version="1.0" encoding='UTF-8' standalone="no" ?><a/>`,
    ],
    ["XML 1.0 name characters", "<ü:ñ ç·a-b.c_d='1' ζ='2'>x</ü:ñ>"],
    ["astral name characters", "<a𐀀/>"],
    ["empty comment", "<a><!----></a>"],
    ["comment with single dashes", "<a><!-- a-b - c --></a>"],
    ["PI target that only starts with xml", "<a><?xml-stylesheet href='s'?></a>"],
    ["DOCTYPE before the root", "<!DOCTYPE a><a/>"],
    ["DOCTYPE with a public id", `<!DOCTYPE a PUBLIC "-//X//DTD a//EN" 'a.dtd'><a/>`],
    ["a future 1.x version, processed as 1.0", '<?xml version="1.7"?><a/>'],
  ];
  for (const [label, xml] of accepts) {
    it(`accepts: ${label}`, () => {
      expect(() => parse(xml)).not.toThrow();
    });
  }
});

describe("limits", () => {
  it("allows exactly maxDepth levels", () => {
    expect(() => parse(nested(256))).not.toThrow();
    expect(() => parse(nested(257))).toThrow(/maxDepth/);
    expect(() => parse(nested(10), { maxDepth: 10 })).not.toThrow();
    expect(() => parse(nested(11), { maxDepth: 10 })).toThrow(/maxDepth/);
  });

  it("allows exactly maxAttributes attributes", () => {
    expect(() => parse(attributes(200))).not.toThrow();
    expect(() => parse(attributes(201))).toThrow(/maxAttributes/);
    expect(() => parse(attributes(3), { maxAttributes: 3 })).not.toThrow();
    expect(() => parse(attributes(4), { maxAttributes: 3 })).toThrow(/maxAttributes/);
  });

  it("allows names of exactly maxNameLength", () => {
    expect(() => parse(`<${name(1000)}/>`)).not.toThrow();
    expect(() => parse(`<${name(1001)}/>`)).toThrow(/maxNameLength/);
    expect(() => parse(`<a ${name(5)}="1"/>`, { maxNameLength: 5 })).not.toThrow();
    expect(() => parse(`<a ${name(6)}="1"/>`, { maxNameLength: 5 })).toThrow(/maxNameLength/);
    expect(() => parse(`<a><?${name(6)} x?></a>`, { maxNameLength: 5 })).toThrow(/maxNameLength/);
  });

  it("caps the DOCTYPE at 64 KiB", () => {
    expect(() => parse(doctype(60_000))).not.toThrow();
    expect(() => parse(doctype(70_000))).toThrow(/64 KiB/);
  });

  it("rejects invalid options", () => {
    for (const options of [{ maxDepth: 0 }, { maxAttributes: -1 }, { maxNameLength: 1.5 }]) {
      expect(() => parse("<a/>", options)).toThrow(RangeError);
    }
  });
});

// parseString caches recent names (by the four characters after "<") and predicts attribute
// names from the cached element; a hit must never accept what NAME_RE would reject.
describe("repeated names", () => {
  it("parses names that extend, differ from or reorder earlier ones", () => {
    const doc = parse(
      '<r><item a="1" b="2"/><item a="1" b="2"/><items a="1"/><itemx a="1"/>' +
        '<item a="1" bb="2" c="3"/><item b="2" a="1"/><item/><item\n/></r>',
    );
    expect(doc.root.children).toEqual([
      { name: "item", attrs: ["a", "1", "b", "2"], children: null },
      { name: "item", attrs: ["a", "1", "b", "2"], children: null },
      { name: "items", attrs: ["a", "1"], children: null },
      { name: "itemx", attrs: ["a", "1"], children: null },
      { name: "item", attrs: ["a", "1", "bb", "2", "c", "3"], children: null },
      { name: "item", attrs: ["b", "2", "a", "1"], children: null },
      { name: "item", attrs: null, children: null },
      { name: "item", attrs: null, children: null },
    ]);
  });

  it("still rejects bad names and duplicates after a repeated name", () => {
    expect(() => parse("<r><item/><item$/></r>")).toThrow(/invalid character in element name/);
    expect(() => parse('<r><e x="1"/><e x$="1"/></r>')).toThrow(XmlError);
    expect(() => parse('<r><e x="1" y="2"/><e x="1" x="2"/></r>')).toThrow(/duplicate attribute/);
    expect(() => parse("<r><a/><></r>")).toThrow(/invalid or missing element name/);
  });

  it("forgets names at the end of a parse, also after an error", () => {
    expect(() => parse("<r><abcdef/></r>")).not.toThrow();
    expect(() => parse("<r><abcdef/></r>", { maxNameLength: 5 })).toThrow(/maxNameLength/);
    expect(() => parse('<r><abcdef x="1"/><x')).toThrow(XmlError);
    expect(() => parse('<abcdef x="1"/>', { maxNameLength: 5 })).toThrow(/maxNameLength/);
  });
});

// Attribute names that repeat a cached element's are matched without the duplicate and
// maxAttributes checks (they can't fail there); every other case must still run them.
describe("predicted attributes", () => {
  it("rejects a duplicate after predicted names", () => {
    expect(() => parse('<r><e x="1" y="2"/><e x="1" y="2" x="3"/></r>')).toThrow(
      /duplicate attribute/,
    );
    expect(() => parse(`<r><e ${many(20)}/><e ${many(20)} a5="2"/></r>`)).toThrow(
      /duplicate attribute/,
    );
  });

  it("keeps maxAttributes after predicted names", () => {
    expect(() => parse('<r><e x="1"/><e x="1" y="2"/></r>', { maxAttributes: 1 })).toThrow(
      /maxAttributes/,
    );
    expect(() => parse('<r><e x="1"/><e x="1"/></r>', { maxAttributes: 1 })).not.toThrow();
  });

  it("parses predicted, extra and reordered names with every kind of value", () => {
    const doc = parse(
      "<r><e s='x &amp; y' t=\"a\tb\"/><e s='x &amp; y' t=\"a\tb\"/><e s='1' t='2' u='3'/>" +
        `<e t="2" s="1"/><e ${many(18)}/><e ${many(18)} b="2"/></r>`,
    );
    expect(doc.root.children).toEqual([
      { name: "e", attrs: ["s", "x & y", "t", "a b"], children: null },
      { name: "e", attrs: ["s", "x & y", "t", "a b"], children: null },
      { name: "e", attrs: ["s", "1", "t", "2", "u", "3"], children: null },
      { name: "e", attrs: ["t", "2", "s", "1"], children: null },
      {
        name: "e",
        attrs: Array.from({ length: 18 }, (_, i) => [`a${String(i)}`, "1"]).flat(),
        children: null,
      },
      {
        name: "e",
        attrs: [...Array.from({ length: 18 }, (_, i) => [`a${String(i)}`, "1"]).flat(), "b", "2"],
        children: null,
      },
    ]);
  });
});
