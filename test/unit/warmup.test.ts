import { describe, expect, it } from "vitest";
import { parse, warmup } from "../../src/index.js";
import { WARMUP_ONE_BYTE, WARMUP_TWO_BYTE } from "../../src/warmup.js";

describe("warmup", () => {
  it("runs once and leaves the parser working", () => {
    expect(() => {
      warmup();
      warmup();
    }).not.toThrow();
    expect(parse("<a b='1'>c</a>").root).toEqual({ name: "a", attrs: ["b", "1"], children: "c" });
  });

  // The warm-up only helps if its documents reach every parser path; these assertions keep the
  // documents from losing coverage when someone edits them (see research/spikes/s5-jit-behavior.md).
  it("uses documents that exercise every parser path", () => {
    for (const [xml, text] of [
      [WARMUP_ONE_BYTE, "café"],
      [WARMUP_TWO_BYTE, "“quoted” €"],
    ] as const) {
      const doc = parse(xml);
      const { root } = doc;
      expect(doc.children.map((node) => (typeof node === "string" ? node : node.name))).toEqual([
        "#comment",
        "?pi",
        "k:root",
        "#comment",
      ]);
      expect(root.attrs).toEqual([
        "xmlns:k",
        "urn:k",
        "a",
        "1",
        "b",
        "x & AB",
        "c",
        "t u v <",
        "d",
        text,
      ]);
      expect(root.children).toEqual([
        { name: "e", attrs: null, children: null },
        { name: "g", attrs: ["h", "1"], children: null },
        { name: "x", attrs: null, children: null },
        { name: "e", attrs: ["x", "1", "y", "2", "z", "3"], children: `t < > " ' ${text}` },
        {
          name: "f",
          attrs: null,
          children: "line\nbreak & morec <d> &after éé😀",
        },
        { name: "h", attrs: null, children: "first" },
        { name: "#comment", attrs: null, children: " in " },
        { name: "?p", attrs: null, children: "in\ndata" },
        {
          name: "n",
          attrs: null,
          children: [
            { name: "m", attrs: null, children: "deep" },
            { name: "m", attrs: null, children: null },
          ],
        },
        "\n  mixed ",
        { name: "b", attrs: null, children: "bold" },
        " text\n",
      ]);
    }
  });
});
