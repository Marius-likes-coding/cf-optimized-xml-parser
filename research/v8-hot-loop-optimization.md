# V8 14–15 hot-loop optimization for a hand-written XML parser loop

Target: workerd 1.20260815 / V8 15.1 (2026-08-01). All version claims below are for V8 11.8 (Maglev launch, Chrome M117, Dec 2023) through V8 15.x (2025–2026, Turboshaft/Turbolev top tier) unless noted. Older Crankshaft-era (pre-V8 6, pre-2017) advice is flagged as outdated.

Note on `ideas.md` #0-8 excerpt: depth-first single `while` loop with an explicit stack is the right choice for this JIT analysis. It gives V8 one hot loop-backedge for OSR (see §1). Breadth-first / both-ends recursion add extra passes and calls with no JIT benefit. [inference]

## 1. Tier-up: thresholds, budgets, OSR, Maglev vs TurboFan/Turboshaft

### How tier-up is triggered

V8 uses a 4-tier pipeline: Ignition (interpreter) → Sparkplug (baseline) → Maglev (mid-tier) → TurboFan/Turboshaft (top-tier). [docs] https://github.com/v8/v8/blob/main/docs/runtime/tiering.md

Each function has an `interrupt_budget_` in its `FeedbackCell`, decremented on (a) loop back-edges and (b) function returns. When it goes negative, `TieringManager::OnInterruptTick` decides whether to queue background compilation. [source] `src/execution/tiering-manager.cc`, `TieringManager::OnInterruptTick`, `src/maglev/x64/maglev-ir-x64.cc` `GenerateReduceInterruptBudget` — https://github.com/v8/v8/blob/main/docs/runtime/tiering.md

Initial budget formula (current `main`, unchanged since ~V8 10–11): [source] `src/execution/tiering-manager.cc` `InterruptBudgetFor()` + `src/flags/flag-definitions.h`:

```
budget = invocation_count_for_{tier} * bytecode_length
```

| Constant | Default (desktop, non-Android) | Meaning |
|---|---|---|
| `invocation_count_for_maglev` | `400` | calls/iterations-weighted budget before Maglev is queued |
| `invocation_count_for_turbofan` | `3000` | before TurboFan/Turboshaft is queued |
| `invocation_count_for_osr` | `500` | budget scale used once TurboFan OSR is requested |
| `invocation_count_for_maglev_osr` | `100` | budget scale used once Maglev OSR is requested |
| `invocation_count_for_feedback_allocation` | `8` | calls before a feedback vector is even allocated |
| `invocation_count_for_early_optimization` / `..._with_delay` | small (PGO only) | fast-path when `profile_guided_optimization` predicts stability |

[source] https://github.com/v8/v8/blob/main/src/flags/flag-definitions.h (`DEFINE_INT(invocation_count_for_maglev...)`, `..._turbofan`, `..._osr`, `..._maglev_osr`); corroborated in search excerpts for `tiering-manager.cc`.

Because budget scales with `bytecode_length`, a big parse function needs proportionally more back-edge hits to tier up than a tiny one — but each character processed is one back-edge hit, so this cancels out in practice for a character loop. [inference]

### What this means for your two call patterns

* **Once on 5 MB (~5M iterations, one call):** return-budget never fires. Only the loop-back-edge path can save you, via **OSR**. Flow: back-edge exhausts budget → Maglev queued → while still stuck in Ignition/Sparkplug frame, `TryIncrementOsrUrgency()` fires → recompiles *with the loop header as entry point* and frame-reconstructs mid-loop. [docs] https://github.com/v8/v8/blob/main/docs/runtime/tiering.md (“On-Stack Replacement”), [source] `TieringManager::TrySetOsrUrgency` / `TryIncrementOsrUrgency`.
* **Thousands of times on 2 KB (~2k iterations each):** each call is too short to OSR usefully. Tier-up comes from the *return* budget accumulating over ~400 calls (Maglev) then ~3000 calls (TurboFan). First ~400 parses run in Sparkplug, next ~2600 in Maglev, then TurboFan/Turboshaft. [inference from budget formula + docs]

Practical consequence: you must warm *both* paths in benchmarks — one long document to test OSR, and a many-call loop to test steady-state top-tier. Testing only one hides the other's cliff. [inference]

### OSR details that matter

