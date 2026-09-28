# Security & robustness for a Workers XML parser (untrusted input, expands only 5 predefined entities + char refs)

Scope: workerd 1.20260815 / V8 15.1 (2026), 128 MB/isolate, 10 ms (Free) to 30 s default / 5 min max (Paid) CPU, single thread, Web APIs only, no `eval`/`new Function`. Parser input is a JS string or bytes fully in memory; output is eager plain objects `{name, attrs, children}` in document order with zero-copy slices; whitespace-only text dropped.

Legend: [source] = verified in source/spec, [docs] = maintainer docs, [3rd-party] = others' benchmark/advisory, [inference] = my reasoning. "No evidence" means I looked and did not find it.

## 1. Attack classes and how they apply when only 5 + char refs are expanded

Core premise: parser expands only `&amp; &lt; &gt; &quot; &apos;` + `&#NNN;` / `&#xHH;`, never defines/resolves DTD general/parameter/external entities, never fetches. That single decision eliminates most XML DoS/XXE classes by construction. Everything else is enforced with counters checked at rare points.

### 1.1 Billion laughs / exponential entity expansion (CWE-776)

Classic payload: 9 levels x 10 refs/level, `lol` -> 3 GB from ~hundreds of bytes. [docs] Python docs definition: https://docs.python.org/3/library/xml.html . [source] Original description matches libxml2 history `CVE-2003-1564`: https://nvd.nist.gov/vuln/detail/CVE-2003-1564 .

Applies to you **only if you add DTD-defined entities**. If you never store/expand `<!ENTITY>` (reject or skip `<!DOCTYPE ... [...] >` without building an entity table), exponential expansion is impossible: output length is `<= input length` because every expansion you do perform *shrinks* (`&amp;` 5->1, `&#65;` 5->1, `&#x41;` 6->1). [inference] No amplification factor >1 exists in that subset.

This is exactly the OWASP rule: "disable DTDs completely ... also makes parser secure against Billion Laughs." [docs] https://cheatsheetseries.owasp.org/cheatsheets/XML_External_Entity_Prevention_Cheat_Sheet.html

Do not do what `fast-xml-parser` did: allow `<!ENTITY big "AAAA...">` then `&big;` x N with no output cap. That is still DoS without nesting. See §2.

### 1.2 Quadratic blowup (CWE-776 variant)

Flat variant: define one ~55k char entity, reference it ~55k times: ~200 KB input -> ~2.5 GB output. [docs] Definition + generator: https://docs.python.org/3/library/xml.html , https://gist.github.com/jordanpotti/04c54f7de46f2f0f0b4e6b8e5f5b01b0 .

With only predefined/char refs, **quadratic blowup via entity definitions is gone** for the same reason. Remaining analogue: attacker sends `&#65;` x 1M (5 MB input -> 1M chars output + tree). That is *linear*, not quadratic, and bounded by input size. [inference] So input-byte cap + total-nodes/output-chars cap fully covers it. But you must still cap it: 1M numeric refs produced ~147 MB in `fast-xml-parser` and bypassed all "entity" limits because the numeric path was uncounted. [3rd-party] https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories/GHSA-8gc5-j5rx-235r , https://osv.dev/vulnerability/GHSA-8gc5-j5rx-235r , CVE-2026-33036: https://nvd.nist.gov/vuln/detail/CVE-2026-33036 .

Lesson: count *decoded output chars*, not "DOCTYPE entities expanded". Numeric refs must count too.

### 1.3 XXE: external general entities, parameter entities, external DTD, XInclude (CWE-611)

Payload: `<!ENTITY xxe SYSTEM "file:///etc/passwd">` + `&xxe;`, or `% param;` + external DTD + `fetch()`. Impacts: file disclosure, SSRF/port scan, DoS via infinite file. [docs] OWASP: https://cheatsheetseries.owasp.org/cheatsheets/XML_External_Entity_Prevention_Cheat_Sheet.html , https://owasp.org/www-project-top-ten/2017/A4_2017-XML_External_Entities_%28XXE%29.html .

Applies to you **only as a correctness bug if you ever fetch**. Workers has `fetch()` available; a parser that resolves `SYSTEM`/`PUBLIC`, `<!ENTITY %`, `xml-stylesheet`, `xsi:schemaLocation`, or `xi:include` reintroduces SSRF/billing + CPU blowup. [inference] In workerd there is no `file://`, but `http(s)://` + internal metadata endpoints + attacker-controlled URLs are enough for SSRF/egress abuse.

Mitigation is architectural: no resolver, no fetch, no `XML_PARSE_DTDLOAD`/`NOENT` equivalent. Treat `<!DOCTYPE` as skip-to-`>` (or hard error — see §4). libxml2 since 2.9 disables XXE by default (no `XML_PARSE_NOENT`/`DTDLOAD`): [docs] https://cheatsheetseries.owasp.org/cheatsheets/XML_External_Entity_Prevention_Cheat_Sheet.html citing https://gitlab.gnome.org/GNOME/libxml2/commit/4629ee02ac649c27f9c0cf98ba017c6b5526070f . [source]

