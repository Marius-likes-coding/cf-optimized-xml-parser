# Implementation plan

Status: draft for review, 2026-09-28. Built on `research/SYNTHESIS.md` (verified facts, decisions D1–D14) and the spike results in `research/spikes/` (S1–S5, including a remote run on Cloudflare).

## Context

`cf-optimized-xml-parser` is meant to be the fastest XML parser for Cloudflare Workers. The research phase settled what "fast" means there:

- V8 compiles on the request thread, and that compile time is billed.
- The optimizing tiers arrive after ~8 (Maglev) and ~10–17 (top tier) parses of a 100 KB document.
- A top-tier compile costs 24–45 ms on Cloudflare's hardware, and a deopt repeats it.
- Most of a parse's cost is building the output tree.

The spikes turned this into a concrete design that is already implemented and measured as throwaway code (`spikes/s5/strict-stacks.ts`). This plan turns it into the library, one reviewable PR per milestone.

### Goals

1. **Lowest total CPU over the first 100 parses in a fresh isolate** (D13, measured with `npm run bench:cold`), then low warm CPU, then low retained memory.
2. Spec-correct output with cheap checks (D4–D10): throws `XmlError` on malformed input, normalizes line endings and attribute whitespace, and expands only the predefined and numeric entities.
3. Safe on untrusted input: iterative parsing, structural limits, no entity expansion beyond the built-ins, no regex with backtracking risk.
4. Web APIs only, zero runtime dependencies, small bundle (the size limit is 30 kB).

### Non-goals (v1)

Streaming input, namespace resolution (prefixes stay raw), DTD validation or internal-entity expansion, XML 1.1, serialization, XPath/querying, a lazy or tape API.

## Decision log

| #      | Decision                                                                                                                                                                                                                                                              | Source            |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| D1     | `parse(input, options?)` returns a document wrapper `{ root, children }`; `children` holds all top-level nodes in order (comments, PIs, root)                                                                                                                         | user              |
| D2     | `XmlError` with `offset`, `line`, `column`; line/column computed only on the error path                                                                                                                                                                               | research          |
| D3     | Comments and PIs are kept as nodes; CDATA becomes text merged with neighbouring text; declaration and DOCTYPE are not in the tree                                                                                                                                     | user              |
| D4–D10 | Spec-correct, cheap checks; five predefined + numeric entities, unknown entity throws; DOCTYPE skipped (64 KiB cap); prefixes raw; XML 1.1 rejected; no per-character validity check                                                                                  | user              |
| D11    | Limits: depth 256, 200 attributes per element, 1,000-character names; configurable; no default input-size cap                                                                                                                                                         | user              |
| D12    | Bytes input: decode once with `TextDecoder`, then parse the string                                                                                                                                                                                                    | S3                |
| D13    | Decisive metric: total CPU over the first 100 parses in a fresh isolate                                                                                                                                                                                               | user, after S1/S5 |
| D14    | Warm-up only through an explicit `warmup()` export                                                                                                                                                                                                                    | user, after S5    |
| —      | Whitespace-only text always dropped (no `xml:space` exception); strings are zero-copy slices; results never outlive the request                                                                                                                                       | user              |
| S1     | Scanner: `indexOf` jumps for text, markup ends and attribute values; memoized searches for `&`, `\r`, `]]>`, `[\t\n\r]`; names via sticky-regex `test()`                                                                                                              | spike             |
| S2     | Nodes are one object-literal shape `{ name, attrs, children }`; `attrs` is a flat `[name, value, …]` array or `null`; `children` collected on a scratch stack and `slice()`d, `null` when empty, **a lone text child stored as the string itself**; no name interning | spike             |
| S4     | All checks from D4–D11 kept (~5–25% cold, 0–10% warm)                                                                                                                                                                                                                 | spike             |
| S5     | Module-level stacks with fixed element kinds; one hot function; a ~10-parse kitchen-sink warm-up removes shape-change deopts (confirmed remotely)                                                                                                                     | spike             |

## Public API

