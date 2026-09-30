# Changelog

From version 2.0.2 on, release notes are on [GitHub Releases](https://github.com/Marius-likes-coding/cf-optimized-xml-parser/releases): releases no longer commit to `main`, so the required checks on `main` can apply to every change. The entries below cover versions up to 2.0.1.

## [2.0.1](https://github.com/Marius-likes-coding/cf-optimized-xml-parser/compare/v2.0.0...v2.0.1) (2026-09-29)

### Bug Fixes

- report the published package version in VERSION ([acb6690](https://github.com/Marius-likes-coding/cf-optimized-xml-parser/commit/acb6690e385ae250e8007c42aebdb751038f9731))
- **warmup:** cover the parser paths that still deoptimized after warmup() ([c4bae31](https://github.com/Marius-likes-coding/cf-optimized-xml-parser/commit/c4bae314541e43c53ce7c9e2152138831b3a7f87))

## [2.0.0](https://github.com/Marius-likes-coding/cf-optimized-xml-parser/compare/v1.0.1...v2.0.0) (2026-09-28)

### ⚠ BREAKING CHANGES

- 1.x only published scaffolding whose parse() threw "Not implemented yet".
  2.0.0 is the first working parser: parse(input, options?) returns an XmlDocument
  { root, children } or throws XmlError, and the package now also exports warmup(), XmlError
  and helper functions.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

### Features

- accept bytes input with encoding detection ([a3410f6](https://github.com/Marius-likes-coding/cf-optimized-xml-parser/commit/a3410f638bc5a65e781d01a080673f6b13aadc27))
- add warmup() to prime the parser's type feedback ([33d146e](https://github.com/Marius-likes-coding/cf-optimized-xml-parser/commit/33d146e9d81b8986e993d79cb9c2133829c06bae))
- enforce well-formedness, normalize line endings and attributes, add limits ([146411f](https://github.com/Marius-likes-coding/cf-optimized-xml-parser/commit/146411f3cfe24c014832eed7ea459ae62fe55fb0)), closes [#13](https://github.com/Marius-likes-coding/cf-optimized-xml-parser/issues/13) [#10](https://github.com/Marius-likes-coding/cf-optimized-xml-parser/issues/10)
- keep duplicate-attribute checks linear and add robustness tests and fuzzing ([f05c77d](https://github.com/Marius-likes-coding/cf-optimized-xml-parser/commit/f05c77d537f5cd38df908bf8ab64f314908480bc))
- parse XML strings into a document tree ([4be4b4f](https://github.com/Marius-likes-coding/cf-optimized-xml-parser/commit/4be4b4fcbe0ae18b40bf1d6806cefa38539aa862))
- release the first working parser as 2.0.0 ([9f97eea](https://github.com/Marius-likes-coding/cf-optimized-xml-parser/commit/9f97eeaed2ee1805161231399cd85ee0839f124a))

### Bug Fixes

- check the DOCTYPE head, accept XML 1.x as 1.0, reject UTF-16 declaration mismatches ([d0eed9c](https://github.com/Marius-likes-coding/cf-optimized-xml-parser/commit/d0eed9c98dfb815b1ee6a264bab5e0c7566136f0))

## [1.0.1](https://github.com/Marius-likes-coding/cf-optimized-xml-parser/compare/v1.0.0...v1.0.1) (2026-09-21)

### Bug Fixes

- match repository.url to provenance repo URL exactly ([7721069](https://github.com/Marius-likes-coding/cf-optimized-xml-parser/commit/77210699eb23c5e7ba48457e0ec5ffbe062059ab))

## 1.0.0 (2026-09-21)

### Features

- allow manual release dispatch ([07527ed](https://github.com/marius-likes-coding/cf-optimized-xml-parser/commit/07527edb38d52553aa5e70da28de6dfc652e25dc))

### Bug Fixes

- pin conventionalcommits preset to v9 for writer compat ([06da7f0](https://github.com/marius-likes-coding/cf-optimized-xml-parser/commit/06da7f044fd2efc30288e924b54a2ac81f05e117))
- regenerate lockfile with complete optional dependency entries ([f2405fb](https://github.com/marius-likes-coding/cf-optimized-xml-parser/commit/f2405fb6b2ef5272b8c5e1285b996942f4bcbdb3))
- self-contained remote bench worker, lint clean, wrangler dry-run passes ([6d852fe](https://github.com/marius-likes-coding/cf-optimized-xml-parser/commit/6d852fe0db967fd15a917357a387d13f4eaf91dd))
- upgrade to semantic-release 25 for npm OIDC trusted publishing ([b7fb5b5](https://github.com/marius-likes-coding/cf-optimized-xml-parser/commit/b7fb5b571485113352040b8c047afe66488f4a00))