Parameter entities (`%`) deserve explicit mention: they enable blind-XXE and DTD-retrieval even when general entities are blocked. If you skip DTD without parsing `%`, they are dead. [docs] OWASP matrix lists "Disable Parameter Entities" separately.

### 1.4 Deeply nested documents: call-stack exhaustion + heap blowup

`<a><a>...x100k...` Each open element pushes a stack entry / tree node. Two failure modes:

* Recursive descent/traversal -> `RangeError: Maximum call stack size exceeded` (V8, 2026). [docs] MDN: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Errors/Too_much_recursion . Typical V8 JS recursion limit is ~5k-15k frames depending on frame size (2017 StackOverflow measurement ~5k frames, varies by build/optimization): [3rd-party] https://stackoverflow.com/questions/44870061/insight-into-v8-max-stack-frames-size . Exact number is version/frame-dependent; must benchmark in workerd.
* Even iterative parsing blows heap: depth 100k x node objects easily exceeds 128 MB + CPU.

This is not theoretical: `xmldom` SAX parse is iterative so parse *succeeds*, then 7 recursive DOM traversals (`normalize()`, `serializeToString()`, `cloneNode(true)`, etc.) crash with `RangeError`, sometimes uncatchably in async chains. [3rd-party] https://github.com/advisories/GHSA-2v35-w6hq-6mfw (CVE-2026-41673). Expat had the same class natively: unbounded recursive entity expansion -> stack overflow, CVE-2024-8176: https://www.cve.org/CVERecord?id=CVE-2024-8176 . libxml2 XPath had CVE-2025-9714 recursive-invocation depth-check bypass.

Mitigation: explicit array stack + iterative loop (never recurse on input depth) + hard `maxDepth` checked once per start-tag. Cost: 1 integer inc + compare. [inference]

### 1.5 Huge numbers of attributes / children / nodes

`<e a1=".." a2=".." ... a1M="..">`, or `<r><c/>x5M</r>`. Costs: attr-string slices + `attrs` object + duplicate checks; children array growth (repeated `push` realloc + GC); total tree >>128 MB. Even without entities, a 10 MB input can become >50 MB live heap as `{name,attrs,children}` + strings. [inference]

.NET docs explicitly warn: "large number of attributes, namespace declarations, nested elements ... require substantial time" — mitigate with `MaxCharactersInDocument`: [docs] https://learn.microsoft.com/en-us/dotnet/fundamentals/runtime-libraries/system-xml-xmlreader .

Mitigations: per-element `maxAttrs`, per-element `maxChildren` (or only total-node cap), global `maxNodes` / `maxOutputChars`, input-byte cap. All checked at element-close, not per char. [inference]

### 1.6 Very long names / values

`Name` of 5 MB, attribute value of 20 MB, text run of 50 MB without `<`. Costs: giant slice (cheap if zero-copy, but retains input), giant decoded string if entities decoded by concatenation, plus downstream `===`, `Map` hashing O(n). libxml2 caps this explicitly: `XML_MAX_NAME_length 50000`, `XML_MAX_TEXT_LENGTH 10000000` (normal) — see §3. JAXP caps `maxXMLNameLimit 1000`. [source]

Check length once at token end (`if (end-start > LIMIT) throw`), not per char. For text, accumulate `totalTextChars` and check at flush. [inference]

### 1.7 Algorithmic complexity: quadratic duplicate-attribute check + hash flooding

XML spec requires duplicate attributes be an error: [source] https://www.w3.org/TR/xml/#sec-starttags ("No attribute name may appear more than once"). Naive `for i<j` string compare is O(a²) per element. With `a=10k`, that's 50M compares on one element — CPU DoS on 10 ms Free tier. [inference]

Hash flooding variant: if you intern names in a plain JS object/`Map` with unbounded distinct keys per element or per document, attacker forces many hashes + collisions + memory. V8 `Map`/object property tables are hashed; I found no primary-source guarantee in V8 12+ docs that adversarial collision DoS is fully mitigated for arbitrary strings, so treat interning as untrusted. [inference — no evidence found of a documented V8 hash-flood immunity bound; assume worst case]. Expat historically had hash-DoS hardening via salt (`SetHashSalt`): [source] https://github.com/python/cpython/blob/master/Include/pyexpat.h .

Mitigation: cap `a` small (e.g. 64-100), then even quadratic is bounded (100²/2=5k compares worst case, only on elements that actually have ~100 attrs — rare). Or hybrid: linear scan for `a<=16`, `Set` for larger `a` but still capped. Never intern unbounded distinct names without a global budget. [inference]

### 1.8 ReDoS if regexes are used (CWE-1333/400)

Any regex with nested quantifiers / overlapping alternation on untrusted input can go exponential: classic `/A(B|C+)+D/` example. In XML parsers the specific trap is *building a regex from input* (entity name -> `new RegExp`) or running a backtracking regex over a long text/name token.

