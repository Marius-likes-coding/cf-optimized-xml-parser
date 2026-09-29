# How we researched, tested and built the parser

This document explains three things in plain words:

1. which tests and experiments we ran while designing the parser,
2. what they showed, and
3. how the finished parser works.

It is for people who use or maintain the library. You don't need to know how the JavaScript engine works inside: we explain each technical term where it first appears, and again in [Words used in this document](#words-used-in-this-document). The detailed numbers are in `research/`, and each section names its source.

## Summary

- **The parser is built for one place: Cloudflare Workers.** There, the JavaScript engine compiles code while your request waits, and that time counts as your request's CPU time. So we measured what a real Worker pays: the total CPU time of the first 100 parses in a fresh Worker instance.
- **Letting built-in functions do the searching is fastest.** We compared five ways to scan XML. The winner uses the engine's built-in search (`indexOf`) to jump through the text, instead of looking at each character in JavaScript.
- **The output shape was chosen by measurement.** We compared eight ways to build the result tree. The chosen shape is up to 24% smaller and no slower.
- **Checking the XML costs little.** All correctness checks together add 5–25% CPU before the code is optimized and 0–10% after. We kept all of them.
- **A short warm-up prevents an expensive surprise.** Without it, the first document of a new kind makes the engine throw away its optimized code and compile it again, which costs tens of milliseconds. We confirmed this, and the fix, on Cloudflare.
- **Results:** 1.1–2.1× less CPU than txml and 5–11× less than fast-xml-parser. The result tree is smaller than theirs on every test document except the SVG image, often about half the size. 1,263 of 1,736 applicable W3C conformance tests pass, and every failure comes from a documented limit of scope.

## 1. Why Cloudflare Workers need their own tests

Most benchmarks measure how fast code runs after it has run many times. On Cloudflare Workers, that number misleads, for four reasons:

1. **Workers start cold often.** Your code runs in an _isolate_, a sandboxed copy of the JavaScript engine V8. Cloudflare creates and discards isolates often, and every new isolate starts without compiled code.
2. **V8 speeds code up in stages.** It first interprets the code (the _Ignition_ tier). Code that runs often is compiled to faster machine code in up to three steps: _Sparkplug_, _Maglev_, and the top tier _Turboshaft_. Each step makes the code faster, but compiling it takes time.
3. **On Cloudflare, you pay for compiling.** On a normal computer, V8 compiles on a background thread. Cloudflare's production setup compiles on the thread that handles your request. The compile time counts as your request's CPU time.
4. **Compiled code can be thrown away.** Optimized code rests on assumptions about the data it has seen. When a new kind of input breaks those assumptions, V8 discards the code (a _deoptimization_) and later compiles it again.

So the number that matters is the whole cost from a cold start: slow early parses, compile time, and fast later parses. **Our main measure is the total CPU time of the first 100 parses in a fresh isolate** ("total-100"). We also report the speed of fully optimized code and the memory the result uses.

One early finding shaped this measure. For documents of about 100 KB, V8 already runs optimized code from about the 10th parse. Small documents (2–4 KB) stay in the slower stages for all 100 parses. So both early and later parses matter, and total-100 covers both.

## 2. How we tested

### 2.1 Research before code

We collected 10 research reports on the topics that decide parser speed: how workerd sets up V8, how V8 stores strings, objects and arrays, how its compiler treats hot loops, how Cloudflare runs code in production, how the fastest XML parsers work, what the XML standard requires, known attacks on XML parsers, typical XML workloads, and text that isn't plain ASCII.

We checked the key claims against the source code of V8 and workerd, and with small experiments in local workerd. Several claims were wrong or incomplete. For example:

- One report said V8 flags can't be used with workerd. They can, and we used them for every measurement.
- One report said text with any non-ASCII character always takes two bytes per character in memory. Only characters above U+00FF do that; text with only characters like é or ü stays at one byte per character.
- One report said most parses in production run in the slowest stages. For 100 KB documents that holds only for about the first 10 parses.

