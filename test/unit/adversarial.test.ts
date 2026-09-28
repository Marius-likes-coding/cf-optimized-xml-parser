import { describe, expect, it } from "vitest";
import { attributes, parse, XmlError } from "../../src/index.js";

/** Runs `run` and returns its wall time in ms (workerd's clock ticks in whole ms). */
function timed(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

const manyAttributes = (count: number): string =>
  `<a ${Array.from({ length: count }, (_, index) => `a${String(index)}="1"`).join(" ")}/>`;

describe("adversarial input stays linear", () => {
  // Budgets are ~10–50× the measured time on a dev machine: they catch quadratic blowups, not
  // small regressions (the benchmarks do that).
  const cases: [string, () => unknown, number][] = [
    [
      "20,000 attributes (limit raised)",
      () => parse(manyAttributes(20_000), { maxAttributes: 20_000 }),
      500,
    ],
    ["1,000,000 character references", () => parse(`<a>${"&#65;".repeat(1_000_000)}</a>`), 3000],
    [
      "1,000,000 entities in one attribute",
      () => parse(`<a b="${"&amp;".repeat(1_000_000)}"/>`),
      3000,
    ],
    ["5 MB of text", () => parse(`<a>${"x".repeat(5_000_000)}</a>`), 500],
    ["100,000 siblings", () => parse(`<a>${"<b/>".repeat(100_000)}</a>`), 1000],
    [
      "depth 100,000 (limit raised)",
      () => parse(`${"<a>".repeat(100_000)}${"</a>".repeat(100_000)}`, { maxDepth: 100_000 }),
      1000,
    ],
    ["1,000,000 comments", () => parse(`<a>${"<!---->".repeat(1_000_000)}</a>`), 3000],
  ];
  for (const [label, run, budget] of cases) {
    it(label, () => {
      expect(timed(run)).toBeLessThan(budget);
    });
  }

  it("rejects limit-breaking input without scanning all of it", () => {
    expect(() => parse(manyAttributes(201))).toThrow(/maxAttributes/);
    expect(
      timed(() => {
        expect(() => parse("<a>".repeat(1_000_000))).toThrow(/maxDepth/);
      }),
    ).toBeLessThan(200);
    expect(() => parse(`<!DOCTYPE a ${"[".repeat(1_000_000)}><a/>`)).toThrow(/64 KiB/);
  });
});

describe("truncated input", () => {
  const document = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY e "v">]><!--c--><?p d?><r a="1" b='&amp;'>t&lt;<![CDATA[x]]><e/></r>`;
  it("throws XmlError (never another error) when cut at any position", () => {
    for (let end = 0; end < document.length; end++) {
      expect(() => parse(document.slice(0, end)), `cut at ${String(end)}`).toThrow(XmlError);
    }
    expect(() => parse(document)).not.toThrow();
  });
});

describe("hostile names", () => {
  it("keeps __proto__ and constructor as plain data", () => {
    const doc = parse('<__proto__ __proto__="1" constructor="2"><constructor/></__proto__>');
    expect(doc.root.name).toBe("__proto__");
    expect(Object.getPrototypeOf(doc.root)).toBe(Object.prototype);
    expect(Object.keys(attributes(doc.root))).toEqual(["__proto__", "constructor"]);
    expect(({} as Record<string, unknown>).constructor).toBe(Object);
  });
});
