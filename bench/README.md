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

Two checks put base and candidate into **one bench Worker** and alternate between them, so
machine drift and hardware differences hit both alike instead of being compared across runs.

| check         | where                                                                                                 | metrics                                                                                                                                                       | gate              |
| ------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `perf-local`  | local workerd on 16 runners in parallel, each measuring every fixture (`SHARD=i/16 npm run bench:pr`) | cold: CPU of the first 100 parses in fresh isolates, 640 isolates per variant (rss-small 3,840); warm: time per parse after tier-up, 16 isolates; 10 fixtures | ≥ 5% (🟢 from 3%) |
| `perf-remote` | 4 real Cloudflare Workers (`npm run bench:pr:remote`)                                                 | warm: CPU per parse, from Cloudflare's own per-request CPU time; 5 fixtures. Pull requests: only with the `perf-remote` label; always on `main`, nightly      | report only       |

**What runs.** A first job (`scope`) compares the change with its base. If it touches nothing
the benchmarks measure (`src/`, `scripts/`, `bench/gates.json`, `package.json`, the lockfile,
`mise.toml`, `tsconfig.json`, the perf workflow and `.github/actions/`), both checks are skipped
and `perf-local` passes in seconds: docs, research and test-only pull requests don't wait for a
benchmark. Otherwise 16 shard runners each measure every fixture, paired as above, and the
`perf-local` job merges the shards' reports (`scripts/bench-merge.mjs`), recomputes every row
from all runners and applies the gate; a missing shard report fails it. A shard's own report is
information only. Nightly and manual runs always measure. A pull request waits about 7 minutes.

A row is a **regression** only when the change reaches the threshold **and** its 99% bootstrap
confidence interval lies above 0, so noise alone can't fail the check. Other statuses: 🟡
inconclusive (over the threshold, not significant), 🟡 slower (significant, at least half the
threshold), 🟢 faster, ⚪ same. **Faster** has its own, lower threshold (`improvementPct`, 3%):
the change reaches it and the interval lies below 0. A cold win smaller than the regression
threshold also needs the same fixture's warm interval below 0; cold-only wins still need 5%
(see "Gate calibration" below for why). Thresholds, fixtures and sample sizes:
`bench/gates.json`.
Retained memory is reported too, as information only (see the realism rules).

**Reading the results.** Each pull request gets one comment with both tables, updated on every
run; each job's summary page has its own table. `bench/results/perf-local.json` (merged) and
`perf-remote.json` are uploaded as artifacts, each shard's report as `shard-local-<n>`. GitHub
assigns each shard a machine of its own choosing (six CPU models in 70 jobs, AMD EPYC and Intel
Xeon), so absolute times are averages over different hardware; the changes are paired within
each runner. The last column splits the change by CPU vendor, so an effect that depends on the
hardware shows there instead of as a disagreement between runs.

**Measuring on Cloudflare.** Add the label `perf-remote` to the pull request; the workflow
reruns with the remote check (about 7 minutes).

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

7. **CPU time, read from outside.** The harness reads the CPU time of workerd's JavaScript
   thread from `/proc` between requests (next section). The Worker, its flags and the requests
   stay as they were; the reading just replaces the Worker's own 1 ms clock, and it is closer to
   what Cloudflare bills (the request thread's CPU time).

Known gaps, covered by the remote check: local workerd lags production's V8 version; the
hardware differs.

### How the local check measures (since 2026-10-01)

**Timing.** All JavaScript of a local workerd process runs on its main thread, and with the
production flags so does every JIT compile. `scripts/workerd-run.mjs` reads that thread's CPU
time in nanoseconds (`/proc/<pid>/task/<pid>/schedstat`) before and after each request, while
the thread waits, so the reading is exact. Requests go to each Worker's own socket, not through
Miniflare's entry Worker, which cost ~0.4 ms of the same thread's CPU per request. A request
without a parse costs ~0.15 ms; each cold batch subtracts its median from every parse request,
so the totals are the parses' own CPU, compiles and GC on that thread included. V8's helper
threads (parallel GC) add 1–3%, which Cloudflare doesn't bill to the request either. Off Linux
the scripts fall back to the Worker's clock and say so in the report.

The Worker's clock advanced in whole milliseconds, so a 0.25–0.65 ms parse read as 0 or 1 ms.
That gave each isolate's cold total 7–10% noise on GitHub runners, and it read single parses with
a bias: over 300 single svg parses on this repo's laptop, the clock averaged 750 µs per parse
against 560 µs of thread CPU. The `precise_timers` compatibility flag doesn't help: it coarsens
timers to 3 ms.

**Cold.** A fixture runs in batches; each batch is a fresh workerd process with 20 isolates per
variant (rss-small: 40), interleaved, and batches alternate the two module orders. Each batch
gives the log ratio of the trimmed means of its candidate and base totals. The 99% interval is a
t-interval over units: one unit per batch on one machine, one unit per runner (its batches'
mean) in CI. Differences between workerd processes and between machines are therefore inside
the interval; the old bootstrap over the isolates of one process missed about 1% of run-to-run
noise. In CI each of the 16 runners runs 2 batches per fixture (rss-small 6). On one machine,
`npm run bench:pr` adds batches until the half-width is 1% or the fixture's budget (120 s,
`COLD_BUDGET_SEC`) is used up; it stops on precision, never on the result, so the interval stays
valid.

