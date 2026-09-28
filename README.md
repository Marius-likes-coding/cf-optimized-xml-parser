# cf-optimized-xml-parser

A fast, spec-correct XML parser built for Cloudflare Workers.

- **Fast where Workers actually run code.** Cloudflare compiles JavaScript on the request thread and discards isolates often, so the parser is designed and measured for the first 100 parses in a fresh isolate: 1.1–2.1× less CPU than txml and 5–11× less than fast-xml-parser on realistic documents.
- **Small trees.** Output strings are zero-copy slices of the input; retained trees are about half the size of txml's or fast-xml-parser's.
- **Spec-correct with cheap checks.** Malformed input throws `XmlError` with line and column; line endings and attribute whitespace are normalized as XML 1.0 requires. Passes every test of the W3C conformance suite that lies within its documented scope.
- **Safe on untrusted input.** No external entities, no DTD entity expansion, structural limits, linear time; fuzzed with 1.5 million mutated inputs.
- **Tiny and dependency-free.** About 7 kB brotli, Web APIs only.

## Install

```bash
npm install cf-optimized-xml-parser
```

## Usage

```ts
import { childNodes, getAttribute, isElement, parse, textContent } from "cf-optimized-xml-parser";

export default {
  async fetch(): Promise<Response> {
    const response = await fetch("https://example.com/feed.xml");
    const doc = parse(await response.arrayBuffer()); // or: parse(await response.text())

    const channel = childNodes(doc.root).find((node) => isElement(node) && node.name === "channel");
    const items = channel && isElement(channel) ? childNodes(channel).filter(isElement) : [];
    const titles = items
      .filter((item) => item.name === "item")
      .map((item) =>
        textContent(childNodes(item).find((c) => isElement(c) && c.name === "title") ?? ""),
      );

    return Response.json({ version: getAttribute(doc.root, "version"), titles });
  },
};
```

## Output format

```xml
<?xml version="1.0"?>
<!-- feed -->
<rss version="2.0">
  <item id="1"><title>A &amp; B</title><link>https://x</link></item>
  <item id="2"><title>C</title><!-- note --></item>
</rss>
```

parses to

```js
{
  root: <the rss element below>,
  children: [                                   // top-level nodes in document order
    { name: "#comment", attrs: null, children: " feed " },
    { name: "rss", attrs: ["version", "2.0"], children: [
      { name: "item", attrs: ["id", "1"], children: [
        { name: "title", attrs: null, children: "A & B" },
        { name: "link", attrs: null, children: "https://x" },
      ] },
      { name: "item", attrs: ["id", "2"], children: [
        { name: "title", attrs: null, children: "C" },
        { name: "#comment", attrs: null, children: " note " },
      ] },
    ] },
  ],
}
```

- Every node has the shape `{ name, attrs, children }`, so V8 keeps them on one hidden class. Comments are named `"#comment"`, processing instructions `"?" + target`; element names never start with `#` or `?`. Text is a plain string.
- `attrs` is a flat `[name, value, name, value, …]` array in document order, or `null`.
- `children` is `null` when empty, **the string itself when the only child is text**, and an array otherwise. `childNodes(element)` always returns an array.
- CDATA becomes ordinary text, merged with neighbouring text. Entity and character references are decoded. Whitespace-only text between elements is dropped (also where `xml:space="preserve"` asks to keep it); other text is never trimmed.
- Line endings are normalized to `\n`; attribute values have literal tabs and newlines turned into spaces, as XML 1.0 requires.
- The XML declaration and DOCTYPE are not part of the tree.
- Strings in the result are slices of the input and keep it in memory. Use the result within the request that produced it.

These choices were measured, not guessed: flat attributes and folded text children made parsing faster and trees smaller than the alternatives (`research/spikes/s2-tree-building.md`).

## API

### `parse(input, options?)`

Returns `{ root, children }` or throws `XmlError`.

`input` is a `string`, an `ArrayBuffer` or any `ArrayBufferView` (for example a `Uint8Array`). Bytes are decoded once: a byte order mark (UTF-8, UTF-16LE/BE) decides, otherwise the declaration's `encoding` (any WHATWG encoding), otherwise UTF-8. Invalid byte sequences throw. When you have a `Response`, pass whichever you like: `response.text()` and `response.arrayBuffer()` measured within ±20% of each other.

| option          | default | limits                                            |
| --------------- | ------: | ------------------------------------------------- |
| `maxDepth`      |     256 | element nesting depth                             |
| `maxAttributes` |     200 | attributes on one element                         |
| `maxNameLength` |    1000 | length of an element, attribute or PI target name |

The DOCTYPE is capped at 64 KiB. There is no input-size limit; you control how much you pass in.

### `XmlError`

Thrown for input that isn't well-formed or exceeds a limit. It has `offset` (UTF-16 code units into the input, or into the decoded text for bytes), `line` and `column`. Messages never quote the input.

### `warmup()`

Parses two small built-in documents 10 times, once per isolate. Call it at module scope when one Worker parses documents of different shapes:

```ts
import { parse, warmup } from "cf-optimized-xml-parser";
warmup();
```

