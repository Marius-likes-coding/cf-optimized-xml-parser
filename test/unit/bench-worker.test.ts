import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/bench-worker.js";

/** Subrequests stay local: the Worker only fetches to let the clock advance. */
function stubClockFetch() {
  const fetchStub = vi.fn(() => Promise.resolve(new Response("ok")));
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

async function bench(query: string) {
  const response = await worker.fetch(new Request(`https://bench.test/bench?${query}`));
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

describe("remote bench worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("times batches of parses between subrequests", async () => {
    const fetchStub = stubClockFetch();
    const { status, body } = await bench("fixture=tiny-1k&samples=2");

    expect(status).toBe(200);
    expect(body.medianMs).toBeGreaterThan(0);
    expect(body.batch).toBeGreaterThanOrEqual(1);
    expect(fetchStub).toHaveBeenCalled();
  });

  it("errors instead of reporting zeros when the clock never advances", async () => {
    stubClockFetch();
    vi.spyOn(performance, "now").mockReturnValue(0);
    const { status, body } = await bench("fixture=tiny-1k&samples=2");

    expect(status).toBe(500);
    expect(body.error).toMatch(/clock did not advance/);
  }, 30_000);

  it("rejects unknown fixtures", async () => {
    const { status } = await bench("fixture=nope");
    expect(status).toBe(400);
  });
});