```ts
/** An element. `attrs` is [name, value, name, value, …] in document order. */
export interface XmlElement {
  name: string;
  attrs: string[] | null;
  /** Child nodes and text in order; a single text child is stored as the string itself. */
  children: XmlNode[] | string | null;
}
export interface XmlComment {
  name: "#comment";
  attrs: null;
  children: string;
}
export interface XmlProcessingInstruction {
  name: `?${string}`; // "?" + target
  attrs: null;
  children: string; // data
}
export type XmlNode = XmlElement | XmlComment | XmlProcessingInstruction | string;
export interface XmlDocument {
  root: XmlElement;
  children: XmlNode[]; // top level, in document order
}
export interface ParseOptions {
  maxDepth?: number; // default 256
  maxAttributes?: number; // default 200
  maxNameLength?: number; // default 1000
}
export class XmlError extends Error {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}
export function parse(
  input: string | Uint8Array | ArrayBuffer,
  options?: ParseOptions,
): XmlDocument;
/** Primes V8's type feedback so later documents of other shapes don't deoptimize the parser. */
export function warmup(): void;

// Small helpers, outside the hot path, for the flat/folded shapes:
export function getAttribute(element: XmlElement, name: string): string | undefined;
export function attributes(element: XmlElement): Record<string, string>; // null-prototype
export function childNodes(element: XmlElement): XmlNode[]; // turns a folded string into [string]
export function textContent(node: XmlNode): string;
export function isElement(node: XmlNode): node is XmlElement;
```

Comments and PIs share the element shape (one hidden class). Element names can never start with `#` or `?`, so the name tells the kinds apart.

## Architecture

```
src/
  index.ts          public API: parse(), warmup(), XmlError, helpers, types (re-exports)
  parse-string.ts   the one hot function: parseString(xml, limits) → XmlDocument
  input.ts          parse() dispatch: string → parseString; bytes → decodeInput() → parseString
  decode.ts         byte input: BOM/encoding sniffing, TextDecoder (fatal) per label
  entities.ts       decodeEntities() (called only when the memoized "&" lies inside a value)
  errors.ts         XmlError + fail(message, offset, xml) computing line/column
  warmup.ts         kitchen-sink documents (one-byte and two-byte) + warmup()
  helpers.ts        getAttribute, attributes, childNodes, textContent, isElement
  types.ts          public types
```

Hot-path rules, from S1–S5:

- **One hot function** (`parseString`) holding the scanner, tree building and all checks. Splitting or outlining error construction didn't reduce compile cost (S5 finding 2). Rare paths go to separate functions only when they carry real work: entity decoding, DOCTYPE skipping, the XML declaration.
- **Builtin-driven scanning:** `indexOf` for text runs, `-->`, `]]>`, `?>` and attribute-value ends; memoized positions for `&`, `\r`, `]]>` and `[\t\n\r]` (one failed search per document when absent). Names use a sticky regex with the XML 1.0 NameStartChar/NameChar classes (`u` flag), called with `test()` and read through `lastIndex`, never `exec`.
- **Tree building:**
  - One object literal per node kind, all with the same shape.
  - attrs from a module-level scratch array via `slice(0, n)`; children from a module-level scratch stack via `slice(start, top)`.
  - A lone text child is folded into `children`.
  - Scratch arrays are cleared after each parse so they retain nothing.
