import { describe, expect, it } from "vitest";
import { VERSION } from "../../src/index.js";

/**
 * Scaffolding tests. These run inside workerd via @cloudflare/vitest-pool-workers,
 * so Web-API-only constraints are enforced for real.
 * Replace `parse` assertions with real ones as the parser is implemented.
 */
describe("scaffolding", () => {
  it("exposes a version", () => {
    expect(typeof VERSION).toBe("string");
  });

  it("has TextDecoder available (Workers runtime proof)", () => {
    const bytes = new TextEncoder().encode("<root/>");
    expect(new TextDecoder().decode(bytes)).toBe("<root/>");
  });

  it("has performance.now available", () => {
    expect(typeof performance.now()).toBe("number");
  });

  it("supports streaming via ReadableStream", () => {
    const rs = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("<a>"));
        c.enqueue(new TextEncoder().encode("</a>"));
        c.close();
      },
    });
    expect(rs).toBeInstanceOf(ReadableStream);
  });
});