**Warm** times its bursts the same way (thread CPU minus the isolate's median request without a
parse). Each runner contributes one isolate; locally 12 isolates run in one process.

**On your machine.** Pin the run to cores whose hyperthread siblings stay idle, for example
`taskset -c 4,5 npm run bench:pr` on an 8-core laptop where `cat
/sys/devices/system/cpu/cpu4/topology/thread_siblings_list` prints `4,12`. CPU time already
ignores time the thread waits, but a laptop also changes its clock speed with temperature: on
this repo's i9 laptop whole isolates ran up to 2× slower, so local intervals stay about twice as
wide as CI's and use up more of the budget. CI decides; local runs steer. The report records the
CPU affinity it ran with.

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

A/A runs (base = candidate, same parser code), 99% interval half-widths, with the sample sizes
before 2026-10-01 (cold 30 isolates per variant, warm 4 isolates):

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
flagged +6% on identical code. Warm therefore uses several isolates, half per copy order, and
combines their ratios with a hierarchical bootstrap; the "per isolate" column shows each one. In
the next A/A run, one isolate was 4–12% off on every fixture and the combined result stayed ⚪.

**A fixed warm schedule leaned (2026-10-01).** 8 A/A runs on GitHub runners (pushes and pull
requests that didn't change `src/`) produced 2 false 🔴 and 3 false 🟢 warm rows, among them
rss-poison +6.1% with all 4 isolates at +3…+7% (PR #30), which failed a docs-only pull request.
Some fixtures leaned the same way run after run (sitemap about +2%, svg and soap about −1%), and
the run means varied more than independent isolates allow (sd 2.0% against 1.4% expected). So
something in the schedule favoured one variant in every isolate at once, and more isolates
alone would only have narrowed the interval around the lean. The likely cause: the base was
always calibrated first, and every round ran the same burst sizes in strict alternation, which
lets the garbage collector fall into step with the schedule (as on Cloudflare, see above).
Since then each round runs the variants in random order, each burst's size varies by ±20%, and
calibration order is random too; with 4 isolates the percentile bootstrap could also call a lean
significant whenever all 4 agreed, so warm now uses 12 isolates and cold 60 per variant. The
shards keep the run time down.

**After the change (2026-10-01).** 5 A/A runs on GitHub runners (PR #31 twice, 3 manual runs
with `base=HEAD`), 100 gated rows: no 🔴, no 🟢, one 🟡 inconclusive (rss-small cold +5.1%).
The old leans are gone (mean warm change over the 5 runs: sitemap +0.1%, svg −0.0%); soap still
leans about −1.3% (−2.9…−0.2), far below the gate. Median 99% interval half-widths:

| check      | typical                                                    | widest                          |
| ---------- | ---------------------------------------------------------- | ------------------------------- |
| local cold | ±2–3.5% (rss ±3.2%, svg ±2.9%, soap ±1.7%, others ±2–2.5%) | ±14% (rss-small, ~7 ms total)   |
| local warm | ±1.5–4% (ooxml ±1.5%, svg ±2.4%, rss ±3.5–4%)              | ±4.3% (rss-small), s3 up to ±6% |

The warm intervals are about as wide as before, but they now hold up in repeated A/A runs; the
cold rss rows narrowed from ±10% to about ±3%. perf-local took 2 min 36 s – 2 min 42 s per pull
request (was about 4 min, and about 7 min until the comment appeared, which waited for
perf-remote). The +14% sensitivity test (PR #29) hasn't been repeated with the new setup.

**Gate calibration (2026-10-01).** The 7 A/A runs of the sharded setup on GitHub (140 gated
rows, artifacts of the PR #31 and `main` runs) show how honest the 99% intervals are. Warm
intervals are, if anything, too wide: the changes spread 0.83× as much as the intervals
predict. Cold intervals are too narrow: each run adds about 1% of noise (fitted standard
deviation 1.0%, at most 1.4%) that the bootstrap over isolates doesn't see. 4 of the 70 cold
A/A rows had intervals that excluded 0 (0.7 expected), at −2.9%, −2.9%, +2.4% and −2.0%. Below
about 3%, a cold interval below 0 therefore doesn't show that a change is real.

The optimization loop (an untracked prompt kept outside this repository) accepts a change only
if a `total-100` row is 🟢 in the local run and the same row is 🟢 again in CI. The chance of
that, from a model fitted to these runs (one row like soap's; the local run assumed noisier
than GitHub's):

| faster from | change without effect accepted | real −4% accepted | real −5% accepted |
| ----------: | -----------------------------: | ----------------: | ----------------: |
|          5% |                         0.007% |                6% |               25% |
|          4% |                          0.04% |               25% |               58% |
|      **3%** |                       **0.3%** |           **58%** |           **85%** |
|          2% |                           2.7% |               85% |               96% |

At 5%, a real 5% win passed only about 1 time in 4, because both runs must land beyond −5%. At
2.5%, the loop would accept a change without effect about once in 90 ideas, at 2% once in 40.
The regression threshold stays at 5%: at 3%, about 14% of pull requests that don't change
performance would fail on noise.

Changes in code shape alone also move cold totals, and they repeat from run to run, so a second
run doesn't remove them. A never-executed block in `parseString` moved sitemap cold +2.8% (warm
±0.2%), and versions of the attribute-name fast path moved s3 cold +5…+8% in three runs, although
s3 never reaches attribute parsing (`research/optimization-log.md`). So a cold win between 3%
and 5% must show in warm too.

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
