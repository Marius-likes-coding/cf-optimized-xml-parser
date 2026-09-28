# S5: JIT behavior of the chosen parser

Settles M7 from `research/SYNTHESIS.md`: which tier the parser reaches after how many parses, what compiling costs on the request thread, where deopts come from, and how big the function is. Run 2026-09-28 on local workerd 1.20260815.1 (V8 15.1) with the production JIT flags (all compilation synchronous on the request thread, `scripts/v8-profiles.mjs`). The machine was loaded (load average 6–8), so absolute compile times are likely inflated.

## Findings

1. **Optimizing the parser costs a lot of CPU on the request thread.** Per-parse timeline in fresh isolates (median of 9, ms):

   | document | parses #1–7 | Maglev compile | after Maglev | top-tier compile | after |
   |---|---|---|---|---|---|
   | rss-ascii (114 KB) | 3–6 | #8: 11, #9: 8 (deopt + recompile) | ~1 | **#17: 79** | ~1 |
   | svg (135 KB) | 9–18 | (within #1–7) | 2–3 | **#10: 86** | ~2 |
   | soap (107 KB) | 9–19 | (within #1–7) | 2–3 | **#11: 75** | ~2 |

   V8's own trace (`--trace-opt`) agrees: Maglev compiles take 4–12 ms and top-tier (Turboshaft) compiles 48–94 ms, for every parser variant from S1–S4. In the S1/S2 data the top tier is only 0–25% faster than Maglev for this parser, so one top-tier compile needs hundreds of parses to pay for itself.

2. **Function size doesn't drive it.** The bytecode is 2.8 KB (S1 A, S2), 4.6 KB (strict) and 4.3 KB with errors outlined, far under V8's 60 KB optimization limit, and compile times are the same within noise across all of them. Moving error construction into a `fail()` helper didn't help.

3. **Padding the function past 60 KB to stay in Maglev backfires.** At 95 KB of bytecode the top tier is skipped as expected, but tier-up budgets scale with bytecode length, so Maglev arrives only after ~75 parses instead of 8, and its compile takes 17 ms.

4. **Two deopt sources, each followed by a costly recompile:**
   - *"Smi" at `open.push(node)`:* the per-parse `[]` literal starts with small-integer elements, and pushing an element node deopts Maglev code (plus a 6–8 ms recompile). **Fix, verified:** module-level stacks whose element kinds are fixed up front (`spikes/s5/strict-stacks.ts`). The deopt and the recompile at parse #9 disappear.
   - *"Insufficient type feedback" when the document shape changes* (rss → svg: paths such as the duplicate-attribute loop never ran on RSS). This discards the top-tier code; after a few more parses it recompiles for another ~75–90 ms.

5. **A tiny warm-up prevents the shape deopts.** V8 allocates a function's feedback vector only after ~8 calls (`invocation_count_for_feedback_allocation`), so the warm-up must call the parser about 10 times on a small "kitchen-sink" document that exercises every path (attributes incl. several per element, entities in text and attributes, CRLF, tabs, CDATA, comments, PIs, DOCTYPE, declaration, two-byte text):

   | warm-up parses | deopts over rss → rss-poison → svg → s3-cjk → rss-small → rss-1mb | top-tier compiles of `parse` |
   |---:|---|---:|
   | 0 | svg #1 (parse), s3-cjk #1 (decodeEntities) | 2 |
   | 1 | same, different reason ("for call") | 2 |
   | **10** | **none** | **1** |
   | 30 | rss #1 "wrong map": the warm-up itself reached Maglev on kitchen-sink-only feedback | 1 |

   The window is narrow and depends on V8's heuristics (feedback allocation after 8 calls, Maglev after ~400 calls' worth of budget), so it can change between V8 versions and needs a remote check.

## Rules for the implementation plan

- Stacks and scratch arrays live at module level with element kinds fixed up front; never create them as `[]` per parse.
- Keep all parsing in one hot function; outlining errors or rare paths doesn't reduce compile cost. Revisit only if remote measurements show smaller units compile disproportionately faster.
- Plan for a warm-up: about 10 parses of a small kitchen-sink document that covers every path with both one-byte and two-byte strings. Open decision: run it automatically on the first `parse()` call (costs that request roughly 1 ms, no API) or as an explicit `warmup()` export for module scope (runs under the separate 1 s startup budget; conflicts with `"sideEffects": false` only if done at import time).
## Remote confirmation on Cloudflare (2026-09-28)

`spikes/remote/` was deployed under the bench Worker's name (user-approved), with a fresh deploy per experiment. Each request parses once; CPU comes from `wrangler tail` (whole ms, including request overhead). Timelines are per isolate, using the Worker's own parse counter. Afterwards the real bench Worker was redeployed.

**A, no warm-up** (one isolate served all 200 requests):

```
rss-ascii  #1:2  #2:1  #3:3  #4–7:1  #8:4 (Maglev)  #9–15:0–1  #16:24 (top tier)  #17–120:0–1 (#48:8)
svg        #121:4  #122:6 (deopt → Maglev again)  #123–125:0–1  #126:29 (top tier again)  #127–200:0–1
```

**B, with the warm-up** (two isolates, 182 + 18 requests):

```
isolate 1  rss #1:3 (incl. warm-up)  #2:4  #3–9:0–1  #10:38 (top tier)  #11–107:0–1 (#48:10)
           svg #108–182: 0–1, no spike
isolate 2  rss #1:3 (incl. warm-up)  #2:5  #10:45 (top tier)  svg #14–18: 0–1
```

Conclusions:
- **Confirmed on production hardware:** the top-tier compile lands on one request per isolate (24–45 ms), and a document-shape change without warm-up costs another deopt and recompile (~35 ms). Local numbers were ~3× inflated by the loaded machine; the pattern is identical.
- **Confirmed:** the warm-up removes the shape-change deopt and its recompile. It costs ~1–2 ms once per isolate and moves the top-tier compile earlier (#10 instead of #16), when it happens anyway.
- Cold parses on Cloudflare: 2–5 ms for 114–135 KB, warm 0–1 ms.
- **New observation:** an 8–10 ms spike at parse #48 in both runs, most likely a stop-the-world major GC (workerd disables incremental marking). A candidate for the performance pass: check whether the short-lived trees get pretenured into old space.
- Requests from one client can be spread over several isolates. Warm-up and tier-up are per isolate, so every isolate pays its own cold phase.
