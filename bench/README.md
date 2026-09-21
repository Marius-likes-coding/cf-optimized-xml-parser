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

## Remember + compare (git-JSON)

```bash
# CI flow:
vitest bench --run --outputJson=bench/results/vitest-bench.json
node scripts/bench-save.mjs
node scripts/bench-compare.mjs        # exits 1 on >10% regression
node scripts/bench-trend.mjs "rss"    # history across bench/history/
```

- `bench/results/current.json` — this run (gitignored).
- `bench/results/baseline.json` — `main` artifact downloaded in CI (gitignored).
- `bench/history/YYYY-MM-DD-<sha>.json` — committed on `main` only, permanent record.
- `REGRESSION_THRESHOLD=10` override per run.

## Remote (real deployed Worker, nightly)

```bash
npx wrangler deploy
BENCH_URL=https://<your-worker>.workers.dev npm run bench:remote
```

Hits `src/bench-worker.ts#/bench` which times `parse()` with
`performance.now()` inside a real isolate. Results saved to
`bench/results/remote-*.json` and committed to history by the nightly workflow.
