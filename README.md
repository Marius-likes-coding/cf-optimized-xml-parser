# cf-optimized-xml-parser

Extremely efficient XML parser exploiting Cloudflare Workers runtime characteristics (V8 isolates, Web APIs, workerd CPU model).

> Status: scaffolding. The parser itself (`src/index.ts`) is intentionally left for you to implement.

## Install

```bash
npm install cf-optimized-xml-parser
```

## Usage (API sketch — you define the final shape)

```ts
import { parse } from "cf-optimized-xml-parser";
```

## Develop

```bash
npm ci
npm run fixtures:generate
npm test            # unit tests in workerd
npm run bench       # local perf in workerd
npm run build
```

See `bench/README.md` for the benchmark memory/compare system.

## Publishing (npm OIDC trusted publishing, no token)

1. One-time manual publish to claim the unscoped name:
   `npm publish --access public` (as `marius-likes-coding`).
2. At `npmjs.com/package/cf-optimized-xml-parser` → Settings → Trusted Publisher → GitHub Actions → owner/repo + `release.yml` → allow `publish`.
3. Push conventional commits to `main` — `semantic-release` versions, changelogs, and publishes with provenance.

Remote nightly perf needs repo secrets: `CLOUDFLARE_API_TOKEN` and var `BENCH_URL`.
