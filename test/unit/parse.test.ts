import { describe, expect, it } from "vitest";
import {
  attributes,
  childNodes,
  getAttribute,
  isComment,
  isElement,
  isProcessingInstruction,
  parse,
  textContent,
  XmlError,
  type XmlElement,
} from "../../src/index.js";

const element = (
  name: string,
  attrs: string[] | null = null,
  children: XmlElement["children"] = null,
): XmlElement => ({ name, attrs, children });

describe("parse: tree shape", () => {
  it("returns the root and all top-level nodes", () => {
    const doc = parse("<root/>");
    expect(doc.root).toEqual(element("root"));
    expect(doc.children).toEqual([doc.root]);
    expect(doc.children[0]).toBe(doc.root);
  });

  it("stores a lone text child as the string itself", () => {
    expect(parse("<a>hello</a>").root).toEqual(element("a", null, "hello"));
  });

  it("keeps elements and text in document order", () => {
    expect(parse("<a>x<b/>y<c>z</c></a>").root.children).toEqual([
      "x",
      element("b"),
      "y",
      element("c", null, "z"),
    ]);
  });

  it("lists attributes flat, in order, with either quote", () => {
    expect(parse(`<a x="1" y = '2'  z="a>b" w='say "hi"'/>`).root.attrs).toEqual([
      "x",
      "1",
      "y",
      "2",
      "z",
      "a>b",
      "w",
      'say "hi"',
    ]);
  });

  it("keeps namespace prefixes raw", () => {
    const doc = parse(`<x:root xmlns:x="urn:x"><x:child x:a="1"/></x:root>`);
    expect(doc.root.name).toBe("x:root");
    expect(doc.root.attrs).toEqual(["xmlns:x", "urn:x"]);
    expect(doc.root.children).toEqual([element("x:child", ["x:a", "1"])]);
  });

  it("drops whitespace-only text but never trims real text", () => {
    const doc = parse("<a>\n  <b> t </b>\n  <c/>\n</a>");
    expect(doc.root.children).toEqual([element("b", null, " t "), element("c")]);
  });

  it("allows whitespace before the end of an end tag", () => {
    expect(parse("<a>x</a  \n>").root).toEqual(element("a", null, "x"));
  });
});

describe("parse: entities and CDATA", () => {
  it("expands the predefined entities in text and attributes", () => {
    const doc = parse(`<a t="&lt;&amp;&gt;">&lt;&gt;&amp;&quot;&apos;</a>`);
    expect(doc.root.attrs).toEqual(["t", "<&>"]);
    expect(doc.root.children).toBe(`<>&"'`);
  });

  it("expands decimal, hex and astral character references", () => {
    expect(parse("<a>&#65;&#x42;&#x1F600;</a>").root.children).toBe("AB😀");
  });

  it("merges CDATA with neighbouring text and leaves its content raw", () => {
    expect(parse("<a>x <![CDATA[<y> & ]]> z</a>").root.children).toBe("x <y> &  z");
  });

  it("keeps CDATA separate from text across an element", () => {
    expect(parse("<a><![CDATA[1]]><b/><![CDATA[2]]></a>").root.children).toEqual([
      "1",
      element("b"),
      "2",
    ]);
  });
});

describe("parse: comments, PIs, prolog", () => {
  it("keeps comments and PIs as nodes, inside and at the top level", () => {
    const doc = parse(
      `<?xml version="1.0"?><!-- top --><?style href="a"?><a><!--in--><?x  y z?></a><!-- end -->`,
    );
    expect(doc.children).toEqual([
      { name: "#comment", attrs: null, children: " top " },
      { name: "?style", attrs: null, children: 'href="a"' },
      doc.root,
      { name: "#comment", attrs: null, children: " end " },
    ]);
    expect(doc.root.children).toEqual([
      { name: "#comment", attrs: null, children: "in" },
      { name: "?x", attrs: null, children: "y z" },
    ]);
  });

  it("skips a DOCTYPE, including an internal subset with > in quotes", () => {
    const doc = parse(`<!DOCTYPE a [ <!ENTITY e "x>y"> <!-- ] --> ]><a/>`);
    expect(doc.children).toEqual([element("a")]);
  });

  it("accepts a byte order mark before the declaration", () => {
    expect(parse(`\uFEFF<?xml version="1.0"?><a/>`).root).toEqual(element("a"));
  });
});

