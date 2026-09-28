# S3: bytes input

Settles M5 and decision D12 from `research/SYNTHESIS.md`: how `parse()` handles a `Uint8Array`/`ArrayBuffer`. Run 2026-09-28 on local workerd 1.20260815.1 (V8 15.1), with bytes delivered through `request.arrayBuffer()` (`INPUT=bytes` in the tools).

## Decision

**Decode the whole buffer once with a shared `TextDecoder("utf-8")`, then run the string parser.** Both alternatives lose everywhere:
- The hybrid binary string (report H2 §5) is 8–217% slower.
- A parser working on the `Uint8Array` directly would be slower at both scanning and building values.

Bytes input costs one decode on top of string input:
- about 25–35 µs per 114 KB for pure ASCII (workerd's simdutf fast path);
- about 250–770 µs for non-ASCII (ICU).

## Variants

| Variant | How | File |
|---|---|---|
| decode-once | `decoder.decode(bytes)` → S2 string parser | `spikes/s3/decode-once.ts` |
| hybrid | Chunked `String.fromCharCode` → one-byte binary string → S2 parser; values with bytes ≥ 0x80 re-decoded with `TextDecoder` (memoized regex finds them) | `spikes/s3/hybrid.ts` |

Both produce trees identical to the string parser on all 21 matrix fixtures plus non-ASCII and BOM edge cases (`node spikes/s3/check.ts`).

## Results

### decode-once vs hybrid (µs per parse including conversion, `INPUT=bytes npm run bench:ab`, medians of 10 interleaved rounds)

| fixture | Ignition | Sparkplug | Maglev | Full |
|---|---|---|---|---|
| rss-ascii | 3,071 / +47% | 2,542 / +48% | 750 / +205% | 1,500 / +217% |
| rss-latin1 | 3,611 / +69% | 3,050 / +56% | 927 / +116% | 1,462 / +139% |
| rss-poison | 5,889 / +8% | 5,000 / +24% | 1,556 / +70% | 964 / +81% |
| rss-cjk | 6,800 / +56% | 5,500 / +50% | 2,222 / +147% | 1,500 / +146% |
| s3-poison | 8,125 / +23% | 6,500 / +23% | 1,917 / +37% | 1,385 / +89% |
| ooxml-poison | 16,000 / +22% | 9,167 / +13% | 1,909 / +5% | 2,222 / +13% |
| rss-small | 189 / +15% | 85 / +46% | 35 / +134% | 39 / +115% |
| rss-1mb-poison | 63,500 / +23% | 29,500 / +44% | 16,750 / +94% | 17,000 / +76% |

Cells: decode-once µs / hybrid's change against it.

### Building blocks (µs per 114 KB document; Ignition / full)

| primitive | rss-ascii | rss-latin1 | rss-poison | rss-cjk |
|---|---|---|---|---|
| `TextDecoder.decode` (whole document) | **25 / 35** | 349 / 425 | 243 / 261 | 679 / 773 |
| binary string (`fromCharCode` chunks) | 969 / 1,479 | 1,056 / 1,222 | 1,017 / 950 | 1,833 / 1,975 |
| find every `<`, string `indexOf` | 338 / 133 | 322 / 87 | 385 / 108 | 433 / 146 |
| find every `<`, `Uint8Array.indexOf` | 547 / 525 | 525 / 325 | 492 / 307 | 625 / 427 |
| find every `<`, JS byte loop | 5,375 / 307 | 5,700 / 230 | 5,167 / 188 | 9,667 / 351 |
| text runs as string slices | 920 / 321 | 850 / 210 | 1,067 / 238 | 1,174 / 328 |
| text runs via per-value `TextDecoder` | 2,500 / 2,850 | 2,682 / 2,250 | 2,423 / 1,583 | 3,208 / 2,933 |

## Findings

1. **Building the binary string costs 30–40× an ASCII decode, and 1.5–4× a non-ASCII decode.** It can't be earned back by a one-byte scan, because two-byte scanning is only ~10% slower (S1 finding 4).
2. **`Uint8Array.prototype.indexOf` doesn't use `memchr`:** 1.6–3.6× slower than string `indexOf` (confirms report H2's absence of evidence). A JS byte loop is 10–20× slower still in Ignition.
3. **Per-value `TextDecoder` is a C++ binding call per value:** 2.4–3.2 ms per document, 3–10× the cost of slicing. That rules out direct-bytes parsing with per-value decoding.
4. **`TextDecoder` returns one-byte strings for Latin-1 content under both the `utf-8` and `latin1` labels** (probe with `%DebugPrint`, no `uc` prefix). This corrects report A §4. The `latin1` label (windows-1252 per WHATWG) remaps bytes 0x80–0x9F, so it can't build a byte-exact binary string.
5. **For callers holding a `Response`,** `await response.text()` decodes through V8's own UTF-8 decoder instead of ICU. Worth measuring against `arrayBuffer()` + our decode in the performance pass before we document a recommendation.

## Memory

Not measured separately. With decode-once, the retained cost is the decoded string (1 B/char, or 2 B/char once any character is above U+00FF) plus the tree from S2. The caller's bytes can be collected once `parse()` returns, unless they keep a reference.