* OSR only kicks in *after* a normal tier-up has already been decided but the function is still in a lower-tier frame (long loop). It does not shortcut warm-up. [source] `tiering-manager.cc` comment “OSR kicks in only once we've previously decided to tier up…”
* Maglev OSR (`IsMaglevOsrEnabled()`) exists in current V8; TurboFan OSR path uses `invocation_count_for_osr * bytecode_length`. There is also an OSR path *from* Maglev to TurboFan, implemented as a deopt with reason `PrepareForOnStackReplacement` / `OSREarlyExit` (these two explicitly do *not* invalidate cached code). [source] `src/deoptimizer/deoptimize-reason.h` `IsDeoptimizationWithoutCodeInvalidation()`, https://github.com/v8/v8/blob/main/src/deoptimizer/deoptimize-reason.h
* OSR-compiled code historically was not cached and caused Benchmark.js variance (±20%); this was fixed — OSR code is now cached. But OSR entry still injects a copy of locals that can confuse type analysis for code before the loop (see §6). [3rd-party] https://issues.chromium.org/issues/42205910, https://mrale.ph/blog/2013/08/14/hidden-classes-vs-jsperf.html

### Maglev vs TurboFan/Turboshaft for this loop

* Compile speed (Chrome 117 M2 Air, Maglev launch post): Maglev ~10× slower than Sparkplug, ~10× faster than TurboFan. Deployed earlier/broader; Speedometer/JetStream data in post. Applies to V8 11.8 (2023); ratio still cited as design goal in 2024–25 Turboshaft docs. [docs] https://v8.dev/blog/maglev
* Sparkplug (V8 9.1, 2021) is a single linear pass over bytecode with no IR, mostly builtin calls + control flow, interpreter-compatible frames making OSR cheap. [docs] https://v8.dev/blog/sparkplug
* Maglev (2023–) builds a single SSA CFG in one forward pass, specializes on feedback (map checks + `LoadField` by offset), does representation selection (Smi vs Float64 vs tagged), linear-scan register allocation with split tagged/untagged stack regions. Deliberately minimal loop opts. [docs] https://v8.dev/blog/maglev
* Turboshaft (+Turbolev frontend, 2024–26) replaces TurboFan's Sea-of-Nodes with an explicit CFG, copying-phase reducers: `MachineOptimizationReducer`, `ValueNumberingReducer`, `TypeInferenceReducer`, `BranchEliminationReducer`, `LoopUnrollingReducer`, plus `LoadElimination` / `MemoryOptimization` / `TypedOptimizations`. Turbolev builds the Turboshaft graph *from the Maglev graph* to reuse its type analysis. [docs] https://chromium.googlesource.com/v8/v8/+/main/docs/compiler/turboshaft/compiler-turboshaft.md, https://chromium.googlesource.com/v8/v8/+/main/docs/compiler/why-cfg.md

For a `while (pos < len) { c = str.charCodeAt(pos); switch... }` loop: expect Maglev to remove dispatch overhead and specialize the shape of your stack/nodes; expect the extra TurboFan/Turboshaft win to come from bounds-check elimination, LICM/loop unrolling, and inlining of tiny helpers — not from “better interpreter.” If your 5 MB parse spends most time in Maglev OSR code before TurboFan finishes background compile, Maglev quality *is* your performance. [inference]

Cloudflare corroboration: Workers (V8) Oct 2025 post reports ~25% benchmark win from letting V8 size its own young generation (prior manual cap caused over-GC) and a 33% `JSON.parse`+reviver win from an upstreamed V8 14.3 patch — i.e., top-tier + GC tuning dominate CPU-heavy JS. [3rd-party/docs] https://blog.cloudflare.com/unpacking-cloudflare-workers-cpu-performance-benchmarks/

## 2. Size limits: one giant function vs helpers

* `max_optimized_bytecode_size = 60 * KB` (61440 bytes of Ignition bytecode). [source] `src/flags/flag-definitions.h` `DEFINE_INT(max_optimized_bytecode_size, 60*KB, ...)`.
* In `TieringManager::ShouldOptimize()`, the size check applies **only to the TurboFan branch**. Maglev branch has no size check (just `maglev_filter` + `!maglev_compilation_failed`). [source] `src/execution/tiering-manager.cc` `ShouldOptimize()`.
  * Consequence: a >60 KB-bytecode parse function still gets Maglev but **never** gets TurboFan/Turboshaft. For peak speed keep the top-level parse function's bytecode under this. A hand-written char loop over 5 MB input is typically a few KB of bytecode — safe — but a giant state machine with hundreds of states inlined into one function can exceed it. Measure with `--print-bytecode` / bytecode-length tooling, not source length. [inference]
