/// <reference types="vite/client" />
import { describe } from "vitest";
import { benchParse } from "../../bench/harness.js";
import { parse as attrsObject } from "./attrs-object.js";
import { parse as base } from "./base.js";
import { parse as childrenPush } from "./children-push.js";
import { parse as classNode } from "./class-node.js";
import { parse as comboFlat } from "./combo-flat.js";
import { parse as comboObject } from "./combo-object.js";
import { parse as foldText } from "./fold-text.js";
import { parse as intern } from "./intern.js";

/** S2: tree building. Run with `npm run bench:tiers -- spikes spikes/s2`. */
const FIXTURES = ["rss-ascii", "s3-ascii", "svg", "soap", "ooxml-ascii", "rss-small"];
const VARIANTS = {
  base,
  "attrs-object": attrsObject,
  "children-push": childrenPush,
  "fold-text": foldText,
  intern,
  "class-node": classNode,
  "combo-flat": comboFlat,
  "combo-object": comboObject,
};

const files = import.meta.glob<string>("../../test/fixtures/generated/matrix/*.xml", {
  query: "?raw",
  import: "default",
  eager: true,
});

for (const name of FIXTURES) {
  const xml = files[`../../test/fixtures/generated/matrix/${name}.xml`];
  if (xml === undefined) throw new Error(`missing fixture ${name}; run npm run fixtures:generate`);
  describe(`s2: ${name}`, () => {
    for (const [variant, parse] of Object.entries(VARIANTS)) {
      benchParse(`${name} ${variant}`, [xml], { time: 300 }, parse);
    }
  });
}
