/**
 * Synthetic XML fixtures shared by the local generator (scripts/generate-fixtures.mjs)
 * and the remote bench Worker, so a fixture name means the same document everywhere.
 * Erasable TypeScript only: Node runs this file directly via type stripping.
 */

function rssFeed(items: number, textLength: number): string {
  const lorem = "Lorem ipsum dolor sit amet "
    .repeat(Math.ceil(textLength / 27))
    .slice(0, textLength);
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>Bench</title>`;
  for (let index = 0; index < items; index++) {
    out += `<item id="${index}"><title>Item ${index}</title><link>https://example.com/${index}</link><description>${lorem}</description><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>`;
  }
  return out + `</channel></rss>`;
}

function attrsHeavy(elements: number, attrsPerElement: number): string {
  let out = `<root>`;
  for (let index = 0; index < elements; index++) {
    let attributes = "";
    for (let attr = 0; attr < attrsPerElement; attr++)
      attributes += ` a${attr}="value-${index}-${attr}"`;
    out += `<node${attributes}>text-${index}</node>`;
  }
  return out + `</root>`;
}

function deepNesting(levels: number, padLength: number): string {
  const pad = "padding-text ".repeat(Math.ceil(padLength / 13)).slice(0, padLength);
  let inner = `leaf-${pad}`;
  for (let depth = 0; depth < levels; depth++)
    inner = `<level${depth} id="${depth}">${pad}${inner}</level${depth}>`;
  return `<?xml version="1.0"?><root>${inner}</root>`;
}

function cdataHeavy(sections: number, sectionLength: number): string {
  const payload = "x <>&'\" ".repeat(Math.ceil(sectionLength / 8)).slice(0, sectionLength);
  let out = `<root>`;
  for (let index = 0; index < sections; index++)
    out += `<entry id="${index}"><![CDATA[${payload}]]></entry>`;
  return out + `</root>`;
}

/** Named fixtures, written locally as `test/fixtures/generated/<name>.xml`. */
export const FIXTURES: Record<string, () => string> = {
  "tiny-1k": () => rssFeed(5, 60),
  "rss-100k": () => rssFeed(300, 200),
  "attrs-heavy-100k": () => attrsHeavy(1200, 8),
  "deep-nesting-100k": () => deepNesting(1200, 60),
  "cdata-heavy-100k": () => cdataHeavy(300, 250),
  "large-1mb": () => rssFeed(3000, 220),
  "large-5mb": () => rssFeed(14_000, 250),
};

/** Size of the `many/` burst corpus. */
export const BURST_COUNT = 200;

/** One ~2KB document of the `many/` burst corpus. */
export function burstDocument(index: number): string {
  return rssFeed(8, 120).replaceAll("Bench", `Bench-${index}`);
}