* Inlining budgets (TurboFan, `flag-definitions.h`): `max_inlined_bytecode_size = 460`, `max_inlined_bytecode_size_small = 27`, cumulative/absolute caps around it. Helpers ≤27 bytes inline almost free (“small” doesn't consume main budget); ≤460 eligible if hot. [source] https://github.com/v8/v8/blob/main/src/flags/flag-definitions.h
* Inlining budgets (Maglev, `maglev-inlining.cc` / flags): `max_maglev_inlined_bytecode_size = 100`, `max_maglev_inlined_bytecode_size_cumulative = 920`, `max_maglev_inlined_bytecode_size_small_total = 3000` (upped to 460/… under `maglev_as_top_tier`). Maglev stops inlining entirely once the small budget is exhausted. [source] https://github.com/v8/v8/blob/main/src/maglev/maglev-inlining.cc `CanInlineCall()` / `InlineCallSites()`.
  * Consequence: split the parser into a tiny hot loop + cold helpers, but keep *hot* helpers ≤~100 bytecode bytes if you want them inlined in Maglev (early tier), ≤460 for TurboFan. One giant function avoids call overhead but risks the 60 KB ceiling and worse I-cache; many medium helpers risk no-inline + call cost in Maglev. The sweet spot is: one hot loop function + 2–5 tiny hot helpers (advance, emit-text, push/pop element) + cold code elsewhere. Must be measured — see Open Questions. [inference]

No evidence found for an exact “function too big for Maglev” constant — only the TurboFan gate above. [source: absence in `ShouldOptimize()`]

## 3. Code patterns

### `switch (code)` on char codes — jump tables?

* Ignition bytecode: `≥6 Smi-literal cases` with `max-min ≤ 3× case_count` uses a jump table (`bytecode-jump-table`), else if-else chain. Rule mirrors GCC. Applies since ~V8 10–11. [source] commit `9711289 “A jump-table implementation for constant case switch statements”` https://github.com/denoland/v8/commit/9711289d064ba420de310f533913169c37d01b61
* Turboshaft/TurboFan backend: `InstructionSelector::EmitTableSwitch` vs `EmitBinarySearchSwitch`, toggled by `EnableSwitchJumpTable`. [source] `src/compiler/backend/instruction-selector.h` https://github.com/v8/v8/blob/main/src/compiler/backend/instruction-selector.h
* Turboshaft optimizer: `StructuralOptimizationReducer` rewrites an if-else cascade comparing the *same* Word32 var against constants into a `Switch` — but only if `cases > 2` and intermediate blocks contain only pure ops. [source] `src/compiler/turboshaft/structural-optimization-reducer.h`
  * Practical: a dense `case 60: case 62: case 47: ...` (`<`, `>`, `/`, `&`, etc., contiguous ASCII ranges) is the best case for a table. Sparse punctuation checks (`<`, `&`, `\0`, 0xE000…) lower to binary search / branches. No public constant for the Turboshaft table-vs-search density cutoff was found — treat exact threshold as unknown; dense = table, sparse = branches is reliable. [inference + source absence stated]
  * For a 2-value test (`<` vs `&`), plain `if/else` is at least as good as `switch`; the cascade→switch reducer doesn't even fire (needs >2). Don't contort 2-way branches into switches. [inference from reducer threshold]

### Lookup table (`Uint8Array[256]`) vs comparison chains

* No primary-source benchmark found proving “table always wins” in V8 14–15. Mechanics, both verified:
  * `table[code]` on a `Uint8Array` is a typed-array load with `CheckTypedArrayBounds`-style guard; Maglev can coalesce redundant constant-index checks in the same block (`max constant index` rewrite) and fold Smi-size checks on bounds-checked indices. [source] commits `1c19bb4 “[maglev] Eliminate redundant constant array bounds checks”`, `d023f43 “[turbolev] Fold Smi-size checks…”` https://github.com/v8/v8/commit/1c19bb4f18e0c5dd8c59f91be31e407060b8ebc1
  * Comparison chains become branches that Turboshaft can eliminate/combine (`BranchEliminationReducer`) and that predict well when one char (e.g. `<`) dominates.
* Trade-off to benchmark yourself: table = 1 bounds-checked load + dependent load (D-cache pressure, detach/OOB deopt surface) vs branches = 0 loads but mispredict cost on mixed content. For classifying 256 byte values with skewed distribution (mostly “content char”), a small table (256 B, stays in L1) *or* a 2-branch fast path (`if (c===60) … else if (c===38) … else content`) are both defensible; a 64 KB `Uint16Array` table keyed by full char code is worse on cache. [inference]

### Bounds-check elimination (strings and typed arrays)

* `String.prototype.charCodeAt` in optimized code is speculatively bounds-checked: `CheckBounds(index, length)` then masked load; OOB is a deopt (`OutOfBounds`), not a slow path. `charCodeAt` lowers to a dedicated builtin returning `TaggedSigned` (Smi). [source] commit `ee2d85a “[turbofan] Speculate on bounds checks for String#char[Code]At”`, commit `86e2a19 “[turbofan] Lower StringCharCodeAt to a dedicated builtin”`.
* What helps BCE in 2024–26 V8: hoist an explicit `if (pos < len)` / unsigned `pos >>> 0 < len` check before the loop, keep `pos` as Uint32/Int32 loop phi, never let it go negative or exceed 2³¹-1, and avoid re-slicing `length` inside the loop (load `len` once into a local). Maglev's range analysis + `BoundsCheckEliminationProcessor` and Turboshaft's `LoadElimination`/`TypedOptimizations` exploit exactly this shape. [source] Maglev/Turbolev BCE commits above + [docs] Turboshaft pipeline doc.
* Typed-array (`Uint8Array`) data-pointer/base loads: TurboFan historically hoisted them better than Maglev; Turbolev's `LateLoadElimination` now closes much of the gap, but Maglev still duplicates some loads in edge cases (constant typed arrays, RAB/GSAB). If you offer a bytes path, keep the `Uint8Array` and its `length` in locals for the whole parse; don't re-fetch `buf.buffer`/`byteLength` per iteration. [source] v8-reviews discussion “[maglev|turbolev] Constant-folding around TypedArrays loads and stores” (2025).

### Smi arithmetic and overflow checks

* With pointer compression (default 64-bit, V8 8+ / 2020–), Smis carry a 31-bit payload incl. sign; 64-bit Smis are 32-bit payloads. Exceeding it boxes a HeapNumber and deopts `NotASmi`/`Overflow`/`LostPrecision` paths. [docs] https://v8.dev/blog/pointer-compression
* Keep `pos`, `len`, `depth`, char codes as small non-negative ints; use `|0`, `>>>0`, `++` on locals; avoid mixing doubles/objects into the same var (see §4). `charCodeAt` already returns a Smi via `SmiFromWord32` — don't re-tag it. Exact overflow-deopt reason strings: `Overflow`, `LostPrecision`, `LostPrecisionOrNaN`, `NotASmi`, `MinusZero`, `NaN`. [source] `src/deoptimizer/deoptimize-reason.h` https://github.com/v8/v8/blob/main/src/deoptimizer/deoptimize-reason.h
* `String::kMaxLength` (~512 MB / 2³⁰-16 UTF-16 code units depending on build) is the hard ceiling; a 5 MB doc is far below it, but the `CheckBounds` still assumes `length ≤ kMaxInt`. [source] comment in `ee2d85a` diff (`STATIC_ASSERT(String::kMaxLength <= kMaxInt)`).

### Monomorphic locals and shapes

* V8 caches property access per call-site (IC): `MONOMORPHIC` (1 map, fastest) → `POLYMORPHIC` (≤4) → `MEGAMORPHIC` (generic stub/global cache). Optimizers speculate on the monomorphic map. [docs] https://chromium.googlesource.com/v8/v8/+/HEAD/docs/runtime/hidden-classes-and-ics.md, https://v8.dev/blog/fast-properties, https://v8.dev/blog/elements-kinds
* For `{name, attrs, children}` nodes: always create properties **in the same order**, never `delete`, pre-size `children`/`attrs` consistently (packed Smis vs packed elements transitions are one-way). Integer-indexed stores should stay `PACKED_SMI_ELEMENTS` or `PACKED_ELEMENTS`, never holey/dictionary on the hot path. [docs] https://v8.dev/blog/elements-kinds, https://v8.dev/blog/fast-properties
* Slow/dictionary mode (`delete`, sparse huge arrays) disables IC fast paths permanently for that object. [docs] same.

### `try/catch` cost (outdated folklore — now cheap)

* Zero-cost happy path since ~V8 6–7: no bytecodes emitted for entering `try`; ranges recorded in a side `HandlerTable` (Ignition/Sparkplug) or return-address table (Maglev/TurboFan). Entry = no-op. [docs] https://chromium.googlesource.com/v8/v8/+/main/docs/runtime/exception-handling.md
* Rare-throw calls in optimized code may use `LazyDeoptOnThrow` (sentinel `-1`, deopt to interpreter only if thrown). So wrapping the whole `parse()` in one outer `try/catch` for malformed-XML errors is fine in V8 12+. The 2012 advice (“never use try/catch, split into nested function”) is **outdated**. [docs] same + [3rd-party] https://github.com/davidmarkclements/v8-perf (“try/catch problem” resolved in V8 5.8+/6.0, 2017–18).
* Residual costs to still avoid: `try/catch` *inside* the per-character loop bloats bytecode (hurts the 60 KB gate) and forces extra deopt metadata / catch-block phis (`CatchBlockBegin`, tagging of exception phis in Turbolev). Put error throws on cold paths outside the loop. [source] `src/compiler/turboshaft/turbolev-graph-builder.cc` `StartSinglePredecessorExceptionBlock` / `InsertTaggingForPhis`.

### Closures in hot code

* Allocating a closure per element/text node (or per loop iteration) is a real allocation + context cost and blocks inlining/scalar-replacement. Reuse top-level functions; never create callbacks inside the char loop. If you need a helper with state, pass state as args, not via capture. This is long-standing and still true in Maglev/Turboshaft (allocation folding exists but only folds *raw* allocations without intervening GC/observable side effects — fragile to rely on). [3rd-party] https://mrale.ph/blog/2014/02/23/the-black-cat-of-microbenchmarks.html (allocation sinking discussion); [source] Maglev allocation-folding code discussed in CVE-2024-0517 write-up (shows how narrow the folding preconditions are).
* Top-level function declarations that are monomorphic inline well; megamorphic call sites don't. Keep call targets stable (don't swap between string-path and bytes-path closures at the same call site — see §4). [inference from IC docs]