- **Stable element kinds:** the open-element and frame stacks are module-level arrays initialized with one element of their final kind (S5 finding 4).
- **Explicit bounds** before every `charCodeAt` in the hot loop (reading past the end deopts, synthesis #7). No `try/catch` in the loop, no closures, no per-node allocations beyond the node, its arrays and its strings.
- **Bytes path:** `decodeInput()` runs once per call:
  1. sniff the BOM (UTF-8, UTF-16LE/BE);
  2. otherwise read `encoding="…"` from the declaration with an ASCII-only scan;
  3. decode with a cached `TextDecoder(label, { fatal: true })`, rejecting labels workerd doesn't support.

  Then `parseString`. A separate function, so string and bytes feedback never mix.

## Milestones

Each milestone is one PR on its own branch with conventional commits; nothing merges without review. The spike code in `spikes/` is the reference for M1–M4; porting means copying its logic into `src/` under the lint rules, not importing it.

### M0: land the measurement setup and research

- Commit the Step 3 tooling that exists uncommitted today:
  - `scripts/bench-{tiers,memory,cold,ab}.mjs`, `scripts/workerd-run.mjs`, `scripts/v8-profiles.mjs`;
  - the matrix fixtures in `src/bench-fixtures.ts` and `scripts/generate-fixtures.mjs`;
  - `bench/harness.ts` (parser parameter + sink), `bench/compare/`, the `compare`/`spikes` vitest projects, the npm scripts, and the new dev dependencies (txml, fast-xml-parser, esbuild).
- Commit `research/` (reports, synthesis, spike notes) and `spikes/` (excluded from lint/format already) as the record the plan refers to. **Review question:** keep `spikes/` in git or drop it after M4?
- CI: run the `workers` bench job with `MINIFLARE_WORKERD_V8_FLAGS` = the production flags (`PROFILES.full`), so local tiering matches production.
- The first real parser (M1) will look like a huge regression against the placeholder `parse()` that throws immediately. Make `scripts/bench-compare.mjs` skip the comparison when the baseline was recorded with the placeholder (for example a `placeholder: true` field written by `bench-save` while `parse` throws).
- Verify: `npm run lint`, `typecheck`, `test`, `bench`, `node spikes/s{1..4}/check.ts`.

### M1: core string parser

- `src/parse-string.ts` from `spikes/s2/fold-text.ts` + the S5 stack fix. Covers: elements, attributes (flat), text (whitespace-only dropped, folded), entities (predefined + numeric with strict digits), CDATA merged into text, comments, PIs, XML declaration position, DOCTYPE skip (64 KiB), single root, text outside the root, `<` inside tags, mismatched/unclosed tags.
- `src/errors.ts` (`XmlError`, `fail()` with line/column), `src/types.ts`, `src/index.ts` (`parse` for strings only), `src/helpers.ts`.
- Tests (`test/unit/parse.test.ts`), each case asserting the exact tree:
  - every node kind; CDATA merging; entity decoding in text and attributes;
  - folded vs array children; top-level comments/PIs in `doc.children`; BOM;
  - one assertion per error class, including `offset`/`line`/`column`.
- Unskip the matching cases in `test/conformance/xml-conformance.test.ts`, with real assertions instead of `toBeDefined()`.
- Bench gate: `bench:ab` of `src` against `spikes/s2/fold-text.ts` on the matrix: no regression beyond noise (±10%). `bench:memory` equal within 1%.

### M2: strictness, normalization, limits

- From `spikes/s4/strict.ts`:
  - line-ending normalization;
  - attribute-value normalization;
  - duplicate attributes, `]]>` in text, `--` in comments, PI targets named `xml` in any case;
  - declaration grammar with XML 1.1 rejected, DOCTYPE placement;
  - XML 1.0 name classes.
- `ParseOptions` limits, validated once per call and passed as locals.
- Tests: the S4 check cases (`spikes/s4/check.ts`) as unit tests, plus each limit at and over its boundary.
- Gate: `bench:ab` vs `spikes/s5/strict-stacks.ts` within noise; total-100 via `bench:cold` recorded.

### M3: bytes input

- `src/decode.ts` + dispatch in `parse()`: `Uint8Array`/`ArrayBuffer`, BOM sniffing, declared encodings, `fatal: true`.
- Measure `fatal: true` against the default on the matrix (open question from report F). Keep it if the cost is within noise; otherwise document the choice.
- Measure `await response.text()` + `parse(string)` against `arrayBuffer()` + `parse(bytes)` for non-ASCII input (S3 finding 5), and put the recommendation in the README.
- Tests: UTF-8 with and without BOM, UTF-16LE/BE with BOM, a declared ISO-8859-1 document, invalid UTF-8 (throws), trees identical to string input on all matrix fixtures.

### M4: warmup()

- `src/warmup.ts`: kitchen-sink documents covering every path, one one-byte and one two-byte; `warmup()` parses them ~10 times in total. The window is narrow: 1 parse records nothing, 30 over-optimize (S5 finding 5).
- Tests: `warmup()` runs, is idempotent, and leaves no retained state.
- Verify with `spikes/s5/trace.mjs` (`--trace-opt --trace-deopt`), rss → poison → svg → cjk sequence: no deopts of `parseString` after `warmup()`. Repeat remotely with `spikes/remote/` (needs the user's OK to deploy).

### M5: security and robustness

- Adversarial unit tests:
  - deep nesting at and over the limit; 10,000 attributes; 5 MB names/values/text;
  - entity floods (`&#65;` × 1M: linear, bounded by input);
  - `__proto__`/`constructor` as element and attribute names, and through `attributes()`;
  - DOCTYPE bombs over 64 KiB; unterminated constructs at end of input.
- Error messages must never embed input slices.
- Fuzzing: a seeded mutation fuzzer over the matrix fixtures (Node, many iterations). The parser must either return a tree or throw `XmlError`, never another error type, a hang, or a stack overflow.
- Timing guard: every adversarial case finishes within a CPU budget in the workers test pool.

### M6: W3C conformance suite

- `scripts/xmlconf.mjs`: download xmlts20130923 into a gitignored cache and verify its checksum. Iterate the leaf catalogs, skipping `VERSION="1.1"`, `EDITION` mismatches and tests that need external entities.
- The oracle for a non-validating parser: `valid`/`invalid` must parse, `not-wf` must throw, `error` either way.
- Run in Node (the parser is pure JS; the suite needs the filesystem). Record the pass rate in `research/conformance.md`, and fix or document every `not-wf` the parser accepts, grouped by rule.
- CI job with a pass-rate floor, raised as fixes land.

### M7: performance pass

Follow-ups collected from the spikes, each judged by total-100 (`bench:cold`) and memory:

- The svg memory gap: share attribute-name strings cheaply (S2).
- A cheaper duplicate-attribute check (S4).
- The 8–10 ms GC spike around parse #48 on Cloudflare: check for pretenured short-lived trees (S5 remote).
- `push` + folding + trimming (S2); a cheaper warm-gap fix for attribute-heavy input (S1).
- CI: a cold/total-100 gate next to the warm `bench-compare` gate, and the remote nightly switched to matrix fixtures plus a fresh-isolate timeline.
- Competitor report on the matrix: CPU (all profiles + total-100) and memory against txml and fast-xml-parser, published in `bench/README.md`.

### M8: documentation and release

- README:
  - API; output shape with examples; helpers; limits;
  - conformance notes: whitespace dropping, `xml:space` ignored, raw prefixes, DOCTYPE skipped, entities;
  - `warmup()` guidance: call at module scope for Workers that parse varied documents;
  - measured numbers and methodology.
- `size-limit`, `attw`, `publint` pass; semantic-release publishes 2.0.0. It's the first real parser, and the current published 1.0.1 is scaffolding.

## Performance targets

Measured on the matrix fixtures (~100 KB each unless named); local numbers with `bench:cold`/`bench:ab`, remote with tail `cpuTime`:

| metric                                              | target                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| total CPU, first 100 parses, fresh isolate          | ≤ the spike parser's (`strict-stacks.ts`) on every fixture; ≥ 1.5× better than txml and fast-xml-parser |
| warm CPU (full tier)                                | ≤ spike + 10%                                                                                           |
| retained tree                                       | ≤ spike + 5%; below both competitors on every fixture after M7 (svg is behind today)                    |
| deopts after `warmup()` across the fixture sequence | 0 (trace)                                                                                               |
| Cloudflare, per-request CPU in a fresh isolate      | cold parse ≤ 5 ms for 100 KB; top-tier compile once per isolate                                         |

**Status after M7 (2026-09-29, `research/spikes/m7-performance.md`):** total-100 is 5–11× better than fast-xml-parser everywhere and 1.13–2.07× better than txml (≥ 1.5× on svg, ooxml and small documents; 1.13–1.44× on rss, s3, soap and sitemap, where txml skips entity decoding and checks). The retained tree is below both competitors on 7 of 8 fixtures (svg +22%). Two further experiments showed no gain; the remaining ideas are listed in that note.

## Risks

- **V8 heuristics change:** the warm-up window (feedback after 8 calls, tier-up budgets) and compile costs depend on V8 internals; production is already on 15.4 while local workerd is 15.1. Mitigation: the M4 trace test and the remote timeline in the M7 nightly.
- **Production differs from open-source workerd:** only partly visible. Mitigation: remote checks for every performance-relevant decision.
- **Measurement noise locally:** 20–50% drift. Mitigation: `bench:ab` interleaving, memory pinned to Ignition, remote confirmation.
- **Ergonomics of flat `attrs` and folded `children`:** mitigated by helpers and README examples. Revisit only if users object; the shape was chosen by measured speed.
- **Two-byte input doubles the input's memory:** inherent to V8 strings (S3).
- **`xml:space="preserve"` content** (OOXML) loses whitespace-only runs: decided and documented.

## Verification (every milestone)

`npm run lint`, `format:check`, `typecheck`, `test`, `build`, `size`, plus that milestone's specific checks and bench gates. Spike equivalence scripts stay runnable until M4, so ported code can be diffed against the reference behavior.
