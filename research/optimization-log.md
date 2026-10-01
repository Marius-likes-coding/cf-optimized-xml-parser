# Optimization log

Every attempt of the optimization loop (`LoopedOptimizationPrompt.md`), oldest first. Read it
before you pick an idea, so that no idea is tried twice without a reason.

A failed idea isn't banned for good. Results depend on the V8 version and on the code around the
change, so each entry says what would have to change before the idea is worth another try.

## Entry format

```markdown
### YYYY-MM-DD: <idea in a few words> (accepted | failed | not confirmed in CI)

- **Hypothesis:** which cost the change removes; which fixtures should improve.
- **Change:** what changed, in which functions.
- **Measured:** base sha → candidate; workerd version (`workerd` in bench/results/perf-local.json).
  The bench:pr rows that matter (total-100, warm, memory), plus the encoding and bytes checks
  if you ran them.
- **CI:** perf-local rows. Leave out if the idea failed locally.
- **Why:** why it worked or failed, e.g. "rss +10%: the table lookup adds a load per character".
- **Retry if:** what would have to change first (V8 version, surrounding code). "Never" only
  for ideas that change behavior.
```

## Before this log

Rejected in the M7 performance pass (2026-09-29, workerd 1.20260815.1, V8 15.1); details in
`research/spikes/m7-performance.md`:

- **ASCII name characters via a 128-entry table**, regex only for non-ASCII: svg −12%,
  ooxml −16%, but rss +10% and s3 +10% (total-100). Mixed, rejected.
- **`indexOf` memos for newline/tab** instead of a regex search, and skipping `normalize()` when
  there's nothing to normalize: −3% to +7%, within noise. Rejected.
- **A general intern table for names** costs 10–30% CPU (S2, `research/spikes/s2-tree-building.md`).

## Gate change (2026-10-01)

Entries up to #39 were judged with 🟢 at −5%. Since then 🟢 starts at −3% (`improvementPct` in
`bench/gates.json`; the regression gate stays at 5%). A cold win between −3% and −5% also needs
the same fixture's warm interval below 0. Why: `bench/README.md`, "Gate calibration".

Re-scored with the new rule, two earlier full runs pass: cheaper entity decoding r2 (entities
cold −3.8%, warm CI below 0) and the clean end-tag slice run (soap cold −4.8%, warm −3.0%).
#39 already ships both. The RAW `normalize()` skip, measured together with r2, isn't in #39. It
had no signal on its own (r1), so it doesn't pass. Every other entry still fails: a 🔴 or 🟡
slower row, or no cold row at −3% with its interval below 0. The M7 `indexOf` memos predate the
paired bench (no intervals) and can't be re-scored.

## Entries

### 2026-09-30: ASCII fast path for attribute names only (failed)

- **Hypothesis:** Per-attribute-name Unicode `NAME_RE.test()` costs 20–50% in optimized code on
  attribute-heavy fixtures (S1 warm gap: E vs A on svg/soap). An ASCII fast path for attribute
  names only keeps the M7 wins (svg −12%, ooxml −16% with the all-names table variant) while
  avoiding its rss/s3 +10% losses: element names stay on the regex (short names where it wins,
  especially cold), and s3 has zero attributes so it should be untouched.
- **Change:** `src/parse-string.ts` attribute-name parsing only; element names, PI targets and
  `DOCTYPE_HEAD_RE` untouched. Three packagings tried: (r1) `nameEnd()` helper with 128-entry
  `Uint8Array` tables + regex fallback (as in `spikes/m7/ascii-names`); (r2) small ASCII-only
  regex `/[:A-Z_a-z][\w.:-]*/y` + `NAME_RE` fallback when the next char is ≥128; (r3) r1's table
  scan inlined at the call site (no new function to compile, no call overhead). Plus
  `src/warmup.ts`: `<v p = "q" é="v"/>` so the non-ASCII fallback gets type feedback, and the
  matching `test/unit/warmup.test.ts` assertion. All reverted; only this log ships.
- **Measured:** base `487cfbd` → candidate `487cfbd`+dirty (uncommitted); workerd 1.20260815.1.
  Decisive run (r3 inline, full `npm run bench:pr`, 30 cold isolates):
  cold total-100: soap −15.4% 🟢 (−18.5…−11.8), svg +1.9% ⚪, sitemap +2.4% ⚪, entities +2.4% ⚪,
  rss-poison +1.5% ⚪, rss-small +3.8% ⚪, ooxml-ascii +4.6% 🟡 slower (+0.8…+8.1), rss-ascii +6.3%
  🟡 inconclusive, rss-crlf +8.0% 🟡 inconclusive, s3-ascii +7.5% 🔴 (+4.7…+10.2);
  warm: svg −8.9% 🟢 (−9.4…−8.3, all 4 isolates), entities −0.3% ⚪, rss-poison −1.1% ⚪,
  ooxml +0.4% ⚪, soap −0.9% ⚪, rss-small +1.6% ⚪, rss-crlf +1.8% ⚪, s3 +2.4% ⚪,
  rss-ascii +3.4% ⚪, sitemap +3.4% 🟡 slower (+2.2…+4.1, all 4 isolates);
  memory: no fixture above +0.0% except rss-ascii −2.2% (noise).
  Earlier rounds: r1 quick (`svg,ooxml-ascii,s3-ascii`, 10 isolates) warm svg −10.4% 🟢 (all
  isolates −9.7…−11.6), warm ooxml −3.1%, warm s3 −0.2%; cold s3 +5.5% 🔴. r1 full run warm
  svg −12.4% 🟢 (tight CI), warm soap −4.8%, warm rss-ascii +3.1%, 2 gated cold regressions.
  r2 quick (`svg,soap,rss-ascii,s3-ascii`, 10 isolates) warm svg +3.4% 🟡 slower (all isolates
  +2.9…+4.0): the extra `charCodeAt`+branch per name costs more than the small regex saves.
- **CI:** not opened (failed locally; no perf PR).
- **Why:** the warm mechanism is real (svg −9…−12% in all three full/quick runs, soap cold −15%
  once), but total-100 never clears: (1) s3-ascii cold regresses +5…+8% with tight CIs although
  s3 has zero attributes and never reaches the changed code — the only delta is module table
  init plus ~15 extra bytecodes in `parseString`, so this is compile size/timing (Turbofan
  feedback interaction), not execution; (2) fixtures with few short attributes (rss, sitemap,
  entities) pay per-name overhead (call in r1, branch in r2/r3) that exceeds the per-char
  saving, slightly slower warm (+2…+3%) and inconclusively slower cold; (3) cold CIs span
  10–40 points on small fixtures, so even neutral rows risk 🟡. R3 inlining kept the svg warm
  win (−8.9%) and turned soap cold 🟢 but could not move s3 cold (+7.5% 🔴).
- **Retry if:** someone finds an attribute-name fast path with zero added compile (no new
  function, no bigger `parseString`, no per-name branch on the ASCII hit) — e.g. if V8 ever
  ships a cheaper Unicode-class match — or if the s3-cold compile sensitivity is understood and
  isolated first (ablate: dead-code-only candidate of the same bytecode size; if s3 still
  regresses, the gate cannot see past compile noise for changes of this size).

### 2026-09-30: Split numeric-reference branch out of decodeEntities (failed)

