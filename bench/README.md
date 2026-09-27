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
