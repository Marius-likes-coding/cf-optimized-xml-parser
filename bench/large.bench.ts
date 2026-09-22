/// <reference types="vite/client" />
import { describe } from "vitest";
// Imported through Vite (`?raw`): node:fs cannot see host files from inside workerd.
// A missing file fails the run; generate them with `npm run fixtures:generate`.
import LARGE_1MB from "../test/fixtures/generated/large-1mb.xml?raw";
import LARGE_5MB from "../test/fixtures/generated/large-5mb.xml?raw";
import RSS_100K from "../test/fixtures/generated/rss-100k.xml?raw";
import { benchParse } from "./harness.js";

describe("parse: large documents", () => {
  benchParse("rss-100k (single)", [RSS_100K], { time: 800 });
  benchParse("large-1mb (single)", [LARGE_1MB], { time: 800 });
  benchParse("large-5mb (single)", [LARGE_5MB], { time: 1000 });
});