- **Hypothesis:** `decodeEntities`' numeric-reference branch (digit loop, range checks,
  `isXmlChar`) bloats the entity decoder and its one-time top-tier compile (the 8–10 ms spike
  at parse #48, 14 ms in the extended warm-up run). Outlining it into `decodeNumeric()` shrinks
  `decodeEntities`, cutting total-100 compile cost on entity-heavy fixtures (entities, sitemap,
  soap/rss with entities) while leaving entity-free fixtures neutral. `parseString` bytecode is
  untouched, so the s3-cold compile sensitivity from the 2026-09-30 attribute-names entry should
  not trigger.
- **Change:** `src/entities.ts` only: numeric `&#...;`/`&#x...;` parsing moved verbatim into a
  new `decodeNumeric(source, amp, semi)` helper; `decodeEntities` calls it on the `#` branch.
  Error messages, offsets and accept/reject behavior identical. No `src/warmup.ts` change: the
  warm-up documents already exercise decimal, hex and named references. Reverted; only this log
  ships.
- **Measured:** base `a82bf1d` → candidate `a82bf1d`+dirty (uncommitted); workerd 1.20260815.1.
  Full `npm run bench:pr` (60 cold isolates, 12 warm isolates):
  cold total-100: rss-ascii −4.6% ⚪ (−11.5…+2.1), rss-poison +1.1% ⚪, rss-small +7.1% 🟡
  inconclusive, rss-crlf +0.1% ⚪, svg +0.7% ⚪, soap −0.4% ⚪, s3-ascii +3.1% 🟡 slower
  (+1.4…+4.5), ooxml-ascii −0.3% ⚪, sitemap −0.6% ⚪, entities +1.0% ⚪;
  warm: all ⚪ same (rss-ascii −0.5%, rss-poison −0.1%, rss-small +0.1%, rss-crlf −0.3%,
  svg −0.3%, soap −1.2%, s3-ascii −1.7%, ooxml-ascii −0.9%, sitemap −1.6%, entities +0.1%,
  all below the 5% gate);
  memory: no change except rss-ascii −2.2% (baseline offset noise, same as the previous entry).
  Quick round (`entities,sitemap,s3-ascii`, 10 isolates) agreed: cold all ⚪ same (entities +4.5%,
  sitemap −0.7%, s3-ascii +2.2%), warm all ⚪ same (+1.1…+1.2%).
  Encoding/bytes checks not run (failed locally; `src/decode.ts` untouched).
- **CI:** not opened (failed locally; no perf PR).
- **Why:** the compile saving never materialized: no total-100 row is 🟢, and s3-ascii cold is
  🟡 slower (+3.1% with CI fully above 0). Warm is a wash (quick round +1%, full run −1% — both
  noise around an extra call per numeric reference that V8 likely inlines back at the top tier
  while it still costs in the early tiers). Notably, s3-ascii cold regressed although
  `parseString` is byte-identical — the only delta is one extra module-level function — which
  corroborates the previous entry's compile-noise hypothesis: s3-cold moves on any module-shape
  change, so the gate cannot resolve changes of this size there.
- **Retry if:** someone shows via `--trace-opt` that `decodeEntities`' compile actually dominates
  an entity-heavy fixture's total-100 and finds a split with zero extra call on the hot path
  (e.g. outlining only the cold `fail()` throws, not the digit loop), or the s3-cold compile
  sensitivity is isolated first (dead-code-only ablation of the same function count; if s3 still
  regresses, the gate cannot see past compile noise for changes of this size).

### 2026-09-30: Cheaper entity decoding — RAW fast path + first-char dispatch (failed)

- **Hypothesis:** Ablation (`bench-ab` on spike copies, all four JIT tiers) shows entity decoding
  is ~55% of the entities fixture and ~10% of sitemap/s3 in every tier, while the other two big
  costs found have no legal angle (below). Removing per-entity call overhead in `decodeEntities`
  (same output) should improve entities total-100 by ~5% and sitemap/s3 by ~1–2%, with
  entity-free fixtures neutral. `parseString` untouched.
- **Change:** `src/entities.ts` only, three rounds (all reverted; only this log ships):
  (r1) skip the per-segment `normalize()` call when `mode === RAW` (cached boolean + ternary;
  identical output since `normalize` returns its input for RAW);
  (r2) r1 plus first-character dispatch with integer compares instead of the `startsWith`
  chain (size pins the length between `&` and `;`, so matching the rest is exact; out-of-bounds
  `charCodeAt` is `NaN`, like a failed `startsWith`);
  (r3) r2 with r1 reverted (dispatch only). No warm-up change: both modes and all reference
  kinds are already exercised.
- **Measured:** base `60c5c12` → candidate `60c5c12`+dirty; workerd 1.20260815.1.
  r1 quick (`entities,sitemap,s3-ascii,svg`; 10 cold / 4 warm isolates): cold all ⚪ same
  (entities +2.2%, sitemap −5.3% with CI crossing 0, s3-ascii −2.2%, svg −3.3%); warm ≈ +1%
  (entities +2.3%, sitemap +1.3% with all 4 isolates positive — the ternary's branch costs at
  the top tier where `normalize` is inlined anyway).
  r2 quick: cold all ⚪ same (entities −4.7%, s3-ascii −2.7%, svg −1.8%, sitemap −0.2%);
  warm entities −3.2%, sitemap −2.6%, s3-ascii −3.1% (CIs below 0), svg −0.3%.
  r2 full (60 cold / 12 warm isolates): cold entities −3.8% (−5.8…−2.0) ⚪, all other fixtures
  ⚪ same, no 🟡/🔴; warm entities −2.1% (all 12 isolates negative), s3-ascii −1.0%, rest neutral;
  memory unchanged (rss-ascii −2.2% baseline offset again).
  r3 quick: cold entities −6.0% but CI (−12.6…+1.5) crosses 0; warm entities −1.6%, weaker than
  r2 — wrong direction, so no full run.
  Equiv `SAME` on 5,427 inputs (r2); `typecheck` + `lint` pass. Encoding/bytes checks not run
  (failed locally; `src/decode.ts` untouched).
- **CI:** not opened (failed locally; no perf PR).
- **Why:** the mechanism is real but too small: dispatch saves ~1 call per entity
  (~7 ns × 4,900 entities × 100 parses ≈ 3.4 ms ≈ the observed −3.2 ms on entities), and the
  remaining decode cost is builtin scans plus slices and concatenations, which are inherent to
  producing decoded output. entities needs −4.2 ms for the 5% gate; the ~1 ms gap has no
  identified source. Notably, s3-ascii cold stayed neutral this time (no 🟡): smaller diffs
  wobble it less.
- **Retry if:** someone finds ~1 ms more in `decodeEntities` without new calls or branches on
  the hot path (e.g. a single-entity-text fast path, if measurements show it is common), or the
  entities fixture's share grows.
- **Ablation appendix (for future loops — measured with `bench-ab`, medians, full tier):**
  skipping entity expansion: entities −52%, sitemap −12%, s3-ascii −9%, svg ±0% (this idea's
  target); skipping the duplicate-attribute check: svg −8%, others ±0% — no legal angle, the
  check cannot be weakened; skipping the end-tag `startsWith` match: s3-ascii −16%,
  sitemap −11% — no legal angle, same reason. Reordering the named-entity checks by frequency
  is worthless and was not tried in code: every miss short-circuits on the `size === N`
  integer compare, so each hit already costs exactly one `startsWith`; reordering only moves
  ~1 ns compares (measured entity frequencies: amp 6,906, quot 3,920, lt/gt 1,400 each,
  numeric 700, apos 0 across the matrix).

### 2026-09-30: Dead-code ablation of the s3-cold compile sensitivity (failed — diagnostic)

- **Hypothesis:** The last three entries all invoke compile size/timing noise to explain cold
  movements (s3-ascii +5…+8% 🔴 on attribute-names r3, +3.1% 🟡 on the decode split). If cold
  moves on compile load alone, a never-executed branch of the same size (~25 lines of bytecode
  inside `parseString`) must move s3-ascii cold with zero execution change. This answers the
  "Retry if" of all three entries and unblocks future small ideas either way.
- **Change:** `src/parse-string.ts` only: an `if (maxAttributes < 0)` block (impossible —
  `limit()` enforces ≥ 1) containing a `charCodeAt` switch loop over the input plus a dead
  `fail()`. Never executed, never reached by the warm-up (by design), no warm-up change.
  Equiv trivially `SAME` on 5,427 inputs; `typecheck` + `lint` pass. Reverted; only this log
  ships.
- **Measured:** base `86d653e` → candidate `86d653e`+dirty; workerd 1.20260815.1.
  Quick (`s3-ascii,rss-ascii,svg`; 10 cold / 4 warm): all ⚪ same (s3-ascii cold +1.4%,
  rss-ascii cold −7.1% with CI spanning ±15, warm ±0.5%).
  Full (60 cold / 12 warm): warm ALL fixtures ±0.2% (dead code costs exactly nothing warm);
  cold s3-ascii +0.7% (−0.8…+2.4, tight) ⚪, svg +0.0%, soap −0.5%, ooxml −0.7%,
  entities −0.3%, rss-ascii −2.8%, rss-poison +2.6%, rss-crlf +1.2% — all ⚪ same;
  sitemap +2.8% (+0.5…+4.9) 🟡 slower; rss-small +7.9% 🟡 inconclusive (CI spans ±15).
  Memory unchanged. Encoding/bytes checks not run (diagnostic, reverted).
- **CI:** not opened (diagnostic, reverted; no perf PR).
- **Why:** the s3-specific compile-size hypothesis is rejected: +0.7% with a tight CI is
  neutral, so raw bytecode size inside `parseString` does not move s3-cold. The earlier s3
  movements were run variance or specific to those changes (a new module-level function, not
  size). But the run also shows the gate's noise floor landing elsewhere: sitemap cold +2.8%
  🟡 with a CI fully above 0 on code that provably never executes — compile-timing noise (or
  run variance) that this fixture happened to catch. And rss-small cold again spans ±15: small
  fixtures resolve nothing cold.
- **Retry if:** never for this ablation (question answered). Consequences for future loops:
  (1) do not blame raw `parseString` size for a cold movement — look for execution effects or
  re-run first; (2) a lone 🟡 on an unrelated fixture (like sitemap here) is expected noise —
  re-run before rejecting on it alone; (3) the s3-cold question that remains is narrower: new
  module-level functions (not inline size) shifting feedback/inlining, still untested — a
  dead-export ablation could isolate that if it ever blocks again.

### 2026-09-30: Sticky-regex whitespace skip in the text path (failed)

- **Hypothesis:** Dropping whitespace-only text between elements burns an interpreted
  `charCodeAt` loop per segment. S1 showed builtins (regex/`indexOf`) beat char loops in the
  early tiers, which dominate total-100. One sticky `/[ \t\n\r]*/y` test should skip each run
  in compiled code; a first-`charCodeAt` guard keeps content-starting segments (minified s3) on
  the old cost. Pretty-printed fixtures (rss, svg, sitemap) should improve cold; s3 neutral.
- **Change:** `src/parse-string.ts` text branch only: the `while` whitespace loop replaced by a
  first-character check plus `WS_RUN_RE.test()` (`lastIndex` seeded per segment). The class
  matches exactly the loop's four characters (not `\s`); overshoot past `textEnd` can only
  happen for trailing whitespace at end of input and takes the same drop path. All reverted;
  only this log ships.
- **Measured:** base `7ef1a29` → candidate `7ef1a29`+dirty; workerd 1.20260815.1.
  Quick (`rss-ascii,s3-ascii,svg,sitemap`; 10 cold / 4 warm): cold all ⚪ same (rss-ascii +2.0%,
  s3-ascii +1.0%, svg −2.2%, sitemap +4.0% — point estimates on the targets go the wrong way);
  warm rss-ascii +5.4% (−1.7…+10.8) 🟡 inconclusive (+7.3/+7.7/+9.7/−2.7 per isolate),
  svg +2.9% (−0.1…+5.0, 3/4 isolates positive), sitemap +1.0%, s3-ascii −2.8% (one −13.9
  isolate, noise). Equiv `SAME` on 5,427 inputs; `typecheck` + `lint` pass. No full run, no
  encoding/bytes checks (rejected on warm).
- **CI:** not opened (failed locally; no perf PR).
- **Why:** S1's "builtins win" does not transfer to short runs at the top tier: a sticky-regex
  `test()` (call + `lastIndex` machinery + Irregexp exec) is slower than a 2–6-iteration
  optimized `charCodeAt` loop, and warm runs entirely at the top tier. The early-tier win never
  showed either — indentation runs are too short for the C++ scan to matter, while every
  segment pays the first-`charCodeAt` plus branch plus regex call. Two target fixtures regress
  in the same direction, so this is a real effect, not noise.
- **Retry if:** documents with very long whitespace runs (measure the run-length distribution
  first — indentation here is 2–6 chars), or V8 ever makes sticky `test()` cheaper than a short
  integer loop. Note for future loops: S1's builtin advantage is for long scans and low tiers;
  at the top tier on short runs, plain integer loops win.

### 2026-09-30: Skip redundant normalize() calls in parseString (failed)

- **Hypothesis:** Every text segment and attribute value without special characters pays a
  `normalize()` call that immediately returns its input (mode RAW). Skipping the call at the
  two hottest sites (text path, attribute-value path) removes per-segment call overhead in all
  tiers, like the 2026-09-30 entity-decoding entry did inside `decodeEntities`. Text-heavy
  (rss, sitemap, entities) and attribute-heavy (svg) fixtures should improve; `parseString`
  grows by two branches, which the dead-code ablation showed is harmless for s3-cold.
- **Change:** `src/parse-string.ts` only, one round: `mode === RAW ? slice : normalize(slice,
  mode)` at the text site and the attribute-value site. Identical output (`normalize` returns
  its input for RAW — same reference). Comment/CDATA/PI sites left alone (rare). All reverted;
  only this log ships.
- **Measured:** base `3eb36ce` → candidate `3eb36ce`+dirty; workerd 1.20260815.1.
  Quick (`rss-ascii,svg,s3-ascii,sitemap,entities`; 10 cold / 4 warm): cold all ⚪ same
  (rss-ascii −3.0%, svg −1.9%, s3-ascii +3.3% with CI spanning ±7, sitemap +0.2%,
  entities −2.7%, all CIs wide and crossing 0); warm all within ±1% and split across isolates
  (rss-ascii +0.9%, svg −0.8%, s3-ascii +0.4%, sitemap +0.3%, entities −0.8%) — no signal in
  either direction. Equiv `SAME` on 5,427 inputs; `typecheck` + `lint` pass. No full run (no
  quick signal), no encoding/bytes checks (reverted).
- **CI:** not opened (failed locally; no perf PR).
- **Why:** the targeted cost does not exist: V8 inlines the 3-line `normalize()` into its
  callers in every tier, so there is no per-segment call overhead to remove — the ternary only
  adds a branch. Together with the entity-decoding entry (where only the `startsWith`→integer
  removal moved anything), the lesson is that per-segment/per-entity *call* overhead is ~0
  across the parser; what remains per segment is slices, concatenations, builtin scans and the
  required checks.
- **Retry if:** never for call-skipping of tiny helpers (inlining already does it). Future loops
  should target fewer builtin scans, fewer allocations, or compile time — not calls/branches.
  Combining this with the entity-decoding dispatch was considered and rejected: this part
  contributes ~0%, so the combination would re-measure −3.8% and still miss the gate.

### 2026-09-30: Per-entity overhead in decodeEntities, completed (failed)

- **Hypothesis:** The 2026-09-30 entity-decoding entry's dispatch (−3.8% entities cold) left two
  per-entity costs untouched: the `isXmlChar()` call on the numeric path and one fewer module
  function overall. Removing both completes per-entity overhead removal and should push entities
  cold over the 5% gate. `parseString` untouched; no warm-up change (same paths).
- **Change:** `src/entities.ts` only, one round: first-character dispatch with integer compares
  instead of the `startsWith` chain (as in the earlier entry) plus the `isXmlChar()` range check
  inlined into the numeric branch and the now-unused helper deleted. All reverted; only this
  log ships.
- **Measured:** base `a1a72dc` → candidate `a1a72dc`+dirty; workerd 1.20260815.1.
  Quick (10 cold / 4 warm): cold sitemap −9.2% (−16.1…−2.6) 🟢 faster, entities −7.6% (CI
  crossing 0), s3-ascii −2.7%, svg +0.6% — but warm ALL neutral (entities +0.6%,
  sitemap +1.1% with all isolates ≥ 0, s3-ascii +0.4%, svg +0.6%): a cold 🟢 with no warm
  correlate and no mechanism (one fewer tiny function cannot save 7 ms — the dead-code
  ablation proved size moves nothing), i.e. suspect variance, so the full run decides.
  Full (60 cold / 12 warm): the 🟢 reverses — cold sitemap −0.6%, entities −0.4%, s3-ascii
  +0.7%, everything ⚪ same, no 🟡/🔴; warm entities −2.5% (−4.1…−0.4, all 12 isolates
  negative) confirms the dispatch mechanism at ~−2.5% but under the gate; memory unchanged.
  Equiv `SAME` on 5,427 inputs; `typecheck` + `lint` pass. Encoding/bytes checks not run
  (reverted). Note: this full run executed on a loaded machine (absolute ms ~50% above the
  quick runs, e.g. entities base 121 vs 76–81) — relative numbers still hold (interleaved),
  CIs widen, and the reversal stands.
- **CI:** not opened (failed in full locally; no perf PR).
- **Why:** the quick-round 🟢 was variance, caught by the process working as designed: no warm
  correlate + full reversal. The dispatch mechanism is real but capped (~−2.5% warm-entities,
  −1…−4% cold — same as the earlier entry), and the `isXmlChar()` inline added nothing measurable
  (V8 inlines the call at the top tier anyway — yet another instance of "call overhead ~0").
- **Retry if:** never for per-entity call removal in `decodeEntities` (both calls now proven
  nil-or-capped). Standing rule for future loops, demonstrated twice (here and sitemap +2.8%
  on dead code): never trust a quick-round 🟢/🟡 without a matching warm correlate — the full
  run is the verdict, especially for cold-only movements.

### 2026-09-30: End-tag match via slice + === instead of startsWith (failed)

- **Hypothesis:** Ablation shows the end-tag `startsWith(name, lt + 2)` match is ~16% of s3-ascii
  and ~11% of sitemap warm. `startsWith` with a position argument looks unintrinsified in V8
  15.1 (the ablation saving implies ~27 ns/call), while `slice` and string `===` are. Replacing
  the check with `xml.slice(lt + 2, lt + 2 + name.length) !== name` keeps accept/reject identical
  (the slice takes exactly `name.length` characters, clamped at end of input exactly like
  `startsWith`) and should win in all tiers, most on end-tag-dense fixtures (s3, sitemap, soap).
- **Change:** `src/parse-string.ts` end-tag branch only, one line + comment. No warm-up change
  (same path). All reverted; only this log ships.
- **Measured:** base `36ae18f` → candidate `36ae18f`+dirty; workerd 1.20260815.1. Three runs:
  quick (10 cold / 4 warm; loaded machine, absolutes ~+40%): cold soap −8.9% (−12.3…−3.0) 🟢,
  s3-ascii −1.6%, sitemap +0.5%, rss-ascii −0.6% all ⚪; warm s3-ascii −3.8%, rss-ascii −2.7%
  (all 4 isolates negative), soap −1.6% (all negative), sitemap +0.2%.
  Full #1 (60/12; loaded, absolutes ~+60–100%): everything ⚪ same with wide CIs — cold soap
  −3.2%, s3-ascii −6.4% (−15.2…+4.1), svg −5.8%, sitemap −4.3%; warm −0.5…−3.0% on 8/10
  fixtures (s3-ascii −3.0% and rss-crlf −2.6% with CIs below 0 but under the gate).
  Full #2, clean re-run on an idle machine (load 1.8/16; exactly one repeat for the degraded
  run, both tables reported): cold ALL 10 fixtures negative — soap −4.8% (−7.1…−2.3), s3-ascii
  −4.2%, ooxml-ascii −3.9%, rss-crlf −3.7%, rss-ascii −3.4%, svg −3.3% (CI fully below 0),
  sitemap −2.0%, rss-poison −1.5%, entities −0.8% — but the best is −4.8%, under the 5% gate;
  warm s3-ascii −3.3%, rss-small −3.1%, soap −3.0% (all 12/12 isolates negative),
  rss-crlf −2.3%, rss-poison −1.9%, rss-ascii −1.6%, entities −1.0%, sitemap −0.8% — all under
  the gate; svg +0.7% and ooxml-ascii +1.1% (11–12/12 isolates positive but CIs at/below gate,
  ⚪ same: the slice allocation costs on long names); memory unchanged.
  Equiv `SAME` on 5,427 inputs; `typecheck` + `lint` pass. Encoding/bytes checks not run
  (reverted).