Why: V8 optimizes the parser after a few parses of the first document it sees. A later document that reaches parser paths the first one never used deoptimizes that code, and the recompile costs 24–45 ms of CPU on Cloudflare's request thread. `warmup()` gives V8 feedback for every path up front; in traces, the deopts disappear. At module scope it runs under Cloudflare's startup budget, not a request's CPU time (`research/spikes/s5-jit-behavior.md`).

### Helpers

| function                                                              | returns                                                                     |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `getAttribute(element, name)`                                         | the attribute's value or `undefined`                                        |
| `attributes(element)`                                                 | all attributes as a null-prototype object                                   |
| `childNodes(element)`                                                 | the children as an array, also when a lone text child is stored as a string |
| `textContent(node)`                                                   | the text of a node and its descendants, without comments and PIs            |
| `isElement(node)`, `isComment(node)`, `isProcessingInstruction(node)` | type guards                                                                 |

Types: `XmlDocument`, `XmlElement`, `XmlComment`, `XmlProcessingInstruction`, `XmlNode`, `ParseOptions`.

## Conformance and scope

A non-validating XML 1.0 (5th edition) parser. It rejects every well-formedness error it can detect cheaply: mismatched or unclosed tags, duplicate attributes, unknown entities, invalid character references, `]]>` in text, `--` in comments, misplaced or malformed declarations and DOCTYPEs, invalid names, and more.

Deliberately out of scope:

- **DTDs.** The DOCTYPE's head is checked, its internal subset is skipped. Entities declared there are not expanded, so documents that use them throw "unknown entity". External DTDs and entities are never fetched.
- **Namespaces.** Prefixes stay part of the name (`"x:child"`); namespace constraints aren't enforced.
- **Character validity.** Control characters and lone surrogates aren't rejected: checking them would cost up to 3× on non-ASCII documents.
- **XML 1.1** is refused; other `1.x` versions are processed as 1.0, as the spec allows.

W3C XML Conformance Test Suite: 1,263 of 1,736 applicable tests pass. Every failure falls under the scope decisions above (`research/conformance.md`); `npm run conformance` runs it.

## Security

- Only the five predefined entities and character references are expanded, so output can't grow beyond the input (no billion-laughs or quadratic blowup), and nothing is ever fetched (no XXE).
- Parsing is iterative and linear: deep nesting can't overflow the stack, and duplicate-attribute checks stay linear even with raised limits.
- A seeded mutation fuzzer (`npm run fuzz`) checks that any input either parses or throws `XmlError`; CI runs 50,000 inputs on every push.
- Names are values, never object keys, and `attributes()` returns a null-prototype object, so `__proto__` in a document is harmless.

## Performance

Total CPU over the first 100 parses in a fresh isolate, in local workerd with Cloudflare's production JIT flags (compilation on the request thread). Milliseconds, lower is better:

| document (~100 KB)   | this parser | txml | fast-xml-parser |
| -------------------- | ----------: | ---: | --------------: |
| RSS feed             |      **73** |   92 |             439 |
| SVG, attribute-heavy |     **135** |  237 |             999 |
| SOAP response        |     **115** |  161 |             773 |
| S3 listing, minified |      **98** |  111 |             504 |
| Word document body   |      **96** |  199 |             936 |
| Sitemap              |      **86** |  123 |             570 |
| RSS, 3.5 KB          |     **5.4** |  9.3 |            59.5 |

txml decodes no entities and checks almost nothing; fast-xml-parser runs in `preserveOrder` mode, its closest output to ours. On Cloudflare, a cold parse of a ~120 KB document takes 2–5 ms and a warm one under 1 ms.

Documents containing any character above U+00FF are stored by V8 at two bytes per character, which doubles the input's memory but barely changes parse time.

Methodology and more numbers: `bench/README.md` and `research/`.

## How it's built

One hot function scans with native `indexOf` jumps (fast in every JIT tier, which matters because Workers often run cold code), matches names with a sticky regular expression, finds `&`, `\r` and `]]>` through memoized searches, and builds every node from one object literal. The choices come from measured spikes, documented in `research/SYNTHESIS.md` and `research/spikes/`.

## Develop

```bash
npm ci
npm run fixtures:generate
npm test               # unit tests in workerd
npm run fuzz           # mutation fuzzing
npm run conformance    # W3C XML Conformance Test Suite
npm run bench          # benchmarks in workerd, production JIT flags
npm run build
```

`bench/README.md` covers the benchmark tooling (tier profiles, A/B, cold isolates, memory, the remote bench on Cloudflare). `docs/implementation-plan.md` is the roadmap this version was built from.

## Publishing (npm OIDC trusted publishing, no token)

1. One-time manual publish to claim the unscoped name:
   `npm publish --access public` (as `marius-likes-coding`).
2. At `npmjs.com/package/cf-optimized-xml-parser` → Settings → Trusted Publisher → GitHub Actions → owner/repo + `release.yml` → allow `publish`.
3. Push conventional commits to `main` — `semantic-release` versions, changelogs, and publishes with provenance.

Remote nightly perf needs repo secrets: `CLOUDFLARE_API_TOKEN` and var `BENCH_URL`.
