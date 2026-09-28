# Benchmarks

Two tiers, no external service required.

## Local (workerd, per-PR gate)

```bash
npm run fixtures:generate
npm run bench
```

Vitest bench runs in the real `workerd` runtime via
`@cloudflare/vitest-pool-workers`, so numbers reflect Workers V8 behavior
(`TextDecoder`, isolate CPU limits, no Node APIs).

Suites:

- `bench/small.bench.ts` — tiny docs × shape (flat / attrs / deep / cdata)
- `bench/large.bench.ts` — single large docs (100KB / 1MB / 5MB)
- `bench/many.bench.ts` — burst of 50× ~2KB docs (batch workloads)

Two workerd quirks shape these files:

- `node:fs` cannot read host files from inside workerd, so fixtures are imported
  through Vite (`?raw`, `import.meta.glob`). Missing fixtures fail the run.
- workerd's clock ticks in whole milliseconds. `bench/harness.ts` measures each
  case once at load and repeats it until a sample spans ~25 ms. The repeat
  count shows in the console name (`tiny rss [×11360]`), and `bench-save`
  divides it back out, so saved ops/s and ms are per pass and compare across runs.

`npm run bench` runs with the production JIT flags (`scripts/v8-profiles.mjs`): Cloudflare
compiles optimized code on the request thread, while open-source workerd defaults to
background compilation. A case whose parser throws is named `<case> (throws)`, so it is
never compared with a case that really parses.

## Design measurements (local workerd)

Tools for comparing parser designs, used by the spikes in `research/spikes/`. They take any
module export as the parser (`path/to/module.ts#export`, default export name `parse`) and run it
in local workerd:

| Command                                       | Measures                                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `npm run bench:tiers -- <project> [filters]`  | a vitest bench project under each tier-pinned profile (Ignition, Sparkplug, Maglev, full)                             |
| `npm run bench:ab -- <a>,<b>[,…] [fixtures]`  | interleaved A/B bursts in one isolate, median per variant; resists the 20–50% drift between minutes on a busy machine |
| `npm run bench:cold -- <a>[,<b>…] [fixtures]` | fresh isolates: parse #1, #2–10, #11–100 and the total over the first 100 parses (the decisive metric)                |
| `npm run bench:memory -- <spec> [fixtures]`   | retained heap of the input string and the parsed tree, via DevTools heap usage after forced GCs                       |
| `npm run bench:competitors`                   | txml and fast-xml-parser on the fixture matrix (`bench/compare/`)                                                     |

`INPUT=bytes` hands the parser a `Uint8Array` instead of a string (ab, cold, memory).
`scripts/with-v8-profile.mjs <profile> <command>` runs any command under one profile.

The fixture matrix (`MATRIX` in `src/bench-fixtures.ts`, generated into
`test/fixtures/generated/matrix/`) covers real workload shapes (RSS, sitemap, S3 listing, SVG,
SOAP, OOXML, entity-heavy, small documents, 1 MB) in four encodings: ASCII, Latin-1, a few
characters above U+00FF (which makes V8 store the whole document two-byte) and CJK.
`manifest.json` records each fixture's size, tag count and string representation.

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

## Remember + compare (`bench-history` branch)

```bash
# CI flow:
vitest bench --run --outputJson=bench/results/vitest-bench.json
node scripts/bench-save.mjs
node scripts/bench-compare.mjs        # exits 1 on a real >10% regression
node scripts/bench-trend.mjs "rss"    # history across the bench-history branch
```

- `bench/results/current.json` — this run (gitignored).
- `bench/results/baseline.json` — latest `local/` entry from the `bench-history` branch, restored in CI (gitignored).
- `bench-history` branch — `local/<UTC timestamp>-<sha>.json` from every push to `main`,
  `remote/…` from the nightly run. Written by `scripts/bench-record.mjs`, and kept off `main`
  so these commits never race the release commit.
- A drop counts as a regression only when it exceeds `REGRESSION_THRESHOLD` (default 10)
  and the two runs' combined margin of error (`rme`).

## Remote (real deployed Worker, nightly)

```bash
npx wrangler deploy
BENCH_URL=https://<your-worker>.workers.dev npm run bench:remote
```

Deployed Workers never count JavaScript execution in `performance.now()` or
`Date.now()`; after I/O the clock moves only by the I/O wait. So nothing inside
the Worker can time `parse()`, and timing requests from outside buries a few ms
of work in network jitter. Instead, `scripts/bench-remote.mjs` runs
`wrangler tail`, which reports Cloudflare's own CPU time for every request, and
sends tagged `/run?fixture=…&count=n` requests. Parse cost is the mean CPU of
`count=n` requests minus that of `count=0` requests, divided by `n`. Each
request targets ~8 ms of parse CPU (`TARGET_MS`), because the Workers Free plan
allows 10 ms per request and rejects sustained overruns with error 1102.

Needs a token with **Workers Tail Read** (`CLOUDFLARE_API_TOKEN` in CI, or
`wrangler login` locally). Each result carries `stdErrPct`, the error within
that run. Numbers also depend on which Cloudflare hardware served the run: the
same code measured 3.0 µs and 4.6 µs on different runs, so treat single
nightly points as rough. Fixtures come from `src/bench-fixtures.ts`, the same
builders the local generator uses. Results go to `bench/results/remote.json`,
and the nightly workflow records them on the `bench-history` branch.
