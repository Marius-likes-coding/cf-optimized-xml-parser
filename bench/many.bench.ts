/// <reference types="vite/client" />
import { describe } from "vitest";
import { benchParse } from "./harness.js";

/** Throughput: many small docs parsed back-to-back (burst / batch workloads). */
const BURST_SIZE = 50;

// Loaded through Vite: node:fs cannot see host files from inside workerd.
const corpus = import.meta.glob<string>("../test/fixtures/generated/many/*.xml", {
  query: "?raw",
  import: "default",
  eager: true,
});
const DOCS = Object.keys(corpus)
  .sort()
  .slice(0, BURST_SIZE)
  .map((path) => corpus[path] ?? "");
if (DOCS.length < BURST_SIZE) {
  throw new Error(
    `expected ${BURST_SIZE} docs in test/fixtures/generated/many/, found ${DOCS.length}; run npm run fixtures:generate`,
  );
}

describe("parse: many small docs (burst)", () => {
  benchParse(`${BURST_SIZE}x ~2KB burst`, DOCS, { time: 800 });
});