The result is `research/SYNTHESIS.md`: 40 facts, each with its source and how we checked it, the corrections, and the list of questions that experiments had to answer.

### 2.2 Decisions made before testing

Some questions are about what the parser should do, not about speed. We decided these before the experiments:

- The result is a tree of elements in document order, wrapped in a document object.
- Input can be a string or bytes.
- Text that is only whitespace between elements is dropped.
- Comments and processing instructions are kept.
- The parser follows XML 1.0 wherever the check is cheap. It skips the DTD (the optional grammar section in `<!DOCTYPE …>`), leaves namespace prefixes as they are, and refuses XML 1.1.
- Limits protect against hostile input: nesting depth, number of attributes, name length.

For everything else, the rule was: **the fastest option wins; if speed is equal, the smaller one wins.**

### 2.3 Test documents

We built a set of realistic test documents, generated from code in `src/bench-fixtures.ts`:

| Document                   | What makes it typical                                  |
| -------------------------- | ------------------------------------------------------ |
| RSS feed                   | News feed, pretty-printed, with CDATA sections         |
| Sitemap                    | Many short entries, many escaped characters (entities) |
| S3 bucket listing          | Minified, no attributes, many small elements           |
| SVG image                  | Many attributes per element, long attribute values     |
| SOAP response              | Namespace prefixes on every element                    |
| Word document body (OOXML) | Deep nesting, prefixed names                           |
| Entity-heavy document      | Escaped characters everywhere                          |
| Small RSS and S3 documents | 3 KB, to test small inputs                             |
| 1 MB RSS feed              | To test large inputs                                   |

Most documents are about 100 KB. Many exist in up to four text variants: plain ASCII; Latin-1 (é, ü); "poison" (mostly ASCII with a few characters above U+00FF, like curly quotes); and CJK-heavy. The variants matter because V8 stores a string with one byte per character only if every character is at most U+00FF. A single curly quote makes V8 store the whole document with two bytes per character. One RSS variant also uses Windows line endings (`\r\n`).

### 2.4 Measuring tools

All local measurements ran in workerd 1.20260815.1 (with V8 15.1), the open-source version of the runtime behind Cloudflare Workers, with the compiler settings of Cloudflare's production setup. We built these tools (details in `bench/README.md`):

| Tool             | Command                     | What it answers                                                                                                                                                        |
| ---------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stage profiles   | `npm run bench:tiers`       | How fast is the code in each V8 stage? Runs the same benchmark four times, each time with V8 limited to one stage.                                                     |
| Fresh isolates   | `npm run bench:cold`        | What does a real Worker pay? 10 new isolates × 100 parses each; reports parse #1, parses #2–10, parses #11–100 and total-100.                                          |
| Interleaved A/B  | `npm run bench:ab`          | Which of two variants is faster? Alternates between them in short bursts and takes the median. Needed because back-to-back runs on the same machine drifted by 20–50%. |
| Memory           | `npm run bench:memory`      | How much memory does the result tree keep alive? Measured after forced garbage collection.                                                                             |
| Competitors      | `npm run bench:competitors` | The same documents parsed by txml and fast-xml-parser.                                                                                                                 |
| Cloudflare check | `spikes/remote/`            | Does the local result hold on Cloudflare's servers? Reads Cloudflare's own CPU time per request from `wrangler tail`.                                                  |

On Cloudflare, timers inside a Worker don't advance while JavaScript runs, so no code inside the Worker can time a parse. That's why the Cloudflare check uses the CPU time that Cloudflare itself records for each request.

Experiments ran as throwaway code in `spikes/` (short experiments are often called _spikes_). Before comparing speed, we checked that all variants of an experiment produce identical results.

## 3. The experiments and what they showed

### 3.1 How to find the parts of a document (spike S1)

**Question:** What is the fastest way to find tags, text and attribute values?

**What we tried:** five scanners that differ only in how they search.

