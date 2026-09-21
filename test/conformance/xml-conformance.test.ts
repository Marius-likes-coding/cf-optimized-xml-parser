import { describe, expect, it } from "vitest";
import { parse } from "../../src/index.js";

/**
 * Conformance skeleton — all skipped until `parse` is implemented.
 * Unskip (remove `.skip`) file-by-file as features land.
 * Each case documents the XML edge it covers so perf fixtures stay honest.
 */
describe.skip("xml conformance (enable as parser lands)", () => {
  it("parses simple elements", () => {
    expect(parse("<root/>")).toBeDefined();
  });

  it("handles attributes", () => {
    expect(parse('<root a="1" b="2"/>')).toBeDefined();
  });

  it("handles nesting", () => {
    expect(parse("<a><b><c>text</c></b></a>")).toBeDefined();
  });

  it("handles namespaces", () => {
    expect(parse('<x:root xmlns:x="urn:x"><x:child/></x:root>')).toBeDefined();
  });

  it("handles CDATA", () => {
    expect(parse("<root><![CDATA[<not>markup</not>]]></root>")).toBeDefined();
  });

  it("handles comments and PIs", () => {
    expect(parse("<root><!-- c --><?pi data?><child/></root>")).toBeDefined();
  });

  it("handles entities", () => {
    expect(parse("<root>&lt;&gt;&amp;&quot;&apos;</root>")).toBeDefined();
  });

  it("rejects malformed XML", () => {
    expect(() => parse("<root><unclosed>")).toThrow();
  });

  it("handles BOM and declarations", () => {
    expect(parse('﻿<?xml version="1.0" encoding="UTF-8"?><root/>')).toBeDefined();
  });
});