- **CI:** not opened (no 🟢 in either full run; no perf PR).
- **Why:** the mechanism is real and broad (10/10 cold rows and 8/10 warm rows negative in the
  clean run, most with CIs below 0 and 12/12-isolate agreement) — `startsWith` with a position
  is indeed slower than `slice` + `===` in every tier, more so early (cold wins exceed warm
  wins). But it caps at −4.8% total-100 (soap), just under the gate: the rest of the end-tag
  path (whitespace skip, `frames.pop()`, `slice` copy) has nothing left to cut, and no r2
  packaging can credibly find the missing fraction (a short/long-name hybrid would re-add the
  per-item branch that killed the 2026-09-30 attribute-names r2).
- **Retry if:** V8 intrinsifies positional `startsWith` (re-measure: if the gap closes, this
  whole entry is obsolete), or someone finds the remaining ~0.5% on soap/s3 without new
  branches. Precedent set here: exactly one documented full re-run is allowed when a run is
  degraded (2× absolutes), reporting every table — not shopping, since the repeat can (and
  here did) fail.

### 2026-09-30: Drop startsWith in the end-tag and entity hot paths (accepted)

- **Hypothesis:** Combining the two near-misses (the prompt blesses this): the 2026-09-30
  end-tag entry (slice + `===`, capped at −4.8% soap) and the entity-decoding entries (first-char
  dispatch, capped at −3.8% entities) remove the same cost — `startsWith` call overhead — on
  disjoint paths, so they stack. s3-ascii (end-tag −4.2% plus 800 `&quot;` dispatches) should
  clear −5% total-100; soap and entities improve secondarily. No new functions, no per-item
  branches beyond restructured (predictable) ones.
- **Change:** `src/entities.ts`: first-character dispatch with integer compares instead of the
  named-entity `startsWith` chain (size pins the length, so matching the rest is exact) and the
  `isXmlChar()` range check inlined into the numeric branch with the helper deleted.
  `src/parse-string.ts`: end-tag match via `xml.slice(lt + 2, lt + 2 + name.length) !== name`
  instead of `startsWith(name, lt + 2)` (identical accept/reject, slice clamps like
  `startsWith`). No warm-up change: every restructured branch (all five named references,
  numeric decimal/hex, end tags) is already reached by both warm-up documents in both string
  representations.
- **Measured:** base `c60d285` → candidate; workerd 1.20260815.1.
  Quick (10 cold / 4 warm): cold entities −5.3% (CI crossing 0), s3-ascii −4.3%, sitemap −3.1%,
  soap −2.6%, svg −2.3% — all same-direction, none 🟢; warm s3-ascii −3.9%, entities −3.4%,
  soap −3.3%, sitemap −2.0% (all with CIs below 0, 4/4 isolates negative), svg +0.2%.
  Full (60 cold / 12 warm): cold soap −5.4% (−8.1…−2.3) 🟢, s3-ascii −5.5% (−7.7…−3.0) 🟢,
  entities −5.8% (−8.9…−2.3) 🟢, rss-crlf −4.9%, sitemap −3.3%, rss-ascii −2.9%,
  rss-poison −3.0%, ooxml-ascii −1.9%, svg −1.2%, rss-small −5.3% (CI spanning ±15,
  inconclusive as always) — no 🟡/🔴; warm s3-ascii −4.6%, entities −3.6%, soap −3.1%,
  rss-crlf −3.7%, rss-small −3.4%, rss-ascii −2.3%, rss-poison −1.6%, sitemap −1.8%,
  ooxml-ascii +0.8% and svg −0.3% (both ⚪ same, under the gate); memory unchanged everywhere
  (rss-ascii −2.2% baseline offset).
  Encodings (`rss-latin1,rss-cjk,ooxml-cjk,s3-cjk`): cold and warm all ⚪ same, no 🟡/🔴
  (two-byte fixtures improve too: rss-cjk cold −3.2%, s3-cjk warm −3.2% on 12/12 isolates).
  `src/decode.ts` untouched, so no bytes-input check needed.
- **CI:** perf-local watched before merge (required: no 🔴 row and at least one of the local
  🟢 total-100 rows 🟢 again); `perf-remote` label not added (report-only).
- **Why:** the two overheads stack as predicted (each part measured separately in its own
  entry). `startsWith` — positional or chained — costs ~one slow call per use in every tier;
  integer compares and `slice` + `===` do not. Entity-free, attribute-heavy docs (svg, ooxml)
  gain least (end-tag half only, minus slice allocation on long names: warm +0.8%/−0.3%).
- **Retry if:** accepted — future loops build on this. Revisit only if V8 intrinsifies
  positional `startsWith` (then the end-tag half is obsolete) or speeds string equality
  past slicing (then reformulate).

### 2026-10-01: No feedback-starved deopt after the first top-tier compile (accepted)

- **Hypothesis:** Ablations and profiles only see steady-state time, but `total-100` also holds
  every compile. A per-request trace of fresh isolates (`--trace-opt --trace-deopt`, one parse
  per request, no warm-up, as the cold bench runs) showed where soap's and s3-ascii's extra
  cold time goes: their top-tier (Turbofan) compile of `parseString` lands early (parse ~9–10),
  deoptimizes on its first run ("Insufficient type feedback for generic named access"), and
  the following parses pay a Maglev recompile (~2.3 ms), a few Maglev-speed parses and a
  **second** Turbofan compile (14–18 ms). The deopt sites (`--trace-deopt-verbose`) were inlined
  helpers that run once per parse: first `checkDeclaration()` (`DECLARATION_RE.exec`), and once
  that was moved, `resetParser()` (`scratch.length = 0`). A helper called once per parse gets
  its feedback vector only after ~8 calls (lazy feedback allocation: a budget of bytecode
  length × 8; `checkDeclaration`'s skipped `fail()` branches hand budget back, so it took even
  longer), so when the parser tiers up around parse 10 the helper has no feedback, yet Turbofan
  inlines it and plants a soft deopt. Code inside `parseString` has feedback from parse 2 on
  (its loop allocates the vector during parse 1). Moving both bodies into `parseString` should
  remove the deopt and the second compile: soap and s3-ascii −15…−20% total-100, every other
  fixture neutral (they tier up later, after the helpers have feedback, and showed no deopt).
