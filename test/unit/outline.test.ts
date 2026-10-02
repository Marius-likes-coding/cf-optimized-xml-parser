import { describe, expect, it } from "vitest";
import { parse, XmlError } from "../../src/index.js";
import { MIN_OUTLINE_LENGTH, parseString, resetParser } from "../../src/parse-string.js";

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

/** Parses with the unpredicted attributes read in restOfTag() and inline; both must agree. */
function expectSameBothWays(xml: string, limits: [number, number, number] = [256, 200, 1000]) {
  const inline = outcome(() => parseString(xml, ...limits, Number.POSITIVE_INFINITY));
  expect(outcome(() => parseString(xml, ...limits, 0))).toEqual(inline);
  return inline;
}

const many = (count: number, from = 0): string =>
  Array.from({ length: count }, (_, index) => `a${String(index + from)}="${String(index)}"`).join(
    " ",
  );

describe("attributes the name cache didn't predict", () => {
  it("are read the same in and outside parseString", () => {
    for (const xml of [
      '<r><c x="1" y="2"/><c x="1" z = \'3\'\t\r\nw="&amp;&#65;\tv"/><c x="1" y="2" z="3"/></r>',
      `<r ${many(20)}><c ${many(17)}/><c ${many(17)} b="x"/></r>`,
      '<r><e aaaa="1" bbbbbbbb="2"/><e aaaa="1" bbbbbbbbb="2"/><e aaaa="1"/></r>',
    ]) {
      expect(expectSameBothWays(xml)).toHaveProperty("root");
    }
  });

  it("are rejected the same in and outside parseString", () => {
    for (const xml of [
      '<r a="1" b="2" a="3"/>',
      `<r><c x="1" y="2"/><c x="1" y="2" x="3"/></r>`,
      `<r><c x="1"/><c x="1" ${many(18)} a3="z"/></r>`,
      `<r ${many(20)} a19="x"/>`,
      '<r a="1" b=2/>',
      '<r a="1" b/>',
      '<r a="1"b="2"/>',
      '<r a="1" b="2',
      '<r a="x<y"/>',
      '<r a="1" $="2"/>',
      '<r a="1" b="&bogus;"/>',
    ]) {
      expect(expectSameBothWays(xml)).toHaveProperty("message");
    }
    expect(expectSameBothWays('<r a="1" b="2" c="3"/>', [256, 2, 1000])).toHaveProperty("message");
    expect(expectSameBothWays('<r a="1" bbbb="2"/>', [256, 200, 3])).toHaveProperty("message");
  });

  it("are read outside parseString in long documents", () => {
    const xml = `<r v="1">${'<c x="1" y="&lt;2"/>'.repeat(MIN_OUTLINE_LENGTH / 16)}<c x="1" z="3"/></r>`;
    expect(xml.length).toBeGreaterThan(MIN_OUTLINE_LENGTH);
    expect(parse(xml)).toEqual(parseString(xml, 256, 200, 1000, Number.POSITIVE_INFINITY));
  });
});
