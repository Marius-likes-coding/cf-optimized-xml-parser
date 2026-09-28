# M7: performance pass

Run 2026-09-29 on local workerd 1.20260815.1 (V8 15.1), production JIT flags. Decisive metric: total CPU over the first 100 parses in a fresh isolate (D13, `npm run bench:cold`, 10 isolates × 100 parses).

## Where the time goes

A CPU profile of 3,000 warm parses of rss-ascii (`spikes/m7-profile.mjs`, DevTools Profiler over the inspector): 86% `parseString`, 8% the `parse` wrapper (most likely inlined parser code attributed to its caller), 4% `decodeEntities`, **1.5% garbage collection**. V8 15.1 attributes optimized code only to whole functions (no `--no-lazy-source-positions` any more), so the finer analysis below uses ablation.

For 100 KB documents, the warm phase dominates the total: of rss-ascii's ~67 ms, parse #1 is ~2 ms, parses #2–10 ~12 ms and parses #11–100 ~52 ms.

## Experiments (all rejected)

Each variant is identical in output to `src` (`node spikes/m7/equiv.mjs`, 5,427 inputs including mutations).

| variant | idea | total-100 vs src | verdict |
|---|---|---|---|
| `spikes/m7/ascii-names` | ASCII name characters via a 128-entry table, regex only for non-ASCII | svg −12%, ooxml −16%, rss +10%, s3 +10%, others ±2% | mixed, no |
| `spikes/m7/memos` | newline/tab `indexOf` memos instead of a regex search; skip `normalize()` when there's nothing to normalize | −3% to +7% (noise) | no |

## GC and the 8–10 ms spike seen on Cloudflare

- 300 consecutive parses (result kept until the next parse, like a request) with `--trace-gc`: **no major GC at all**; scavenges every ~18 parses at 0.15–0.6 ms, heap back to ~0.9 MB each time. Trees die young; allocation-site pretenuring isn't kicking in.
- The 8–10 ms spike at parse #48 in the S5 remote run lines up with `decodeEntities` reaching the top tier: in the local trace it compiled (8 ms) at overall parse #49. It's a one-time compile per isolate, not GC.

## Against the competitors

Total CPU over the first 100 parses, ms (lower is better):

| fixture | ours | txml | fast-xml-parser | vs txml | vs fast-xml-parser |
|---|---:|---:|---:|---:|---:|
| rss-ascii | **73.4** | 91.7 | 439.3 | 1.25× | 6.0× |
| rss-poison | **70.8** | 85.3 | 406.3 | 1.20× | 5.7× |
| svg | **135.0** | 237.0 | 999.3 | 1.76× | 7.4× |
| soap | **114.7** | 160.9 | 772.9 | 1.40× | 6.7× |
| s3-ascii | **97.8** | 110.7 | 503.6 | 1.13× | 5.2× |
| ooxml-ascii | **95.9** | 198.9 | 936.3 | 2.07× | 9.8× |
| sitemap | **85.5** | 122.8 | 569.7 | 1.44× | 6.7× |
| rss-small | **5.4** | 9.3 | 59.5 | 1.72× | 11.0× |

Retained tree, KB (`npm run bench:memory`; input string not included):

| fixture | ours | txml | fast-xml-parser |
|---|---:|---:|---:|
| rss-ascii | **106** | 218 | 225 |
| rss-poison | **104** | 219 | 229 |
| svg | 331 | 272 | **255** |
| soap | **271** | 401 | 423 |
| s3-ascii | **175** | 425 | 432 |
| ooxml-ascii | **313** | 504 | 425 |
| sitemap | **270** | 529 | 501 |
| rss-small | **3.4** | 7.7 | 9.7 |

txml does less work than we do: it decodes no entities and checks almost nothing. fast-xml-parser runs in `preserveOrder` mode, its closest output to ours.

## Status against the plan's targets

- **Total-100 ≥ 1.5× better than both competitors:** met against fast-xml-parser everywhere (5–11×). Against txml met for svg, ooxml, rss-small, and nearly for sitemap (1.44×) and soap (1.40×). Not met for rss (1.20–1.25×) and the minified S3 listing (1.13×), where txml skips the work that dominates (entity decoding in every ETag, checks per element).
- **Retained tree below both competitors:** met on 7 of 8 fixtures; svg is 22% above txml, because our flat attribute arrays copy each short attribute name while object keys are interned.

## What could still move the numbers (not attempted)

- Sharing attribute-name strings without a general intern table (S2 showed interning costs 10–30% CPU); for example, reusing the previous element's names when the same element name repeats. That targets svg's memory gap.
- A cheaper per-element path for minified, element-dense documents (s3). Most per-element work is checks txml doesn't do.
- `decodeEntities`' one-time optimizing compile (8–10 ms): splitting the numeric-reference branch into its own function might shrink it.
