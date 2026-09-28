# Research synthesis

The single reference the implementation plan cites instead of the individual reports. Written 2026-09-27 for workerd 1.20260815.1 (V8 15.1.206.7), `compatibility_date` 2026-08-01.

## Reports

| Code | File | Topic |
|---|---|---|
| A | `workerd-v8-runtime.md` | workerd's V8 setup, memory and CPU accounting, native APIs, tooling |
| B | `v8-strings.md` | V8 string internals for a scan-and-slice parser |
| C | `v8-object-array-memory.md` | Object and array layout, allocation, GC |
| D | `v8-hot-loop-optimization.md` | JIT behavior of a hot parsing loop |
| E | `fastest-xml-parsers-survey.md` | Techniques of fast JS and native parsers |
| F | `xml-conformance-checklist.md` | XML 1.0 + Namespaces requirements and their cost |
| G | `xml-security-robustness.md` | Attack classes, CVEs, limit defaults |
| J | `edge-xml-workloads-fixtures.md` | Real workloads, corpora, fixture matrix |
| K | `v8-jit-tiering-workers-production.md` | Tiering, compile billing, flushing, GC in production |
| H2 | `non-ascii-xml-v8-workerd.md` | One-byte vs two-byte strings, bytes input strategies |

Not run: H (replaced by H2) and I (WebAssembly, deferred until a JS baseline and a profile exist).

Verification labels: **src** = checked in V8/workerd source or a spec by the report, **docs** = maintainer documentation, **probe** = verified by us in local workerd, **inf** = reasoned, not verified.

## Verified facts

### JIT and tiering

| # | Fact | From | Verified |
|---|---|---|---|
| 1 | Tier-up budgets scale with bytecode length: Maglev after ~400 invocations' worth, the optimizing tier after ~3000; OSR (100 for Maglev, 500 for the top tier) lets one long call tier up mid-loop. | D, K | src |
| 2 | The production embedder disables `--concurrent-recompilation`, `--concurrent-sparkplug`, `--maglev-build-code-on-background` and related flags, so all JIT compilation runs on the request thread. | K | src (workerd `setup.h` comment) |
| 3 | That compile time is billed as the request's CPU time. | K | inf (consistent with Cloudflare's CPU-time definition) |
| 4 | Bytecode and optimized code are flushed after ~180 s idle or 6 major GCs; there is no JS code cache across isolates or deploys. Cold isolates start in Ignition. | K | src, docs |
| 5 | Consequence: most parses in production run in Ignition or Sparkplug. Native builtins (`indexOf`, `slice`) run at full speed in every tier; hand-written `charCodeAt` loops are only fast after Maglev/Turboshaft. | K | inf from 1–4 |
| 6 | Functions over 60 KB of bytecode never reach the top tier (Maglev has no size gate). Maglev inlines callees up to 100 bytes of bytecode (920 cumulative); the top tier up to 460. | D | src |
| 7 | `charCodeAt` past the end deopts in optimized code; it is not a free NaN sentinel. Keep explicit `i < len` checks. | B, D | src |
| 8 | One function handling both strings and `Uint8Array` pollutes type feedback. Use separate hot functions per input kind. | D | docs + inf |
| 9 | `try/catch` has a zero-cost happy path; keep it outside the inner loop only for bytecode size. | D | docs |
| 10 | A global warm-up at module load can't reach Maglev cheaply, costs every cold start, and risks wrong feedback. No library-side warm-up. | K | docs + inf |

### GC and memory

| # | Fact | From | Verified |
|---|---|---|---|
| 11 | workerd always sets `--noincremental-marking` and atomic CppGC: every major GC is a stop-the-world pause on the request thread, and billed. Parallel scavenges still use helper threads. | A, K | src |
| 12 | Young generation is the Scavenger (~8 MB semi-space with pointer compression). A retained tree is copied twice before promotion unless its allocation site gets pretenured (literal sites, ≥100 created, ≥85% survival). | C | src |
| 13 | Young-generation sizing changed Cloudflare's benchmark results by ~25%: GC is a major, billed cost of allocation-heavy code. | K | docs (Cloudflare blog, Oct 2025) |
| 14 | 128 MB per isolate, shared by concurrent requests, counting JS heap + Wasm. Local (open-source) workerd does not enforce it. | A | docs, src |
| 15 | Local workerd uses pointer compression (4-byte fields). | A, B, C | probe (addresses share their upper 32 bits; consistent, not proof) |

### Strings