`fast-xml-parser` is the case study: entity names were interpolated into a regex for replacement -> regex injection / ReDoS, CVE-2023-34104 (fixed 4.2.4): [3rd-party] https://github.com/advisories/GHSA-6w63-h3fj-q4vw , https://nvd.nist.gov/vuln/detail/CVE-2023-34104 . Follow-up: denylist validation (`indexOf` special chars) was judged unsafe; allowlist per `Name ::= NameStartChar NameChar*` recommended: https://github.com/advisories/GHSA-GPV5-7X3G-GHJV . Later: `.` in entity name treated as regex wildcard shadowing built-ins, CVE-2026-25896: https://www.sentinelone.com/vulnerability-database/cve-2026-25896 . Plus generic ReDoS CVE-2024-41818 (<4.4.1): https://security.snyk.io/vuln?search=fast-xml-parser .

Mitigation: no `RegExp` on hot path at all; hand-rolled `charCodeAt` loops. If you must use regex, anchor it, use linear constructs only, never `new RegExp(input)`, never adjacent nested quantifiers. V8 (2024+) has non-backtracking `v`-flag work, but do not rely on it for untrusted XML in workerd 15.1 — no evidence it covers your patterns without benchmarking. [inference]

### 1.9 Prototype pollution when names become JS keys (CWE-1321)

