import { describe, expect, it } from "vitest";
import worker from "../../src/bench-worker.js";

async function get(path: string) {
  const response = await worker.fetch(new Request(`https://bench.test${path}`));
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

describe("remote bench worker", () => {
  it("parses a fixture count times and reports its size", async () => {
    const { status, body } = await get("/run?fixture=tiny-1k&count=3");
    expect(status).toBe(200);
    expect(body).toEqual({ fixture: "tiny-1k", bytes: 1153, count: 3 });
  });

  it("accepts count=0, the baseline request the client subtracts", async () => {
    const { status, body } = await get("/run?fixture=large-1mb&count=0");
    expect(status).toBe(200);
    expect(body.count).toBe(0);
  });

  it("rejects unknown fixtures and bad counts", async () => {
    for (const query of [
      "fixture=nope&count=1",
      "fixture=tiny-1k&count=-1",
      "fixture=tiny-1k&count=1.5",
      `fixture=tiny-1k&count=${String(2 ** 20 + 1)}`,
    ]) {
      const { status } = await get(`/run?${query}`);
      expect(status, query).toBe(400);
    }
  });

  it("lists every fixture", async () => {
    const { body } = await get("/fixtures");
    expect(body.fixtures).toContain("deep-nesting-100k");
  });
});
