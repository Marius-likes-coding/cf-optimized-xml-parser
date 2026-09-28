# V8 JIT tiering & compilation in Cloudflare Workers production (V8 15.1 / workerd ~2026)

> Scope: CPU-heavy library, one large parsing function, ~5–20 KB bytecode, eager DOM-style output, zero-copy slices. All version claims are for V8 12–15 (2023–2026) unless noted. Pre-2023 TurboFan-only advice is flagged where outdated.

## 1. Do Sparkplug/Maglev/Turboshaft compile on the request main thread, and is it billed?

**Confirm: yes for compilation, with one nuance (GC still uses background threads).**

- [source] `src/workerd/jsg/setup.h` (`IsolateBase::codeMap` comment, current `main`) says:
  > "Our internal embedder disables all of the above" for `--concurrent_recompilation`, `--concurrent_sparkplug`, `--maglev_build_code_on_background`, `--maglev_deopt_data_on_background`, `--lazy_compile_dispatcher`, `--parallel_compile_tasks_for_eager_toplevel`, `--parallel_compile_tasks_for_lazy`, `--stress_concurrent_inlining`.
  > Reason given: `getJsStackTrace()` reads `codeMap` from a signal handler, which cannot lock a mutex, so concurrent JIT code events would race.
  https://github.com/cloudflare/workerd/blob/main/src/workerd/jsg/setup.h
- [source] That is OSS workerd, not a separate "production" branch. No public evidence of a different production flag set was found. `V8System::init` in `src/workerd/jsg/setup.c++` applies caller `flags` + hardcoded `--noincremental-marking` + `--js-source-phase-imports` (+ `--single-threaded-gc` only on macOS arm64). Production adds limit-enforcer values via `IsolateLimitEnforcer::getCreateParams()` / `customizeIsolate()`, but I found no published production `--v8-flags` list. Treat "production = OSS flags + undisclosed limits/tuning" as [inference].
- [source] Mechanism when those flags are off (so why compile becomes synchronous):
  - `OptimizingCompileDispatcher::EnsureStarted` only posts background `CompileTask` if `v8_flags.concurrent_recompilation || concurrent_builtin_generation`: https://github.com/nodejs/node/blob/main/deps/v8/src/compiler-dispatcher/optimizing-compile-dispatcher.cc
  - `BaselineBatchCompiler::concurrent()` returns `v8_flags.concurrent_sparkplug && !UseEfficiencyModeForTiering()`: https://chromium.googlesource.com/v8/v8/+/main/src/baseline/baseline-batch-compiler.cc
  - `MaglevCompiler::Compile` / `GenerateCode` paths check `maglev_build_code_on_background` / `maglev_deopt_data_on_background` in `src/flags/flag-definitions.h`: https://github.com/v8/v8/blob/main/src/flags/flag-definitions.h
  - V8 tiering doc still describes the default as "queues the function for concurrent compilation in the background": https://chromium.googlesource.com/v8/v8/+/main/docs/runtime/tiering.md — that sentence does **not** apply to the workerd configuration above.
- [source] Background threads still exist. `V8System` builds `defaultPlatform(0)` (autodetect) wrapped by `V8PlatformWrapper`, whose `CreateJobImpl` forwards to the inner platform: `src/workerd/jsg/setup.c++`, `src/workerd/jsg/v8-platform-wrapper.h`. So V8 GC jobs (parallel scavenge, parallel mark-compact phases, concurrent sweeping) can still use the pool; only the JIT-compile jobs listed above are disabled.
- [docs] + [inference] on billing: Cloudflare defines CPU time as "how long the CPU spends executing your Worker code; waiting on `fetch`/KV/DB does not count": https://developers.cloudflare.com/workers/platform/limits/. JIT compile happens while holding the isolate lock inside `LimitEnforcer::enterJs` (`src/workerd/io/limit-enforcer.h`), i.e. it blocks the request and looks like execution. Cloudflare has never published "JIT compile is billed," but the Oct 2025 CPU post distinguishes the two cases explicitly: queueing behind another request's CPU work "is not billed as CPU time against the waiting request," while the actor's own execution is: https://blog.cloudflare.com/unpacking-cloudflare-workers-cpu-performance-benchmarks/. Inference: your own parser's Sparkplug/Maglev/Turboshaft compile is billed to that request; time you spend waiting for a busy isolate is wall time, not your CPU time. No evidence background-thread GC/compile time is attributed to a request.