- **Change:** `src/parse-string.ts` only: `checkDeclaration()`'s three lines inlined into the PI
  branch (same regex, same errors at the same offsets) and the function deleted; at the end of
  a successful parse, the five reset statements inline instead of the `resetParser()` call.
  `resetParser()` stays exported for `parse()`'s catch and `warmup()`. No new path, so no
  warm-up change (both warm-up documents run the declaration and the end of a parse).
- **Measured:** base `44c7b71` → candidate `44c7b71`+dirty; workerd 1.20260815.1.
  Trace, one isolate each (TOTAL of 100 per-request parses, ms): s3-ascii 95/86 → 67/80, soap
  98/96 → 75/71, svg 123 → 119/143 (noise); after the change both show exactly one Maglev and
  one Turbofan compile of `parseString` and no deopt.
  Quick (`s3-ascii,soap,svg`; 10 cold / 4 warm): cold s3-ascii −25.6% 🟢 (−29.2…−17.9), soap
  −23.2% 🟢 (−28.4…−19.4), svg +0.0% ⚪; warm all ⚪ (+0.4…+1.2%).
  Full (60 cold / 12 warm): cold soap −21.3% 🟢 (−23.1…−19.7), s3-ascii −22.4% 🟢 (−25.1…−19.6),
  all other rows ⚪ same (rss-ascii −0.6%, rss-poison +0.8%, rss-small −6.6% with its usual
  ±11 CI, rss-crlf +0.9%, svg +1.2%, ooxml-ascii −0.7%, sitemap +0.6%, entities −0.2%); warm all
  ⚪ within −0.2…+0.7% (12/12 isolates within ±3.3%); memory unchanged (rss-ascii −2.2%
  baseline offset).
  Encodings (`rss-latin1,rss-cjk,ooxml-cjk,s3-cjk`): cold s3-cjk −18.4% 🟢 (−21.0…−16.0), the
  others ⚪ (rss-latin1 +0.6%, rss-cjk −0.8%, ooxml-cjk +0.1%); warm all ⚪ (−0.7…−0.1%).
  Equiv `SAME` on 5,427 inputs; lint, typecheck, 157 unit tests, fuzz (20,000 inputs), size
  (7.74 kB) pass; conformance 1263/1736 = main.
  `src/decode.ts` untouched, so no bytes-input check needed.
- **CI:** perf-local watched before merge (required: no 🔴 row and soap or s3-ascii total-100
  🟢 again); `perf-remote` label not added (report-only).