| Variant | How it searches                                                                                                       |
| ------- | --------------------------------------------------------------------------------------------------------------------- |
| A       | Built-in `indexOf` jumps to the next `<`, closing mark or quote; a JavaScript loop reads names character by character |
| B       | A JavaScript loop reads every character (the classic "state machine" design)                                          |
| C       | `indexOf` for text; a character loop for everything inside tags                                                       |
| D       | Like A, but names and attributes are read with a regular expression that returns the matched parts                    |
| E       | Like A, but names are checked with a regular expression that only answers "matches" or "doesn't match" (`test()`)     |

**Results:**

- B was 2–4× slower than A in the early stages. V8 runs JavaScript loops slowly until it optimizes them, but its built-in functions run at full speed from the first call.
- C was the slowest of all on the SVG document in the interpreter, because its loop walks through long attribute values.
- D was fast early but slow once optimized, because it creates new objects for every attribute.
- E was fastest or tied on most documents:

| Total-100, ms |     A |     D |     **E** |
| ------------- | ----: | ----: | --------: |
| RSS feed      | 107.3 | 109.9 |  **99.4** |
| SVG image     | 179.3 | 265.3 | **183.0** |
| SOAP response | 133.8 | 183.8 | **137.0** |
| Small RSS     |  13.6 |     — |   **9.4** |

Documents with two-byte text scanned only about 10% slower than plain ASCII.

**Decision:** variant E.

### 3.2 What the result looks like and how to build it (spike S2)

**Question:** Within the decided tree format, which details make parsing fastest and the result smallest?

**What we tried:** one change at a time against a base version, measured for CPU in every stage and for memory.

| Change                                                                              | CPU                                        | Memory                                      | Decision                               |
| ----------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------- | -------------------------------------- |
| Attributes as an object `{ name: value }` instead of a flat list `[name, value, …]` | up to 50% slower once optimized (SVG)      | 13–36% smaller on attribute-heavy documents | rejected: speed comes first            |
| Children added one by one with `push`, instead of copied at the end tag             | same early, about 4% faster once optimized | 5–24% larger (arrays keep spare slots)      | rejected: equal speed, so smaller wins |
| An element whose only child is text stores the text directly (`children: "text"`)   | 2–17% faster once optimized, same early    | 14–24% smaller on text-heavy documents      | **adopted**                            |
| Identical names share one string (interning)                                        | 10–31% slower                              | 17–28% smaller                              | rejected                               |
| Nodes created by a class instead of an object literal                               | 0–21% slower                               | no difference                               | rejected                               |

**Decision:** every node has the same three fields, `{ name, attrs, children }`, so V8 can treat all nodes as one type. Attributes are a flat list. A lone text child is stored as a string.

### 3.3 How to handle bytes (spike S3)

**Question:** When input arrives as bytes, is it faster to convert it to a string first, or to parse the bytes directly?

**What we tried:** decoding once with the built-in `TextDecoder` and then parsing the string; a "hybrid" that turns bytes into a raw one-byte string and decodes only the parts that need it; and the building blocks of a parser that reads the bytes directly.

**Results:**

- Decoding once was fastest in every case. The hybrid was 8–217% slower.
- Searching bytes (`Uint8Array.indexOf`) is 1.6–3.6× slower than searching a string. The string search uses the fast system function `memchr`; the byte search apparently doesn't.
- Decoding each value separately costs 3–10× more than cutting it out of a decoded string.
- Decoding a 114 KB document costs about 6 µs for plain ASCII and up to about 285 µs for CJK text (measured on a quiet machine).
- Strict decoding, which rejects invalid bytes, costs nothing measurable.
- For a `Response`, `response.text()` and `response.arrayBuffer()` were within ±20% of each other, with no consistent winner.

**Decision:** decode bytes once, then run the string parser.

### 3.4 What correctness costs (spike S4)

**Question:** Can the parser afford the checks the XML standard requires?

**What we tried:** a strict version with every chosen check, compared with a lenient one:

- line endings `\r\n` and `\r` turned into `\n`, and tabs and line breaks in attribute values turned into spaces;
- duplicate attributes, `]]>` in text, `--` in comments;
- rules for the XML declaration, the DOCTYPE and processing instructions;
- the full set of characters XML allows in names;
- character references (like `&#65;`) checked for valid numbers;
- the limits on depth, attributes and name length.

