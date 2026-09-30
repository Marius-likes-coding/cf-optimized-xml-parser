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