| # | Fact | From | Verified |
|---|---|---|---|
| 16 | One character above U+00FF anywhere makes the whole string two-byte (typographic quotes, dashes, €, emoji — common in feeds). Latin-1-only content stays one-byte, because `NewFromTwoByte` downgrades. | B, H2 | src, probe (`uc` prefix in `%DebugPrint`) |
| 17 | workerd `TextDecoder('utf-8')`: pure ASCII takes a simdutf fast path to a one-byte string; anything else goes through ICU to UTF-16, then the downgrade in #16. | A, H2 | src |
| 18 | `slice` of ≥13 chars is a 20-byte SlicedString (zero copy, inherits the parent's encoding, pins the parent). Shorter slices are copied and can downgrade to one-byte. Slices never flatten; reads chase the parent pointer. | B | src |
| 19 | Single-character `indexOf` is libc `memchr`; on two-byte strings it scans twice the bytes. Patterns of ≥7 chars use Boyer-Moore-Horspool. | B, H2 | src |
| 20 | `===` on strings is length check + memcmp without internalization; using a sliced string as a property key forces flatten + copy. `startsWith` is a scalar compare with no allocation. | B | src |
| 21 | The first non-empty `indexOf` flattens a user's ConsString input once; `s + ''` does not flatten. | B | src |
| 22 | `TextDecoder.decode` is a regular C++ binding call per invocation (no V8 Fast API). Libraries switch from hand decoding to `TextDecoder` at 12–64 bytes. | A, H2 | src, 3rd-party |
| 23 | No evidence that `Uint8Array.prototype.indexOf` uses `memchr`. A JS byte loop can't approach `memchr` on long text runs. | H2 | src (absence) + inf |
| 24 | There is no zero-copy way to get a one-byte "binary string" from bytes; the cheapest is chunked `String.fromCharCode.apply` (4k–32k chunks). | H2 | inf |

### Objects and arrays (pointer compression on)

| # | Fact | From | Verified |
|---|---|---|---|
| 25 | Sizes: 3-field object literal 24 B; `[]` 16 B (shared empty backing); array backing 8 B + 4 B per slot; `null` 0 B. | C | src + computed |
| 26 | `push` growth is `old + old/2 + 16`, so a one-child array built by `push` carries ~16 slots. `slice()` allocates exact capacity. `new Array(n)` is holey forever. | C | src, docs |
| 27 | An object literal at one site gets an exact map with no slack tracking; class instances pay slack tracking for the first ~7. | C | src, docs |
| 28 | `Object.create(null)` objects are dictionary mode. | — | probe (`%HasFastProperties` false) |
| 29 | Objects grown with dynamic keys walk map transitions and make the store site megamorphic. | C, D | docs |

### XML, security, workloads

| # | Fact | From | Verified |
|---|---|---|---|
| 30 | Wrong output if skipped: nesting match, duplicate attributes, entity handling, line-ending normalization, attribute-value normalization, BOM strip, unterminated CDATA. | F | spec |
| 31 | The only genuinely expensive conformance items: per-character `Char` validation, namespace resolution, full DTD grammar. | F | inf |
| 32 | XML 1.1 is rare; a 1.0 processor may reject it. | F | spec, docs |
| 33 | xmlconf 20130923 (W3C Software License). Non-validating oracle: `valid` and `invalid` must parse, `not-wf` must throw, `error` either. | F | docs |
| 34 | Expanding only the five predefined entities and numeric references can never grow the output past the input. The remaining risks are node floods, depth, huge attribute counts, prototype pollution and regex backtracking. | G | inf + CVE history |
| 35 | Fastest JS DOM parsers (txml, @rgrove/parse-xml) use `indexOf` jumps + `charCodeAt` dispatch + `slice`; per-character SAX state machines are slowest. | E | src, 3rd-party |
| 36 | Workloads: RSS pretty-printed with CDATA; S3 listings minified with no attributes; SVG attribute-heavy; OOXML deep, prefix-heavy, relies on `xml:space="preserve"`; sitemaps entity-heavy; typical size 10 KB–1 MB. | J | docs + inf |

### Tooling

| # | Fact | From | Verified |
|---|---|---|---|
| 37 | `MINIFLARE_WORKERD_V8_FLAGS` passes V8 flags to local workerd (vitest pool, wrangler dev, Miniflare). An unknown flag is fatal. | A | probe, src |
| 38 | Standalone probes need `new Miniflare(convertV4MiniflareOptions({...}))` with the installed Miniflare 5 alpha. | — | probe |
| 39 | No heap-usage API inside a Worker; use `--trace-gc` locally or DevTools heap snapshots. | A | docs |
| 40 | Production clocks don't advance during compute; the remote metric is tail `cpuTime` (whole ms). The local clock ticks in whole ms. | memory | probe |

## Corrections to the reports

- **C §2** says `Object.create(null)` gets a fast map. Wrong (#28). **E §7** and **G §1.9/§4** recommend it for `attrs`; don't follow that. Use a flat array or `{}` with a `__proto__` guard (decided by spike S2).
- **C §6** and **D §4** say V8 flags can't be used with workerd. Wrong locally (#37); use workerd itself, not d8/Node, for traces.
- **A §4** says non-ASCII UTF-8 always yields two-byte strings. Refined by **H2 §1**: Latin-1-only content downgrades to one-byte (#16).
- **D §5** says slices may flatten on first read. **B** shows they never flatten (#18); B is sourced.
- **A §4** says `TextDecoder('latin1')` always returns two-byte strings. Wrong: a `%DebugPrint` probe shows one-byte results for Latin-1 content under both `latin1` and `utf-8`, as **H2 §1** read from the code (`research/spikes/s3-bytes-input.md`).
- **H2 §5** predicts the hybrid binary string wins on typical RSS (mostly ASCII, a few typographic quotes). Measured: it's 8–217% slower than decoding once in every tier (S3).
- **K** says most production parses run in Ignition/Sparkplug. Only partly: tier-up budgets count loop iterations, so 100 KB documents run optimized code from about the 10th parse per isolate; small documents stay in the low tiers (S1 finding 3).
- **J §3** throughput (1 MB ≈ 12–50 ms CPU) is an estimate from desktop Node numbers. Measure.

## Open items

### Decisions (settled with the user, 2026-09-27)

| ID | Question | Decision |
|---|---|---|
| D1 | API shape and return value | `parse(input, options?)` returns a document wrapper: `doc.root` plus `doc.children` with every top-level node in document order (comments, PIs, root). Internally separate hot functions for string and bytes input (#8). |
| D2 | Error model | `XmlError` with `offset`, `line`, `column`; line and column computed on the error path only. (Adopted from research.) |
| D3 | CDATA, comments, PIs, prolog | Comments and PIs are always kept as nodes. CDATA becomes ordinary text, merged with neighbouring text. XML declaration and DOCTYPE are not in the tree (the wrapper can expose them later). Node shape for comments/PIs goes to S2. |
| D4 | Which well-formedness checks throw | Mismatched tags, duplicate attributes, unknown entities, unterminated CDATA/comments/PIs, text or a second element after the root, bad `<` in attribute values, the other cheap checks in F. |
| D5 | Line-ending and attribute-value normalization | Done as the spec requires. Values without `\r`, tab or newline stay zero-copy. |
| D6 | Entities | Five predefined + numeric references; anything else throws. |
| D7 | DOCTYPE policy | Skipped with a size cap, no entity declarations read. |
| D8 | Namespaces | Prefixes stay raw in v1. |
| D9 | XML 1.1 | Rejected. |
| D10 | Per-character `Char` validation | Off. |
| D11 | Limit defaults | Structural only: depth 256, 200 attributes per element, 1,000-character names; configurable; no default input-size cap. |
| D12 | Bytes path scope for v1 | Decided by S3 under the "fastest wins" rule. |
| D13 | Success definition | Originally: cold, low-tier CPU decides. **Revised 2026-09-28 after S1/S5:** total CPU over the first 100 parses in a fresh isolate decides (`bench:cold` total), because V8 tiers up after ~10 parses of 100 KB input and compile spikes land in that window. Warm CPU and retained heap are reported. Competitors: txml and fast-xml-parser. |
| D14 | Warm-up (from S5) | An explicit `warmup()` export only (~10 parses of a built-in kitchen-sink document). `parse()` does no hidden warm-up. |

### Measurements (Steps 3–4, spikes)

| ID | Question | Spike |
|---|---|---|
| M1 | `indexOf` jumps vs `charCodeAt` state machine vs hybrid, per tier and per encoding | S1 |
| M2 | Two-byte penalty for `indexOf`, `charCodeAt`, `slice`, `===` | S1 |
| M3 | attrs as flat array vs `{}` + guard; children via scratch stack + `slice` vs `push`; folding text-only elements; name interning; pretenuring | S2 |
| M4 | Retained heap per input byte per fixture; major-GC pause for tens of MB | S2 |
| M5 | Bytes: decode-once vs hybrid binary string vs direct `Uint8Array`; `TextDecoder` per-value crossover; `latin1` label check | S3 |
| M6 | Cost of normalization, attribute-value checks, entity decoding, duplicate-attribute check, limit counters | S4 |
| M7 | Tier reached after N parses, main-thread compile cost, bytecode size, deopt sources | S5 |
| M8 | Local ranking holds on Cloudflare hardware (tail `cpuTime`) | Remote run |

### Deferred

- WebAssembly tokenizer (report I): revisit after the performance pass if profiling shows scanning dominates.
- Streaming input, namespace resolution, serialization, bytecode-flush horizon in production.