One technique keeps these checks cheap. The parser searches the whole document once for each rare character (`&`, `\r`, `]]>`) and remembers where it is. It searches again only after passing that position. A document without any `&` pays for one failed search, not one per text.

**Results:** the strict version costs 5–25% more CPU in the early stages (up to about 20% on the SVG document) and 0–10% once optimized. It uses no extra memory on documents that need no changes.

**Decision:** keep every check.

### 3.5 How V8 compiles the parser (spike S5)

**Question:** When does V8 optimize the parser, what does that cost, and what makes it throw optimized code away?

**What we found (locally):**

- Compiling is expensive: 4–12 ms for Maglev and 48–94 ms for the top tier, on a busy machine.
- The size of the parser function doesn't change this. We tried making it too large for the top tier; then Maglev came only after about 75 parses instead of 8, and was slower to compile.
- **Deoptimization cause 1:** arrays created fresh for each parse start out typed for small numbers. When the parser put an element into one, V8 discarded its optimized code. **Fix:** a few arrays created once per isolate, with their content type fixed from the start.
- **Deoptimization cause 2:** a new kind of document reaches code paths that never ran before, so V8 has no data about them. Switching from an RSS feed to an SVG image made V8 discard its optimized code and compile again (another 75–90 ms locally).
- **Fix for cause 2: a warm-up.** V8 starts recording data about a function only after about 8 calls. So a warm-up needs about 10 parses of a small document that uses every feature. With 0 or 1 warm-up parses the deoptimizations stayed; with 10 they were gone; with 30, V8 optimized on the warm-up data alone.

**Decision:** fixed-type arrays created once per isolate, and an explicit `warmup()` function that you call when your Worker starts.

### 3.6 Confirmation on Cloudflare

We deployed the spike parser as a Worker and read Cloudflare's CPU time for each request, one parse per request.

- The top-tier compile happens once per isolate and costs 24–45 ms on Cloudflare's servers.
- Without a warm-up, switching from RSS to SVG caused another deoptimization and a recompile of about 35 ms.
- With the warm-up, that second compile disappeared. The warm-up itself cost about 1–2 ms, once per isolate.
- A cold parse of a 114–135 KB document took 2–5 ms; a warm parse took under 1 ms.
- An 8–10 ms step around parse #48 turned out to be the one-time compile of the function that decodes entities (found in the performance pass, section 3.9), not garbage collection.
- Requests from one client can be spread over several isolates, and each isolate pays its own cold start.

**After the release, we checked again** with the finished parser and `warmup()` called at the top of the Worker's module. Each run sent 140 requests with seven kinds of documents in a row: RSS, SVG, SOAP, a Word document with CJK text, an S3 listing as bytes, RSS with Windows line endings, and an entity-heavy document.

- **Without the warm-up,** the isolate that served the most requests compiled the parser again three times, for 27–36 ms each. Each recompile came on or just after a change to a new kind of document.
- **With the warm-up of version 2.0.0,** every change was free except one: RSS with Windows line endings still caused a 24 ms recompile. The cause was one search (for the next `\r` before a processing instruction) that the warm-up documents never ran. A coverage check, which lists every part of the code that never ran, found three more such gaps. We extended the warm-up documents to cover all four.
- **With the extended warm-up,** no change of document kind caused a recompile. Only the two one-time compiles that every isolate pays remained: the parser (42 ms) and the entity decoder (14 ms).
- **The warm-up runs when the isolate starts.** It raised the Worker's startup time from 1 ms to 4 ms, but it isn't counted in the first request's CPU time: the first parse in an isolate cost 1–2 ms with the warm-up, and 2.8 ms on average without.

### 3.7 Robustness and security tests

**Question:** Can hostile or broken input crash the parser or make it slow?

**What we tested:**