- **Why:** the cost was never execution but a compile thrown away: a one-time deopt in the
  first ~10 parses costs a whole second top-tier compile (14–18 ms on a ~90 ms total). It hit
  soap and s3-ascii because those reach Turbofan earliest (parse 9–10, minified and dense);
  rss reaches it at ~16, after the helpers have feedback. svg reaches it at ~9 too but showed
  no deopt (not investigated; most likely its compile didn't inline the helpers). Every document
  that tiers up early benefits (the reset runs at the end of every parse, the declaration check
  on every document with a declaration); after `warmup()` the helpers usually have feedback
  already.
- **Retry if:** accepted. Lessons for future loops: (1) trace the cold timeline per request
  (`--trace-opt --trace-deopt`, one parse per request in a fresh isolate: `spikes/s5/trace.mjs`
  with the parse loop replaced by one parse per request and a parse-number marker) before
  profiling —
  compiles and deopts are a large share of `total-100` (svg: ~24 ms Turbofan + ~4 ms Maglev of
  ~120 ms) and invisible to warm profiles and ablations; (2) don't put once-per-parse work in a
  small helper that `parseString` calls: V8 inlines it without feedback. Still open from the
  same traces: `decodeEntities` deopts once in Maglev during parse 1 at `source.length` (the
  "no further `&`" branch, reached only at the document's last entity; s3, sitemap, entities;
  ~0.5 ms, under the gate on its own).

### 2026-10-01: Comments and PIs outside parseString's top-tier compile (failed)

- **Hypothesis:** After the previous entry, every fixture pays exactly one Turbofan compile of
  `parseString`. It is the largest single item in `total-100`: rss ~22 ms of ~60, svg 25–30 of
  ~120, s3/soap ~15 of 65–75 (per-request traces). Turbofan inlines only `normalize` here
  (`--trace-turbo-inlining`), so the compile is `parseString` itself, and its time tracks the
  paths a document has run: s3/soap ~15 ms; rss, which adds comments, CDATA and PIs, ~22; svg,
  which also has a DOCTYPE, ~27. Comment and PI handling (~900 of 4,140 bytecode bytes) runs a
  few times per document but is compiled in full. Moved into one helper larger than Turbofan's
  460-byte inlining limit (`--max-inlined-bytecode-size`), it is called instead of compiled:
  a few ms less compile on every fixture, most where comments or PIs exist (rss, svg). The
  helper must not be small: a small once-per-parse helper is inlined without feedback and
  deoptimizes (previous entry). CDATA stays inline (one per RSS item), and so does DOCTYPE
  (svg only, ~140 bytes).
- **Change:** `src/parse-string.ts`, three rounds, all reverted; only this log ships.
  (r1) New `markup(xml, lt, cr, maxNameLength, bom)` (834 bytecode bytes) with the comment and
  PI branches verbatim (declaration check included). It returns the node, or null for the
  declaration, and reports the end position and the updated `\r` memo in two module-level
  numbers, so no node reference outlives a parse. `parseString` (4,140 → 3,193 bytes) calls it
  from one site, `c === 63 || <!--`, ahead of the CDATA/DOCTYPE branch.
  (r2) Same helper, but main's branch structure kept exactly: two call sites, the comment one
  inside `c === 33` and the PI one in `c === 63` (`parseString` 3,249 bytes).
  (r3) Only the PI branch outlined (helper 588 bytes, `parseString` 3,495); comment inline
  again.
  Equiv `SAME` on 5,427 inputs in every round. No warm-up change was needed: block coverage of
  `warmup()` left only error paths, two `cr = length` assignments and a comment containing CR
  unrun in `markup()`, the same as in `parseString`.
- **Measured:** base `a2c6f26` → candidate `a2c6f26`+dirty; workerd 1.20260815.1.
  r1 traces (Turbofan compile of `parseString`, 3 fresh isolates each, ms): rss-ascii
  22.0/24.3/24.7 → 16.1/17.7/16.0, svg 28.3/26.0/25.4 → 20.3/20.3/20.7, s3-ascii
  15.8/15.2/20.2 → 14.3/12.0/11.7, soap 15.4/15.5/18.2 → 12.2/12.1/12.0; Maglev compiles
  −0.5 ms.
  r1 quick (`rss-ascii,svg,soap`; 10 cold / 4 warm): cold svg −5.6% 🟢, rss-ascii −6.0% and
  soap −5.4% ⚪ (CIs crossing 0); warm ⚪ (rss-ascii +2.7%, svg −0.2%, soap +0.6%).
  r1 full (60 cold / 12 warm): cold rss-ascii −11.2% 🟢 (−16.4…−5.6), rss-poison −8.7% 🟢,
  rss-small −14.2% 🟢, rss-crlf −6.1% 🟢, svg −6.9% 🟢 (−8.7…−5.2), soap −6.2% 🟢, s3-ascii
  −6.4% 🟢, ooxml-ascii −4.6% ⚪, sitemap −3.4% ⚪, entities −4.4% ⚪.
  Warm: all ⚪, but rss is slower with CIs above 0: rss-ascii +2.3% (+0.2…+4.5), rss-poison
  +1.5%, rss-small +2.0%, rss-crlf +1.2%. Also soap +0.9%, sitemap +0.9%, s3-ascii +0.6%,
  ooxml-ascii +0.5%, entities +0.3%, svg −0.6%. Memory unchanged.
  r1 encodings: cold rss-latin1 −12.3% 🟢, rss-cjk −11.7% 🟢, ooxml-cjk −2.4% ⚪, s3-cjk −3.8% ⚪;
  warm **rss-latin1 +2.8% 🟡 slower** (+0.8…+5.2, 11/12 isolates positive), rss-cjk +1.5%,
  s3-cjk +1.8%, ooxml-cjk +0.1%.
  A warm CPU profile of rss-latin1 (6,000 parses) put `markup` at 0.2% of samples, so the
  helper's own work isn't the cost.
  r2 quick (`rss-latin1,rss-ascii,s3-cjk`; 10 cold / 12 warm): cold rss-latin1 −9.3% 🟢,
  rss-ascii −11.3%, s3-cjk −6.2% (⚪, CIs crossing 0); warm rss-latin1 +2.3% (+0.1…+4.6),
  rss-ascii +1.5% (+0.4…+2.8), s3-cjk +1.0%: main's branch structure doesn't remove it.
  r3 quick (`rss-latin1,rss-ascii,svg`; 10 cold / 12 warm): cold all ⚪ (rss-latin1 −6.9%,
  rss-ascii −2.4%, svg −4.5%); warm rss-latin1 +2.4%, rss-ascii +2.1% (+0.1…+3.2; 11/12
  isolates positive), svg −2.3% (one −25.9 isolate).
  Encoding and bytes checks for r2/r3 not run (failed on the warm rows; `src/decode.ts`
  untouched).
- **CI:** not opened (failed locally; no perf PR).
- **Why:** the compile saving is real and large (−3…−8 ms of Turbofan compile per isolate;
  −6…−14% `total-100` on 9 of 14 rows in r1). But every packaging also makes rss warm ~2%
  slower, at or just past the 🟡 line. The hot paths are byte-identical in source in r2/r3
  and the helper's own time is negligible. So the loss is in how Turbofan compiles the smaller
  `parseString` (register allocation, block layout), which no source change tried here
  controls. The cost lands on text-heavy pretty-printed RSS (CDATA per item, whitespace text,
  entities in links), and svg is slightly faster: it isn't the extra call per document.
- **Retry if:** the warm loss can be explained and avoided. One way to look: compare
  `parseString`'s optimized code (size, spills) on rss between base and r2. That needs a V8
  build with `--print-opt-code`, which release workerd lacks. Or if a V8 update changes
  Turbofan's codegen for this loop, or if the gate starts weighing cold above warm.
  Notes for future loops:
  (1) Per-request Turbofan compile time (`--trace-opt`, 3 fresh isolates) is a precise way to
  measure compile-side ideas; `total-100` alone can't resolve 2–3 ms.
  (2) Also tried while choosing this idea, and not pursued: earlier tier-up (simulated with
  halved `--invocation-count-for-*` budgets, which is what a smaller `parseString` buys).
  Maglev then arrives by OSR during parse 1 and deoptimizes three times on paths parse 1
  hadn't reached ("insufficient type feedback"). `total-100` didn't improve (svg 124/118 vs
  123/115, s3 72/72 vs 66/64).
  (3) `spikes/m7-profile.mjs` no longer starts: workerd 1.20260815.1's V8 rejects
  `--no-lazy-source-positions`. Drop the flag to use it (outside this loop's scope to fix).

### 2026-10-01: Name cache with attribute-name prediction (failed)

- **Hypothesis:** A warm `--prof` profile (attribution below) puts `NAME_RE.test()` at 17–31% of
  warm time on every fixture but entities (rss 20%, svg 31%, soap 24%, ooxml 24%, s3 18.5%,
  sitemap 16.6%, entities 9.6%), and more than half of that is the `RegExpPrototypeTestFast`
  builtin's call overhead, not the match. Documents repeat a small set of names. A direct-mapped
  cache of the last element per hash of the four characters after "<" lets a repeated start tag
  take the cached name after a slice + `===` check, and the cached element's attribute list
  predicts the new element's attribute names, checked the same way. Equivalent: a hit needs the
  exact characters and then one that ends a name, so NAME_RE would match exactly the cached
  (already validated) name. Simulated hit rate: ~99% for element and attribute names on every
  large fixture (256 slots), 55–80% on rss-small/s3-small. Attribute-heavy fixtures (svg, soap,
  ooxml) should gain most, and repeated names stop allocating a string each (less retained memory).
- **Change:** `src/parse-string.ts` only; two rounds, reverted; only this log ships. Module-level
  `recent` (256 elements, empty slots hold a dummy named "/", which no start tag can match),
  `usedSlots` (reset at the end of a parse and in `resetParser()`, so no node outlives a parse).
  (r1) slot = `((c·31 + c2)·31 + c3)·31 + c4 & 255`, the element is stored on every start tag.
  (r2) slot = `(c << 6 ^ c2 << 4 ^ c3 << 2 ^ c4) & 255` (no overflow checks; same simulated
  hit rates), stored only after a miss of the name or any attribute name (r1's store paid a
  write barrier, `RecordWriteSaveFP` 3–4% of warm time). Misses run the old NAME_RE code
  unchanged. Strict equivalence (full error messages, 64,908 inputs incl. multi-character and
  name-boundary mutations under four limit settings) `SAME` in both rounds. Warm-up not extended
  (it failed before that step).
- **Measured:** base `0fa3edf` → candidate `0fa3edf`+dirty; workerd 1.20260815.1.
  r1 quick (`svg,soap,s3-ascii,rss-ascii`; 10 cold / 4 warm): warm svg −14.4% 🟢 (−16.2…−12.0),
  soap −9.5% 🟢, s3-ascii −4.5% 🟢, rss-ascii −3.9% 🟢; cold all ⚪ (svg −2.8%, soap −0.2%,
  s3-ascii +1.3%, rss-ascii −13.7% with a ±23 CI).
  r2 quick (plus sitemap): warm svg −15.4% 🟢 (−16.7…−13.6), soap −11.4% 🟢, sitemap −6.0% 🟢,
  s3-ascii −6.8% 🟢, rss-ascii −5.0% 🟢; cold svg −2.1%, soap +0.9%, s3-ascii −2.3%,
  sitemap −3.8% (all ⚪), rss-ascii +12.2% 🟡 inconclusive (−3.8…+32.7).
  Per tier (`bench:ab`, r2): Ignition +6…+10%, Sparkplug 0…+7%, Maglev −11…−17%,
  Turbofan −4…−12%.
  Compile (per-request trace, 3 fresh isolates each): `parseString` bytecode 4,231 → 4,738
  bytes; Turbofan compile s3-ascii 15.6 → 18.7 ms, svg 25.7 → 29.4 ms; Maglev +0.5…+0.8 ms.
  Ablations of the +3.1 ms on s3: the three extra `charCodeAt` for the hash ~1.1 ms, attribute
  prediction ~0.7 ms, slot reset loop ~0.4 ms, the rest ~1 ms.
  Small documents (`bench:cold`, 40 isolates): rss-small 6.04 → 6.92 ms (+14.6%), s3-small
  5.54 → 5.96 ms (+7.6%). They never reach Turbofan within 100 parses. Their Maglev compile of
  `parseString` (rss-small 3.9 → 4.6 ms, s3-small 2.7 → 3.4 ms) is ~65% of their total.
  No full run (rss-small would be 🔴 or 🟡), no encoding/bytes checks.
- **CI:** not opened (failed locally; no perf PR).
- **Why:** the mechanism works (regex gone from the profiles, warm −5…−15% on all five large
  fixtures), but it costs 507 bytes of bytecode, and in this parser compile time is paid per
  byte that runs: ~6 µs per byte in Turbofan, ~1.4 µs in Maglev. Large documents give back most
  of their warm win as compile, so cold stays within noise. For small documents the Maglev
  compile is most of `total-100`, so they get slower. The hit path itself also isn't free:
  the slice + `StringEqual` check costs ~9 ns per start tag, against ~30 ns per NAME_RE test.
- **Retry if:** the same commit removes at least ~500 bytes of compiled bytecode from
  `parseString`. The 2026-10-01 comments/PIs outlining (−950 bytes; failed only on a ~2% rss
  warm loss, which this idea's −5% rss warm more than offsets) is the obvious partner: measure
  that combination. Or someone finds a cache packaging of under ~150 bytes.
  Notes for future loops:
  (1) V8's tick profiler works in local workerd: `--prof --no-logfile-per-isolate
  --logfile=<path>` in the V8 flags. `node --prof-process` lumps embedded builtins into the
  workerd binary (47% "shared library"). Instead, attribute each tick's pc to the log's own
  `code-creation,Builtin,…` entries: that splits warm time into `parseString`, regex code,
  `RegExpPrototypeTestFast`, `StringSubstring`, `StringIndexOf`, `StringEqual`, and so on. The
  scripts lived in the session scratchpad and weren't kept.
  (2) For small documents, `parseString`'s Maglev compile is ~65% of `total-100`. Any bytecode
  added to `parseString` costs rss-small about 1.4 ms per KB; removing bytecode helps it as much.
  (3) The attribute-value memo `WS_RE` scans to the end of minified documents once per parse
  (s3 2.5–3.6% of warm time, soap 1.8%): a possible small target.

### 2026-10-01: Name cache, paid for by moving comments and PIs out of parseString (accepted)

- **Hypothesis:** The previous two entries are near-misses that fail for opposite reasons. The
  name cache cuts warm time 5–15%, but its 507 bytecode bytes cost as much compile as it saves.
  Moving comments and PIs out (−950 bytes) saves 3–8 ms of compile but cost rss ~2% warm. Together
  `parseString` ends up smaller than on main, so compile time goes down while the cache's warm
  win stays, and the warm win covers the outlining's rss loss. Every fixture should improve in
  `total-100`, small documents shouldn't get slower, and retained memory should drop: repeated
  names become one shared string.
- **Change:** `src/parse-string.ts`: the name cache exactly as in r2 of the name-cache entry,
  plus `markup()` (834 bytecode bytes, over Turbofan's 460-byte inlining limit) holding the
  comment and PI branches verbatim (declaration check included). It returns the node, or null
  for the declaration, and reports the end position and the `\r` memo in two module-level
  numbers. `parseString` calls it from one site (`c === 63` or `<!--`), ahead of the
  CDATA/DOCTYPE branch: 4,231 → 3,698 bytecode bytes. `src/warmup.ts`: repeated `<v>`, `<c>` and
  `<abcd>` start tags, so the warm-up runs every hit and miss kind of both caches (counted with
  an instrumented copy: element hit, empty slot, delimiter miss, slice miss; attribute hit after
  `=` and after whitespace, no prediction, past the list, delimiter miss, slice miss). Block
  coverage leaves the same plain assignments unrun as on main. `test/unit/warmup.test.ts`
  asserts the added nodes. `test/unit/strict.test.ts` has three new tests: repeated, extended
  and reordered names; rejection after a repeated name; and a cache emptied after a parse and
  after an error.
- **Measured:** base `0fa3edf` → candidate `adefaf3`+dirty (src as on main); workerd 1.20260815.1.
  Trace (one fresh isolate each, ms): Turbofan compile of `parseString` rss-ascii 21–25 → 19.3,
  svg 26–31 → 24.0, soap 15.9 → 15.3, s3-ascii 15.6 → 14.9, sitemap 17.6 → 15.1, entities
  16.3 → 14.7, ooxml-ascii 16.0 → 16.9; Maglev rss-small 3.9 → 3.6, s3-small 2.7 → 2.8. No new
  deopt. `markup()` stays in Ignition/Sparkplug within 100 parses.
  Quick (`rss-ascii,rss-small,rss-latin1,svg,s3-ascii,soap`; 10 cold / 4 warm): cold svg −17.2%
  🟢, s3-ascii −7.7% 🟢, soap −4.4%, rss-latin1 −12.5%, rss-small −2.7%, rss-ascii +0.3% (⚪);
  warm svg −16.6%, soap −12.5%, s3-ascii −10.5%, rss-latin1 −7.9%, rss-ascii −7.2% (🟢),
  rss-small −0.9% ⚪.
  Full (60 cold / 12 warm; load 0.7, absolutes as in the quick round):
  cold svg −15.1% 🟢 (−17.0…−13.3), rss-ascii −8.5% 🟢 (−15.0…−1.5), rss-crlf −7.0% 🟢,
  s3-ascii −7.0% 🟢, ooxml-ascii −7.0% 🟢, soap −5.5% 🟢 (−7.5…−3.3), sitemap −3.9% 🟢
  (−6.4…−1.0, warm CI below 0), rss-poison −3.2% ⚪, entities +0.3% ⚪ (−1.9…+2.5),
  rss-small +2.5% ⚪ (−9.3…+15.9); no 🟡/🔴.
  Warm: svg −16.5%, rss-poison −15.3%, soap −12.8%, ooxml-ascii −11.4%, s3-ascii −9.9%,
  sitemap −7.9%, rss-crlf −7.8%, rss-ascii −6.2%, entities −3.5% (all 🟢, all 12 isolates
  negative), rss-small −1.0% ⚪.
  Retained tree: −8.6% (entities) to −33.8% (svg, 331 → 219 KB, now below txml's 272 KB);
  rss −25…−27%, soap −29%, ooxml −30%, s3 −26%, sitemap −21%.
  Encodings (`rss-latin1,rss-cjk,ooxml-cjk,s3-cjk`): cold rss-latin1 −7.0%, rss-cjk −8.6%,
  ooxml-cjk −14.3%, s3-cjk −4.6% (all 🟢); warm −5.7%, −14.9%, −18.2%, −13.8% (all 🟢); memory
  −25…−30%. `src/decode.ts` and byte input untouched, so no bytes check.
  Equiv `SAME` on 5,427 inputs, and on 64,908 inputs with full error messages and limits;
  lint, typecheck, 160 unit tests, fuzz (20,000 inputs), size (8.69 kB brotlied), conformance
  1263/1736 = main.
- **CI:** perf-local watched before merge (required: no 🔴 row and at least one of the local 🟢
  total-100 rows 🟢 again); `perf-remote` label not added (report-only).
- **Why:** the two parts trade compile size against warm speed and add up as predicted.
  `parseString` compiles faster than on main (−0.5…−6 ms Turbofan) and runs 4–17% faster warm,
  because most names skip the NAME_RE call (~30 ns each) for a slice + `===` (~9 ns). rss's warm
  loss from outlining disappeared. Either the cache's gain hides it, or it was a layout effect of
  that build of `parseString`. entities gains least: it has few distinct names, and its time is
  entity decoding. Memory drops because a repeated name is stored once instead of as one
  string per node (short slices are copies in V8).
- **Retry if:** accepted. Lessons for future loops: (1) in this parser, compile size and warm
  speed can be traded against each other. An idea that only fails on compile cost can be paired
  with an outlining that removes as many bytecode bytes; measure the bytecode length
  (`spikes/s5/bytecode.mjs` with `FILTER=parseString`) and the per-request compile times. (2)
  The cache's key is the four characters after "<", so prefixed names (`w:p`, `m:Order`) still
  separate; with two characters, ooxml and soap hit almost never (simulated).

### 2026-10-01: indexOf memos instead of the attribute-value whitespace regex (failed)

- **Hypothesis:** After the name cache, a warm `--prof` profile shows the attribute-value memo
  `WS_RE` (`/[\t\n\r]/g`, next tab/newline/CR) at 6.4% of svg warm time (3.0%
  `RegExpPrototypeTestFast` + 3.4% regex code), 4.2% of entities and 2% of s3. In svg it refreshes
  once per element line, and in minified documents it scans to the end once per parse. Three
  `indexOf` memos (`\n`, `\t`, and the existing `\r`), with `tabOrBreak` kept as their minimum
  and only the memos that fell behind refreshed, should cost an `indexOf` (~6 ns) instead of a
  regex call (~30–40 ns): svg warm about −4…−6%, the others −1…−3%. M7 rejected "indexOf memos
  for newline/tab" at −3…+7% (noise), but that predates the paired bench and the name cache,
  which roughly doubled this cost's share.
- **Change:** `src/parse-string.ts` only, one round, stacked on the name-cache commit (`c8a4f82`,
  PR #44): `WS_RE` removed; locals `tab` and `lineFeed`; the refresh updates whichever of
  `lineFeed`, `tab` and `cr` is behind `valueStart` and takes the minimum. Same mode decision, so
  identical output; strict equivalence `SAME` on 64,908 inputs. Bytecode 3,698 → 3,790 bytes.
  Warm-up coverage unchanged except two plain assignments. Reverted; only this log ships.
- **Measured:** base `c8a4f82` (PR #44, `BASE=perf/name-cache-markup-out`) → candidate
  `c8a4f82`+dirty; workerd 1.20260815.1. Quick (`svg,soap,s3-ascii,entities,rss-ascii`; 10 cold /
  4 warm): warm s3-ascii −3.0% 🟢 (−3.6…−2.4), entities −2.9%, soap −1.8%, svg −2.5% (isolates
  −1.0/−1.5/−8.5/+1.3), rss-ascii −0.8% (⚪); cold svg −3.2% (−7.6…+1.0), rss-ascii −7.2% (±11),
  s3-ascii −1.3%, soap +2.1%, entities +2.0% (all ⚪). No full run, no encoding/bytes checks.
- **CI:** not opened (failed locally; no perf PR).
- **Why:** real but small. svg's per-line refresh saves less than the profile suggested, and when a
  document has no tab, the tab memo scans to its end once per parse (≈1% of a 100 KB parse).
  About −1…−3% warm is ≈ −1…−2% cold after the 92 extra bytecode bytes are compiled, under the
  gate's 3%.
- **Retry if:** combined with another small warm win on the same paths, or if a document class
  with many attribute-bearing lines (svg-like) is added to the gate. A variant without the tab
  memo's full scan (for example, tabs checked per value only when the value is long) was not
  tried.

### 2026-10-01: Fewer charCodeAt sites to cut Turbofan's loop unrolling (failed — diagnostic)

- **Hypothesis:** Turbofan's compile of `parseString` (15–25 ms per isolate) is now the largest
  single item in `total-100`. Node's `--turbo-stats` (V8 13.6; same pipeline, svg 23 ms like
  workerd's 24) puts register allocation at 28% and Turboshaft's optimization at 32%, with
  `TurboshaftLoopUnrolling` 1.4 ms and 14% of the compile's memory. With
  `--no-turboshaft-loop-unrolling` (diagnosis only; a flag can't ship), workerd compiles
  `parseString` 3–6 ms faster (s3 15.1 → 12.0, rss 19.6 → 15.1, svg ~24.5 → 18.3). A synthetic
  function with 40 `charCodeAt` sites and no JS loop compiles in 12.3 ms in workerd, 5.5 ms
  without unrolling: each `charCodeAt` lowers to a small loop over string representations
  (cons, sliced, thin), and Turboshaft partially unrolls each one ×4. `parseString` has 21 such
  sites. Fewer sites should mean less compile.
- **Change:** `src/parse-string.ts`, two equivalent variants, compile time measured only
  (per-request trace, 3 fresh isolates each); reverted, only this log ships.
  (v1) the text and end-tag whitespace loops as `do … while` with one `charCodeAt` site each
  instead of two. (v2) the name-cache hash read through a one-site loop
  (`for (k = lt + 2; k < lt + 5; k++) slot = (slot << 2) ^ xml.charCodeAt(k)`) instead of three
  sites.
- **Measured:** base `e0ca77a` → candidate +dirty; workerd 1.20260815.1. Turbofan compile of
  `parseString`: base s3-ascii 15.1/15.3, rss-ascii 19.5/19.8 ms; v1 s3 16.2–16.5, rss
  20.7–20.9 (+1.2 ms); v2 s3 15.2–15.8, rss 19.7–20.0 (no change). No bench:pr round (no compile
  saving to measure).
- **CI:** not opened (failed locally; no perf PR).
- **Why:** removing sites in source doesn't remove lowered loops one for one. Turbofan's own loop
  peeling copies the first iteration of each innermost JS loop, and a `do … while` or a short
  `for` adds loop structure of its own, so the graph stays the same size or grows.
- **Retry if:** V8 stops unrolling the `charCodeAt` lowering loop (re-measure the synthetic: if
  12.3 vs 5.5 ms closes, this entry is obsolete), or someone finds a construct that reads a
  character without that loop. Notes for future loops: (1) Node's `--turbo-stats` works for
  Turbofan phase timings (workerd's are lost when it's killed); `spikes`-style scripts lived in
  the scratchpad. (2) Compile time doesn't follow bytecode size alone: measure each variant.

### 2026-10-01: Named entities without the ";" search (failed)

- **Hypothesis:** `decodeEntities` searches for ";" with `indexOf` before it looks at the name.
  The five named references pin the position of ";" (no name character is ";"), so checking
  the characters and the ";" directly saves one `indexOf` per named reference (~4,500 per parse
  on entities). Expected: entities warm −6…−8%, sitemap/s3 −2…−4%, entities cold ≈ −3%.
- **Change:** `src/entities.ts` only, one round: the named references (`amp` first, then `quot`,
  `lt`/`gt`, `apos`) matched by integer compares including the ";". Only the remaining cases
  (numeric references, unknown names, a missing ";") take the search and the old checks, in
  the old order, so the errors are the same. A match never crosses `end`, which is a "<", a quote
  or the end of the input. Reverted; only this log ships.
- **Measured:** base `c8a4f82` (src as on main `e0ca77a`) → candidate +dirty; workerd
  1.20260815.1. Equivalence: `SAME` on 5,427 and 64,908 inputs, and on 200,000 random
  entity-fragment documents (text, attributes, CDATA; full error messages).
  `decodeEntities`' Turbofan compile on entities 5.9–6.4 → 6.6 ms; no new deopt.
  Quick (`entities,sitemap,s3-ascii,rss-ascii,soap`; 10 cold / 4 warm): warm entities −7.2% 🟢,
  sitemap −4.7% 🟢, s3-ascii −3.7% 🟢, rss-ascii −2.0%, soap −1.2%; cold all ⚪ (entities −1.5%).
  Full (60 cold / 12 warm): warm entities −6.9% 🟢 (−7.7…−5.4), sitemap −3.0% (−3.6…−2.3),
  s3-ascii −1.9%, all else within ±1% ⚪; cold entities −0.6% (−3.0…+1.7), sitemap −1.9%
  (−4.2…+0.2), s3-ascii −1.4%, rss-poison −4.2% (±9), all ⚪, no 🟡/🔴. Memory unchanged.
  No encoding/bytes checks (failed).
- **CI:** not opened (failed locally; no perf PR).
- **Why:** the warm saving is real (one builtin call per entity), but `total-100` sees little of
  it. On entities, `parseString` reaches Turbofan only at parse ~19 and `decodeEntities` at ~5,
  so the warm-tier share is smaller than on other fixtures. In Ignition and Sparkplug the four
  or five `charCodeAt` calls cost about as much as the `indexOf` they replace, and the larger
  function compiles ~0.5 ms slower.
- **Retry if:** combined with another `decodeEntities` saving that pays in the first parses. The
  open item from the 2026-10-01 deopt entry is a candidate: the Maglev deopt at `source.length`
  in parse 1 (≈0.5–0.7 ms on s3, sitemap and entities). Or if the gate adds an entity-heavy
  fixture that tiers up early.

### 2026-10-01: Name checks without slices (failed)

- **Hypothesis:** A per-request `--trace-gc` shows scavenges taking 7–11% of `total-100` (100
  cold parses: s3-ascii 19 scavenges, 6.8 ms; soap 20, 7.9 ms; svg 22, 7.7 ms; rss-ascii 13,
  4.0 ms). Part of the allocation is garbage: every name check slices a temporary string only to
  compare it (end tags, name-cache hits, predicted attribute names). An ablation without those
  three checks (not equivalent, one isolate each) cut `total-100` ~15% (s3 66 → 56 ms, svg
  106 → 90) and scavenges by a quarter (s3 19 → 14, svg 21 → 16), so most of the cost is the
  checks' own work (two builtin calls each), not GC. Checks without a slice should recover part
  of it.
- **Change:** `src/parse-string.ts`, two variants, reverted; only this log ships.
  (v1) end tag compared in place: a `charCodeAt` loop over the open element's name instead of
  slice + `===`. (v2) the name cache stores the four characters after "<" of each cached start
  tag in two `Int32Array`s (two UTF-16 code units per int, zeroed with the slot). A start tag
  with an equal window and a name of up to four characters is then checked without a slice
  (window plus the delimiter after the name); longer names still slice. Both `SAME` on 64,908
  inputs.
- **Measured:** base `e0ca77a`; workerd 1.20260815.1.
  v1 `bench:ab` (1 ms clock, ±3%): Sparkplug s3 +35%, sitemap +33%, rss +25%; Maglev s3 +25%,
  sitemap +6%; Turbofan ±0 except sitemap −11%; Turbofan compile s3 15.1 → 16.2 ms. Stopped
  there.
  v2 `bench:ab`: Ignition +2…+5%, Sparkplug 0…+6%, Maglev −13…+1%, Turbofan −6…+8%; compile s3
  15.1 → 15.8 ms. v2 quick (`s3-ascii,sitemap,rss-ascii,ooxml-ascii,svg`; 10 cold / 4 warm):
  warm rss-ascii −3.5% 🟢, ooxml-ascii −3.7% 🟢, svg −1.8%, s3-ascii −1.1%, sitemap −0.1%; cold
  all ⚪ (s3 −7.2% ±10, sitemap −2.5%, ooxml −0.9%, svg +0.3%). No full run.
  Also measured: a synthetic with 40 `codePointAt` sites compiles in 24.2 ms (40 `charCodeAt`:
  11.7 ms), so swapping the read primitive makes compile worse.
- **CI:** not opened (failed locally; no perf PR).
- **Why:** in Ignition and Sparkplug a `charCodeAt` is a builtin call, so a per-character loop
  costs far more than the two builtin calls of slice + `===`. Maglev is in between, and
  Turbofan gains nothing. The window check avoids the calls only for names of up to four
  characters, and it adds packing, two typed-array loads and stores to every start tag, so
  the early tiers lose what the warm tier gains.
- **Retry if:** V8 makes positional `startsWith` (or another non-allocating substring compare)
  as cheap as slice + `===` in all tiers. Then the checks would stop allocating at no cost.
  Note for future loops: GC is 7–11% of `total-100` (scavenges every ~5 parses in a fresh
  isolate). Reducing allocation per parse helps, but the retained tree is fixed by the output
  shape, and the remaining garbage is mostly these check slices.

### 2026-10-01: Attribute loop outside parseString (failed)

- **Hypothesis:** The attribute loop is ~1,000 of `parseString`'s 3,698 bytecode bytes. Documents
  whose only attribute sits on the root (s3, sitemap, entities) run it once per parse, so its
  feedback is complete and Turbofan compiles it in full. In its own function, larger than the
  460-byte inlining limit, those documents would run it in Ignition/Sparkplug, and
  `parseString` would compile ~30% faster. Attribute-heavy documents would compile it
  separately at a similar total cost, plus one call per element with attributes.
  Two other ideas were measured for compile time while choosing this one, both without effect.
  (1) Rarely used values (`maxDepth`, `maxAttributes`, `maxNameLength`, `bom`, `seenDoctype`)
  moved from locals to module scope, against register-allocation time. Node `--turbo-stats`:
  s3 18.0–18.1 → 18.2–18.5 ms, svg 22.8–22.9 → 23.5–23.7 ms.
  (2) The `charCodeAt`-site work in the 2026-10-01 diagnostic entry above.
- **Change:** `src/parse-string.ts` only, one round: `attributes(xml, p, ch, predicted, lt,
  maxAttributes, maxNameLength, amp)` (1,005 bytecode bytes) holds the loop verbatim. It is
  called when the character after the name isn't ">" or "/", and reports the end position, the
  next character, the "&" memo and an attribute-miss flag in module-level variables;
  `tabOrBreak` moved to module scope, reset per parse. `parseString` 3,698 → 2,520 bytes. `SAME` on
  5,427 and 64,908 inputs. Reverted; only this log ships.
- **Measured:** base `e0ca77a`; workerd 1.20260815.1.
  Trace (one fresh isolate each): `parseString` Turbofan compile s3 15.1 → 11.1 ms, sitemap
  15.0 → 10.8, soap 15.3 → 10.2, ooxml 16.9 → 11.7, rss 19.5 → 15.0, svg 24 → 18.6. Maglev
  −0.8…−1.0 ms; rss-small Maglev 3.6 → 2.6. On svg `parseString` now tiers up much later (Maglev
  #12, Turbofan #25). `attributes()` compiles in ~5.5 ms Turbofan where attributes are dense,
  and on soap and ooxml it deoptimizes once in Maglev at parse 2 ("insufficient type
  feedback"): its first compile, during parse 1, comes before the name cache's predictions run.
  Quick (`s3-ascii,sitemap,svg,soap,rss-ascii,ooxml-ascii`; 10 cold / 4 warm): warm svg +6.0%
  🔴 (+4.4…+8.5), soap +5.2% 🔴, ooxml-ascii +3.9% 🟡 slower, rss-ascii +1.8%, s3 +1.8%, sitemap
  +0.5%; cold sitemap −9.0% (−15.3…+0.7), s3 −4.6%, ooxml −0.4%, soap +0.5%, svg +3.7%,
  rss-ascii +12.6% (🟡 inconclusive, ±24). No full run.
- **CI:** not opened (failed locally; no perf PR).
- **Why:** the compile saving is real, but each element with attributes pays a call with eight
  arguments and four module-level results (~25–30 ns). On svg, soap and ooxml that's 4–6% of
  warm time, and their cold totals don't gain because the compile only moves to the new
  function.
- **Retry if:** the call can be made nearly free. For example, a version that passes and returns
  almost nothing: parse state in one reused object, end position as the return value. Or if
  the gate weighs attribute-light documents more. The compile numbers above give the upside:
  about −4 ms of Turbofan compile per isolate on s3 and sitemap.

### 2026-10-01: Skip the duplicate and maxAttributes checks for predicted attribute names (accepted)

- **Hypothesis:** The ablation appendix of the entity-decoding entry measured the duplicate-
  attribute check at ~8% of svg warm time, with "no legal angle" then. The name cache (#44)
  creates one: while a start tag's attribute names match the cached element's names in order,
  they are a prefix of a list that passed the duplicate check and the maxAttributes check in this
  parse, with the same limits. Neither check can fail, so both can be skipped. Attribute-heavy
  documents with repeated elements (svg) should gain warm and cold; others are neutral.
- **Change:** two rounds.
  (r1, rejected) a lean inline loop for predicted names (no regex, no duplicate or
  maxAttributes check), with everything else (no prediction, a different or an extra name)
  continued in an out-of-line `attributes()` (958 bytecode bytes; `parseString` 3,698 → 3,380).
  Attribute-light documents then never ran the inline loop, so Turbofan compiled `parseString`
  ~4 ms faster on s3 and sitemap. Warm-up extended so the inline loop saw every value kind.
  (r2, shipped) `src/parse-string.ts` only: in the existing loop, `onPrediction` stays true
  while every name hit the prediction, and the two checks run only once it's false. The
  duplicate check's Set (used beyond 16 names) is now built from all names so far the first
  time it's needed (`seenReady`), since the check may start late. No new path for the
  warm-up: block coverage unchanged. `test/unit/strict.test.ts`: three tests (duplicate after
  predicted names, also beyond 16; maxAttributes after predicted names; predicted, extra and
  reordered names with entities, quotes and tabs).
- **Measured:** base `e0ca77a`; workerd 1.20260815.1. Equivalence `SAME` (both rounds) on 5,427
  and 64,908 inputs, on 160,000 random attribute-list documents (duplicates, more than 16
  names, mispredictions, `maxAttributes` 3 and 17, `maxNameLength` 1) and on 200,000 entity
  documents, full error messages.
  r1 full (60 cold / 12 warm): cold svg −7.2% 🟢, s3-ascii −7.7% 🟢, sitemap −7.3% 🟢; warm svg
  −9.1% 🟢; rss-small cold +8.0% 🟡 inconclusive. Pooled `bench:cold` (300 isolates per
  variant): rss-small +17% (6.46 → 7.58 ms, +1.06 ms in parses 11–100), s3-small −6%. In small
  documents, elements whose attributes don't repeat within the document (root, the first
  `<guid>`) run `attributes()`, which stays in Ignition/Sparkplug until ~parse 55. Before,
  that code ran in Maglev-compiled `parseString` from parse 9. Rejected for that.
  r2 quick (`svg,soap,ooxml-ascii,rss-ascii,rss-small`; 10/4): cold svg −7.1% 🟢; warm svg
  −9.1% 🟢; rest ⚪. Pooled rss-small (300 isolates): 6.78 → 6.85 ms (+0.9% mean, −0.3% trimmed).
  r2 full (60 cold / 12 warm): cold svg −5.1% 🟢 (−6.9…−3.5), soap −1.9%, others within
  ±1% except rss-poison +3.2% (±8) ⚪ and rss-small +8.6% 🟡 inconclusive (−5.2…+23.7; the
  pooled measurement above is neutral); warm svg −9.5% 🟢 (−10.1…−8.9, all 12 isolates), soap
  −1.0%, ooxml −0.8%, rss-poison −1.1%, rest ±0.4% ⚪; memory unchanged.
  Encodings (`rss-latin1,rss-cjk,ooxml-cjk,s3-cjk`): cold −1.4/−1.6/−0.5/−0.5%, warm
  +0.4/−1.8/−0.8/−0.1%, all ⚪. `src/decode.ts` untouched, so no bytes check.
  Lint, typecheck, 163 unit tests, fuzz (20,000 inputs), size (8.71 kB brotlied), conformance
  1263/1736 = main.
- **CI:** perf-local watched before merge (required: no 🔴 row and svg total-100 🟢 again);
  `perf-remote` label not added (report-only).
- **Why:** svg repeats elements with many attributes (5–7 per `<rect>`/`<path>`), so the linear
  duplicate scan (up to 15 compares per name) was a large share of its attribute work. Other
  fixtures have one or two attributes per element, where the scan was short anyway. r1 showed
  that the compile saving of moving the general path out is real (~4 ms on s3 and sitemap). But
  a function called only a few times per parse stays in the slow tiers, and small documents
  pay for that.
- **Retry if:** accepted. r1's outlining is worth another try only if small documents can avoid
  it, for example if the general path is moved out only for elements past the root, or if V8
  tiers up rarely called functions sooner. Note for future loops: a gated-row 🟡 inconclusive
  on rss-small has appeared in four full runs in a row (+2.5…+8.6%). Pooled `bench:cold`
  (`SAMPLES=75`, four passes) settles it.

### 2026-10-01: Cheaper value decoding — three near-misses combined (accepted)

- **Hypothesis:** Three logged near-misses remove builtin calls from the same work, the decoding
  of text and attribute values, and their "Retry if" lines ask for exactly this combination:
  - named entities matched without the `indexOf(";")` (warm entities −6.9%, cold −0.6%);
  - three `indexOf` memos instead of the `/[\t\n\r]/` attribute-value regex (warm −1…−3%; now
    7.6% of svg warm time after #50);
  - `decodeEntities`' Maglev deopt in parse 1 at `source.length` (s3, sitemap, entities; open
    since the 2026-10-01 deopt entry), fixed by reading the length once at entry.
  Together they should push entity-heavy fixtures over the gate. Tested on top of #50,
  `BASE=perf/predicted-attributes-skip-checks`.
- **Change:** `src/entities.ts`: the named-entity fast path exactly as in its entry, and
  `const length = source.length` at entry. `src/parse-string.ts`: the `WS_RE` memo replaced by
  `lineFeed`/`tab`/`cr` memos as in its entry, `tabOrBreak = Math.min(...)`. No new path for the
  warm-up (block coverage unchanged apart from two plain assignments).
- **Measured:** base `4345c66` (PR #50) → candidate +dirty; workerd 1.20260815.1. Trace: the
  `decodeEntities` deopt is gone on s3, sitemap and entities. Equivalence against #50: `SAME` on
  5,427, 64,908 (full messages), 200,000 entity and 160,000 attribute documents; also against
  main.
  Quick (`entities,s3-ascii,sitemap,svg,soap`; 10/4): warm entities −9.6%, s3 −5.5%, sitemap
  −4.1% (🟢), svg −2.7%, soap −1.7%; cold all ⚪ (−1.2…+1.4%).
  Full (60 cold / 12 warm): cold entities −3.9% 🟢 (−6.2…−1.7, warm CI below 0), rss-poison
  −7.2% (±8), s3-ascii −1.6%, svg −1.0%, sitemap +0.3%, soap +0.8%, ooxml +1.2%, rss-ascii
  +1.8%, rss-small +2.1% (±21), rss-crlf ±0 — all ⚪, no 🟡/🔴. Warm entities −10.6% 🟢
  (−11.1…−10.1), s3-ascii −5.6% 🟢, sitemap −3.8% 🟢, svg −3.0% 🟢, soap −2.0%, rss-ascii
  −2.1%, rss-crlf −1.8%, rss-small −1.7%, rss-poison −1.6%, ooxml −1.4% (⚪, all 12 isolates
  negative on most rows).
  Encodings: cold s3-cjk −10.3% 🟢 (−13.1…−7.5), rss-cjk −4.7%, rss-latin1 −3.0%, ooxml-cjk
  −2.4% (⚪); warm s3-cjk −15.2% 🟢, ooxml-cjk −7.6% 🟢, rss-latin1 −2.1%, rss-cjk −1.2%.
  `src/decode.ts` untouched, so no bytes check. Lint, typecheck, 163 unit tests, fuzz, size
  (8.75 kB), conformance 1263/1736 = main.
- **CI:** perf-local watched before merge (stacked on #50, so CI compares against it; required:
  no 🔴 row and entities total-100 🟢 again); `perf-remote` label not added.
- **Why:** each part removes one builtin call per value or reference in every tier after the
  first, and they add up on documents that hit several: entities (references in every text),
  s3 (`&quot;` in every ETag, minified so the whitespace regex scanned to the end), and two-byte
  documents, where the regex was slower still (s3-cjk −15% warm). Alone, each stayed under the
  gate.
- **Retry if:** accepted. Note for future loops: on most fixtures a warm win of ≥5% turns into
  only ≈ a third of that in `total-100`, because compiles and the first ~10 parses don't share
  in it. Combining wins on the same paths is how such ideas clear the 3% gate.

### 2026-10-01: Compile diet — constant startsWith and repeated charCodeAt sites (failed)

- **Hypothesis:** A synthetic function in workerd with 10 `s.startsWith("[CDATA[", i)` sites
  compiles in 12.5 ms in Turbofan, with 10 `charCodeAt` sites in 3.1 ms. Turbofan inlines a
  constant `startsWith` as one character read per character, and each read lowers to a loop
  that Turboshaft unrolls (2026-10-01 diagnostic entry), so one 7-character `startsWith` costs
  ~1.2 ms of compile. `parseString` runs two (`[CDATA[` on rss and svg, `DOCTYPE` on svg), and
  `decodeEntities` reads the characters after "&" at 13 sites. Cutting the sites that execute
  rarely or repeat should save 1–3 ms of compile per fixture, with no warm cost.
- **Change:** on top of #51, one round: `[CDATA[`/`DOCTYPE` tested with slice + `===`; the
  byte-order-mark check as `slice(0, 1) === "﻿"`; the comment check's second "-" moved
  into `markup()`, which fails with the same message at the same offset when it's missing;
  `decodeEntities` reads the second and third characters once and shares them between the
  named references and the numeric "x" check (6 read sites instead of 13). `SAME` on 5,427 and
  64,908 inputs, 200,000 entity documents and 100,000 markup/BOM documents. Reverted; only this
  log ships.
- **Measured:** base `5697925` (PR #51) → candidate +dirty; workerd 1.20260815.1. Turbofan compile
  (2 isolates each): `parseString` rss-ascii 20.2/20.5 → 18.8/18.8 ms, svg 24.5/24.6 →
  21.9/22.1 ms; `decodeEntities` on entities 6.6/6.8 → 5.3/5.7 ms.
  Quick (`rss-ascii,svg,entities,rss-crlf,s3-ascii`; 10/4; one disturbed isolate per fixture
  swung −15…−22%): cold svg −6.1% 🟢, others ⚪.
  Full (60 cold / 12 warm; absolutes ~10–15% above earlier runs, not degraded enough to repeat):
  cold all ⚪ — rss-small −5.6% (±17), svg −2.6% (±10), rss-poison −2.7%, soap −2.5%, entities
  −2.2% (−5.1…+0.6), rss-ascii −2.0%, sitemap −1.3%, s3 −0.5%, rss-crlf +1.0%, ooxml +1.4%;
  warm all ⚪ within −0.8…+1.0%. No encoding/bytes checks (failed).
- **CI:** not opened (failed locally; no perf PR).
- **Why:** the compile saving is real but small: 1–3 ms per isolate, under 3% of `total-100`.
  A compile-only win needs −5% to count as 🟢. The CDATA check now costs a slice per CDATA
  section, which offsets a little on rss.
- **Retry if:** combined with a warm win on the same fixtures (then the 3–5% rule applies), or
  if more compile-heavy constructs turn up. Notes for future loops: (1) never put a constant
  `startsWith()`/`endsWith()` on an executed path of a hot function. Each costs ~0.17 ms of
  Turbofan compile per character; slice + `===` or one `charCodeAt` plus a slice is cheaper to
  compile. (2) The diff of this round (shared reads in `decodeEntities`, slice-based CDATA/DOCTYPE
  checks) is a cheap add-on for a later combination.

### 2026-10-01: Array literals for small attribute and child lists (failed)

- **Hypothesis:** Earlier warm profiles put `ArrayPrototypeSlice` + `ExtractFastJSArray` at
  ~10% of soap and ~14% of ooxml. Every element's attribute list and child list is copied out of
  a scratch array with `slice()`, and in namespaced documents most of those lists are tiny.
  Counted on the fixtures: one attribute on 1,200 ooxml and 1,201 soap elements; two children on
  900 ooxml and 350 entities elements, one element child on 302 ooxml elements. For those sizes an
  array literal allocates inline instead of calling the builtin, so ooxml and soap should gain
  warm and cold; other documents are neutral.
- **Change:** `src/parse-string.ts`, two rounds, on top of #51 (now main); reverted, only this
  log ships.
  (r1) `[name, value]` for one attribute, `[only]`/`[a, b]` for one or two children (a lone
  string child stays a string), `slice()` otherwise; warm-up got `<o><m/></o>` for the
  one-element-child literal, and its test the node.
  (r2) only the one-attribute literal.
  Equivalence `SAME` on 64,908 inputs and 160,000 attribute documents (both rounds).
- **Measured:** base `8e236c8` (src as on main `e0ca77a`+#50+#51); workerd 1.20260815.1.
  r1 quick (`ooxml-ascii,soap,entities,svg,s3-ascii`; 10/4): cold ooxml −6.0% 🟢; warm ooxml −8.5%,
  soap −6.5%, entities −3.1% (🟢). r1 full: cold ooxml −6.6% 🟢, soap −3.3% 🟢, but rss-ascii
  +5.9% 🔴 (+0.5…+12.1) and rss-small +7.4% 🟡 inconclusive; warm ooxml −11.9%, soap −6.2%,
  entities −4.9% (🟢), but svg +1.5%, s3 +1.6%, sitemap +1.4% (⚪, all isolates positive).
  r2 quick: cold soap −7.5% 🟢; warm soap −5.8%, ooxml −4.3% (🟢). r2 full: cold all ⚪ (soap
  −2.9%, −6.0…−0.0; ooxml −1.6%; others −2.8…+3.4%); warm soap −5.9% 🟢, ooxml −4.3% 🟢,
  entities −2.1%, svg −1.0%, but s3-ascii +1.9% and sitemap +1.7% (all 12 isolates positive).
  No encoding/bytes checks (failed).
- **CI:** not opened (failed locally; no perf PR).
- **Why:** the warm mechanism is real where small lists dominate (ooxml −12% with both literals).
  But in both rounds, documents without such lists got ~2% slower warm (s3, sitemap; every
  isolate). That's the codegen effect of a larger `parseString`, not the literals' own cost,
  since those documents never create them. Cold sees ooxml and soap gain little after compile
  and the early tiers. r1's 🔴 on rss-ascii cold (+5.9%) had no warm counterpart; probably noise
  at its ±6% CI, but it blocks either way.
- **Retry if:** combined with another win for namespaced documents (ooxml, soap), or if the
  ~2% warm cost on unrelated documents is explained and avoided. The diffs (r1, r2) are
  small; r2's one-attribute literal is the safer half.

### 2026-10-01: Three near-misses combined — compile diet, short-name windows, one-attribute literal (not confirmed in CI)

- **Hypothesis:** Three logged near-misses have overlapping wins and no shared cost:
  - the compile diet (slice-based CDATA/DOCTYPE/BOM checks, comment "-" check in `markup()`, shared
    character reads in `decodeEntities`): 1–3 ms less Turbofan compile, no warm cost;
  - name-cache windows (four characters after "<" stored per slot; names of up to four
    characters checked without a slice): warm rss −3.5%, ooxml −3.7%;
  - the one-attribute literal: warm soap −5.9%, ooxml −4.3%.
  Each failed the gate alone, mostly with cold in the 1–3% band. Together the warm wins should
  put a fixture's cold change past 3% with its warm CI below 0. The "Retry if" lines of the
  compile-diet and small-array entries ask for exactly this.
- **Change:** `src/parse-string.ts` and `src/entities.ts`, one round: the compile-diet diff, the
  name-cache window diff (v2 of the slice-free name checks entry) and r2 of the small-array
  entry, applied unchanged to main `8127824`. No new path for the warm-up: block coverage leaves
  the same plain assignments unrun as main.
- **Measured:** base `8127824` (main) → candidate +dirty; workerd 1.20260815.1. Equivalence
  `SAME` on 5,427 and 64,908 inputs (full messages), 160,000 attribute, 200,000 entity and
  100,000 markup/BOM documents.
  Quick (`rss-ascii,svg,ooxml-ascii,soap,s3-ascii,sitemap`; 10/4): warm ooxml −9.6%, soap −5.2%,
  rss −4.3% (🟢), others −0.8…−2.1%; cold ooxml −8.3%, svg −3.9%, rss −3.7% (⚪).
  Full (60 cold / 12 warm): cold ooxml-ascii −5.3% 🟢 (−7.4…−3.0), svg −2.0% (−3.5…−0.5),
  rss-small −3.3%, rss-ascii −2.7%, rss-crlf −2.5%, rss-poison −0.6%, s3 −0.2%, soap +0.2%,
  entities +0.4%, sitemap +1.1% — all ⚪ but ooxml, no 🟡/🔴. Warm ooxml −9.2%, soap −4.8%,
  rss-ascii −4.5%, rss-crlf −3.9%, rss-poison −3.7% (🟢), s3 −2.1%, rss-small −2.1%, sitemap
  −1.6%, entities −1.4%, svg −1.2% (⚪); every warm row negative.
  Encodings: cold rss-cjk −5.9% 🟢, ooxml-cjk −4.1% 🟢, rss-latin1 −2.2%, s3-cjk −1.1%; warm
  ooxml-cjk −9.1%, rss-cjk −4.0%, rss-latin1 −3.8% (🟢), s3-cjk −2.6%. `src/decode.ts` untouched.
  Lint, typecheck, 163 unit tests, fuzz, size (9 kB brotlied), conformance 1263/1736 = main.
- **CI:** PR #54, perf-local (5 GitHub runners): cold ooxml-ascii −2.3% ⚪ (−4.4…+0.0), so the
  local 🟢 row wasn't confirmed. Elsewhere: rss-ascii −5.4% 🟢 (locally ⚪ −2.7%, so it doesn't
  count), svg −3.9% ⚪ (−6.8…−1.2), rss-small +9.2% 🟡 inconclusive, others −1.4…+0.5% ⚪. Warm:
  ooxml −4.1% 🟢, rss-crlf −5.5% 🟢, soap −1.9%, sitemap −2.1%, rss-poison −2.1%, s3 +1.2%,
  entities +0.1% ⚪. No 🔴. Closed per the merge rule.
- **Why:** the parts don't interfere. The compile diet removes compile on rss and svg, the
  windows remove slices on short element names (ooxml `w:t`/`w:r`/`w:p`/`w:b`, rss `link`/
  `guid`/`item`), and the literal removes a `slice()` call per single-attribute element
  (ooxml, soap). The ~2% warm cost on s3/sitemap that the literal showed alone is gone in the
  combination (−2.1%/−1.6% warm): those were codegen shifts, and this build of `parseString`
  lays out differently.
- **Retry if:** the gate can resolve 2–3% cold changes (CI half-widths well under 2%), or another
  win on ooxml or rss is added. Warm is consistently faster on rss, soap and ooxml in both runs,
  but cold sits at −2…−5%, where a local and a CI run disagree. The combined commit is
  `989065a` (closed PR #54).
