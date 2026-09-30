# Benchmarks

## Pull requests and `main`: paired comparisons

Every pull request, every push to `main` and every night, `.github/workflows/perf.yml` compares
a **base** with a **candidate**:

| event                             | base                                         | candidate                                       |
| --------------------------------- | -------------------------------------------- | ----------------------------------------------- |
| pull request                      | the base branch tip                          | the PR merged into it                           |
| push to `main`                    | the previous `main` commit                   | the new commit                                  |
| nightly (02:00 UTC), manual       | the latest release tag (`BASE` input)        | `main`                                          |
| `npm run bench:pr` (your machine) | merge-base with `origin/main` (`BASE=<ref>`) | your working tree, uncommitted changes included |

Two checks run in parallel. Both put base and candidate into **one bench Worker** and alternate
between them, so machine drift and hardware differences hit both alike instead of being
compared across runs.

| check         | where                                                 | metrics                                                                                                                             | gate        |
| ------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `perf-local`  | local workerd on the runner (`npm run bench:pr`)      | cold: total of the first 100 parses in 30 fresh isolates per variant; warm: time per parse after tier-up in 4 isolates; 10 fixtures | ≥ 5%        |
| `perf-remote` | 4 real Cloudflare Workers (`npm run bench:pr:remote`) | warm: CPU per parse, from Cloudflare's own per-request CPU time; 5 fixtures                                                         | report only |

A row is a **regression** only when the change reaches the threshold **and** its 99% bootstrap
confidence interval lies above 0, so noise alone can't fail the check. Other statuses: 🟡
inconclusive (over the threshold, not significant), 🟡 slower (significant, at least half the
threshold), 🟢 faster, ⚪ same. Thresholds, fixtures and sample sizes: `bench/gates.json`.
Retained memory is reported too, as information only (see the realism rules).

**Reading the results.** Each pull request gets one comment with both tables, updated on every
run; each job's summary page has its own table. `bench/results/perf-local.json` and
`perf-remote.json` are uploaded as artifacts.

**Intended slowdowns.** Add the label `perf-regression-accepted` to the pull request. The
workflow reruns, still reports the regression (🔴 accepted), and passes. `perf-local` is a
required check on `main` (repository ruleset), so a regression without the label blocks the
merge. Repository admins can bypass the ruleset in an emergency.

**History.** Pushes to `main` and nightly runs record both reports on the `bench-history` branch
(`local/` and `remote/`); `npm run bench:trend -- "total-100 > svg"` prints a series. The
nightly run also deletes per-run Workers that a dead run left behind (`scripts/bench-sweep.mjs`).

### Realism rules

Nothing gated depends on something a deployed Worker can't have:

1. **One bench Worker for both.** `scripts/bench-lib.mjs` generates it; local runs load it in
   Miniflare, remote runs deploy the same bundle (the report prints its hash). Same endpoints,
   same `compatibility_date`, no compatibility flags.
2. **Realistic input.** Each isolate builds a fixture once and reads it through
   `new Response(xml).text()`, so the parser gets the flat string a `fetch()` body gives.
3. **Only production V8 flags.** Gated local runs use exactly `PROD_FLAGS`
   (`scripts/v8-profiles.mjs`): settings Cloudflare's production embedder already applies
   (compilation on the request thread). No tier pinning, `--expose-gc`, traces or inspector.
4. **Cold is production-shaped.** 100 separate requests to a fresh isolate, one parse each, not
   100 parses in one request (loop iterations drive V8's tier-up differently).
5. **Remote samples are steady-state.** The Worker reports how many parses its isolate already
   ran; rounds that hit a cold isolate are re-sent.
6. **Memory is lab-only.** Retained-tree size needs `--expose-gc` and the inspector, which a
   Worker doesn't have, so it doesn't gate. (Object layout is the same in every tier.)

Known gaps, covered by the remote check: local workerd lags production's V8 version; the local
clock (1 ms ticks inside the Worker) differs from Cloudflare's per-request CPU time; the
hardware differs.

### Remote details

**Why the remote check doesn't gate.** On Cloudflare, two identical copies of the parser in one
isolate settle at steady-state speeds up to ~35% apart, in either direction, depending on the
isolate's history (tier-up timing, GC state). Five A/A runs on 2026-09-30 showed it; the
request log put every request in the same isolate, so it isn't hardware. Local workerd (an
older V8) doesn't show it. A single isolate therefore can't resolve a 10% change, and enough
isolates to do so would take far too long per pull request. The check deploys 4 fresh Workers
in parallel, half with [base, candidate] and half with [candidate, base], and combines their
ratios with a hierarchical bootstrap (Workers, then rounds), so the interval includes that
variance; the "per Worker" column shows each Worker's own change. It catches large
production-only effects and shows trends, but it never fails on performance.

**How it measures.** Deployed Workers never count JavaScript execution in `performance.now()`,
so the check reads Cloudflare's per-request CPU time from `wrangler tail`. Tail delivers about
one event per second per session (bursts of about 11, then sampling; measured 2026-09-30), so
each Worker has its own tail and paces its requests at `paceMs` (1.05 s). Per Worker and
fixture: warm both variants, calibrate `count` so one request parses for about 6 ms (the Free
plan allows 10 ms per request), measure the per-request overhead with `count=0` requests, then
run rounds of one base and one candidate request in random order (a strict alternation can
phase-lock with the garbage collector). A round counts only if both requests ran in the same
warmed isolate and both tail events arrived. Every Worker calls each variant's `warmup()` at
module scope. A run takes about 7 minutes; `bench/results/perf-remote-requests.json` logs every
request.