- Extreme inputs, each with a time limit: 20,000 attributes, 1 million character references, 1 million entities in one attribute, 5 MB of text, 100,000 sibling elements, nesting 100,000 levels deep, 1 million comments.
- Input over a limit must be rejected quickly: a document of 1 million start tags stops at the depth limit in under 200 ms, and a DOCTYPE over 64 KiB is refused.
- A document cut off at every possible position must throw an `XmlError`, never another kind of error.
- Names like `__proto__` and `constructor` must stay plain data.
- A _fuzzer_ changes small documents at random (seeded, so every run can be repeated) and checks that each result either parses or throws `XmlError`: never another error, a stack overflow or a slow parse.

**Results:** one real problem, now fixed. With a raised attribute limit, the duplicate-attribute check became quadratic: 20,000 attributes took 1.2 seconds. The check now uses a hash set once an element has more than 16 attributes. On the released parser, 1.5 million fuzzer inputs all either parsed or threw `XmlError`, and the slowest took 1.2 ms. The CI runs 50,000 inputs on every push.

### 3.8 The W3C conformance suite

**Question:** How close is the parser to the XML 1.0 standard?

**What we tested:** the official W3C XML Conformance Test Suite (version 20130923). Every test document is parsed from bytes, so encoding detection is tested too. We skipped 576 tests that don't apply: XML 1.1, older editions of the standard, and tests that need external files.

**Results:** 1,263 of 1,736 applicable tests pass (72.8%). Every failure has one of four known causes, all of them decisions about scope:

| Cause                                                                                  | Failing tests |
| -------------------------------------------------------------------------------------- | ------------: |
| The DTD is skipped, not checked, so broken DTD declarations are accepted               |           335 |
| Entities declared in the DTD are not expanded, so documents that use them are rejected |            42 |
| Characters XML forbids (control characters, lone surrogates) are not rejected          |            74 |
| Namespace rules are not checked                                                        |            22 |

The suite found three real bugs, now fixed: a DOCTYPE without a name was accepted; a byte order mark that contradicted the declared encoding was accepted; and versions like `1.7` were rejected, although the standard allows a 1.0 parser to accept them.

We measured one of the skipped checks. Rejecting forbidden characters costs 0–5% on ASCII documents, but 44–205% on two-byte documents. It stays off.

### 3.9 Performance pass

**Question:** Where does the time go in the finished parser, and can we save more?

**Results:**

- The main parser function takes 86% of the time, entity decoding 4%, garbage collection 1.5%.
- In 300 parses in a row, V8 ran no major garbage collection at all. The result trees are short-lived and cheap to clean up.
- Two ideas didn't help, so we didn't adopt them. A lookup table for ASCII name characters was faster on SVG and Word documents (−12% and −16%) but slower on RSS and S3 listings (+10% each). Remembering more search positions made no measurable difference.

## 4. Results against other parsers

We compared against two popular parsers: **txml**, which is very fast but checks almost nothing and doesn't decode entities, and **fast-xml-parser**, in its `preserveOrder` mode, whose output is closest to ours.

Total CPU time of the first 100 parses in a fresh isolate, in milliseconds (lower is better):

| Document (~100 KB)   | This parser | txml | fast-xml-parser |
| -------------------- | ----------: | ---: | --------------: |
| RSS feed             |      **73** |   92 |             439 |
| SVG image            |     **135** |  237 |             999 |
| SOAP response        |     **115** |  161 |             773 |
| S3 listing, minified |      **98** |  111 |             504 |
| Word document body   |      **96** |  199 |             936 |
| Sitemap              |      **86** |  123 |             570 |
| RSS feed, 3.5 KB     |     **5.4** |  9.3 |            59.5 |

Memory kept alive by the result tree, in KB (lower is better; the input string is not counted):

| Document             | This parser | txml | fast-xml-parser |
| -------------------- | ----------: | ---: | --------------: |
| RSS feed             |     **106** |  218 |             225 |
| SVG image            |         331 |  272 |         **255** |
| SOAP response        |     **271** |  401 |             423 |
| S3 listing, minified |     **175** |  425 |             432 |
| Word document body   |     **313** |  504 |             425 |
| Sitemap              |     **270** |  529 |             501 |
| RSS feed, 3.5 KB     |     **3.4** |  7.7 |             9.7 |