Outdated advice to discard: any "TurboFan compiles off-thread so its cost is free on the main thread" guidance (true for Chrome/Node default, false for workerd).

## 2. Compile cost for 5–20 KB bytecode; code/bytecode flushing

### Relative costs — verified ratios, no official absolute table

- [docs] v8.dev "Maglev" (Dec 2023, V8 11–12 era, still the architecture in V8 15): "roughly 10× slower than Sparkplug, and 10× faster than TurboFan": https://v8.dev/blog/maglev
- [docs] v8.dev "Holiday season 2023" gives a wider band: Maglev "~20× slower than Sparkplug, but 10–100× faster than top-tier TurboFan": https://v8.dev/blog/holiday-season-2023. Use 10×/10× as the planning number; the spread reflects workload dependence.
- [docs] "Leaving the Sea of Nodes" (Mar 2025): Turboshaft backend "compile time divided by 2 compared to SoN": https://v8.dev/blog/leaving-the-sea-of-nodes. Turboshaft docs add that Turbolev (Maglev frontend → Turboshaft backend, `src/compiler/turboshaft/turbolev-graph-builder.cc`) reuses Maglev graph building: https://chromium.googlesource.com/v8/v8/+/main/docs/compiler/turboshaft/compiler-turboshaft.md
- [3rd-party] V8 engineer via InfoQ (2021, Sparkplug launch): Sparkplug "2–3 orders of magnitude faster than TurboFan," "same order of magnitude as Ignition compilation," ~4× faster than the interpreter on suitable code: https://www.infoq.com/news/2021/06/v8-sparkplug-compiler/
- [3rd-party, unverified absolute] Skein "V8 four-tier JIT pipeline" cheat sheet: Sparkplug ~1 ms/kB bytecode, Maglev ~10 ms/function, TurboFan ~100 ms/function; speedups ~1.5–2× / ~50–70% of TurboFan / max: https://fallowlone.com/en/learn/browser/03-v8-internals/02-jit-pipeline. I found **no** primary-source ms-per-KB table from the V8 team. Do not treat those absolutes as guaranteed.
- [inference] for your 5–20 KB parser function: expect Sparkplug in low single-digit to ~tens of ms on first tier-up, Maglev roughly an order above that, Turboshaft/top-tier roughly another order above that — all on the requesting thread, all billed. Exact numbers must be measured in workerd (see open questions). Note Sparkplug batches (4 KB batches, `baseline_batch_compilation_threshold` in `baseline-batch-compiler.cc`) to amortize W^X page-flip cost, so one big function pays differently than many small ones.

Budgets that gate *when* you pay it (still current in `main`):

- [source] `DEFINE_INT(invocation_count_for_maglev, 400)` (1000 on Android), `invocation_count_for_maglev_osr, 100`, `invocation_count_for_turbofan, 3000`, `invocation_count_for_osr, 500`, `minimum_invocations_after_ic_update` / `minimum_invocations_before_optimization` in `src/flags/flag-definitions.h`: https://github.com/v8/v8/blob/main/src/flags/flag-definitions.h
- [source] Budgets are interrupt/bytecode budgets scaled by bytecode length, not raw call counts; Sparkplug/Maglev/TurboFan all decrement via `AddToInterruptBudgetAndJumpIfNotExceeded` at returns/back-edges, and OSR fires at loop back-edge budget zero: `docs/runtime/tiering.md`, `src/baseline/.../baseline-assembler-*-inl.h`. So "400 invocations" is shorthand — a 20 KB function needs proportionally more budget than a tiny one. A single long parse *can* OSR mid-call (Ignition→Maglev/TurboFan frame replacement at the loop header) without 400 separate calls.

### Flushing between requests — yes, it exists