### Labeled loops / `continue`

* No evidence found that `break label` / `continue label` / labeled `while` carries a penalty vs unlabeled equivalents in Maglev/Turboshaft — both lower to the same CFG gotos/branches. Prefer whatever minimizes bytecode size and branch count. If you find a difference, it's a codegen accident worth a microbenchmark, not a documented rule. [inference + absence stated]

### Returning several values from a helper without allocating

* Returning `[a,b]` / `{a,b}` per call allocates on the hot path. Escape analysis / allocation sinking *can* remove non-escaping aggregates (known since Crankshaft; still present), but it fails if the object escapes through a deopt, a call, or a megamorphic store — common in parser error paths. Don't rely on it. [3rd-party] https://mrale.ph/blog/2013/08/14/hidden-classes-vs-jsperf.html, https://github.com/davidmarkclements/v8-perf
* Robust patterns (all still valid in V8 15): (1) out-param object reused across calls (monomorphic, pre-initialized); (2) module-scoped scratch vars for single-threaded Workers (no reentrancy — document it); (3) pack two small ints into one Smi (`(pos<<1)|state`, decode with `>>1`/`&1` — stays Smi, no box); (4) split into two monomorphic getters or duplicate the helper per call-site so each returns one value. Choice depends on whether the helper is inlined (then (1)–(4) all fold anyway). Benchmark inlined vs non-inlined sizes. [inference]

