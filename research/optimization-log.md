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