Each run deploys its own Workers (`cfxp-bench-<run id>-w0…w3`), so runs never clobber each
other and every run starts with fresh isolates; the script deletes them at the end. The token
(`CLOUDFLARE_API_TOKEN`) needs **Workers Scripts Edit** and **Workers Tail Read**. Pull requests
from forks and Dependabot get no secrets: `perf-remote` then reports "skipped". To measure
dependency updates remotely too, add the same token as a Dependabot secret.

Locally, `npm run bench:pr:remote` uses your `wrangler login`.

### Calibration (2026-09-30)

A/A runs (base = candidate, same parser code), 99% interval half-widths:

| check              | typical                                       | widest                       |
| ------------------ | --------------------------------------------- | ---------------------------- |
| local cold         | ±3% (svg, soap, s3, ooxml, sitemap, entities) | ±10% (rss), ±20% (rss-small) |
| local warm         | ±2–4%                                         | ±7% (rss-ascii)              |
| remote (4 Workers) | ±20–45%                                       |                              |

**Local.** A deliberate slowdown (every 7th parse done twice, about +14%; test PR #29) failed 17
of 20 rows on a GitHub runner: warm +11–17%, cold +4–9% (cold includes the one-time compile,
which the extra parses don't double). rss-small's cold total is only ~7 ms, and the Worker's
1 ms clock makes it noisy, so it catches only large regressions; its warm row is precise.

**Two copies in one isolate can diverge.** Even locally, the two parser copies in one isolate
sometimes settle a few percent apart: in one GitHub run, a single-isolate warm measurement
flagged +6% on identical code. Warm therefore uses 4 isolates, 2 per copy order, and combines
their ratios with a hierarchical bootstrap; the "per isolate" column shows each one. In the next
A/A run, one isolate was 4–12% off on every fixture and the combined result stayed ⚪.

**Remote.** On Cloudflare the divergence is far larger (the copy loaded second was 18–52%
slower in 3 of 4 Workers of one A/A run), and it dominates: the +14% slowdown of test PR #29 did
not show in the remote report at all (combined −8…+1%). Read the remote table as a check for
very large, production-only effects, not as a measurement of small changes.

## Design measurements (local workerd)

Tools for comparing parser designs, used by the spikes in `research/spikes/`. They take any
module export as the parser (`path/to/module.ts#export`, default export name `parse`) and run it
in local workerd:

| Command                                       | Measures                                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `npm run bench:tiers -- <project> [filters]`  | a vitest bench project under each tier-pinned profile (Ignition, Sparkplug, Maglev, full)                             |
| `npm run bench:ab -- <a>,<b>[,…] [fixtures]`  | interleaved A/B bursts in one isolate, median per variant; resists the 20–50% drift between minutes on a busy machine |
| `npm run bench:cold -- <a>[,<b>…] [fixtures]` | fresh isolates, one parse per request: parse #1, #2–10, #11–100 and the total over the first 100 parses               |
| `npm run bench:memory -- <spec> [fixtures]`   | retained heap of the input string and the parsed tree, via DevTools heap usage after forced GCs                       |
| `npm run bench:competitors`                   | txml and fast-xml-parser on the fixture matrix (`bench/compare/`)                                                     |

`INPUT=bytes` hands the parser a `Uint8Array` instead of a string (ab, cold).
`scripts/with-v8-profile.mjs <profile> <command>` runs any command under one profile.

The fixture matrix (`MATRIX` in `src/bench-fixtures.ts`, generated into
`test/fixtures/generated/matrix/` by `npm run fixtures:generate`) covers real workload shapes
(RSS, sitemap, S3 listing, SVG, SOAP, OOXML, entity-heavy, small documents, 1 MB) in four
encodings: ASCII, Latin-1, a few characters above U+00FF (which makes V8 store the whole
document two-byte) and CJK. `manifest.json` records each fixture's size, tag count and string
representation.

## Exploration suites (`npm run bench`)

```bash
npm run fixtures:generate
npm run bench
```

Vitest bench in workerd via `@cloudflare/vitest-pool-workers`, with the production JIT flags:
`bench/small.bench.ts` (tiny documents by shape), `bench/large.bench.ts` (100 KB, 1 MB, 5 MB)
and `bench/many.bench.ts` (a burst of 50 documents of ~2 KB). Not a gate. workerd's clock ticks
in whole milliseconds, so `bench/harness.ts` repeats each case until a sample spans ~25 ms; the
repeat count shows in the case name (`tiny rss [×11360]`).

## Current standing (2026-09-29)

Total CPU over the first 100 parses in a fresh isolate (`npm run bench:cold`, production JIT
flags, ms, lower is better). Details, memory and methodology: `research/spikes/m7-performance.md`.

| fixture (~100 KB)  | this parser | txml | fast-xml-parser |
| ------------------ | ----------: | ---: | --------------: |
| rss-ascii          |      **73** |   92 |             439 |
| svg                |     **135** |  237 |             999 |
| soap               |     **115** |  161 |             773 |
| s3-ascii           |      **98** |  111 |             504 |
| ooxml-ascii        |      **96** |  199 |             936 |
| sitemap            |      **86** |  123 |             570 |
| rss-small (3.5 KB) |     **5.4** |  9.3 |            59.5 |

txml decodes no entities and checks almost nothing; fast-xml-parser runs in `preserveOrder` mode.
These numbers come from the earlier `bench:cold` loop (100 parses in one request); the paired
checks above use one parse per request.