## 4. Deoptimization causes and detection

### The three parser-relevant deopt families

1. **Out-of-bounds reads.** Any `charCodeAt(i)` / `buf[i]` with `i ≥ length` (or negative, or non-Smi) deopts `OutOfBounds` (TurboFan/Turboshaft speculate bounds away; Maglev guards too). A single OOB near EOF poisons the rest of the 5 MB parse if it invalidates the optimized code (`code->set_marked_for_deoptimization`, lazy deopt at next safepoint). Always guard the loop with an upfront length check and handle the tail separately; never “peek past end and catch.” Reason list includes `OutOfBounds`, `ArrayBufferWasDetached`, `ArrayLengthChanged`, `Hole`. [source] `src/deoptimizer/deoptimize-reason.h`, [docs] https://github.com/v8/v8/blob/main/docs/runtime/deoptimization.md (eager vs lazy deopt).
2. **Type-feedback pollution: one function handling both `string` and `Uint8Array`.** ICs and representation selection learn per call-site. A `parse(input)` that sees both one-byte strings, two-byte strings, *and* typed arrays at the same loads/branches goes polymorphic → megamorphic (`UnknownMapInPolymorphicAccess`, `InsufficientTypeFeedbackForGeneric*`, `NotASmi`/`NotAString` flip-flops) and either never promotes to top tier or deopt-loops. **Use separate functions — or separate generated copies — for the string path and the bytes path.** Cloned functions via a factory share `SharedFunctionInfo` but get separate `FeedbackVector`s per closure in some paths; to be safe, write two textually distinct functions (`parseString`, `parseBytes`) sharing only cold helpers, so feedback can't mix. Same rule applies to `attrs` as object vs array, `children` element kinds. [docs] IC states doc + [source] deopt reasons. This is the single most important structural decision in this section. [inference for “textually distinct is safest”; pollution mechanics are sourced]
3. **Megamorphic stores with dynamic keys.** `node[key] = value` where `key` varies over many strings (attribute names, tag names as keys) becomes `MEGAMORPHIC`/`GENERIC` keyed store, falls back to stub cache/dictionary, and blocks store elimination. Keep hot-path stores monomorphic: fixed-shape nodes, `attrs` as parallel arrays or a fresh object built with constant keys in fixed order, tag-name-indexed caches keyed by Smi IDs (intern table) rather than arbitrary strings. Reasons to watch: `KeyedAccessChanged`, `StoreToConstant`, `InsufficientTypeFeedbackForGenericKeyedAccess`. [docs] hidden-classes/ICs doc + stub-cache section; [source] deopt reasons.

