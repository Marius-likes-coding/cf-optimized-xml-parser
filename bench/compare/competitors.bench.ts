/// <reference types="vite/client" />
import { describe } from "vitest";
import { benchParse } from "../harness.js";
import { fastXmlParser, txml } from "./parsers.js";

/**
 * Competitor baselines on the fixture matrix (npm run fixtures:generate). The parsers do
 * unequal work (see ./parsers.ts), so these are reference points, not a like-for-like race.
 */
const files = import.meta.glob<string>("../../test/fixtures/generated/matrix/*.xml", {
  query: "?raw",
  import: "default",
  eager: true,
});
const fixtures = Object.entries(files)
  .map(([path, xml]) => [/([^/]+)\.xml$/.exec(path)?.[1] ?? path, xml] as const)
  .sort(([a], [b]) => a.localeCompare(b));
if (fixtures.length === 0) {
  throw new Error(
    "no matrix fixtures in test/fixtures/generated/matrix/; run npm run fixtures:generate",
  );
}

for (const [name, xml] of fixtures) {
  describe(`competitors: ${name}`, () => {
    benchParse(`${name} txml`, [xml], { time: 400 }, txml);
    benchParse(`${name} fast-xml-parser`, [xml], { time: 400 }, fastXmlParser);
  });
}
