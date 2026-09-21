import { readFileSync } from "node:fs";
import { bench, describe } from "vitest";
import { parse } from "../src/index.js";

function load(name: string): string {
  try {
    return readFileSync(new URL(`../test/fixtures/generated/${name}`, import.meta.url), "utf8");
  } catch {
    // Fallback synthetic doc when fixtures haven't been generated (CI always generates first).
    return `<root>${"<item>hello</item>".repeat(5000)}</root>`;
  }
}

const RSS_100K = load("rss-100k.xml");
const LARGE_1MB = load("large-1mb.xml");
const LARGE_5MB = load("large-5mb.xml");

function safeParse(xml: string): void {
  try {
    parse(xml);
  } catch {
    // overhead baseline until parser lands
  }
}

describe("parse: large documents", () => {
  bench(
    "rss-100k (single)",
    () => {
      safeParse(RSS_100K);
    },
    { time: 800 },
  );
  bench(
    "large-1mb (single)",
    () => {
      safeParse(LARGE_1MB);
    },
    { time: 800 },
  );
  bench(
    "large-5mb (single)",
    () => {
      safeParse(LARGE_5MB);
    },
    { time: 1000 },
  );
});