Also watch: `StringTooLarge` (building huge text by `+=` in a loop creates ConsString trees that flatten late — prefer push-to-array + `join`, or slice ranges and join once), `Overflow`/`LostPrecision` (pos arithmetic), `WrongCallTarget` (swapping helpers), `UnoptimizedCatch` (first throw through optimized code forces lazy deopt). [source] deopt reasons list.

### How to detect (and why workerd makes it awkward)

* Local (Node/d8 with matching V8, **not** workerd): `--trace-deopt --trace-opt --trace-turbo-inlining --trace-ic --log-deopt`, plus `--allow-natives-syntax` with `%OptimizeFunctionOnNextCall(f)`, `%GetOptimizationStatus(f)`, `%DeoptimizeNow()`. `TraceDeoptBegin` prints `[bailout (kind: ..., reason: ...)]`. Deopt Explorer VSCode extension visualizes `--log-deopt`. [source] `src/deoptimizer/deoptimizer.cc` `TraceDeoptBegin`/`TraceMarkForDeoptimization`; [3rd-party] https://github.com/microsoft/deoptexplorer-vscode
* workerd does **not** expose V8 flags or natives syntax to Workers (Web APIs only, no `Buffer`, no `eval`/`new Function` per project constraints). So: reproduce tier/deopt questions in `d8`/Node pinned to V8 15.1, then validate wall/CPU time in workerd with `wrangler dev` / `workerd` + `performance.now()` deltas. Never assume a flag-observed behavior transfers without a workerd timing check — inlining/GC heuristics differ under isolate memory caps (128 MB) and Cloudflare's young-space tuning (see §1 Cloudflare post). [inference + docs] https://developers.cloudflare.com/workers/ (isolate/memory/CPU limits).

## 5. Folklore: dead vs still alive (V8 12+)

