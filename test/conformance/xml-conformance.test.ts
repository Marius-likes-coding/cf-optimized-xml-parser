import { describe, expect, it } from "vitest";
import { parse, XmlError } from "../../src/index.js";

/**
 * Conformance smoke tests: one case per XML edge the parser must handle. The full W3C suite
 * runs separately (milestone M6 in docs/implementation-plan.md).
 */
describe("xml conformance", () => {
  it("parses simple elements", () => {
    expect(parse("<root/>").root).toEqual({ name: "root", attrs: null, children: null });
  });

  it("handles attributes", () => {
    expect(parse('<root a="1" b="2"/>').root.attrs).toEqual(["a", "1", "b", "2"]);
  });

  it("handles nesting", () => {
    expect(parse("<a><b><c>text</c></b></a>").root).toEqual({
      name: "a",
      attrs: null,
      children: [
        {
          name: "b",
          attrs: null,
          children: [{ name: "c", attrs: null, children: "text" }],
        },
      ],
    });
  });

  it("keeps namespace prefixes as written", () => {
    const { root } = parse('<x:root xmlns:x="urn:x"><x:child/></x:root>');
    expect(root.name).toBe("x:root");
    expect(root.children).toEqual([{ name: "x:child", attrs: null, children: null }]);
  });

  it("handles CDATA as text", () => {
    expect(parse("<root><![CDATA[<not>markup</not>]]></root>").root.children).toBe(
      "<not>markup</not>",
    );
  });

  it("keeps comments and PIs", () => {
    expect(parse("<root><!-- c --><?pi data?><child/></root>").root.children).toEqual([
      { name: "#comment", attrs: null, children: " c " },
      { name: "?pi", attrs: null, children: "data" },
      { name: "child", attrs: null, children: null },
    ]);
  });

  it("handles entities", () => {
    expect(parse("<root>&lt;&gt;&amp;&quot;&apos;</root>").root.children).toBe(`<>&"'`);
  });

  it("rejects malformed XML", () => {
    expect(() => parse("<root><unclosed>")).toThrow(XmlError);
  });

  it("handles BOM and declarations", () => {
    const doc = parse('﻿<?xml version="1.0" encoding="UTF-8"?><root/>');
    expect(doc.children).toEqual([{ name: "root", attrs: null, children: null }]);
  });
});
