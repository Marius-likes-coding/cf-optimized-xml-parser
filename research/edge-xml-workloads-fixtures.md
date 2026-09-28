# Edge XML workloads, structure, corpora & fixture matrix

Target: Cloudflare Workers / workerd 1.20260815 (V8 15.1), `compatibility_date 2026-08-01`.
Research date: 2026-09-27.
Project decisions assumed: whole document in memory (no streaming); eager DOM-style output `{name, attrs, children}` in document order; output strings are zero-copy slices of input; whitespace-only text nodes dropped; priority 1 = CPU time, priority 2 = memory; Web APIs only, single thread, 128 MB/isolate, no `eval`/`new Function`.

Labels: `[source]` = verified in source/spec code, `[docs]` = maintainer docs, `[3rd-party]` = others' benchmark/blog, `[inference]` = my reasoning. "No evidence found" is stated plainly.
V8-version notes from the companion files (`research/v8-strings.md`, `research/workerd-v8-runtime.md`) apply; this file is about *what* to parse, not *how V8 stores it*.

Note on `ideas.md` items 0–8 (depth-first stack, breadth-first, recursive-from-both-ends, ad-hoc via children/paths/parents, regex): the workload survey below confirms there is exactly one viable full-parse strategy — single-pass depth-first with an explicit open-element stack (ideas.md's first bullet: push on open tag, expect closes in LIFO order, fail on mismatch, fail if stack ≠ 0 at end). Breadth-first requires random access to not-yet-parsed input and is unusable for a one-shot text parse; recursive-from-both-ends doubles scanning without helping nesting validation; regex cannot track the stack (nested same-name elements, CDATA-embedded `<`, entity edge cases). Ad-hoc child/path/parent access is a *query* strategy on top of the already-built tree (good for surgical single-point reads), not a replacement for the initial depth-first build when the whole tree is required. The fixture matrix (§3) is designed to stress the depth-first scanner (nesting depth, attribute density, giant text nodes, entities/CDATA, DOCTYPE skipping).

## 1. Common workloads in Workers-like edge/serverless JS

Why these matter on the edge: Workers typically sit as (a) feed/API aggregators, (b) storage gateways (R2/S3), (c) auth/enterprise glue (SAML/SOAP), (d) content transform (SVG, OOXML, KML/GPX), (e) compliance parsers (e-invoicing, sitemaps). Average Worker uses ~2.2 ms CPU/request [docs](https://developers.cloudflare.com/workers/platform/limits/index.md); heavy parse workloads use 10–20 ms [docs](https://developers.cloudflare.com/workers/platform/limits) — so any fixture >~100 KB already exceeds the Free 10 ms budget (see §4).

### 1.1 RSS 2.0 + Atom (news, blogs, alerts, Workers AI summarizers)

* Spec: `rss>channel>item`, no namespace for core elements; extensions via namespaces [source](https://www.rssboard.org/rss-draft-1-17). Atom: `feed>entry`, default `http://www.w3.org/2005/Atom` [source](https://www.ietf.org/rfc/rfc4287.txt).
* Typical size: 10–900 KB [inference from multiple docs]. Google's CAP feed guidance: ideal ≤100 KB, max 900 KB [docs](https://developers.google.com/public-alerts/guides/cap-requirements/feed-formats). No limit in RSS 2.0 ≥0.92 [docs](http://www.rssboard.org/rss-specification).
* Depth: 3–4 (`rss/channel/item/title`; `feed/entry/content/div` if embedded XHTML = 5–6) [source — RFC4287 text constructs].
* Elements/KB: ~10–20 [inference]. Example: 150-byte item (`title+link+pubDate+guid+description` short) → ~6 items/KB × 6 elements ≈ 30/KB for headline-only; with 500-byte `description` → ~2 items/KB ≈ 12/KB.
* Attributes/element: ~0.2 [inference]. Core RSS has almost none except `rss@version`, `enclosure@url/length/type`, `guid@isPermaLink`. Atom adds `link@href/rel/type/hreflang/length` [source](https://validator.w3.org/feed/docs/atom.html).
* Text lengths: bimodal [inference]. Titles 20–100 chars, links 30–100, dates 29–31 (`Tue, 8 Jan 2019 01:15:00 GMT`), descriptions 100–4,000 chars (podcast limit 4,000 bytes, see below).
* Entities: common (`&amp; &lt; &gt;` in URLs/titles) [docs](https://www.sitemaps.org/faq.html) pattern applies generally; feeds with HTML escape heavily.
* CDATA: common for `<description>`, `<content:encoded>` containing HTML e.g. `<a href=...>` [source](https://help.apple.com/itc/podcasts_connect/en.lproj/itcbaf351599.html) shows `<![CDATA[...<a href="https://www.apple.com/...">...]]>`.
* Comments: rare in generated feeds; occasional generator banners [inference — found no corpus study].
* Namespaces/prefixes: RSS 2.0: `content:`, `dc:`, `media:`, `atom:` (for `atom:link rel=self`); Atom: default + `content:` rarely [source](https://validator.w3.org/feed/docs/atom.html).
* Non-ASCII: common in text (smart quotes, CJK, emoji). Characters >U+00FF occur in real feeds but at low density (<1% of chars) [inference — no published distribution found].
* Pretty vs minified: almost always pretty-printed with `\n` + 2-space indent (WordPress, FeedBurner style) → whitespace-drop rule pays off [inference from public feed samples].
* DOCTYPE: essentially never [inference].

### 1.2 Podcast feeds (iTunes + Podcasting 2.0 namespaces)

* Spec: RSS 2.0 + `xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/"` required; PSP-1 adds `podcast:` + `atom:` [docs](https://podcasters.apple.com/support/823-podcast-requirements) [source](https://github.com/Podcast-Standards-Project/PSP-1-Podcast-RSS-Specification/blob/main/README.md).
* Typical size: 50 KB (20 episodes) to 1–5 MB (500+ episodes, long show notes) [inference]. Per-item cost: enclosure (150 chars) + guid + pubDate + 1–2 KB description. Apple example feed structure confirms per-`item` enclosure+guid+pubDate+CDATA description [source](https://help.apple.com/itc/podcasts_connect/en.lproj/itcbaf351599.html).
* Depth: 4–5 (`rss/channel/item/itunes:image`; nested `itunes:category/itunes:category`) [source](https://github.com/Podcastindex-org/podcast-namespace/blob/main/example.xml).
* Attributes/element: ~0.8–1.2 [inference] — highest among feeds due to `enclosure@url/length/type`, `itunes:image@href`, `itunes:category@text`, `podcast:remoteItem@feedGuid/feedUrl/medium`.
* Text: descriptions 200–4,000 bytes (Apple caps channel `description` at 4,000 bytes [docs](https://help.apple.com/itc/podcasts_connect/en.lproj/itcb54353390.html)); titles ≤255 chars per PSP-1 [docs](https://github.com/Podcast-Standards-Project/PSP-1-Podcast-RSS-Specification).
* Entities/CDATA/comments: CDATA very common; entity-escaped `&amp;` required in categories (`Society &amp; Culture`) [docs](https://podcasters.apple.com/support/829-validate-your-podcast). Comments rare.
* Namespaces: 2–4 prefixes per doc (`itunes`, `content`, `podcast`, `atom`) — best namespace-count stress among small docs [source](https://github.com/Podcast-Standards-Project/PSP-1-Podcast-RSS-Specification).
* Non-ASCII: episode titles/descriptions often contain accented chars; URLs/filenames must be ASCII-only [docs](https://podcasters.apple.com/support/823-podcast-requirements) so >U+00FF only in text.
* Pretty/minified: pretty [inference]. DOCTYPE: never.

### 1.3 Sitemaps + sitemap indexes (SEO Workers, crawlers, prerender)

* Spec limits (hard ceilings, not typical): 50,000 URLs and 50 MB (52,428,800 bytes) uncompressed per sitemap or index; gzip allowed but limit measured uncompressed [docs](https://www.sitemaps.org/protocol.html) [docs](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap).
* Typical edge-parsed size: 5–500 KB (50–5,000 URLs). Full 50 MB files are never parsed in a Worker (would blow 128 MB + CPU) — Workers parse shards or indexes [inference].
* Structure: `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>...<lastmod>...<changefreq>...<priority>`; index: `sitemapindex>sitemap>loc+lastmod` [source](https://www.sitemaps.org/protocol.html).
* Depth: 3, fixed [source]. Elements/KB: ~15–25 [inference]: minimal entry `<url><loc>https://ex.com/foo.html</loc></url>` ≈ 70 B → ~14 entries/KB; with `lastmod+changefreq+priority` ≈ 180 B → ~5 entries/KB × 4 els = ~20/KB.
* Attributes: ~0 (only `xmlns` on root) unless image/video/news extensions add namespaced attrs [docs](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap) — good zero-attribute fast path.
* Text: URLs 30–150 chars (max 2,048 [docs](https://www.sitemaps.org/protocol.html)); dates 10 chars. Long repeated URL prefixes — excellent for slice-sharing, bad for dictionary if copied [inference].
* Entities: mandatory escaping of `& ' " < >` in all values including URLs [docs](https://www.sitemaps.org/faq.html) — best entity fast-path fixture.
* CDATA/comments/namespaces: CDATA never; comments rare; one default namespace always [source].
* Non-ASCII: URLs are percent-encoded ASCII (RFC 3986/3987) [docs](https://www.sitemaps.org/protocol.html); >U+00FF essentially absent.
* Pretty: usually one `<url>` per line, minimal indent [inference]. Encoding: UTF-8 only [docs](https://www.sitemaps.org/protocol.html). DOCTYPE: never.

### 1.4 S3-compatible listings incl. Cloudflare R2 S3 API (ListObjectsV2)

* API: `GET ?list-type=2` returns up to 1,000 keys per response [docs](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html). R2 implements the S3 API surface (S3-compat `ListObjects` or Workers R2 binding; REST `List Buckets/Objects` is JSON, not XML — only the S3-compat path is XML) [docs](https://developers.cloudflare.com/r2/api/s3/api).
* Typical size: 10–300 KB (10–1,000 `Contents`). Example skeleton `ListBucketResult>Contents>Key,LastModified,ETag,Size,StorageClass` [docs](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html).
* Depth: 3 (`ListBucketResult/Contents/Key`), flat + wide [source].
* Elements/KB: ~15–25 [inference]: one `Contents` ≈ 250–350 B (Key 20–100 + dates/ETag) → ~3–4/KB × 6 children ≈ 20/KB.
* Attributes: 0 (all data in children) except root `xmlns="http://s3.amazonaws.com/doc/2006-03-01/"` [source].
* Text: Keys 10–200 chars (any Unicode; XML 1.0-illegal bytes must use `encoding-type=url` [docs](https://docs.aws.amazon.com/cli/latest/reference/s3api/list-objects.html)); ETags 32 hex + quotes; ISO8601 timestamps 24 chars; sizes numeric.
* Entities: `&<>"'` escaped in keys; `%`-escapes if `url` encoding requested [docs].
* CDATA/comments/DOCTYPE: never [inference from AWS examples]. Namespaces: single default ns [source]. Non-ASCII: keys can be any Unicode (UTF-8 response) — only workload where >U+00FF in element text at scale is realistic (user filenames) [docs].
* Pretty: minified, no indent (AWS serializes without whitespace) [inference from sample responses] — tests the no-whitespace path.

### 1.5 SOAP responses (legacy enterprise proxied via Workers)

* Spec: `env:Envelope>env:Body>app:Operation`; prefixes arbitrary, namespaces `http://schemas.xmlsoap.org/soap/envelope/` (1.1) or `.../2003/05/soap-envelope` (1.2) + `xsi`/`xsd` [source](https://www.w3.org/TR/2000/NOTE-SOAP-20000508) [source](https://www.w3.org/TR/soap12-part2). A SOAP message MUST NOT contain a DTD or PIs [source — SOAP 1.1 §4].
* Typical size: 0.5 KB (single RPC) to 2.7 MB (10k-item batch). Piccolo SAXBench suite explicitly uses SOAP 0.5 KB / 2.5 KB / 26 KB / 2.7 MB tiers [3rd-party](https://piccolo.sourceforge.net/bench.html).
* Depth: 4–8 including app payload [source].
* Attributes/element: ~0.5–1.0 (`env:mustUnderstand`, `env:encodingStyle`, `xsi:type`, `SOAP-ENC:arrayType/offset`) [source].
* Text: short scalars (IDs, floats, dates) + occasional base64 blobs [inference].
* Entities/CDATA: entities when app embeds markup; CDATA rare. Comments: never per spec intent.
* Namespaces: 3–5 prefixes — heaviest prefix-resolution load among small docs [source].
* Non-ASCII: payload-dependent; usually ASCII [inference]. Pretty: usually minified from stacks (Axis, WCF) [inference].

### 1.6 SAML 2.0 assertions (Workers as SP / Access-style login)

* Spec: root `saml:Assertion` or `saml:EncryptedAssertion`, ns `urn:oasis:names:tc:SAML:2.0:assertion`; protocol `samlp:`, sig `ds:`, enc `xenc:` [source](https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf) [docs](https://www.iana.org/assignments/media-types/application/samlassertion+xml).
* Typical size: 3–15 KB signed (assertion 2–4 KB + `ds:Signature` with base64 cert 2–8 KB) [inference from RFC 7522 example](https://datatracker.ietf.org/doc/rfc7522) which shows Issuer+Subject+Conditions+AuthnStatement skeleton before signature omission.
* Depth: 5–7 (`Assertion/AttributeStatement/Attribute/AttributeValue`; `Signature/SignedInfo/Reference/DigestValue`) [source].
* Attributes/element: ~1.5–2.5 (`ID`, `Version`, `IssueInstant`, `Format`, `NameFormat`, `Method`, `NotOnOrAfter`, `Recipient`, URIs) — densest attribute load per KB among small docs [source].
* Text: long base64 lines (SignatureValue, X509Certificate, EncryptedData CipherValue: 1–4 KB single text nodes with no whitespace) + short URIs/datetimes/emails [source].
* Entities/CDATA/comments/DOCTYPE: effectively never (signatures break on stray whitespace/comments) [inference].
* Namespaces: 3–4 prefixes always [source]. Non-ASCII: rare (NameIDs/emails usually ASCII) [inference]. Pretty: often pretty for display but signature canonicalizes — include both variants [inference].

### 1.7 SVG (image optimization/sanitization Workers)

* Spec: `svg` root, ns `http://www.w3.org/2000/svg`; presentation attributes double as CSS properties (`fill`, `stroke-width`, `d`, `viewBox`) [source](https://www.w3.org/TR/SVG11/struct.html) [source](https://www.w3.org/TR/SVG11/styling.html).
* Typical size: 1 KB (icon) to 200–500 KB (illustration/map); sprite sheets 1 MB+ [inference — no single authoritative size table found; MDN confirms text-based/indexable nature but gives no sizes](https://developer.mozilla.org/en-US/docs/Web/SVG).
* Depth: 3–8 (`svg>g>g>path`; `defs>linearGradient>stop`) [source].
* Attributes/element: 2–6 — highest sustained attribute density (e.g. `<rect x y width height fill stroke-width .../>`; `<path d="M...z"/>` with `d` 100–10,000 chars) [source]. `d` is the longest common attribute value in any workload here.
* Text: little element text except `<text>`, `<title>`, `<desc>`, `<style>` (CSS, often CDATA) [source].
* Entities: `&amp;` in style/text; CDATA in `<style>` common [source example in SVG 1.1 styling](https://www.w3.org/TR/SVG11/styling.html).
* Comments + PIs: `<!-- -->` license headers + `<?xml-stylesheet href="mystyle.css"?>` seen in spec examples [source]. DOCTYPE: SVG 1.1 examples carry `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">` [source](https://www.w3.org/TR/SVG11/struct.html); SVG 2 drops it [source](https://www.w3.org/TR/SVG2/struct.html) — include one of each.
* Namespaces: default + `xlink:` (legacy `xlink:href`) [source]. Non-ASCII: `<text>` labels (place names) can exceed U+00FF [inference]. Pretty: both (hand-written pretty, tool-emitted minified) [inference].

### 1.8 OPML (feed-reader import/export Workers)

* Spec: `opml>head+body>outline`; subscription lists use `outline@type/text/xmlUrl/htmlUrl` flat or nested by category [source](http://2005.opml.org/spec2.html).
* Typical size: 5 KB (50 feeds) to 200 KB (2,000 feeds). Import cap example: RSSMonster caps OPML upload at 1 MiB [docs](https://pietheinstrengholt.github.io/rssmonster/opml.html).
* Depth: 2–4 [source]. Attributes/element: 3–5 on every `outline` (`type`, `text`, `title`, `xmlUrl`, `htmlUrl`) — pure attribute-list doc [source example](https://gist.github.com/bertwagner/6e25e48daeb6e7bd83c641f3cd362d16).
* Text: almost none (all data in attrs) [source]. Entities: URL-escaped `&amp;` in `xmlUrl` [source]. CDATA/comments/DOCTYPE/namespaces/non-ASCII: essentially none [inference].
* Pretty: pretty [inference].

### 1.9 XMLTV (EPG Workers, TV/PVR guides)

* Spec: `tv>channel+programme`; DTD at [source](https://github.com/XMLTV/xmltv/blob/master/xmltv.dtd); format doc [docs](https://wiki.xmltv.org/index.php/XMLTVFormat).
* Typical size: ~1 MB/day, 10–50 MB for 2-week full grab [inference from grabber `--days` model](https://github.com/XMLTV/xmltv/blob/master/doc/QuickStart) — Workers parse 1-day shards (~0.5–2 MB).
* Depth: 3–4 (`tv/programme/title`; `programme/credits/actor`) [source].
* Attributes/element: ~1.5 (`channel@id`, `programme@start/stop/channel`, `display-name@lang`, `image@src/width/height`) [source].
* Text: titles 10–80 chars, `desc` 50–1,000 chars, multilingual duplicates (`display-name lang=en/fr`) — good lang-attr + duplicated-text case [source].
* Entities: accented chars as entities if ISO-8859-1-encoded legacy files [source example `<?xml version="1.0" encoding="ISO-8859-1"?><!DOCTYPE tv SYSTEM "xmltv.dtd">`](https://github.com/AlekSi/xmltv/blob/master/example.xml).
* Comments: rare. Namespaces: none (DTD, no ns) — useful no-namespace control [source]. Non-ASCII: common (French/German titles: `Chaîne un`) [source DTD example]. DOCTYPE: frequently present (`<!DOCTYPE tv SYSTEM "xmltv.dtd">`) — best DOCTYPE fixture among realistic docs [source].
* Pretty: pretty-printed by grabbers [inference].

### 1.10 GPX + KML (mapping/field Workers)

* GPX 1.1: `gpx>trk>trkseg>trkpt`; `trkpt@lat/lon` + children `ele/time`; root carries `version/creator/xmlns/xsi:schemaLocation` [source](https://www.topografix.com/GPX/1/1) [source](https://en.wikipedia.org/wiki/GPS_Exchange_Format).
* KML 2.2/2.3: `kml>Document>Placemark>Point/LineString/Polygon`; ns `http://www.opengis.net/kml/2.2` + `gx:` extension [source](https://developers.google.com/kml/documentation/kmlreference) [docs](https://www.ogc.org/standards/kml/).
* Typical size: GPX 0.4–254 KB (samples: waypoints 407 B, route 365 B, track 2.7 KB, 2,000-point track 254 KB) [source](https://samplelib.com/sample-gpx.html). KML: 1.3 KB (10-point `gx:Track`) [source](https://examples.novusstreamsolutions.com/geospatial/kml/kml-gx-track) to 10 MB (country borders).
* Depth: GPX 4–5, KML 5–7 [source].
* Attributes/element: GPX high on points (`lat/lon` floats, 2 attrs × thousands of elements); KML low except `id` [source].
* Text: GPX short numerics/timestamps; KML has the signature outlier — `<coordinates>` single text with thousands of `lon,lat,alt` triples (space/comma separated), and `gx:coord` space-separated variant that breaks comma-splitting parsers [source Novus example]. Include both.
* Entities/CDATA/comments: `<!-- Comments look like this -->` in GPX spec example [source](https://en.wikipedia.org/wiki/GPS_Exchange_Format); description HTML sometimes CDATA. Namespaces: default + `xsi` (+`gx:` for KML) [source]. Non-ASCII: waypoint names (UTF-8) occasionally >U+00FF [inference]. Pretty: pretty [inference]. DOCTYPE: never.

### 1.11 Office Open XML parts (Workers that preview/convert `.docx/.xlsx`)

* Container: ZIP package of parts per ECMA-376/ISO 29500; logic in `word/document.xml`, `xl/sharedStrings.xml`, styles [docs](https://ecma-international.org/publications-and-standards/standards/ecma-376/) [source overview](https://www.ecma-international.org/wp-content/uploads/OfficeXML-White-Paper-v2008-10-03.pdf).
* Typical `document.xml` (uncompressed, what the parser sees after unzip): 30 KB (letter) to 2 MB (report); `sharedStrings.xml` similar. Whole `.docx` is smaller on the wire (ZIP) — fixture should store the inflated XML [inference — no authoritative size table found; structure per ECMA-376 `document>body>p>r>t`].
* Depth: 6–8 (`document/body/p/r/t`; `pPr/rPr` siblings) [source ECMA-376 Part 1].
* Attributes/element: 1–3 (`w:val`, `w:sz`, `w:space="preserve"`) with `w:` prefix on nearly every element — prefix-heavy [source].
* Text: `w:t` runs of 5–50 chars (word fragments; `xml:space=preserve` keeps boundary spaces — interacts with the whitespace-drop rule: must not drop `w:t> <`!) [source ECMA-376]. Repeat of `w:rsid*` attrs bloats size.
* Entities/CDATA/comments/DOCTYPE: rare; no DOCTYPE [inference]. Non-ASCII: document language text, often >U+00FF (CJK/Arabic docs) [inference]. Pretty: minified (single line from Word) [inference].

### 1.12 E-invoicing: UBL 2.x / XRechnung / ZUGFeRD-Factur-X CII (compliance Workers)

* EU context: EN 16931 semantic model; two syntaxes UBL 2.1 and UN/CEFACT CII D16B; XRechnung is a pure-XML CIUS (no PDF wrapper) mandatory for German federal suppliers since end-2020; ZUGFeRD is hybrid PDF/A-3 + embedded CII XML [docs](https://e-rechnung-bund.de/en/faq_category/xrechnung) [docs](https://www.getzugferd.com/en/xrechnung-format).
* Typical size: XRechnung UBL example 151 lines ≈ 6 KB [3rd-party](https://www.invoicenavigator.eu/de/xrechnung-beispiel). UBL Invoice 2.1 example 493 lines ≈ 25–35 KB [source](https://github.com/Tradeshift/tradeshift-ubl-examples/blob/master/src/main/resources/org/oasis-open/ubl/examples/UBL-Invoice-2.1-Example.xml) [source OASIS](https://docs.oasis-open.org/ubl/os-UBL-2.2/xml/UBL-Invoice-2.1-Example.xml). Real invoices with 50 lines: 30–100 KB [inference].
* Depth: 5–7 (`Invoice/cac:AccountingCustomerParty/cac:Party/cac:PostalAddress/cbc:StreetName`) [source].
* Attributes/element: ~0.8 (`currencyID`, `unitCode`, `listID/listAgencyID`, `languageID`) [source].
* Text: short codes/dates/amounts (10–30 chars); `cbc:Note` sentences; base64 `cbc:EmbeddedDocumentBinaryObject` occasionally (PDF attachment in UBL) [source].
* Namespaces: default `Invoice-2` + `cac:` + `cbc:` (+ `ram:/rsm:/udt:` for CII) — 3-prefix fixture [source]. Entities/CDATA/comments/DOCTYPE: none in the wild [inference from examples]. Non-ASCII: party names/addresses (ü, ß, é) — >U+00FF at low rate [inference]. Pretty: pretty [inference].

### Cross-workload summary

| Workload | Size in edge | Depth | els/KB | attrs/el | Long-text risk | Namespaces | Entities/CDATA | DOCTYPE |
|---|---|---|---|---|---|---|---|---|
| RSS/Atom | 10–900 KB | 3–6 | 10–30 | 0.2 | desc 4 KB | 1–3 | ent yes, CDATA yes | no |
| Podcast | 50 KB–5 MB | 4–5 | 8–15 | 1.0 | desc 4 KB | 2–4 | both yes | no |
| Sitemap | 5–500 KB shards | 3 | 15–25 | 0 | none | 1 | ent yes | no |
| S3/R2 listing | 10–300 KB | 3 | 15–25 | 0 | Key 200 ch | 1 | ent yes | no |
| SOAP | 0.5 KB–2.7 MB | 4–8 | 8–15 | 0.7 | base64 blobs | 3–5 | ent sometimes | forbidden |
| SAML | 3–15 KB | 5–7 | 8–12 | 2.0 | base64 4 KB | 3–4 | no | no |
| SVG | 1–500 KB | 3–8 | 5–12 | 4.0 | `d` 10 KB, `style` | 1–2 | CDATA+comments+PI | 1.1 yes / 2 no |
| OPML | 5–200 KB | 2–4 | 5–10 | 4.0 | none | 0 | ent in URLs | no |
| XMLTV | 0.5–2 MB shards | 3–4 | 10–18 | 1.5 | desc 1 KB | 0 | ent yes | often yes |
| GPX/KML | 1–250 KB (GPX), to 10 MB (KML) | 4–7 | GPX ~15, KML ~2 | GPX 2, KML 0.2 | KML coords MB-single-node | 1–2 | comments | no |
| OOXML part | 30 KB–2 MB inflated | 6–8 | 12–20 | 2.0 | `w:t` fragments | 1–2 (`w:` everywhere) | no | no |
| UBL/CII invoice | 6–100 KB | 5–7 | 12–18 | 0.8 | base64 attach | 3 | no | no |

No published study of elements/KB or text-length distributions for these specific edge workloads was found; els/KB and text figures above are [inference] from spec examples sized by hand.

## 2. Public corpora for XML benchmarking

| Corpus | Download | Size | License | Best edge use |
|---|---|---|---|---|
| XMark `xmlgen` (auction DB, depth fixed 12, SF=1 → ~100–116 MB) | generator: https://projects.cwi.nl/xmark/ (mirror + paper: https://github.com/eliben/xmlgen) | SF 0.01 ≈ 1 MB … SF 1 ≈ 116 MB (`./xmlgen -f 1` ≈ 116 MiB [3rd-party](https://github.com/eliben/xmlgen); SF=1.0 = 100 MB per benchmark paper [3rd-party](https://staffwww.dcs.shef.ac.uk/people/S.North/papers/WebIST2010/webist2010paper.pdf)) | Historically free for research (check repo README; no OSI label found — verify before vendoring) | Scalable deep-narrow + text-mix stress; generate 10 KB–2 MB slices with `-f` |
| UW XML Data Repository (Mondial, SwissProt slice, DBLP slice, etc. + stats) | Original http://aiweb.cs.washington.edu/research/projects/xmltk/xmldata — **dead as of Sep 2026 (404)**; use Web Archive copy or the `mondial-europe.xml` copies vendored in benchmark repos (e.g. https://github.com/zulimazuli/dotnetXmlBenchmarks) | Mondial ≈ 1–2 MB; SwissProt slice ≈ tens of MB (exact figures only on archived page — not verifiable today) | Mixed public sources | Classic small-doc breadth; do not depend on live URL |
| DBLP monthly dump + DTD | https://dblp.org/xml/ (datadir); DOI snapshots e.g. Aug 2026: https://drops.dagstuhl.de/entities/artifact/10.4230/dblp.xml.2026-08-01 | `dblp-2026-08-01.xml.gz` = 1.01 GB [docs](https://drops.dagstuhl.de/entities/artifact/10.4230/dblp.xml.2026-08-01) (Nov 2024: 0.84 GB — growth visible) | CC0 1.0 [docs](https://dblp.org/) | Shallow-wide + DOCTYPE + latin-1 entities; slice 100–500 KB. Format: shallow list, max depth ~3, `<!DOCTYPE dblp SYSTEM "dblp.dtd">`, ASCII + latin-1 named entities [docs](https://dblp.org/faq/16154937) |
| UniProtKB / Swiss-Prot + UniRef XML + XSD | https://www.uniprot.org/help/downloads; FTP https://ftp.uniprot.org/pub/databases/uniprot/current_release/ | `uniref100.xml.gz` = 74 GB; `fasta.gz` = 59 GB (Jun 2026 listing) [source listing](https://ftp.uniprot.org/pub/databases/uniprot/current_release/uniref/uniref100) — full Swiss-Prot XML is TB-scale; use REST slices | CC BY 4.0 (UniProt — verify current `LICENSE` on FTP) | Deep protein entries; take ≤500 KB slice, not the dump |
| OpenStreetMap planet + Geofabrik extracts | Planet: https://planet.openstreetmap.org/ (weekly XML 165 GB [docs](https://planet.openstreetmap.org/)); extracts: https://download.geofabrik.de/; format: https://wiki.openstreetmap.org/wiki/Downloading_data | Planet compressed ~100–165 GB, uncompressed ~2 TB and growing [docs](https://wiki.openstreetmap.org/wiki/Downloading_data); full-history uncompressed ~3.7 TB+ [docs](https://wiki.openstreetmap.org/wiki/Planet.osm/full) | ODbL 1.0 [docs](https://planet.openstreetmap.org/) | Attribute-dense geo; use city extract (e.g. Liechtenstein ~5 MB) sliced to 200–500 KB |
| Wikipedia dumps (MediaWiki XML) | https://dumps.wikimedia.org/enwiki/; current: `enwiki-*-pages-articles-multistream.xml.bz2` 24–25 GB compressed, >105 GB uncompressed [docs](https://en.wikipedia.org/wiki/Wikipedia:Database_download) (Apr 2026 progress: 24.4 GB [docs](https://dumps.wikimedia.org/enwiki/20260401)) | Per-article mean ~718 words [docs](https://en.wikipedia.org/wiki/Wikipedia:Size_of_Wikipedia) | CC BY-SA + GFDL | Giant-text + non-ASCII + entity stress; slice single `<page>`s |
| Feed collections (no single standard corpus found) | Assemble: Apple sample https://help.apple.com/itc/podcasts_connect/en.lproj/itcbaf351599.html; PodcastIndex example https://github.com/Podcastindex-org/podcast-namespace/blob/main/example.xml; PSP-1 spec https://github.com/Podcast-Standards-Project/PSP-1-Podcast-RSS-Specification; sitemap examples https://www.sitemaps.org/protocol.html | n/a (curate 10–50 live feeds, 10 KB–1 MB each) | Per-feed © (use permissively licensed: Wikimedia blog, Geofabrik changelogs, W3C) | Most representative of actual Worker traffic; record URL+date |
| JS-parser benchmark harnesses (fixture ideas + baselines) | https://github.com/rgrove/parse-xml (291 B / 72 KB / 1.16 MB tiers; M1 Max: 253k ops/s small, 1,350 ops/s medium [3rd-party](https://github.com/rgrove/parse-xml)); https://github.com/trivikr/benchmark-xml-parser (S3-shaped doc; AWS custom parser ~238–259 ops/s beats fast-xml-parser/xmldoc [3rd-party](https://github.com/trivikr/benchmark-xml-parser)) | Small/medium/large as named | ISC / MIT | Methodology + smoke fixtures; absolute MB/s not comparable across machines |

Licenses: DBLP CC0 allows vendoring with attribution; OSM ODbL share-alike triggers on derivative DBs (sliced test fixtures are generally fine with attribution, but get review); Wikipedia text requires share-alike attribution — prefer synthetic or CC0 slices for repo fixtures and link out for full dumps.

## 3. Suggested fixture matrix (10 fixtures, 2 KB–2 MB)

Sizing rule for Workers (V8 15.1, 2026): isolate heap 128 MB shared across concurrent requests; CPU 10 ms (Free) vs 30 s default / 300 s max (Paid) [docs](https://developers.cloudflare.com/workers/platform/limits/index.md) [docs](https://developers.cloudflare.com/changelog/2025-03-25-higher-cpu-limits). Pure-JS parse throughput on desktop V8/Node is order 20–80 MB/s (e.g. 291 B @ 253k ops/s ≈ 70 MB/s on M1 Max [3rd-party](https://github.com/rgrove/parse-xml)); workerd on shared cores will be slower. So: **1 MB ≈ 12–50 ms CPU → already over Free, comfortable on Paid; 5 MB+ risks GC + output-tree blowup (DOM ~3–9× input per Java FastXml/DOM factors [3rd-party](https://github.com/fastxml/fastxml-benchmark)).** Keep checked-in fixtures ≤2 MB; generate the 5–10 MB stress at bench time on Paid only.

| # | Fixture (name/size) | Source to build from | Dimensions covered |
|---|---|---|---|
| F1 | `rss-small.xml` ~20 KB, 20 items, pretty, entities + 2 CDATA HTML | Hand-write from RSS 2.0 spec + Apple CDATA pattern | Baseline shallow, entity+CDATA, whitespace-drop |
| F2 | `podcast-mid.xml` ~500 KB, 150 episodes, `itunes+content+podcast+atom`, enclosures | Expand [PodcastIndex example](https://github.com/Podcastindex-org/podcast-namespace/blob/main/example.xml) programmatically | Multi-namespace, attr-heavy feed, 4 KB descs |
| F3 | `sitemap-shard.xml` ~500 KB, ~2,500 urls, escaped `&amp;` URLs | Template from [protocol example](https://www.sitemaps.org/protocol.html) | Wide-flat, zero-attr, entity path, prefix-repeat slices |
| F4 | `s3-list-1000.xml` ~250 KB, 1,000 `Contents`, default ns, 5% non-ASCII keys | Template from [ListObjectsV2 sample](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html) | Minified, wide-flat, numeric/date text, UTF-8 keys |
| F5 | `soap+saml-small.xml` two files: SOAP 15 KB (3 ns, `mustUnderstand`), SAML 8 KB (sig base64) | Skeletons from [SOAP 1.1 examples](https://www.w3.org/TR/2000/NOTE-SOAP-20000508) + [RFC 7522 Fig.1](https://datatracker.ietf.org/doc/rfc7522) | Prefix resolution, attr density, 4 KB base64 single-node |
| F6 | `svg-mixed.xml` ~120 KB: icons + one `d=8KB` path + `<style>` CDATA + comment + PI; plus `svg-doctype.xml` 5 KB variant | Hand-assemble per [SVG 1.1 structure/styling](https://www.w3.org/TR/SVG11/struct.html) | Attr-value scanning, CDATA/style, comments, DOCTYPE on/off |
| F7 | `ubl-invoice.xml` ~30 KB (XRechnung UBL, `cac/cbc`) + `cii-invoice.xml` ~30 KB | Trim [UBL example](https://github.com/Tradeshift/tradeshift-ubl-examples/blob/master/src/main/resources/org/oasis-open/ubl/examples/UBL-Invoice-2.1-Example.xml) to 6 KB minimal + 30 KB 10-line versions | 3-prefix business XML, short-code text, currency attrs |
| F8 | `ooxml-document.xml` ~200 KB inflated `w:document` (2,000 `w:p`), `xml:space=preserve` | Generate `document>body>p>r>t` per ECMA-376 (no live sample — synthesize) | Deep (7), `w:`-prefixed everything, whitespace-preserve vs drop |
| F9 | `osm-city-slice.xml` ~500 KB (2,000 nodes + 200 ways, `tag k/v`), UTF-8 names | Slice Geofabrik Liechtenstein extract ([planet docs](https://wiki.openstreetmap.org/wiki/Downloading_data)) | Attr-dense geo, float attrs, >U+00FF street names |
| F10 | `mixed-edge.xml` ~200 KB: `dblp-slice` (DOCTYPE + `&auml;` entities) + `kml-coords` (single 80 KB `<coordinates>`) + `xmltv-day` (DOCTYPE + `lang`) | DBLP slice ([format](https://dblp.org/faq/16154937)) + Novus [gx:Track pattern](https://examples.novusstreamsolutions.com/geospatial/kml/kml-gx-track) + [XMLTV DTD example](https://github.com/XMLTV/xmltv/blob/master/xmltv.dtd) | DOCTYPE skip, latin-1 entities, giant-text node, multilingual |

Explicitly excluded from checked-in set: full DBLP/OSM/Wikipedia dumps, 50 MB sitemaps, multi-MB KML borders — generate-or-download at bench time only, Paid tier. OPML/GPX-track shapes are subsumed by F2 (attr-list) and F9 (point-list); add them only if those paths diverge in profiling.

Each fixture should ship in two serializations (pretty + minified) and record: bytes, element count, max depth, attr count, CDATA/entity/comment counts, % non-ASCII / %>U+00FF — because serializer choice alone moves whitespace-node counts dramatically under the drop rule.

## 4. Actionable rules for the parser

* Fast-path `<`, `>`, `"`, `=`, `/`, `?`, `!`, `-`, `[` dispatch on ASCII; assume tag/attr names are ASCII (`[A-Za-z0-9:_.-]`) and bail to slow path only on `>=0x80` — all 12 workloads are ASCII-structure even when text is not.
* Zero-copy slices for names/text/attr values; never concatenate across scans except (a) entity expansion, (b) base64 single-nodes (F5), (c) KML `coordinates` (F10) — cap the concatenation path.
* Exploit repetition: intern or `===`-compare `loc`, `Key`, `url`, `w:t`, `trkpt`, `cac:`/`cbc:`/`w:` prefixes; share URL prefixes via slices, not copies.
* Whitespace-drop at scan time (don't materialize pretty-print text nodes): F1–F3/F7/F9 are pretty-printed; F4/F8 are minified — branch matters.
* Attribute parser must handle 0-attr (F3/F4) and 4–6-attr (F6/F8/OPML) without per-attr allocation spikes; `d`, `xmlUrl`, `href` values are 100–10,000 chars — slice, don't trim-copy.
* Entities: fast-path the 5 predefs (`&amp; &lt; &gt; &quot; &apos;`); slow-path latin-1 named set only when DOCTYPE/DTD hints it (F10 DBLP `&auml;` etc. per [dblp format](https://dblp.org/faq/16154937)); numeric `&#x...;` must handle >U+FFFF (emoji in feeds).
* CDATA: dedicated `]]>` scanner (F1/F2/F6); comments `<!--` and PIs `<?` skippable without tree nodes; DOCTYPE `<!DOCTYPE ...>` (+ internal subsets) skippable — required for F6/F10, forbidden-but-tolerate for SOAP [SOAP 1.1](https://www.w3.org/TR/2000/NOTE-SOAP-20000508).
* Namespaces: resolve prefixes lazily (store `qName` slice + prefix length); only F2/F5/F7/F8 need live prefix maps — default-ns-only docs (F3/F4) should never touch the map.
* Depth: stack must handle 12 (XMark) and 7–8 (OOXML/SVG/KML) without recursion; typical edge depth is 3–5 so a small inline stack (e.g. 16) covers 99% [inference].
* Size guards: default max ~2 MB input / ~50k elements for Free-tier safety; stream 5 MB+ only on Paid with `cpu_ms` raised [limits](https://developers.cloudflare.com/workers/platform/limits/index.md). Input `Uint8Array` path must avoid a full UTF-16 blowup before scanning when text is ASCII-heavy.
* Test matrix must include: ISO-8859-1-declared XMLTV bytes, `w:space="preserve"` boundary spaces (must survive drop rule), `gx:coord` space-separated vs `coordinates` comma-separated, and `encoding-type=url` `%`-escaped S3 keys.

## 5. Open questions that need a benchmark (in workerd, V8 15.1)

1. What sustained MB/s does the candidate parser hit in workerd (not Node) for F3 (flat) vs F8 (deep `w:`) vs F10 (giant text) at 100 KB / 1 MB / 5 MB?
2. At what input size does Free 10 ms actually break (expect 50–200 KB) vs Paid 30 s (expect 10–50 MB) for attribute-heavy F6 vs text-heavy F2?
3. Peak heap + output-tree ratio per fixture (input → `{name,attrs,children}` tree): is DOM blowup closer to 3× or 8×, and which fixture (KML coords vs OSM attrs vs `w:t` fragments) is worst?
4. Cost of entities: 5-predef-only vs full latin-1 table on F10-DBLP slice; cost of `%`-decoding S3 keys?
5. Cost of namespaces: `qName`-slice + lazy resolve vs eager `{prefix,local}` split on F2/F5/F7/F8?
6. CDATA vs escaped-HTML description throughput (F1 both forms)?
7. `Uint8Array`→string decode strategy: upfront `TextDecoder` vs lazy per-text-node decode for ASCII-heavy F3/F4 vs non-ASCII-heavy F9?
8. `w:space="preserve"` + whitespace-drop interaction: false-drop rate on real OOXML slices?
9. DOCTYPE skip cost and correctness on internal subsets (F10) — ignore vs validate?
10. Concurrency: 128 MB isolate-shared — how many simultaneous 500 KB parses before `exceededMemory`, and does slicing input (zero-copy) actually pin more than copying short strings?
11. Real feed drift: sample 100 live RSS/podcast/sitemap URLs — what % exceed 1 MB, use >U+00FF, CDATA, or >3 namespaces today? (No current crawl found; must measure.)
