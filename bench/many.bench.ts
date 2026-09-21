import { readdirSync, readFileSync } from "node:fs";
import { bench, describe } from "vitest";
import { parse } from "../src/index.js";

/** Throughput: many small docs parsed back-to-back (burst / batch workloads). */
function loadMany(limit = 50): string[] {
  try {
    const dir = new URL("../test/fixtures/generated/many/", import.meta.url);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".xml"))
      .slice(0, limit);
    return files.map((f) => readFileSync(new URL(f, dir), "utf8"));
  } catch {
    return Array.from({ length: 20 }, () => `<item id="1">hello</item>`);
  }
}

const DOCS = loadMany(50);

describe("parse: many small docs (burst)", () => {
  bench(
    "50x ~2KB burst",
    () => {
      for (const doc of DOCS) {
        try {
          parse(doc);
        } catch {
          // overhead baseline until parser lands
        }
      }
    },
    { time: 800 },
  );
});
