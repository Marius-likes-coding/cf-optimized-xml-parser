# S4: cost of correctness

Settles M6 from `research/SYNTHESIS.md`: what the conformance level decided in D4–D11 ("spec-correct, cheap checks") costs on top of the S2 winner. Run 2026-09-28 on local workerd 1.20260815.1 (V8 15.1).

## Decision

**Adopt every check as designed.** The strict parser costs about 5–25% extra CPU in the low tiers (up to ~20% on attribute-heavy svg) and 0–10% once optimized, and there's no allocation or memory cost on documents that don't trigger normalization. That's the price of the conformance level the user chose; nothing needs to be dropped or made optional.

## What the strict parser adds (`spikes/s4/strict.ts`)

| Check | Implementation | Cost on documents that don't trigger it |
|---|---|---|
| Line endings (`\r\n`, `\r` → `\n`) in text, CDATA, comments, PI data | memoized `indexOf("\r")`; `replace` only on values that contain one | one failed search per document |
| Attribute-value normalization (tab/newline/CR → space, `\r\n` → one space) | memoized regex search for `[\t\n\r]`; `replace` only on affected values | ~one regex call per tag with attributes in pretty-printed input; free when minified |
| Duplicate attributes | linear `===` scan over the element's earlier attribute names | ~10% on svg in low tiers (6–9 attributes per element) |
| `]]>` in text | memoized `indexOf("]]>")` | one failed search |
| `--` in comments, `--->` | one extra `indexOf` per comment | per comment only |
| PI target named `xml` in any case; declaration only first; grammar; XML 1.1 rejected | once per document (regex on the declaration) | none |
| DOCTYPE only once and before the root; 64 KiB cap | flags + bounded skip | none |
| XML 1.0 name characters | the sticky name regex uses the full NameStartChar/NameChar classes (`u` flag) | none measurable |
| Char references: digits only, range, no surrogates | digit loop instead of `parseInt` | per reference only |
| Limits: depth 256, 200 attributes, 1,000-char names | counters compared at element/attribute boundaries | none measurable |

Correctness (`node spikes/s4/check.ts`):
- Identical to the S2 winner on 20 matrix fixtures; rss-crlf equals its LF version after normalization.
- Normalizes `\r\n` in text, attributes and comments; keeps `&#13;`/`&#10;` literal as the spec requires.
- Rejects 14 malformed inputs and accepts 4 valid edge cases (declaration with encoding/standalone, Unicode names, empty comment, depth exactly 256).

## Results (µs per parse, `npm run bench:ab`, medians of 10 interleaved rounds)

Strict vs lenient (S2 winner), change per tier. The machine was loaded during this run (load average ~6–7, absolute numbers ~2.5× slower than S2's), so single cells carry ±10–15% noise:

| fixture | Ignition | Sparkplug | Maglev | Full |
|---|---:|---:|---:|---:|
| rss-ascii | +12% | +18% | +7% | +56%* |
| rss-poison | +25% | +14% | +21% | +2% |
| rss-crlf | +26% | −3% | −3% | −12% |
| sitemap | +3% | +6% | +5% | −3% |
| s3-ascii | 0% | +17% | +9% | +10% |
| svg | +41% | +27% | +6% | +38%* |
| soap | +11% | +7% | +1% | −9% |
| ooxml-ascii | +10% | −3% | −12% | 0% |
| entities | +11% | +1% | −4% | +10% |
| rss-small | +19% | +21% | +12% | +10% |

\* Outliers inconsistent with neighbouring tiers; a repeat run in the low tiers put strict at +7% (Ignition) and +19% (Sparkplug) on svg.

Ablations (low tiers only, same run): removing the duplicate-attribute check lowered svg's overhead by ~10 points; swapping the Unicode name regex for S1's negated class or removing the attribute-whitespace memo made no measurable difference. The remaining overhead is spread over the extra per-text-node memo checks.

## Follow-ups (M7)

- Duplicate-attribute check: compare lengths or first characters before `===`, or hash only when an element has many attributes.
- Re-measure strict vs lenient on a quiet machine or the remote bench Worker; this run's noise limits precision to ~±10%.
