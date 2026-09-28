# W3C XML Conformance Test Suite results

Milestone M6. Suite: xmlts20130923 (the latest), run with `npm run conformance` (`scripts/xmlconf.mjs`) on 2026-09-29. Every test document is parsed from bytes, so encoding detection is exercised too. The per-failure list is written to `bench/results/xmlconf.json`.

Oracle for a non-validating parser (XML 1.0 §5.1): `valid` and `invalid` documents must parse (validity is only checked by validating parsers), `not-wf` documents must throw, `error` may do either.

## Result

**1,263 of 1,736 applicable tests pass (72.8%). Every one of the 473 failures traces to a documented scope decision; none is unexplained.**

| type | pass | fail |
|---|---:|---:|
| valid | 565 | 36 |
| invalid | 169 | 6 |
| not-wf | 520 | 431 |
| error | 9 | 0 |

576 tests are skipped: XML 1.1 and Namespaces 1.1 tests (D9), tests for editions before the 5th, and tests that need external entities (`ENTITIES` other than `none`), which this parser never reads.

## Failures by cause

| cause | decision | tests |
|---|---|---:|
| The DTD's internal subset is skipped, not checked: malformed ELEMENT/ATTLIST/ENTITY/NOTATION declarations, parameter entities, conditional sections are accepted | D7 | 335 not-wf |
| Entities declared in the internal subset aren't expanded, so documents that use them are rejected with "unknown entity" | D7 | 42 valid/invalid |
| The Char production (§2.2) isn't checked: C0 controls, U+FFFE/U+FFFF and lone surrogates pass through | D10 | 74 not-wf |
| Namespace constraints aren't enforced; prefixes stay raw | D8 | 22 not-wf |

## Fixed while running the suite

- A DOCTYPE without a name (`<!DOCTYPE SYSTEM "x.dtd">`) or with a malformed external id was accepted. The DOCTYPE's head is now checked against §2.8 [28] (Name, then optional `SYSTEM` or `PUBLIC` id with PubidChar characters) with one regex per document. This also fixed 15 tests from the DTD bucket.
- A UTF-16 byte order mark followed by a declaration naming another encoding was accepted; it's now an error, like a contradicting UTF-8 byte order mark.
- `version="1.7"` was rejected. XML 1.0 (5th ed.) §2.8 lets a 1.0 processor treat any `1.x` as 1.0. Only `1.1` is refused now (D9).

## What revisiting a decision would cost

- **D10 (Char production):** measured as one regex pass over the whole document before parsing (`spikes/m6/chars.ts`, `bench:ab`). ASCII documents: 0–5%. Two-byte documents (CJK): +44% in Sparkplug and +205% fully optimized, because the lone-surrogate check runs on every character. Not worth enabling by default; an opt-in could be added later.
- **D7 (internal entities):** parsing `<!ENTITY name "value">` declarations from the internal subset and expanding them (with output caps against expansion attacks) would fix the 42 valid/invalid failures. Checking the rest of the internal subset's grammar would address the 335 not-wf tests, at the cost of a DTD parser.
- **D8 (namespaces):** would need a prefix-binding stack per element and URI comparison for attribute uniqueness.