| Claim | Verdict for V8 14–15 |
|---|---|
| “`try/catch` blocks optimization” / “calling inside `try` is slow” | **Dead.** Zero-cost tables + lazy-deopt-on-throw; only keep it out of the innermost loop for size reasons. (2012 `web.dev/articles/speed-v8` advice explicitly superseded.) [docs] exception-handling doc |
| “`delete obj.k` is always slow” | **Mostly alive, one nuance dead.** Non-last-key `delete` → dictionary mode, kills ICs. Deleting the *most recently added* property has a fast path since V8 6.0/6.1 — but don't rely on it on hot nodes; use `= undefined` or rebuild. [3rd-party] https://github.com/davidmarkclements/v8-perf (`delete` section, incl. Kummerow correction) |
| “Hidden classes / init fields in constructor order” | **Alive.** Same-order creation → shared maps → monomorphic ICs → inlineable loads. Out-of-order/conditional props → polymorphic/megamorphic → deopt. [docs] fast-properties, hidden-classes docs |
| “Monomorphic > polymorphic > megamorphic; >4 shapes = cliff” | **Alive.** Threshold ~4 maps before megamorphic stub. [docs] IC states doc |
| “Avoid sparse/holey arrays, don't `delete arr[i]`” | **Alive.** Holey + dictionary elements add prototype-chain checks and kill elements-kind specialization. [docs] https://v8.dev/blog/elements-kinds |
| “Smi vs HeapNumber, 31-bit Smis” | **Alive** (with pointer-compression update: 31-bit payload on 64-bit). [docs] https://v8.dev/blog/pointer-compression |
| “`arguments` leaks / rest-args are slow” | **Mostly alive.** Leaking `arguments` (aliasing, non-analyzable use) still inhibits optimization; plain rest `...args` on non-hot paths is fine. No new evidence it became free — keep `arguments` out of the char loop. [inference; no contrary source found] |
| “Micro-optimizations like `++i` vs `i++`, `\|0` hints” | **Dead as style rules.** The compilers do representation selection and range analysis themselves; write the checkable shape (unsigned compare, hoisted length) instead of syntactic tricks. [inference from Maglev representation-selection + BCE docs] |
| “`substr`/`slice` copies; avoid slicing” | **Updated.** `slice`/`substring`/`trim` with length ≥13 produce `SlicedString` (parent pointer + offset + length, no copy, never nested — double-slice flattens to original parent). But the parent stays alive (memory!) and first *read* may flatten/copy. So zero-copy slices are real and match your “strings are slices” decision — but holding many tiny slices of a 5 MB input pins the whole 5 MB. If memory (128 MB isolate) matters more than CPU, copy small hot strings; if CPU matters, slice. `kMinLength = 13` is the threshold. [source] `src/objects/string.h` (`SlicedString::kMinLength = 13`, “cannot be nested”, “keeps parent alive”), `src/objects/string.cc` `Flatten`/`WriteToFlat`, [docs] https://chromium.googlesource.com/v8/v8/+/main/docs/objects/strings.md |

## 6. Benchmarking pitfalls with a JIT (and how to avoid them)

All of these have bitten real V8 benchmarks; all apply to your 5 MB-once vs 2 KB-many-times matrix.