describe("parse: errors", () => {
  const rejects: [string, string][] = [
    ["mismatched end tag", "<a></b>"],
    ["end tag that only prefixes the name", "<ab></a>"],
    ["end tag longer than the name", "<a></ab>"],
    ["unclosed element", "<a><b></b>"],
    ["end tag without start tag", "<a></a></a>"],
    ["unknown entity", "<a>&nbsp;</a>"],
    ["unterminated entity", "<a>&amp</a>"],
    ["invalid character reference digits", "<a>&#12a;</a>"],
    ["empty character reference", "<a>&#;</a>"],
    ["uppercase X in a hex reference", "<a>&#X41;</a>"],
    ["character reference out of range", "<a>&#x110000;</a>"],
    ["reference to a forbidden character", "<a>&#0;</a>"],
    ["reference to a surrogate", "<a>&#xD800;</a>"],
    ["< in an attribute value", `<a x="<"/>`],
    ["unquoted attribute value", "<a x=1/>"],
    ["attribute without =", `<a x "1"/>`],
    ["no whitespace between attributes", `<a x="1"y="2"/>`],
    ["second root element", "<a/><b/>"],
    ["text after the root", "<a/>x"],
    ["text before the root", "x<a/>"],
    ["CDATA outside the root", "<![CDATA[x]]><a/>"],
    ["unterminated comment", "<a><!-- x</a>"],
    ["unterminated CDATA", "<a><![CDATA[x</a>"],
    ["unterminated PI", "<a><?pi x</a>"],
    ["unterminated DOCTYPE", "<!DOCTYPE a [ <a/>"],
    ["declaration not at the start", ` <?xml version="1.0"?><a/>`],
    ["PI without target", "<a><? x?></a>"],
    ["unknown markup declaration", "<!FOO><a/>"],
    ["missing element name", "< a/>"],
    ["/ not followed by >", "<a/ >"],
    ["empty document", ""],
    ["only a comment", "<!-- x -->"],
  ];
  for (const [label, xml] of rejects) {
    it(`rejects: ${label}`, () => {
      expect(() => parse(xml)).toThrow(XmlError);
    });
  }

  it("reports offset, line and column", () => {
    try {
      parse("<a>\r\n  <b></c>\n</a>");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(XmlError);
      const xmlError = error as XmlError;
      expect([xmlError.offset, xmlError.line, xmlError.column]).toEqual([10, 2, 6]);
      expect(xmlError.message).toContain("line 2, column 6");
    }
  });

  it("never puts input text into the message", () => {
    let message = "";
    try {
      parse("<secret-name></other-name>");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toMatch(/secret|other/);
  });

  it("parses correctly after a failed parse", () => {
    expect(() => parse("<a><b><c>")).toThrow(XmlError);
    expect(parse("<x>1</x>").root).toEqual(element("x", null, "1"));
  });

  it("rejects non-string input", () => {
    expect(() => parse(42 as unknown as string)).toThrow(TypeError);
  });
});

describe("helpers", () => {
  const doc = parse(
    `<a id="1" __proto__="p" constructor="c">t<!--c--><?p d?><b>u<c>v</c></b>w</a>`,
  );

  it("reads attributes", () => {
    expect(getAttribute(doc.root, "id")).toBe("1");
    expect(getAttribute(doc.root, "missing")).toBeUndefined();
    const map = attributes(doc.root);
    expect(Object.getPrototypeOf(map)).toBeNull();
    expect(Object.entries(map)).toEqual([
      ["id", "1"],
      ["__proto__", "p"],
      ["constructor", "c"],
    ]);
    expect(attributes(parse("<x/>").root)).toEqual(Object.create(null));
  });

  it("tells node kinds apart", () => {
    const kinds = childNodes(doc.root).map((node) => [
      isElement(node),
      isComment(node),
      isProcessingInstruction(node),
    ]);
    expect(kinds).toEqual([
      [false, false, false],
      [false, true, false],
      [false, false, true],
      [true, false, false],
      [false, false, false],
    ]);
  });

  it("returns children as an array", () => {
    expect(childNodes(parse("<a>x</a>").root)).toEqual(["x"]);
    expect(childNodes(parse("<a/>").root)).toEqual([]);
  });

  it("concatenates descendant text, skipping comments and PIs", () => {
    expect(textContent(doc.root)).toBe("tuvw");
    expect(textContent("s")).toBe("s");
  });
});