**Where we missed our targets:**

- We aimed for at least 1.5× less CPU than both competitors. Against fast-xml-parser we reached 5–11× everywhere. Against txml we reached it on the SVG, Word and small documents, but only 1.13–1.44× on RSS, S3, SOAP and sitemap. On these documents, much of our time goes to work txml skips: decoding entities and checking the XML.
- On the SVG image, our tree is 22% larger than txml's. Our flat attribute lists store a copy of each short attribute name, while object keys in the other parsers share one copy.

## 5. How the finished parser works

### 5.1 The result

`parse()` returns `{ root, children }`. `root` is the root element; `children` lists every top-level node in order, including comments. Every node has the same three fields:

```js
{ name: "item", attrs: ["id", "1"], children: [ … ] }
```

- `name` is the element name. Comments are named `"#comment"`, processing instructions `"?"` plus their target.
- `attrs` is a flat list `[name, value, name, value, …]`, or `null`.
- `children` is `null` when empty, the text itself when the only child is text, and a list otherwise.

The README describes the result and the helper functions in full.

### 5.2 From input to text

If the input is a string, the parser uses it as it is.

If the input is bytes, the parser first works out the encoding:

1. A byte order mark at the start decides (UTF-8, UTF-16LE or UTF-16BE).
2. Otherwise, the `encoding` in the XML declaration decides (for example `<?xml version="1.0" encoding="ISO-8859-1"?>`).
3. Otherwise, the text is UTF-8.

It then decodes all bytes at once with the built-in `TextDecoder`. Invalid bytes throw an error. From here on, bytes and strings take the same path.

### 5.3 The main loop

The parser is one function with one loop (`src/parse-string.ts`). It keeps a list of the elements that are open, and a shared work area where the children of open elements collect.

1. **Find the next `<`** with `indexOf`. Everything before it is text.
2. **Handle the text.** If it is only whitespace, drop it. Otherwise, check it for `]]>`, decode entities if there is an `&` in it, and normalize line endings if there is a `\r`. Text that needs none of this is taken from the input as it is, with `slice`.
3. **Look at the character after `<`** to decide what comes next:
   - `/` starts an **end tag**. The parser checks that the name matches the open element, closes it, and copies its children out of the work area into the element. A lone text child is stored as the text itself.
   - `!` starts a **comment**, a **CDATA section** or the **DOCTYPE**. A comment becomes a `#comment` node. CDATA becomes ordinary text, joined with the text around it. The DOCTYPE is checked at its start and then skipped.
   - `?` starts a **processing instruction** or the **XML declaration**. A processing instruction becomes a node named `?` plus its target. The declaration is checked, not stored.
   - Anything else starts an **element**. The parser checks the name with a regular expression, then reads the attributes one by one: name, `=`, and a quoted value, whose end it finds with `indexOf`. Each name is compared with the names before it to catch duplicates. The element is added to the work area, and, unless it ends with `/>`, to the list of open elements.
4. **Repeat** until the input ends. Then every element must be closed, and there must be exactly one root element.

Two details keep this fast:

- **Remembered positions.** The parser searches for rare characters (`&`, `\r`, `]]>`, tab or line break in attribute values) once and remembers where the next one is. It searches again only after passing that position.
- **One search, two jobs.** After a start tag, the parser searches for the next `<` from the start of the tag, not from its end. If it finds one inside the tag, the tag is broken. So the same search both moves on and checks the tag.

### 5.4 Errors and limits

Broken input throws an `XmlError` with the position (`offset`), `line` and `column`. The parser computes line and column only when an error happens, so correct documents don't pay for it. Error messages never quote the input.

Three limits protect against hostile input: nesting depth (256), attributes per element (200) and name length (1,000 characters). You can change them in the options. The DOCTYPE is limited to 64 KiB.

### 5.5 Memory