1. **Warm-up / tier skew.** First N runs are Sparkplug/Maglev, later runs TurboFan. Reporting the mean over cold+hot mixes tiers. *Fix:* discard warm-up (hundreds of 2 KB calls; at least 1–2 full 5 MB passes to allow OSR + background compile), then measure steady state; also report cold (1st-parse) separately since Workers often parse once per isolate. [3rd-party] Maglev post (compile-speed ratios), tiering doc; Cloudflare post on warm isolates.
2. **Dead-code elimination.** A parse whose result is never used gets sunk/eliminated (allocation sinking, store-to-load forwarding can empty a loop). Classic failure: benchmarking `parse(x)` without consuming `tree` measures an empty loop. *Fix:* checksum the tree (e.g. count nodes + hash tag names/lengths), print/return it, and assert it. [3rd-party] https://mrale.ph/blog/2014/02/23/the-black-cat-of-microbenchmarks.html
3. **OSR skew.** Functions that only ever optimize via OSR historically showed huge variance (±20% in Benchmark.js); OSR entry copies also hide pre-loop constants from LICM (the `parseInt` vs `+x` jsPerf case measured OSR artifacts, not operator speed). *Fix:* separate “loop-only” microbenchmarks from full `parse()` benchmarks; ensure setup code isn't textually inlined into the timed loop (Benchmark.js inlines `setup` + test into one function — don't copy that pattern blindly). [3rd-party] Chromium issue 42205910; https://stackoverflow.com/questions/28457585/jsperf-parseint-vs-plus-conversion (mrale.ph analysis); https://mrale.ph/blog/2013/08/14/hidden-classes-vs-jsperf.html
4. **GC noise.** Young-space Scavenge is cheap; old-space promotion + Mark-Sweep-Compact is not. A parser that retains the input + tree promotes quickly; Cloudflare's own tuning post shows GC config alone moved scores 25%. *Fix:* force GC between samples where available (`--expose-gc` locally), report median/p95 over many runs, keep heap small between iterations, test at 128 MB cap in workerd. [3rd-party/docs] Cloudflare CPU post.
5. **Different inlining in benchmark vs real use.** A helper that inlines in a monomorphic microbenchmark (≤100/460-byte budget, one call-site) may not inline in the real parser (many call-sites, bigger caller, budget exhausted → `could_not_inline_all_candidates`). *Fix:* trace inlining (`--trace-turbo-inlining`, `--trace-maglev-inlining`) in the *real* call graph, pin bytecode sizes of hot helpers (see §2 budgets), and re-measure after every structural change. [source] `maglev-inlining.cc` budget-exhausted paths.
6. **Feedback pollution from the harness.** Reusing one `parse` across string *and* bytes samples in the same process pollutes its feedback vector (see §4). *Fix:* separate processes / fresh isolates per input kind, or at minimum separate functions per kind; randomize input order and check `--trace-ic` for unexpected polymorphism. [inference from IC docs + jsPerf pollution analysis]
7. **Clock and billing confusion.** `performance.now()` in workerd measures wall time, not billed CPU time; isolate contention/warmth (Cloudflare's routing heuristics) adds wait time that isn't billed but *is* measured. *Fix:* in workerd, use CPU-time metrics where exposed, run isolated single-request samples for CPU claims, and treat latency benchmarks as separate from CPU benchmarks. [docs/3rd-party] Cloudflare CPU post (wait vs CPU time).

Minimal harness shape: warm up → GC → time N steady iterations consuming a checksum → report median + p95 + cold-first-parse separately, per input kind (string vs bytes), per size (2 KB vs 5 MB). Never `eval`/`new Function` the harness (banned in workerd anyway). [inference]

---

## Actionable rules for the parser

* One hot `while` loop per input kind; two textually separate entry points: `parseString(str)` and `parseBytes(u8)`. No shared polymorphic hot function.
* Hoist `len` into a local; loop as `while (pos < len)` with `pos` a Smi/Uint32 phi; handle EOF tail outside the loop so OOB never executes speculatively.
* Dispatch on `<` (60) / `&` (38) with plain `if/else` (2-way); use `switch` only for ≥3 dense char classes where Ignition jump-table (`≥6 cases, range ≤3×count`) and Turboshaft `Switch` lowering apply.
* Benchmark `Uint8Array[256]` class table vs 2-branch fast path on your corpus — no default winner; keep any table ≤256 entries, in a local, length-hoisted.
* Build `{name, attrs, children}` in identical property order; `children`/`attrs` always same elements-kind (pre-size or push-only, never holes); never `delete`; interning tag/attr names to Smi IDs for keyed access.
* Keep hot helpers ≤~100 bytecode bytes (Maglev inline) and the whole hot caller well under 60 KB bytecode (TurboFan gate); cold error paths out of the loop.
* One outer `try/catch` around `parse*`, never inside the char loop; throw on cold paths only.
* No closures/allocations per character or per node on the hot path; reuse out-param/scratch or pack ints into one Smi for multi-value helper returns.
* Prefer `slice()` zero-copy text (≥13 chars → `SlicedString`, pins parent — intended) but copy or drop the input reference if peak memory near 128 MB matters more than CPU.
* No `eval`/`new Function`; WASM only as precompiled module (already constrained) — the above is all plain-JS optimizable.

## Open questions that need a benchmark (in workerd + pinned-V8 d8/Node)

* Dense `switch` vs `if`-chain vs `Uint8Array` table for the content/tag/attribute dispatch, on ASCII-heavy vs entity-heavy vs CJK 2-byte-string inputs.
* String path (`charCodeAt` loop + `slice`) vs bytes path (`Uint8Array` + `TextDecoder` once per text node vs manual UTF-8 decode) for 2 KB × N vs 5 MB × 1, CPU and peak memory.
* One giant parse function vs loop + 2–5 tiny helpers: steady-state ns/byte, bytecode sizes vs 100/460/60 KB budgets, `--trace-*-inlining` hit rates.
* Out-param vs scratch-var vs Smi-packing for helper multi-returns under inlined and non-inlined outcomes.
* `SlicedString` pinning cost: holding N slices of 5 MB input vs copying text nodes — CPU vs 128 MB peak.
* Cold-first-parse (Sparkplug/Maglev OSR) vs hot-parse (Turboshaft) latency split per input size; OSR vs invocation-count tier-up behavior reproduced locally then confirmed in workerd CPU time.
* GC behavior at 128 MB: median/p95 with forced-GC locally vs workerd without flag access; young-space promotion rate for node-heavy vs text-heavy docs.
* Exact Turboshaft table-vs-binary-search cutoff for your `switch` shape (`--print-code`/`turbolizer` comparison) — undocumented, must read generated code.