- [source] `DEFINE_BOOL(flush_bytecode, true)`, `DEFINE_INT(bytecode_old_age, 6)`, and since commit `63a23cf` ([heap] Enable `flush_code_based_on_time` by default): `DEFINE_BOOL(flush_code_based_on_time, true)`, `DEFINE_INT(bytecode_old_time, 180)` (was 30 s): https://chromium.googlesource.com/v8/v8/+/master/src/flags/flag-definitions.h and commit diff.
- [source] Aging/flush logic: `MarkingVisitorBase::IsOld` / `MakeOlder` / `HasBytecodeArrayForFlushing` / `ShouldFlushCode` in `src/heap/marking-visitor-inl.h`; `SharedFunctionInfo::age` (`uint16`, `kMaxAge`) in `src/objects/shared-function-info.h`. Un-executed bytecode ages each major GC (or by seconds since last GC when time-based); when old and unmarked it becomes a `code_flushing_candidates` entry and is replaced by `UncompiledData`; optimized `Code` is evicted via `CodeFlusher` (`src/codegen/compilation-cache.cc` `Age()` paths).
- [inference] In a long-lived isolate that goes idle >~180 s or through ≥6 major GCs without calling the parser, expect bytecode + baseline + optimized code to be flushed. Next request recompiles lazily (`CompileLazy` via `InterpreterEntryTrampoline`). Sparkplug support for flushing baseline+bytecode was added explicitly (commit `ea55438` / reland `3ae733f`). I found no workerd override of these flushing flags.

## 3. Isolate lifetime, cold starts, code caching

- [docs] Isolates "are not necessarily long-lived" and "may be spun down" for machine resource limits, suspicious scripts, individual limits: https://developers.cloudflare.com/workers/reference/how-workers-works/. Memory is 128 MB/isolate; exceeding it condemns the isolate for follow-on requests: https://developers.cloudflare.com/workers/platform/limits/
- [docs] Sharding ("Eliminating Cold Starts 2," Sep 2025, fully deployed): consistent-hash "shard server" per Worker per colo, <1 ms forward hop, optimistic Cap'n Proto refusal. Result on enterprise traffic: only ~4% of requests sharded, yet global eviction rate down 10×, warm rate 99.9%→99.99% (cold 0.1%→0.01%): https://blog.cloudflare.com/eliminating-cold-starts-2-shard-and-conquer/
- [docs] Pre-warm during TLS ClientHello SNI (2020) still exists but no longer hides large cold starts: 5 ms then vs. up to 10 MB scripts / 400 ms–1 s startup now; TLS 1.3 shortened the hiding window: same post + https://blog.cloudflare.com/eliminating-cold-starts-with-cloudflare-workers/
- [3rd-party] Community reports eviction after ~30 s–3 min idle on low-traffic Workers (2022 thread): https://community.cloudflare.com/t/worker-response-is-slow-for-first-hit/421353. Treat as anecdote, not a guarantee — sharding (2025) lengthened low-traffic residency but published no new idle timeout.
- [source] No JS code-cache across isolates/deploys for user code was found. What exists:
  - Per-isolate in-memory `CompilationCache` (bytecode hashtable keyed by source): `src/codegen/compilation-cache.cc`.
  - workerd PR #2952 "enable compile cache" covers **built-in modules only** (`node:buffer`, `node:url`, …), making the *second import* cheap: https://github.com/cloudflare/workerd/pull/2952
  - V8's on-disk code cache is a Chrome/Blink concept (HTTP cache metadata, `ScriptCompiler::kProduceCodeCache`/`kConsumeCodeCache`): https://v8.dev/blog/code-caching-for-devs — no workerd equivalent for user Workers was found.
  - Counter-example proving snapshots are the exception: Python Workers (Dec 2025) get deployment-time memory snapshots (10 s→1 s on fastapi/httpx/pydantic import): https://blog.cloudflare.com/python-workers-advancements/. No JS equivalent announced.
- [inference] Plan on: every cold isolate pays parse + Ignition + Sparkplug from scratch; Maglev/Turboshaft only if the isolate lives long enough and the function gets hot enough *within that isolate*. Deploys and evictions reset everything.