Text and values of 13 or more characters are not copied, unless the parser had to change them (entities, line endings): V8 stores them as a reference into the input. That keeps the tree small, but it also keeps the whole input in memory as long as any part of the result is in use. Use the result within the request that produced it.

The parser's work area and its list of open elements are created once per isolate and reused. After every parse, and after every error, they are emptied, so they don't keep old documents alive.

### 5.6 The warm-up

`warmup()` parses two small built-in documents 10 times in total, and decodes one of them from bytes once. Together, the two documents use every feature and every code path of the parser. We checked this with V8's coverage tool: parsing them runs every part of the parser except error handling and a few simple steps for which V8 needs no data. One document has only one-byte characters, the other has characters above U+00FF, so V8 sees both kinds of string.

Call it once at the top of your Worker's module. There, it runs when the isolate starts, not during a request. It is worth it when one Worker parses documents of different kinds. A second call does nothing.

### 5.7 What the parser does not do

- **DTDs:** the DTD inside `<!DOCTYPE …>` is skipped. Entities declared there are not expanded; documents that use them throw "unknown entity". Nothing is ever loaded from outside.
- **Namespaces:** prefixes stay part of the name (`"soap:Body"`); namespace rules are not checked.
- **Forbidden characters:** control characters and lone surrogates are not rejected, because checking them would cost up to 3× on non-ASCII documents.
- **XML 1.1** is refused.
- **Streaming:** the whole document must be in memory.

## Words used in this document

| Word                                    | Meaning                                                                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| CDATA section                           | `<![CDATA[ … ]]>`: text in which `<` and `&` have no special meaning                                                        |
| Deoptimization                          | V8 discards optimized code because its assumptions about the data turned out wrong; the code later has to be compiled again |
| DTD                                     | Optional grammar rules and entity definitions inside `<!DOCTYPE …>`                                                         |
| Entity                                  | An escaped character such as `&amp;` for `&`; a character reference such as `&#65;` gives the character by number           |
| Fuzzer                                  | A program that feeds random, changed inputs to code to find crashes                                                         |
| Garbage collection                      | V8 freeing memory that is no longer used                                                                                    |
| Ignition, Sparkplug, Maglev, Turboshaft | V8's four stages (tiers), from interpreter to fully optimizing compiler                                                     |
| Isolate                                 | A sandboxed copy of the V8 engine that runs a Worker; Cloudflare creates and discards them often                            |
| One-byte / two-byte string              | How V8 stores text: one byte per character if all characters are at most U+00FF, otherwise two bytes per character          |
| Processing instruction                  | `<?target data?>`: an instruction for an application, kept in the result                                                    |
| Spike                                   | A short, throwaway experiment that answers one design question                                                              |
| Total-100                               | Our main measure: total CPU time of the first 100 parses in a fresh isolate, including compile time                         |
| V8                                      | The JavaScript engine in Chrome and in Cloudflare Workers                                                                   |
| workerd                                 | The open-source runtime behind Cloudflare Workers; we ran all local measurements in it                                      |
| µs                                      | Microsecond, a thousandth of a millisecond                                                                                  |

## Where to find the details

| Topic                                             | File                                      |
| ------------------------------------------------- | ----------------------------------------- |
| Verified facts, corrections, all design decisions | `research/SYNTHESIS.md`                   |
| Scanner experiment (3.1)                          | `research/spikes/s1-scanner.md`           |
| Tree-building experiment (3.2)                    | `research/spikes/s2-tree-building.md`     |
| Bytes experiment (3.3)                            | `research/spikes/s3-bytes-input.md`       |
| Cost of correctness (3.4)                         | `research/spikes/s4-correctness-costs.md` |
| Compiler behavior and Cloudflare check (3.5, 3.6) | `research/spikes/s5-jit-behavior.md`      |
| Conformance suite (3.8)                           | `research/conformance.md`                 |
| Performance pass (3.9, 4)                         | `research/spikes/m7-performance.md`       |
| Measuring tools                                   | `bench/README.md`                         |
| Milestones the parser was built in                | `docs/implementation-plan.md`             |
| API and usage                                     | `README.md`                               |
