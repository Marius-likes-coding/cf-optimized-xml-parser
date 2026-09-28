/// <reference types="vite/client" />
import { describe } from "vitest";
import { benchParse } from "../../bench/harness.js";
import { txml } from "../../bench/compare/parsers.js";
import { parse as a } from "./a-indexof.js";
import { parse as d } from "./d-regex.js";
import { parse as e } from "./e-regex-names.js";

/** S1: scanner design (B and C were dropped after round 1, see research/spikes/s1-scanner.md). Run with `npm run bench:tiers -- spikes spikes/s1`. */
const FIXTURES = [
  "rss-ascii",
  "rss-poison",
  "rss-cjk",
  "sitemap",
  "s3-ascii",
  "s3-poison",
  "svg",
  "soap",
  "ooxml-ascii",
  "entities",
  "rss-1mb-ascii",
  "rss-small",
  "s3-small",
];

const files = import.meta.glob<string>("../../test/fixtures/generated/matrix/*.xml", {
  query: "?raw",
  import: "default",
  eager: true,
});

for (const name of FIXTURES) {
  const xml = files[`../../test/fixtures/generated/matrix/${name}.xml`];
  if (xml === undefined) throw new Error(`missing fixture ${name}; run npm run fixtures:generate`);
  describe(`s1: ${name}`, () => {
    benchParse(`${name} A indexOf`, [xml], { time: 300 }, a);
    benchParse(`${name} D regex`, [xml], { time: 300 }, d);
    benchParse(`${name} E regex names`, [xml], { time: 300 }, e);
    benchParse(`${name} txml (reference)`, [xml], { time: 300 }, txml);
  });
}