## 4. Warm-up at startup (1 s global budget)

- [docs] "Worker startup time: 1 s. A Worker must parse and execute its global scope within 1 s" (raised 400 ms→1 s Oct 10 2025): https://developers.cloudflare.com/workers/platform/limits/ + https://developers.cloudflare.com/changelog/post/2025-10-10-increased-startup-time/. Exceeding it fails deploy with `Script startup exceeded CPU time limit (10021)`.
- [source] Startup runs under `IsolateLimitEnforcer::enterStartupJs` (also `enterDynamicImportJs` / `enterStartupPython` variants): `src/workerd/io/limit-enforcer.h`.
- [inference] Parsing "a few sample documents" at module load will **not** reach Maglev (needs ~400 scaled invocations) or Turboshaft (~3000) unless you loop hundreds/thousands of times or trigger OSR with a long loop (`maglev_osr` 100 / `osr` 500 scaled iterations). You would at most warm Ignition feedback + Sparkplug, and even that only pays off if the *same isolate* serves later requests (no cross-isolate transfer).
- Risks, all real:
  - [docs] Cloudflare explicitly says "avoid expensive work in global scope; move initialization into your handler or build time" (same limits page). Warm-up burns the 1 s budget and increases every cold start.
  - [source/inference] Feedback poisoning → deopt: Maglev/Turboshaft speculate on `FeedbackVector` (hidden classes, call-site monomorphism). Samples that are all-ASCII, small, or single-shaped will stabilize the wrong guards; real traffic (two-byte strings, new attr shapes, `delete`, polymorphic call sites) then deoptimizes back to Ignition/Sparkplug and recompiles. V8 exposes the knobs (`minimum_invocations_after_ic_update`, `osr_from_maglev`, `maglev_overwrite_budget`) precisely because early tier-up on unstable feedback is costly.
  - Startup warm-up also grows the heap that must survive into requests (peak memory), working against Priority 2.

## 5. GC in production

What workerd forces:

- [source] `V8System::init` hardcodes `--noincremental-marking` with comment: JSG GC integration historically buggy with it; 128 MB heaps make incremental "probably not a win"; revisit only with stress testing: `src/workerd/jsg/setup.c++`.
- [source] CppGC (Oilpan, used by JSG `CppgcShim`/`HeapTracer` in `src/workerd/jsg/wrappable.c++`) is also forced atomic: `heapParams.marking_support = kAtomic; sweeping_support = kAtomic` with comment "concurrent GC only wins with idle cores; Workers servers are saturated; browsers differ": same file, `newCppHeap`/`newIsolate`.
- [docs] Atomic vs incremental vs concurrent semantics (atomic = one STW pause, most efficient overall, most jank; incremental splits on mutator thread + write barriers; concurrent offloads to background): https://chromium.googlesource.com/v8/v8/+/main/include/cppgc/README.md and https://v8.dev/blog/trash-talk

What still runs in parallel (STW-parallel, not concurrent):

- [docs] Parallel Scavenger (young gen) since V8 6.2 cut "main thread young generation GC total time by ~20–50%" (up to ~2× on real sites): https://v8.dev/blog/orinoco-parallel-scavenger
- [docs] Concurrent marking cut "main-thread marking time by 60–70%": https://v8.dev/blog/concurrent-marking — but that win requires incremental/concurrent marking, which workerd disables for the major GC. Expect major-GC marking to be STW (parallel across helpers, but pausing the mutator).
- [source] `ScavengerJobTask::GetMaxConcurrency` collapses to 1 only if `!ShouldUseBackgroundThreads()` or battery-optimized: `src/heap/scavenger.cc`. workerd provides a real worker pool, so young-gen scavenges should still parallelize (except macOS arm64 `--single-threaded-gc` builds). Major sweep can also run concurrently with JS in stock V8 (`docs/heap/marking-and-sweeping.md`), but with incremental disabled the observable behavior is closer to atomic-pause-then-parallel-sweep.

Billing:

- [docs] Oct 2025 post proves main-thread GC is billed: relaxing the 2017 young-gen cap "gave ~25% boost to the benchmarks … some workloads will also use fewer billed CPU seconds": https://blog.cloudflare.com/unpacking-cloudflare-workers-cpu-performance-benchmarks/
- [inference, no evidence found] Background-helper CPU (parallel scavenge workers, concurrent sweep tasks) is almost certainly **not** attributed to the request — billed CPU tracks isolate-lock execution — but it still consumes machine cores and can add noise/latency. No Cloudflare doc quantifies it.
- [inference] With `--noincremental-marking`, a heap with tens of MB live pays fewer, larger STW pauses instead of spread-out steps. Throughput is slightly better (no write-barrier tax), tail latency worse. For a parser that allocates the whole tree eagerly, the young-gen size matters more than anything: the 2017-to-2025 fix is the proof. Absolute pause for "tens of MB live" is an open benchmark (GC speed is ~MB/ms-order, but no citable V8 number covers your object graph).

## 6. Fast-in-low-tiers vs fast-after-optimization: how to balance it

V8 reasoning (applies directly to workerd because low tiers dominate there):

- [source] `String.prototype.indexOf` fast path: single-char one-byte needle → `libc_memchr` direct call in CSA (`StringBuiltinsAssembler::StringIndexOf`); longer/general cases → `Runtime::kStringIndexOf[Unchecked]` → C++ `String::IndexOf` → `SearchString` over flattened `FlatContent` with one-byte/two-byte dispatch: `src/builtins/builtins-string-gen.cc`, `src/builtins/builtins-string.cc`, `src/objects/string.cc`. `slice`/`substr` produce `SlicedString` (parent pointer + offset + length, no copy): `docs/objects/strings.md` ("Strings in V8").
- [source] TurboFan even pattern-matches `s.slice(-1)` into `StringCharAt`: `src/compiler/js-builtin-reducer.cc` (`ReduceStringSlice`). Torque string builtins now use `GetStringData()` slices rather than per-char `StringCharCodeAt` (commit `65d2c4b`).
- [inference] Consequences for the parser:
  1. `indexOf`/`slice` are precompiled CSA/C++ and run at full speed in **every** tier, including the first request on a cold isolate. A hand-rolled `charCodeAt` loop pays interpreter dispatch (Ignition) or unoptimized machine code (Sparkplug) until Maglev, and only reaches parity after bounds-check elimination, Smi untagging, and hidden-class stabilization — all of which require hot, monomorphic feedback you will rarely have (few calls per isolate, flushing between).
  2. The exception is OSR: a single huge document with a tight scan loop *can* OSR to Maglev/Turboshaft mid-parse. So `charCodeAt` loops are not hopeless — they are just lottery tickets, while builtins pay out every time.
  3. Memory side: `SlicedString` zero-copy is exactly what you want (input outlives request), but it pins the whole input — fine here. Avoid `+=` string building (creates `ConsString` trees that later force `Flatten` copies); push slices/indices into arrays and join once, or emit the tree directly.

Rule of thumb: structure the parser as **builtin-driven coarse splitting** (`indexOf('<')`, `indexOf('>')`, `slice` for names/text) with **minimal JS per character**; reserve `charCodeAt` for the small regions builtins cannot delimit (attribute-value quoting, entity scans), kept monomorphic (same string representation, same object shapes).

Outdated advice to ignore: pre-2021 "avoid builtins, hand-roll loops for speed" (Crankshaft-era) and pre-2023 "write for TurboFan peak" — in Workers the median execution is Ignition/Sparkplug, where builtins win by default.

## 7. Other Cloudflare-specific V8 flags/patches

