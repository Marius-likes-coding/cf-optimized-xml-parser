# S1: scanner design

Settles M1 and M2 from `research/SYNTHESIS.md`: how the parser finds tokens, per JIT tier and per string encoding. Run 2026-09-27 on local workerd 1.20260815.1 (V8 15.1), production JIT flags (`scripts/v8-profiles.mjs`).

## Decision

**Variant E**: builtin-driven scanning plus sticky-regex name matching.
- `indexOf` finds text runs, comment/CDATA/PI ends and attribute-value ends.
- One memoized `indexOf("&")` covers every entity check.
- The next `"<"` is searched from the tag's own start, which doubles as the "no `<` inside a tag" check.
- Element and attribute names are skipped with a sticky regex's `test()` (no match array, no allocation) instead of an interpreted `charCodeAt` loop.

It is the fastest or tied in the low tiers and within ~10% of the best variant once optimized. It's also the fastest over the first 100 parses on small documents. A pure `charCodeAt` state machine is ruled out.

## Variants

All five produce identical trees on the 21 matrix fixtures and agree on 7 edge cases and 9 malformed inputs (`node spikes/s1/check.ts`). They share the output shape, entity decoding and error rules; only scanning differs.

| Variant | Scanning | File |
|---|---|---|
| A | `indexOf` for text, markup ends and attribute values; `charCodeAt` loops for names | `spikes/s1/a-indexof.ts` |
| B | `charCodeAt` loops for everything | `spikes/s1/b-charcode.ts` |
| C | A for text and markup; `charCodeAt` loops for everything inside tags | `spikes/s1/c-hybrid.ts` |
| D | A for text and markup; sticky regex `exec` for names and attributes | `spikes/s1/d-regex.ts` |
| E | A, but names via sticky regex `test()` | `spikes/s1/e-regex-names.ts` |

## Results

### Tier-pinned profiles (µs per parse, `npm run bench:tiers -- spikes spikes/s1`)

Round 1 (A–D) ruled out B and C:
- **B** was 2–4× slower than A in Ignition and Sparkplug on every fixture (rss-1mb in Ignition: 160 ms vs 68 ms).
- **C** was the slowest of all on svg in Ignition (45.6 ms vs 19.2 ms), because its interpreted loop walks long `d` attribute values.

Round 2 (A, D, E, txml), selected rows. Cross-profile absolute numbers drift 20–30% between runs on this machine, so compare within a column.

| fixture | variant | Ignition | Sparkplug | Maglev | Full |
|---|---|---:|---:|---:|---:|
| rss-ascii | A | 2,990 | 2,469 | 455 | 459 |
| | D | 2,692 | 2,033 | 561 | 606 |
| | **E** | **2,243** | **1,929** | 479 | 517 |
| | txml | 3,706 | 4,264 | 758 | 873 |
| svg | A | 9,121 | 10,500 | 1,052 | 1,171 |
| | D | **4,250** | **3,763** | 1,875 | 1,733 |
| | **E** | 6,313 | 4,319 | 1,346 | **1,071** |
| | txml | 14,591 | 11,833 | 3,286 | 2,413 |
| soap | A | 6,458 | 4,361 | **985** | **892** |
| | D | **3,800** | **2,855** | 1,796 | 1,210 |
| | **E** | 5,217 | 2,963 | 1,259 | 990 |
| ooxml-ascii | A | 6,841 | 4,708 | 1,033 | 939 |
| | D | **4,652** | 3,614 | 1,530 | 1,243 |
| | **E** | 4,864 | **3,571** | 1,131 | 944 |
| rss-1mb-ascii | A | 31,300 | 35,000 | 10,914 | **5,527** |
| | D | **22,786** | 23,600 | 13,100 | 7,580 |
| | **E** | 23,692 | **17,800** | **8,960** | 6,233 |
| s3-small (2.7 KB) | A | 121 | 92 | **23** | 22 |
| | **E** | **94** | **68** | 29 | 23 |

### Fresh isolates, production flags (`npm run bench:cold`, 10 isolates × 100 parses, interleaved)

| fixture | variant | parse #1 ms | #2–10 ms | #11–100 ms | total ms |
|---|---|---:|---:|---:|---:|
| rss-ascii | A | 2.70 | 2.56 | 0.91 | 107.3 |
| | D | 2.50 | 2.44 | 0.95 | 109.9 |
| | **E** | **2.40** | **2.36** | **0.84** | **99.4** |
| svg | A | 6.70 | 8.49 | **1.07** | **179.3** |
| | D | 6.10 | 4.92 | 2.39 | 265.3 |
| | **E** | **4.80** | **3.81** | 1.60 | 183.0 |
| soap | A | 5.00 | 5.47 | **0.88** | **133.8** |
| | D | 4.70 | 3.64 | 1.63 | 183.8 |
| | **E** | **3.70** | **2.71** | 1.21 | 137.0 |
| ooxml-ascii | A | 7.50 | 8.19 | **1.28** | 196.4 |
| | D | **4.20** | **3.72** | 1.75 | **195.2** |
| | **E** | 5.30 | 7.30 | 1.45 | 201.8 |
| rss-small | A | 1.10 | 0.57 | 0.08 | 13.6 |
| | **E** | **0.80** | **0.36** | **0.06** | **9.4** |
| s3-small | A | 1.10 | 0.42 | 0.06 | 10.1 |
| | **E** | 0.90 | 0.36 | 0.06 | 9.1 |

## Findings

1. **Builtins win in the low tiers, as report K predicted.** Every interpreted per-character loop costs 2–4× in Ignition/Sparkplug. Regex `test()`/`exec` and `indexOf` run as compiled code in every tier.
2. **Regex `exec` hurts once optimized.** D allocates a match array and capture strings per attribute, and the optimized `charCodeAt` loops of A overtake it (svg, full tier: 1.7 ms vs 1.2 ms). E's allocation-free `test()` keeps most of D's low-tier gain without that penalty.
3. **V8 tiers up faster than report K assumed, at least for 100 KB documents.** Tier-up budgets count loop iterations, not calls, so parses #11–100 already run optimized code for 100 KB input. Only small documents (2–4 KB) stay in the low tiers for all 100 parses. Implication for the decision metric (D13): "cold" in production means roughly the first 10 parses per isolate for 100 KB input, and all early parses for small documents. The total-over-100 column is the fairest single number; E leads or ties A there, except svg/soap/ooxml, where A leads by 2–3%.
4. **The two-byte penalty for scanning is small:** rss-poison and rss-cjk run within ~10% of rss-ascii in every tier. `memchr` over twice the bytes is still cheap next to tree building. The penalty that matters is memory (S2/S3).
5. **All our variants beat txml** by 1.5–3× in every tier, even though ours check well-formedness and decode entities. The exception is `entities`, where txml decodes nothing.
6. **Compile time shows up on the request thread.** A's svg parses #2–10 (8.5 ms) are slower than parse #1 (6.7 ms), consistent with Maglev/Turboshaft compiling synchronously under the production flags.

## Follow-ups

- The warm gap between E and A on attribute-heavy documents (svg, soap: E 20–50% slower in parses #11–100) is the target for the performance pass (M7). Option: regex only for element names, `charCodeAt` for attribute names.
- Finding 3 refines D13's premise. It doesn't change this decision, but it's worth confirming with the user before Step 5.