If `attrs` is `{}` and you do `attrs[name]=value` with `name="__proto__"`, you mutate `Object.prototype` (or at minimum the instance's prototype). Same for element-name-indexed objects. Consequences: DoS, logic bypass, RCE gadgets.

Real CVEs:

* `fast-xml-parser` <4.1.2, `<__proto__>` tag/attr -> pollution, CVE-2023-26920: https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories/GHSA-x3cc-x39p-42qx , https://nvd.nist.gov/vuln/detail/CVE-2023-26920 .
* `xml2js` <0.5.0, CVE-2023-0842: https://security.snyk.io/vuln/SNYK-JS-XML2JS-5414874 , https://github.com/advisories/GHSA-776f-qx25-q3cc .
* `xmldom` `copy()` via `p` variable, CVE-2022-37616 (disputed scope but patched in fork): https://security-tracker.debian.org/tracker/CVE-2022-37616 .

Your shape `{name, attrs, children}` is directly exposed: `attrs` keyed by attacker-controlled strings. Fix is structural: `attrs = Object.create(null)` (or `Map`), never `{}`, plus explicit `__proto__`/`constructor`/`prototype` handling tests. Cost ~zero (one `Object.create(null)` per element; or reuse `Map`). Also ensure validator/lookup paths don't use `in` / truthiness on polluted keys. [inference, backed by cited fixes]

## 2. Real CVEs: root cause + fix

### JS parsers

| CVE / GHSA | Package, versions | Root cause | Fix |
|---|---|---|---|
| CVE-2023-26920 (https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories/GHSA-x3cc-x39p-42qx , https://nvd.nist.gov/vuln/detail/CVE-2023-26920) | `fast-xml-parser` <4.1.2 | `__proto__` tag/attr assigned onto plain object -> proto pollution. | 4.1.2: null-prototype objects / pollution guard. |
| CVE-2023-34104 (https://github.com/advisories/GHSA-6w63-h3fj-q4vw , https://nvd.nist.gov/vuln/detail/CVE-2023-34104) | `fast-xml-parser` 4.1.3–<4.2.4 | Entity name interpolated into regex for replacement -> regex injection / ReDoS. | 4.2.4: escape/validate entity names; follow-up https://github.com/advisories/GHSA-GPV5-7X3G-GHJV demands allowlist per W3C `Name` (https://www.w3.org/TR/xml11/#sec-common-syn). |
| CVE-2024-41818 (https://security.snyk.io/vuln?search=fast-xml-parser) | `fast-xml-parser` <4.4.1 | ReDoS in parsing regexes. | 4.4.1 regex hardening. |
| CVE-2026-25896 (https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories/GHSA-m7jm-9gc2-mpf2 , https://www.sentinelone.com/vulnerability-database/cve-2026-25896) | `fast-xml-parser` 4.1.3–<4.5.4, 5.0.0–<5.3.5 | `.` in DOCTYPE entity name treated as regex wildcard -> shadows predefined entities / encoding bypass. | Strict entity-name matching, no regex wildcard. |
| CVE-2026-26278 (https://github.com/advisories/GHSA-jmr7-xgp7-cmfj) | `fast-xml-parser` 4.1.3–<4.5.4, 5.0.0–<5.3.6 | `DocTypeReader` only rejected entities containing `&` (blocked nesting) but `replaceEntitiesValue` loop had no total-size/count cap; single large entity x N refs -> unbounded expansion (quadratic blowup without nesting). PoC 1.3 KB -> 4–8 s. | 4.5.4/5.3.6: `maxTotalExpansions`, `maxExpandedLength`, `maxEntityCount`, `maxEntitySize` + counting. |
| CVE-2026-33036 (https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories/GHSA-8gc5-j5rx-235r , https://nvd.nist.gov/vuln/detail/CVE-2026-33036) | `fast-xml-parser` ≤5.5.5 | Above fix only counted DOCTYPE entities; numeric/standard entities (`&#65;`, `&lt;`) went through separate uncounted `lastEntities` loop -> full bypass (1M refs -> ~147 MB). | 5.5.6: count all expansions / output length. Default `maxExpandedLength` observed 100,000: https://osv.dev/vulnerability/GHSA-8gc5-j5rx-235r . |
| CVE-2026-73569 (https://github.com/advisories/GHSA-8r6m-32jq-jx6q) | `fast-xml-parser` 5.9.3–<5.10.1 | Multiple `<!DOCTYPE>` each called `addInputEntities()` which reset counters -> limits resettable by attacker. | 5.10.1: single DOCTYPE / no reset. |
| CVE-2023-0842 (https://github.com/advisories/GHSA-776f-qx25-q3cc) | `xml2js` <0.5.0 | No validation of `__proto__` keys when building objects. | 0.5.0 pollution guard. |
| CVE-2022-37616 (https://security-tracker.debian.org/tracker/CVE-2022-37616 , https://github.com/xmldom/xmldom/security/advisories/GHSA-9pgh-qqpf-7wqj) | `xmldom` / `@xmldom/xmldom` pre-0.8.3 | `copy()` in `dom.js` via `p` variable allows proto pollution (disputed global impact, target-object pollution demonstrated). | Use `@xmldom/xmldom` ≥0.8.3; avoid bare `xmldom`. |
| CVE-2021-21366 (https://security.snyk.io/vuln/SNYK-JS-XMLDOM-3042242) | `xmldom` <0.5.0 | XXE: system identifiers/FPIs/namespaces not preserved safely on re-parse/serialize. | ≥0.5.0 XXE hardening. |
| CVE-2026-34601 (https://www.sentinelone.com/vulnerability-database/cve-2026-34601) | `xmldom` ≤0.6.0, `@xmldom` <0.8.12/<0.9.9 | CDATA `]]>` breakout during `serializeToString()` -> XML structure injection into downstream consumers. | 0.8.12/0.9.9 escaping. Relevant if you ever serialize. |
| CVE-2026-41673 (https://github.com/advisories/GHSA-2v35-w6hq-6mfw) | `@xmldom` <0.8.13/<0.9.10 | 7 recursive DOM traversals, no depth guard -> `RangeError` DoS. Parse succeeds, later op crashes. | Depth guard / iterative traversal. Direct lesson: parse iteratively *and* keep depth cap so later consumers are safe. |
| CVE-2024-34391 / CVE-2024-34392 (https://nvd.nist.gov/vuln/detail/CVE-2024-34391 , https://nvd.nist.gov/vuln/detail/CVE-2024-34392) | `libxmljs` (native binding) | Type confusion `attrs()` / `namespaces()` on entity-referencing nodes -> DoS / leak / RCE (32-bit + `XML_PARSE_HUGE`). | Upgrade; avoid native bindings in Workers (also violates Web-APIs-only + precompiled-WASM-only constraint). |
| CVE-2022-21144 (https://www.cve.org/CVERecord?id=CVE-2022-21144) | `libxmljs` all | `parseXml(nonBuffer)` calls attacker-controlled `.toString`; if not a function, V8 crash. | Type-check before `.toString`. Lesson: validate input type (`string` vs `Uint8Array`/`ArrayBuffer`) before coercion. |
| CVE-2017-7375 / CVE-2016-9318 (https://security.snyk.io/vuln/SNYK-JS-LIBXMLJS-10557412) | `libxmljs` <1.0.0 (libxml2 default flags) | XXE via libxml2 defaults (entity substitution/DTD loading reachable). | 1.0.0 flag hardening. |
| `sax` / `saxes` npm | — | No CVE found in Snyk DB for `sax@1.3.0`/`saxes` at time of search (shows no direct vulns): https://security.snyk.io/package/npm/sax/1.3.0 . Do not interpret as "secure" — `sax` leaves entity handling to caller, so XXE/expansion risk moves to your handler. Say plainly: no evidence of a sax-specific CVE in this search. | N/A |

### Native parsers (why their limits look the way they do)

* `libxml2` Billion Laughs lineage: CVE-2003-1564 (no recursion detection), CVE-2014-3660 (expansion even when substitution disabled, https://security-tracker.debian.org/tracker/CVE-2014-3660). Fix direction: `XML_PARSER_ALLOWED_EXPANSION`, `XML_ENT_FIXED_COST`, amplification cap (see §3).
* `libxml2` XXE bypass CVE-2024-40896: SAX produced external-entity events even when handler set `checked` -> classic XXE, fixed 2.11.9/2.12.9/2.13.3: [source] https://nvd.nist.gov/vuln/detail/CVE-2024-40896 .
* `libxml2` memory-safety (out of scope for pure-JS parser but reason to stay pure-JS): CVE-2022-29824 (integer overflow `xmlBuf*`), CVE-2025-6021 (`xmlBuildQName` stack overflow), CVE-2025-32414/32415 (Python-bindings OOB + schema under-read): https://access.redhat.com/errata/RHSA-2025:13429 .
* `expat`: CVE-2024-8176 (recursive entity expansion stack overflow), CVE-2023-52425 (quadratic reparse of large tokens needing many buffer fills — https://nvd.nist.gov/vuln/detail/CVE-2023-52425 , fix https://github.com/libexpat/libexpat/pull/789), CVE-2023-52426 (billion laughs when compiled without DTD), plus 2022 integer-overflow series (CVE-2022-22822..22827 etc.). Current defense: dual tracker (output amplification + allocation amplification), see §3. [source]

## 3. Default limits in mature parsers + recommended defaults for Workers

### 3.1 libxml2 (current `master`, 2024–2026)

[source] `include/libxml/parser.h` (`XML_PARSE_HUGE` comment), `parserInternals.h` (https://gnome.pages.gitlab.gnome.org/libxml2/html/parserInternals_8h.html), `parser.c` (https://github.com/GNOME/libxml2/blob/master/parser.c) (`XML_PARSER_ALLOWED_EXPANSION`, `XML_ENT_FIXED_COST`, `nodeMax`/`inputMax` growth):

| Limit | Normal | `XML_PARSE_HUGE` |
|---|---|---|
| Single text node / tag / comment / PI / CDATA / entity value | 10 M (`XML_MAX_TEXT_LENGTH`) | 1 B (`XML_MAX_HUGE_LENGTH`) |
| Name / sysliteral / pubid | 50 K (`XML_MAX_NAME_length`) | 10 M |
| Element nesting depth | 256 (`xmlParserMaxDepth`, `nodeMax` growth cap) | 2048 |
| Entity nesting depth | 20 (`inputMax` growth cap) | 40 |
| Dictionary size | 100 M (`XML_MAX_DICTIONARY_LIMIT`) | override |
| Lookup buffer | 10 M (`XML_MAX_LOOKUP_LIMIT`) | — |
| Entity-expansion accounting | `ALLOWED_EXPANSION 1000000`, `BIG_ENTITY 1000`, `LOT_ENTITY 5000`, `FIXED_COST 20`/ref + amplification cap | — |
| Serialized-output amplification | `xmlCtxtSetMaxAmplification`, default `XML_MAX_AMPLIFICATION_DEFAULT 5` (output ≤ ~5x input): https://gnome.pages.gitlab.gnome.org/libxml2/html/parser_8h.html | configurable |

Takeaway: 256 depth / 10 MB text / 50 KB name are battle-tested "normal" ceilings; `HUGE` is opt-in and explicitly warned as DoS-weakening.

### 3.2 expat ≥2.6–2.7 (2024–2026)

[source] `xmlwf(1)` man page (https://manpages.debian.org/testing/expat/xmlwf.1.en.html), Python 3.14 `pyexpat` docs ([docs] https://docs.python.org/release/3.14.7/library/pyexpat.html), `pyexpat.h` (`SetBillionLaughs...`, `SetAllocTracker...`): https://github.com/python/cpython/blob/master/Include/pyexpat.h , changes: https://github.com/libexpat/libexpat/blob/master/expat/Changes :

* Billion-laughs tracker: activation 8 MiB output (direct+indirect), max amplification `(direct+indirect)/direct = 100`. Only enforced *after* threshold — avoids false positives on tiny docs where transient 15k–30k amplification was observed on benign files.
* Alloc tracker: activation 64 MiB allocated, max `allocated/direct = 100`.
* Tunables: `XML_SetBillionLaughsAttackProtectionActivationThreshold/MaximumAmplification`, `XML_SetAllocTracker...`.

Takeaway: two-dimensional defense (bytes-out *and* bytes-allocated) with a floor before ratio checks kick in. Copy that pattern: absolute caps + ratio/throughput caps that activate after a floor.

### 3.3 Java JAXP (JDK 8 → 24, tightened by JDK-8343006, 2024–2025)

[docs] https://docs.oracle.com/javase/tutorial/jaxp/limits/limits.html , https://docs.oracle.com/en/java/javase/24/docs/api/java.xml/module-summary.html , https://docs.oracle.com/en/java/javase/24/security/java-api-xml-processing-jaxp-security-guide.html , https://bugs.openjdk.org/browse/JDK-8343006 :

| Property | Old default / FSP | New strict default (JDK 24+, FSP on) |
|---|---|---|
| `entityExpansionLimit` | 64000 | 2500 |
| `totalEntitySizeLimit` | 50000000 | 100000 |
| `maxGeneralEntitySizeLimit` | 0 (unlimited) | 100000 |
| `maxParameterEntitySizeLimit` | 1000000 | 15000 |
| `entityReplacementLimit` (nodes in entity refs) | 3000000 | 100000 |
| `maxElementDepth` | 0 (unlimited) | 100 |
| `elementAttributeLimit` | 10000 | 200 |
| `maxXMLNameLimit` | 1000 | 1000 |

Takeaway: modern trend is *much* tighter (2500 expansions, 100 depth, 200 attrs, 100 KB entity totals). Your no-custom-entity design is stricter still, so you can adopt JAXP-strict-scale numbers directly.

### 3.4 .NET `XmlReaderSettings` (.NET 4.5.2+ / .NET 8–10, 2024–2026)

[docs] https://learn.microsoft.com/en-us/dotnet/api/system.xml.xmlreadersettings.dtdprocessing?view=net-10.0 , https://learn.microsoft.com/en-us/dotnet/api/system.xml.xmlreader?view=net-10.0 , [source] https://source.dot.net/System.Private.Xml/System/Xml/Core/XmlReaderSettings.cs.html :

* `DtdProcessing.Prohibit` is the default for `XmlReader.Create` — DTD encountered -> `XmlException`. No XXE, no custom-entity expansion unless caller opts into `Parse`. This is the model to copy: **secure default, opt-in insecurity**.
* `XmlResolver`: `null` since 4.5.2 (no external fetch by default); otherwise `XmlUrlResolver` with no creds. Set yours to `null`/never-fetch unconditionally.
* `MaxCharactersInDocument`, `MaxCharactersFromEntities`: default `0` = *no limit* (must set explicitly). Docs recommend setting `MaxCharactersInDocument` for untrusted input.
* Depth/content quotas live in `XmlDictionaryReaderQuotas` (`MaxDepth 32`, `MaxStringContentLength 8192`, etc.) for WCF paths — do not quote "MaxDepth 32" as an `XmlReader` default; it isn't. [docs] Say plainly: `XmlReader` has no single `MaxDepth` default; depth is bounded in practice by prohibiting DTD + optional quotas.

Worker limits context: [docs] https://developers.cloudflare.com/workers/platform/limits (128 MB/isolate, 10 ms Free / 30 s–5 min Paid CPU).

### 3.5 Recommended defaults for this library (Workers, 128 MB, CPU-billed)

Scale from above, biased tight because (a) Free tier is 10 ms CPU, (b) output tree amplifies heap 3–6x input, (c) results must not outlive request but *do* pin input via zero-copy slices.

| Budget | Recommended default | Rationale |
|---|---|---|
| `maxInputBytes` (UTF-16 code units if `string`, bytes if `Uint8Array`) | 2 MiB default, configurable to e.g. 10 MiB | 2 MiB string ≈ 4 MB heap (UTF-16); tree 3–6x -> fits 128 MB isolate shared by concurrent requests. Paid users parsing large feeds raise explicitly. Mirrors expat 8 MiB activation scaled down for shared isolate. |
| `maxNodes` (elements + text nodes retained) | 100000 | Stops `<c/>`x5M heap death. JAXP `entityReplacementLimit` 100k is the closest analogue. One integer inc per node. |
| `maxDepth` | 128 (hard error) | Below libxml2 256, above JAXP 100, well below V8 ~5k-frame `RangeError`. Iterative stack so no crash; cap keeps later recursive consumers safe (xmldom lesson). |
| `maxAttrsPerElement` | 64 | Below JAXP 200, above any legitimate doc. Bounds quadratic dup check to ≤2k compares worst case. |
| `maxChildrenPerElement` | 50000 (or rely on `maxNodes` alone) | Rare; mainly to fail fast on `<r>`x10M before OOM. |
| `maxNameLength` (element/attr, in code units) | 1024 | Matches JAXP `maxXMLNameLimit` 1000. Checked once at token end. |
| `maxTextNodeLength` (single retained text run after entity decode) | 1 MiB | 10x below libxml2 10M normal; fits Workers heap. Checked at flush. |
| `maxTotalTextLength` (sum of retained text) | = `maxInputBytes` (or 4 MiB) | Enforces amplification ≤1 given shrink-only expansions; catches `&#65;`x1M linear flood. This is the CVE-2026-33036 fix in one counter. |
| `maxAttrValueLength` | 100 KiB | JAXP `maxGeneralEntitySize` 100K analogue; checked once per attr. |
| DTD / entities | `forbidOrSkipDoctype: 'skip'` default with `maxDoctypeSize 64 KiB`; never expand custom entities; option `rejectDoctype: true` for strict mode | `.NET Prohibit` parity. Skip must itself be bounded or attacker hides 50 MB inside `<!DOCTYPE [...]>` you scan. |
| `__proto__` etc. | Always safe (null-prototype `attrs`), no option | CVE-2023-26920/0842 class. No limit needed, just correct type. |

All defaults configurable upward, but *document that raising them reintroduces the corresponding CVE class* (as libxml2 documents for `HUGE`).

## 4. Near-zero-cost implementation (hot-path discipline)

General principle (mirrors libxml2/expat): **per-char work is only classify + accumulate; all policy checks happen at token boundaries** (tag close, attr-value end, text flush, depth inc). Branch predictor + inline caches stay hot; limits are ~1–3 extra integer ops per element.

* **No DTD table, no fetch, no regex.** Scan input with `charCodeAt` / `Uint8Array` index loop. On `<` followed by `!`, check for `DOCTYPE`/`ENTITY`/`--`/`[CDATA[` via 2–3 integer compares and either (a) throw `DOCTYPE not allowed`, or (b) skip to matching `>` with a nested-`[` counter and a `doctypeBytesSeen` cap (fail if `>64 KiB`). Never create entity objects, never call `fetch`/`XmlResolver`. Cost on hot path: one `<`-branch already present. This kills billion-laughs/quadratic/XXE/parameter-entity/SSRF at zero marginal cost.
* **Depth counter.** `depth++` on start-tag open (after name), `if (depth>maxDepth) throw`; `depth--` on end-tag. Single array stack holds `{node, nameStart, nameEnd}` for order validation (expect each opened to be closed in order, fail if stack>0 at end). Iterative only; never recurse. Also validate `stack.length===0` at EOF and mismatched close -> fail. Cost: 2 ops/tag.
* **Duplicate attributes, cheap-small / safe-large.** For `a<=16` (covers >99% real docs), nested loop over start/length pairs comparing slices inline (no allocation, no hashing). For `a>16`, insert slices into a per-element `Set` of hashed slices — but only after `if (a>maxAttrs) throw`, so quadratic/hashing is bounded by 64. Do not intern globally without a `totalDistinctNames` budget. Cost common case: handful of integer compares; rare case pays `Set` but cannot be driven unbounded.
* **Hash-flood containment.** Do not use attacker strings as keys in long-lived `{}`/global `Map`. Per-element attr `Set` is short-lived and size-capped. Tag-name interning (if any for speed) must be bounded (e.g. LRU 1024 entries) + fall back to slice compare; otherwise disable interning. Use `Object.create(null)` for `attrs` so lookups never walk `Object.prototype`. [inference]
* **Long names/values.** Record `tokenStart`; on delimiter, `len=end-start; if (len>LIMIT) throw`. No per-char length check. For `Uint8Array` input, validate UTF-8 once via `TextDecoder({fatal:true})` or manual decode with replacement limits — do not attempt zero-copy slices of invalid sequences. Cost: 1 subtract + branch per token.
* **Children/nodes/text totals.** `nodeCount++` per element/text retained; `if (nodeCount>maxNodes) throw`. `totalText+=decodedLen` at text flush; `if (totalText>maxTotalText) throw`. `children.length` check only when appending past threshold (`if (parent.children.length>maxChildren) throw` — 1 compare/append, predictable). Whitespace-only drop happens *before* counting (already decided) — saves nodes.
* **Char-ref decode without regex.** Manual `&` scan: `&amp; &lt; &gt; &quot; &apos;` via 4–5-way `charCodeAt` switch; `&#123;` / `&#x1F600;` via digit loop with `value = value*10/16 + d`, range-check `0<=v<=0x10FFFF` minus surrogates, `if (digits>7 || missing ;) throw`. Count `totalText++` per decoded char against budget. Never `String.replace(/&#.../g)` (that's the CVE-2026-33036 uncounted path) and never `new RegExp(entityName)`. Cost: branch only when `&` seen (rare in text).
* **Prototype pollution.** `attrs = Object.create(null)`; `node = {name, attrs, children}` created via object literal with *fixed* shape (same property order for V8 hidden-class stability) but `attrs` null-prototype. Never `attrs[attrName]` on `{}`. Test `__proto__`, `constructor`, `prototype` as element *and* attr names. Also guard any `options[name]` merge paths the same way. Cost: zero per key beyond allocation already needed.
* **ReDoS avoidance.** Zero regexes in parser core. If validation regexes exist (e.g. `Name` check), precompile constants, anchor `^...$`, no nested `+/*`, no alternation overlap, run once per name (not per char). Prefer explicit `isNameStart/isNameChar` tables over regex entirely.
* **Input-type + size gate first.** `typeof input==='string' ? input.length : byteLength`; `if (size>maxInputBytes) throw` before any loop (also defends libxmljs CVE-2022-21144 class: don't coerce arbitrary objects via `.toString` — accept only `string|Uint8Array|ArrayBuffer`, else throw). For `Uint8Array`, decode-or-parse bytes directly; don't duplicate into string + bytes.
* **Fail-fast errors, no recovery attempts.** On any limit or well-formedness violation, throw immediately (don't attempt error recovery / continued scanning — that burns the CPU the attacker wants). Ensure thrown error doesn't include sliced giant strings (avoid retaining input via error messages).

### Required threat table

| Threat | Mitigation | Hot-path cost | Recommended default |
|---|---|---|---|
| Exponential entity expansion (billion laughs) | No custom-entity table; skip/reject `DOCTYPE`; expand only 5 predefined + char refs | 0 (no table, 1 branch on `<!`) | Reject or bounded-skip; `maxDoctypeSize 64 KiB` |
| Quadratic blowup (flat large entity x N) | Same as above + `maxTotalText` / `maxNodes` output caps (counts numeric refs too) | 1 add + branch per text flush | `maxTotalText = maxInputBytes` (≈2 MiB); `maxNodes 100k` |
| XXE external general entities (`SYSTEM`/`PUBLIC`, `file:`/`http:`) | Never resolve external IDs; no fetch/resolver; treat as error/skip | 0 | Always-on, no option to enable fetch |
| XXE parameter entities (`%`) + external DTD subset | Skip DTD opaquely; never parse `%` directives | 0 | Always-on |
| XInclude / stylesheet / schema-location fetch | No XInclude/schema processing | 0 | Always-on |
| Deep nesting stack exhaustion (`RangeError`) + heap blowup | Iterative explicit stack + `maxDepth` per start-tag | 1 inc + branch / element | `maxDepth 128` |
| Attr/children flood (memory + CPU) | `maxAttrsPerElement`, `maxChildrenPerElement`, `maxNodes`, `maxInputBytes` gate | 1 branch / element / append | `maxAttrs 64`, `maxChildren 50k`, `maxNodes 100k`, `maxInput 2 MiB` |
| Very long names | Length check at token end | 1 sub + branch / token | `maxNameLength 1024` (JAXP parity) |
| Very long attr values / text runs | Length check at value/flush end + total-text accumulator | 1 branch / attr / flush | `maxAttrValue 100 KiB`, `maxTextNode 1 MiB`, `maxTotalText 2 MiB` |
| Quadratic duplicate-attr check | Linear scan ≤16 attrs, `Set` above, hard cap before blowup; spec error on dup (https://www.w3.org/TR/xml/#sec-starttags) | ~0 common (few int compares) | `maxAttrs 64` makes worst case ≤2k compares |
| Hash flooding of interning/`Map` | Bounded/capped interning, short-lived per-element sets, null-prototype dicts | 0 common | Intern cache ≤1024 entries or off; global name budget via `maxNodes` |
| ReDoS | No regex on hot path; never `new RegExp(input)`; anchored linear patterns only | Negative (removes regex engine) | 0 regexes in core |
| Prototype pollution (`__proto__` tag/attr) | `Object.create(null)` for `attrs` (+ any name-keyed map); fixed-shape nodes; regression tests | 0 per key | Always-on |
| CDATA breakout / serializer injection (if you add serialization later) | Escape `]]>` on serialize; not a parse-path issue | N/A now | Note for roadmap (xmldom CVE-2026-34601) |
| Oversize input pinning via zero-copy slices | Input-size gate + node/text caps; errors don't embed slices | 1 check upfront | `maxInputBytes 2 MiB` default |
| Repeated-`DOCTYPE` counter reset (fast-xml-parser CVE-2026-73569) | Single-shot counters initialized once per `parse()`; at most one DTD skip | 0 | Counters never reset mid-parse |

## Actionable rules for the parser

* Default-deny DTD: either throw on `<!DOCTYPE` (strict, recommended) or bounded-skip (≤64 KiB) with zero entity registration and zero fetches. Never add an option that enables external entities.
* Gate `input.length/byteLength` against `maxInputBytes` (2 MiB) before looping; accept only `string | Uint8Array | ArrayBuffer`.
* Expand only 5 named + numeric refs via hand-rolled `&`-scanner; count every decoded char toward `maxTotalText`.
* Enforce `maxDepth 128`, `maxNodes 100k`, `maxAttrs 64`, `maxNameLength 1024`, `maxAttrValue 100 KiB`, `maxTextNode 1 MiB` — all checked at token/element boundaries, never per char.
* Duplicate-attr check: linear to 16, `Set` beyond, cap first; report duplicates as errors per W3C.
* Use `Object.create(null)` for all attacker-keyed dicts; keep `{name,attrs,children}` shape monomorphic; add `__proto__`/`constructor`/`prototype` tests.
* Zero regexes in core; zero recursion on input depth (parse *and* any bundled serialize/validate helpers iterative).
* Throw immediately on first violation; never include input slices in error strings.

## Open questions that need a benchmark (in workerd itself)

* What input size hits 10 ms Free-tier CPU vs 30 s Paid CPU for typical docs (small SOAP, RSS, Office XML)? Determines whether 2 MiB default is too high/low.
* What is the real per-node heap cost of `{name,attrs,children}` + slices in V8 15.1 (measure via isolate memory + GC timing for 10k/100k nodes)? Determines `maxNodes`.
* What is the actual `RangeError` depth for minimal-frame iterative-vs-recursive helpers in workerd 15.1, and does `try/catch` around deep `RangeError` reliably recover? Determines `maxDepth` margin.
* `Object.create(null)` vs `Map` vs plain-object-with-guard for `attrs`: parse throughput + memory at 0/4/16/64 attrs in V8 15.1?
* Linear-scan vs `Set` crossover for duplicate-attr detection in V8 15.1 (measure at 8/16/32/64 attrs)?
* `string.charCodeAt` loop vs `Uint8Array` + `TextDecoder` path: which is faster under workerd for ASCII-heavy vs CJK-heavy docs, and does `TextDecoder(fatal:true)` add measurable cost?
* False-positive check: do any legitimate target docs exceed `maxNameLength 1024` / `maxAttrValue 100 KiB` / `maxDepth 128`? Corpus test required before freezing defaults.
* Contention: how does 128 MB *per-isolate* (shared across concurrent requests) change per-request caps under load? Measure multi-request heap to avoid one large parse starving co-resident requests.