- [docs] Young-generation cap: set June 2017 per V8's ≤512 MB guidance, "limiting young space too rigidly," relaxed ~Oct 2025 to V8 heuristics → "~25% boost, small memory increase": Oct 2025 CPU post. Only quantified production V8-heap tuning published.
- [docs] Transcendental flag: Workers had a faster trig path "mostly by coincidence" via a V8 compile-time flag Node lacked; Cloudflare PR'd Node: same post. Irrelevant to XML parsing except as proof that build-flag skew exists.
- [docs] `JSON.parse` with revivers ~33% upstream fix landing V8 14.3 (Chrome 143): same post. Relevant precedent: Workers team upstreams V8 patches, so V8 15.1 behavior may already include Workers-driven fixes.
- [docs] Scheduler, not V8 flags: CPU-vs-I/O routing heuristics (coalesce I/O-bound, spread CPU-bound, spin up isolates earlier) rolled out Oct 2025: same post. Expect fewer "stuck behind a hot isolate" tails than pre-Oct-2025 benchmarks show.
- [source] Misc workerd deltas vs stock: `--js-source-phase-imports` on; `eval`/`new Function`/Wasm codegen gated by `IsolateBase::modifyCodeGenCallback`/`allowWasmCallback`; `SetAllowAtomicsWait(false)`; default `IsolateGroup` shared sandbox; `HeapTracer` embedder-roots/CppgcShim bridging. None change tier thresholds, but the sandbox/cage layout is why pointer-compression/cage advice from Chrome may not transfer 1:1.
- [inference, stated plainly] I found **no** public list of production `--v8-flags` beyond the OSS `setup.c++`/`setup.h` set, and no statement that production enables anything OSS disables. Assume OSS workerd behavior for tiering/GC/flushing until you A/B in production.

---

## Actionable rules for the parser

- Optimize for Ignition/Sparkplug first: route all long scans through `indexOf`/`slice`; keep JS per byte near zero. Measure cold-isolate first-parse, not steady-state hot-loop, as the primary metric.
- Keep one function shape hot within an isolate: stable `attrs`/`children` object shapes (initialize all fields in the same order, no `delete`, no shape transitions after construction), monomorphic call sites, one string representation per hot path where possible — this is what lets the rare Maglev/Turboshaft tier-up stick instead of deopting.
- Make the long scan loop OSR-friendly as a secondary bet: counted loop over a flat string/Uint8Array with hoisted length, no polymorphic calls inside, so a single large document can still tier up mid-parse even when invocation counts never reach 400/3000.
- Zero-copy via `slice` (SlicedString), never `+=`; whitespace-only text dropped inline without materializing nodes; pre-size arrays where free to cut young-gen pressure (young-gen size is the proven billing lever).
- Do not spend startup budget on sample parses unless you can loop them into the hundreds *and* prove the feedback matches production; default to no global warm-up (Cloudflare advises against expensive global scope, and each cold isolate would repay the cost).
- Cap peak live set: with `--noincremental-marking` every major GC is STW on your thread and billed; streaming-chunk or index-based designs that avoid holding two copies (input + tree + temporaries) beat micro-optimizations.

## Open questions that need a benchmark (in workerd, not Node/Chrome)

1. Tier reached per request-count: after N parses of size S in one isolate, which tier is the parser in (Ignition/Sparkplug/Maglev/Turboshaft)? Use `--trace-opt --trace-deopt --trace-baseline` locally + `performance.now()` deltas around parses in `wrangler dev`.
2. Absolute compile cost of the 5–20 KB function per tier on Workers-class CPUs (Sparkplug batch vs Maglev vs Turboshaft), and whether it visibly exceeds the 10 ms free-plan CPU budget on first hit.
3. Flush horizon: after how many idle seconds / major GCs does the parser's bytecode + optimized code get flushed in a real isolate (test `bytecode_old_time`≈180 s vs `bytecode_old_age`=6 under your allocation rate)?
4. Builtin vs loop crossover document size: at what input size does an OSR'd `charCodeAt` loop beat `indexOf`/`slice` scanning, per string encoding (one-byte vs two-byte)?
5. Major-GC pause with tens of MB live under `--noincremental-marking` (your tree shape, not a synthetic benchmark) — wall pause and billed CPU per collect.
6. Startup-budget cost of any proposed global warm-up vs. its hit-rate gain, given 99.99% warm enterprise routing but uncorrelated cold isolates for tail Workers.
7. Production/OSS skew: does production add undisclosed `--v8-flags` (heap, YoungGen, `max-opt`, `predictable`) that change any of the above? Only Cloudflare can answer; treat OSS numbers as lower bounds.
