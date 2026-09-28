# S2: tree building

Settles M3 and M4 from `research/SYNTHESIS.md`: the output's shape details and how the tree is built, measured by CPU per tier and by retained heap. Run 2026-09-27 on local workerd 1.20260815.1 (V8 15.1). All variants start from S1's winner (variant E) and change one factor, plus two combinations. Trees are identical after normalizing the shape (`node spikes/s2/check.ts`).

## Decision

- **Nodes:** one object literal shape `{ name, attrs, children }` for elements, comments (`name: "#comment"`) and PIs (`name: "?target"`), so every node shares one hidden class. A class constructor brings nothing (same memory, 0–21% slower).
- **attrs:** a flat `[name, value, name, value, …]` array, or `null` when there are none. An object is 13–36% smaller on attribute-heavy input but up to 50% slower once optimized (svg, full tier).
- **children:** collected on a shared scratch stack and copied out with `slice()` at the end tag, `null` when empty. **An element whose only child is text stores that string directly** (`children: "text"`): 14–24% less memory on text-heavy input and 2–17% faster once optimized, neutral cold.
- **No name interning in the hot path.** It saves 17–28% memory but costs 10–31% CPU in every tier; speed comes first. Revisit a cheaper scheme in the performance pass (M7).
- **No per-node `push`.** Cold CPU is neutral, and it is ~4% faster warm than fold-text, but it retains 5–24% more memory (V8 grows arrays to ≥17 slots). With cold CPU tied and warm CPU within noise, memory (priority 2) decides.

## Memory (retained tree, KB; `npm run bench:memory`, deterministic ±0.4 KB)

| fixture | base | attrs-object | children-push | **fold-text** | intern | class-node | fold+intern | fold+intern+object |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| rss-ascii (114 KB) | 132.9 | −3% | +5% | **104.1 (−22%)** | −20% | 0% | 77.6 (−42%) | 77.2 (−42%) |
| sitemap (106 KB) | 335.3 | 0% | +11% | **269.7 (−20%)** | −17% | 0% | | |
| s3-ascii (101 KB) | 230.2 | 0% | +10% | **175.4 (−24%)** | −20% | 0% | 130.0 (−44%) | 130.1 (−43%) |
| svg (135 KB) | 337.7 | −36% | +5% | **330.8 (−2%)** | −28% | 0% | 236.7 (−30%) | 196.9 (−42%) |
| soap (107 KB) | 314.8 | −15% | +8% | **270.9 (−14%)** | −25% | 0% | 191.1 (−39%) | 182.1 (−42%) |
| ooxml-ascii (87 KB) | 329.8 | −13% | +24% | **313.4 (−5%)** | −25% | 0% | 231.2 (−30%) | 223.6 (−32%) |

The input string itself costs 1.00 B/char (one-byte) or 2.00 B/char (two-byte) and doesn't depend on the variant; the tree size doesn't depend on the input's encoding (rss-poison = rss-ascii ±0.3 KB).

Competitors on the same fixtures (tree KB): the chosen design (fold-text) against txml and fast-xml-parser (preserveOrder):

| fixture | ours | txml | fast-xml-parser |
|---|---:|---:|---:|
| rss-ascii | **104** | 218 | 225 |
| sitemap | **270** | 529 | 501 |
| s3-ascii | **175** | 425 | 432 |
| svg | 331 | 272 | **255** |
| soap | **271** | 401 | 423 |
| ooxml-ascii | **313** | 504 | 425 |

svg is the one fixture where competitors retain less: their attribute objects share interned keys, while our flat arrays copy each short attribute name (V8 copies slices under 13 chars).

## CPU (µs per parse, `npm run bench:ab`: median of 10 rounds of interleaved ~30 ms bursts)

Change against base, per tier (Ignition / Sparkplug / Maglev / full):

| variant | rss-ascii | s3-ascii | svg | soap | ooxml-ascii | rss-small |
|---|---|---|---|---|---|---|
| base (µs) | 1853 / 2094 / 375 / 417 | 3000 / 3000 / 594 / 607 | 7167 / 3333 / 1100 / 846 | 4375 / 2423 / 796 / 682 | 4286 / 2654 / 824 / 775 | 72.6 / 44.3 / 12.1 / 11.3 |
| attrs-object | −3 / −7 / −3 / −8% | −7 / +11 / +2 / +3% | +7 / +7 / +25 / **+50%** | −7 / +13 / +15 / +15% | −3 / +3 / +10 / +12% | −1 / 0 / +5 / +5% |
| children-push | +8 / −2 / −14 / −20% | +1 / −3 / −8 / −13% | +5 / −2 / +6 / −3% | −5 / +7 / −11 / −8% | −3 / +7 / −5 / −9% | 0 / +4 / −6 / −12% |
| **fold-text** | −5 / −11 / −8 / −17% | −4 / +3 / −5 / −6% | −5 / +1 / +4 / −2% | −3 / +2 / −8 / −10% | −1 / +11 / −2 / −2% | +1 / +22 / −5 / −11% |
| intern | +10 / +3 / +11 / +5% | +12 / +17 / +12 / +15% | **+26 / +31** / +21 / +22% | +19 / +24 / +15 / +19% | +21 / +26 / +17 / +19% | +13 / +31 / +13 / +8% |
| class-node | +5 / 0 / +1 / 0% | +9 / +21 / +2 / −4% | +2 / +5 / +6 / −2% | +3 / +8 / +2 / −3% | +11 / +9 / +2 / +11% | +9 / +7 / +5 / −2% |

Remaining noise is about ±5–10% per cell; single cells (fold-text rss-small Sparkplug +22%) are inside it, the row patterns are not.

## Findings

1. **Interning trades CPU for memory at a bad rate.** A hash + table lookup + `startsWith` per name costs more than V8's own copy of a short slice, in every tier.
2. **Object attrs are fast to build cold but slow once optimized** (dynamic keys make the store site megamorphic, report C/D), and their memory advantage comes from V8 interning property keys.
3. **Scratch + `slice()` gives exact-size arrays;** `push` leaves 16+ slots of slack per array. Measured cost: up to +24% memory on deep documents.
4. **Tooling:** CPU differences below ~20% are invisible in sequential vitest runs on this machine (drift of 20–50% between minutes). Use `npm run bench:ab` (interleaved bursts, medians) for design comparisons; memory measurement must pin the tier (optimized code is heap-allocated and otherwise lands in the measurement).

## Follow-ups for the performance pass (M7)

- Share attribute-name strings more cheaply than a general intern table (e.g. remember the previous element's attribute names per element name) to close the svg memory gap.
- Try `push` combined with text folding and a close-time trim if slack can be avoided cheaply.
