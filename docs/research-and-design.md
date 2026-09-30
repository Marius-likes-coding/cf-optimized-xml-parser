# Research, tests and design of the parser

## About this document

This document gives the results of the research for the parser. It has these parts:

1. The tests and experiments that we did during the design of the parser.
2. The results of these tests.
3. How the finished parser operates.
4. Answers to three questions about the startup cost and the benchmarks.

The document is for persons who use or maintain the library. It is not necessary to know how the JavaScript engine operates. Section 8 gives the meaning of each technical term.

The document uses the writing rules of ASD-STE100 Simplified Technical English. Where STE has no approved word, the document uses technical names and technical verbs from software, for example "isolate", "parse" and "compile".

The detailed numbers are in the `research/` folder. Section 9 gives the source file for each section.

## 1. Summary

- **The parser is for one platform: Cloudflare Workers.** On this platform, the JavaScript engine compiles code while your request waits. Cloudflare counts this time as CPU time of your request. For this reason, our primary measurement is the total CPU time of the first 100 parses in a new Worker instance.
- **Built-in search functions give the fastest scan.** We compared five scan methods. The best method uses the built-in function `indexOf` to go directly to the next `<`. It does not examine each character in JavaScript.
- **Measurements selected the shape of the result.** We compared eight methods to make the result tree. The selected shape is up to 24% smaller, and it is not slower.
- **The correctness checks use little CPU time.** All checks together increase the CPU time by 5–25% before V8 optimizes the code, and by 0–10% after. We kept all checks.
- **A short warm-up prevents a large, unexpected cost.** Without the warm-up, the first document of a new type causes V8 to remove its optimized code. Then V8 compiles the code again, and this uses 24–45 ms of CPU time. We confirmed this problem and its correction on Cloudflare.
- **The parser is faster than two popular parsers.** txml uses 1.1–2.1 times more CPU time, and fast-xml-parser uses 5–11 times more. Our result tree is smaller than their trees on all test documents, but not on the SVG image.
- **The parser passes 1,263 of 1,736 applicable W3C conformance tests.** Each failure has a known cause. Each cause is a decision about the scope of the parser.
- **Section 7 answers three questions.** These questions are about the startup cost of the warm-up and about the benchmarks in the CI.

## 2. Why the tests for Cloudflare Workers are special

Most benchmarks measure the speed of code after many runs. On Cloudflare Workers, this speed does not show the real cost. There are four reasons:

1. **Workers start cold frequently.** Your code operates in an _isolate_, which is a separate instance of the JavaScript engine V8. Cloudflare starts and stops isolates frequently. Each new isolate starts without compiled code.
2. **V8 makes code faster in steps.** First, V8 interprets the code (the _Ignition_ tier). Then V8 compiles code that runs frequently to faster machine code, in up to three steps: _Sparkplug_, _Maglev_ and the top tier _Turboshaft_. Each step makes the code faster, but each compilation uses time.
3. **On Cloudflare, you pay for the compilation.** On a usual computer, V8 compiles code on a background thread. In the production setup of Cloudflare, V8 compiles code on the thread of your request. Cloudflare counts this compilation time as CPU time of your request.
4. **V8 can remove compiled code.** Optimized code uses assumptions about the data that it saw before. If a new type of input does not agree with these assumptions, V8 removes the code (a _deoptimization_). Then V8 compiles the code again.

For these reasons, the important number is the full cost from a cold start. This cost includes the slow first parses, the compilation time and the fast parses after them. **Our primary measurement is the total CPU time of the first 100 parses in a new isolate.** The name of this measurement is "total-100". We also measure the speed of fully optimized code and the memory of the result.

One early result had an effect on this measurement. For documents of approximately 100 KB, V8 uses optimized code from approximately the 10th parse. Small documents (2–4 KB) stay in the slow tiers for all 100 parses. For this reason, the early parses and the later parses are both important, and total-100 includes both.

## 3. How we did the tests

### 3.1 Research before the code

We collected 10 research reports about the subjects that have an effect on the speed of a parser:

- how workerd configures V8
- how V8 keeps strings, objects and arrays in memory
- how the V8 compiler optimizes loops that run frequently
- how Cloudflare operates code in production
- how the fastest XML parsers operate
- what the XML standard requires
- known attacks on XML parsers
- typical XML workloads
- text with characters that are not ASCII

We compared the important statements with the source code of V8 and workerd. We also did small experiments in a local workerd. Some statements were incorrect or not complete. For example:

- One report said that workerd cannot use V8 flags. This is incorrect. We used V8 flags for all measurements.
- One report said that V8 uses two bytes for each character of a text with non-ASCII characters. This is only true for characters above U+00FF. Text with only characters such as é or ü uses one byte for each character.
- One report said that most parses in production run in the slowest tiers. For documents of 100 KB, this is only true for approximately the first 10 parses.

The result is the file `research/SYNTHESIS.md`. It contains 40 facts, each with its source and the method that we used to examine it. It also contains the corrections and the questions for the experiments.

### 3.2 Decisions before the tests

Some questions are about the function of the parser, not about its speed. We made these decisions before the experiments:

- The result is a tree of elements in the sequence of the document. A document object contains the tree.
- The input can be a string or bytes.
- The parser removes text between elements if this text contains only whitespace.
- The parser keeps comments and processing instructions.
- The parser obeys XML 1.0 if the check uses little CPU time. The parser does not read the DTD, which is the optional grammar section in `<!DOCTYPE …>`. It does not change namespace prefixes, and it does not accept XML 1.1.
- Limits give protection against dangerous input. The limits apply to the nesting depth, the number of attributes and the length of names.

For all other questions, the rule was: the fastest option wins. If two options have the same speed, the smaller option wins.

### 3.3 Test documents

We made a set of realistic test documents. The code in `src/bench-fixtures.ts` makes these documents.

| Document                    | Why it is typical                                         |
| --------------------------- | --------------------------------------------------------- |
| RSS feed                    | A news feed with indents and CDATA sections               |
| Sitemap                     | Many short entries and many escaped characters (entities) |
| S3 bucket list              | Minified text, no attributes, many small elements         |
| SVG image                   | Many attributes in each element, long attribute values    |
| SOAP response               | Namespace prefixes on all elements                        |
| Word document body (OOXML)  | Deep nesting, names with prefixes                         |
| Document with many entities | Escaped characters in all parts of the text               |
| Small RSS and S3 documents  | 3 KB, for the test of small input                         |
| RSS feed of 1 MB            | For the test of large input                               |

Most documents are approximately 100 KB. Many documents have up to four text variants:

- plain ASCII
- Latin-1, for example é and ü
- "poison": almost all ASCII, but with some characters above U+00FF, for example curly quotes
- CJK text

The variants are important because of the V8 string format. V8 uses one byte for each character only if all characters are U+00FF or lower. One curly quote causes V8 to use two bytes for each character of the full document. One RSS variant also has Windows line ends (`\r\n`).

### 3.4 Measurement tools

We did all local measurements in workerd 1.20260815.1 with V8 15.1. workerd is the open-source version of the runtime of Cloudflare Workers. We used the compiler settings of the production setup of Cloudflare. We made the tools in this table. `bench/README.md` gives more data.

| Tool             | Command                     | What the tool measures                                                                                                                                             |
| ---------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tier profiles    | `npm run bench:tiers`       | The speed of the code in each V8 tier. The tool runs the same benchmark four times. Each time, V8 can use only one tier.                                           |
| New isolates     | `npm run bench:cold`        | The cost for a real Worker. The tool starts 10 new isolates and does 100 parses in each isolate. It shows parse 1, parses 2–10, parses 11–100 and total-100.       |
| A/B comparison   | `npm run bench:ab`          | Which one of two variants is faster. The tool runs the variants in short alternate bursts and uses the median. Two runs on one computer had differences of 20–50%. |
| Memory           | `npm run bench:memory`      | The memory that the result tree keeps. The tool measures after a forced garbage collection.                                                                        |
| Competitors      | `npm run bench:competitors` | The same documents with txml and fast-xml-parser.                                                                                                                  |
| Cloudflare check | `spikes/remote/`            | If the local results are also correct on the servers of Cloudflare. The tool reads the CPU time that Cloudflare records for each request (`wrangler tail`).        |

On Cloudflare, the timers in a Worker do not move forward while JavaScript runs. For this reason, code in the Worker cannot measure the time of a parse. The Cloudflare check uses the CPU time that Cloudflare records for each request.

The experiments used temporary code in the `spikes/` folder. The name for a short experiment of this type is "spike". Before we compared the speed of the variants of an experiment, we made sure that all variants gave the same results.

## 4. Experiments and results

### 4.1 How to find the parts of a document (spike S1)

**Question:** Which method finds tags, text and attribute values fastest?

**Test:** We compared five scanners. The only difference between the scanners is the search method.

| Variant | Search method                                                                                                        |
| ------- | -------------------------------------------------------------------------------------------------------------------- |
| A       | The built-in function `indexOf` goes directly to the next `<`, end mark or quote. A JavaScript loop reads each name. |
| B       | A JavaScript loop reads each character of the document. This is the usual "state machine" design.                    |
| C       | `indexOf` finds the text. A JavaScript loop reads all characters in tags.                                            |
| D       | Same as A, but a regular expression reads names and attributes and gives the matched parts.                          |
| E       | Same as A, but a regular expression examines names and gives only "match" or "no match" (`test()`).                  |

**Results:**

- In the early tiers, B was 2–4 times slower than A. V8 runs JavaScript loops slowly before it optimizes them. Built-in functions run at full speed from the first call.
- On the SVG image in the interpreter, C was the slowest variant. Its loop reads all characters of the long attribute values.
- D was fast in the early tiers, but slow after the optimization. It makes new objects for each attribute.
- E was the fastest variant, or equally fast, on most documents:

| Total-100, ms |     A |     D |     **E** |
| ------------- | ----: | ----: | --------: |
| RSS feed      | 107.3 | 109.9 |  **99.4** |
| SVG image     | 179.3 | 265.3 | **183.0** |
| SOAP response | 133.8 | 183.8 | **137.0** |
| Small RSS     |  13.6 |     — |   **9.4** |

For documents with two-byte text, the scan time was only approximately 10% longer than for plain ASCII.

**Decision:** Variant E.

### 4.2 The shape of the result and how to make it (spike S2)

**Question:** In the selected tree format, which details give the fastest parse and the smallest result?

**Test:** We changed one detail at a time and compared the result with a base version. We measured the CPU time in each tier and the memory.

| Change                                                                                | CPU time                                                   | Memory                                           | Decision                                  |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------- |
| Attributes as an object `{ name: value }`, not as a flat list `[name, value, …]`      | Up to 50% more after the optimization (SVG)                | 13–36% smaller on documents with many attributes | Not used, because speed is more important |
| The parser adds each child with `push`, and does not copy the children at the end tag | Same in the early tiers, 4% less after the optimization    | 5–24% larger, because arrays keep empty slots    | Not used, because the smaller option wins |
| If text is the only child, the element keeps the text directly (`children: "text"`)   | 2–17% less after the optimization, same in the early tiers | 14–24% smaller on documents with much text       | Used                                      |
| One shared string for each name (interning)                                           | 10–31% more                                                | 17–28% smaller                                   | Not used                                  |
| The parser makes nodes with a class, not with an object literal                       | 0–21% more                                                 | No difference                                    | Not used                                  |

**Decision:** All nodes have the same three fields, `{ name, attrs, children }`. For this reason, V8 can use one type for all nodes. Attributes are a flat list. If the only child is text, the element keeps the text as a string.

### 4.3 How to process bytes (spike S3)

**Question:** If the input is bytes, is it faster to change the bytes into a string first, or to parse the bytes directly?

**Test:** We compared these methods:

- Decode all bytes one time with the built-in `TextDecoder`, and then parse the string.
- A "hybrid" method: change the bytes into a raw one-byte string, and decode only the parts with non-ASCII bytes.
- The basic operations of a parser that reads the bytes directly.

**Results:**

- The decode of all bytes at one time was the fastest method in all tests. The hybrid method was 8–217% slower.
- A search in bytes (`Uint8Array.indexOf`) is 1.6–3.6 times slower than a search in a string. The string search uses the fast system function `memchr`. Our measurements show that the byte search probably does not use it.
- A separate decode for each value takes 3–10 times more time than a cut from a decoded string.
- On a computer with no other load, the decode of a 114 KB document took approximately 6 µs for plain ASCII. For CJK text, it took up to approximately 285 µs.
- A strict decode, which rejects incorrect bytes, has no measurable cost.
- For a `Response`, the difference between `response.text()` and `response.arrayBuffer()` was ±20% or less. Neither method was always faster.

**Decision:** Decode the bytes one time. Then use the string parser.

### 4.4 The cost of correctness (spike S4)

**Question:** Can the parser do the checks that the XML standard requires, with an acceptable cost?

**Test:** We compared a strict version with all selected checks and a version without these checks. The strict version does these checks and changes:

- It changes the line ends `\r\n` and `\r` into `\n`. It changes tabs and line breaks in attribute values into spaces.
- It finds duplicate attributes, `]]>` in text and `--` in comments.
- It applies the rules for the XML declaration, the DOCTYPE and processing instructions.
- It accepts all characters that XML permits in names.
- It examines the numbers in character references such as `&#65;`.
- It applies the limits for the depth, the attributes and the length of names.

One method keeps these checks fast. The parser searches the full document one time for each rare character (`&`, `\r`, `]]>`). It keeps the position of the result. It searches again only after it moves past that position. If a document has no `&`, the parser does one search for `&` in total, not one search for each text.

**Results:** The strict version uses 5–25% more CPU time in the early tiers, and up to approximately 20% more on the SVG image. After the optimization, it uses 0–10% more. On documents that the parser does not change, it uses no more memory.

**Decision:** Keep all checks.

### 4.5 How V8 compiles the parser (spike S5)

**Question:** When does V8 optimize the parser? How much time does this use? What causes V8 to remove optimized code?

**Results of the local measurements:**

- The compilation uses much time: 4–12 ms for Maglev and 48–94 ms for the top tier, on a computer with a high load.
- The size of the parser function does not change this. We made the function too large for the top tier. Then Maglev compiled it only after approximately 75 parses, not after 8. The Maglev compilation was also slower.
- **Deoptimization cause 1:** Each parse made new arrays. At the start, V8 configures a new array for small numbers. When the parser put an element object into this array, V8 removed the optimized code. **Correction:** The parser makes a small number of arrays one time for each isolate. The content type of these arrays does not change.
- **Deoptimization cause 2:** A new type of document goes through code paths that did not run before. V8 has no data about these paths. After an RSS feed, an SVG image caused V8 to remove its optimized code and compile the code again. Locally, this used 75–90 ms more.
- **Correction for cause 2: a warm-up.** V8 starts to record data about a function only after approximately 8 calls. For this reason, a warm-up must do approximately 10 parses of a small document that uses all features. With 0 or 1 warm-up parses, the deoptimizations occurred. With 10 parses, they did not occur. With 30 parses, V8 optimized the code with only the data from the warm-up.

**Decision:** The parser makes its arrays one time for each isolate, with a fixed content type. The library supplies a `warmup()` function that you call when your Worker starts.

### 4.6 Tests on Cloudflare

We did two series of tests on Cloudflare. In each test, one request did one parse. We read the CPU time that Cloudflare recorded for each request.

**First series, with the spike parser:**

- The top-tier compilation occurs one time in each isolate. On the servers of Cloudflare, it uses 24–45 ms.
- Without a warm-up, the change from RSS to SVG caused one more deoptimization. The recompilation used approximately 35 ms.
- With the warm-up, this second compilation did not occur. The warm-up used approximately 1–2 ms, one time in each isolate. In this series, the warm-up ran in the first request.
- A cold parse of a 114–135 KB document used 2–5 ms. A warm parse used less than 1 ms.
- At approximately parse 48, the CPU time increased by 8–10 ms. The performance pass (section 4.9) found the cause: the one-time compilation of the function that decodes entities. Garbage collection was not the cause.
- Cloudflare can send the requests of one client to different isolates. Each isolate has its own cold start.

**Second series, with the released parser (version 2.0.0):** The Worker calls `warmup()` in the global scope of its module. Each test sent 140 requests with seven types of documents in this sequence:

1. RSS
2. SVG
3. SOAP
4. A Word document with CJK text
5. An S3 list as bytes
6. RSS with Windows line ends
7. A document with many entities

The results were:

- **Without the warm-up:** The isolate with the most requests compiled the parser three more times. Each recompilation used 27–36 ms. Each recompilation occurred at or after a change to a new type of document.
- **With the warm-up of version 2.0.0:** Only one change of document type caused a recompilation. RSS with Windows line ends caused a recompilation of 24 ms. The cause was a search that the warm-up documents did not do: the search for the next `\r` before a processing instruction.
- **The coverage check:** A coverage check shows all parts of the code that did not run. This check found three more gaps of the same type. We added the four code paths to the warm-up documents.
- **With the extended warm-up:** No change of document type caused a recompilation. Only the two compilations that occur one time in each isolate stayed: the parser (42 ms) and the entity decoder (14 ms).
- **Startup time:** The warm-up runs when the isolate starts. It increased the startup time of the Worker from 1 ms to 4 ms. Section 7.1 tells who pays this time.

### 4.7 Robustness and security tests

**Question:** Can dangerous or damaged input cause the parser to stop or to become slow?

**Test:**

- Extreme input, each with a time limit:
  - 20,000 attributes
  - 1 million character references
  - 1 million entities in one attribute
  - 5 MB of text
  - 100,000 sibling elements
  - 100,000 levels of nesting
  - 1 million comments
- The parser must quickly reject input that is more than a limit. A document with 1 million start tags stops at the depth limit in less than 200 ms. The parser rejects a DOCTYPE that is larger than 64 KiB.
- For a document that is cut at any position, the parser must give an `XmlError`. It must not give a different type of error.
- The parser must keep names such as `__proto__` and `constructor` as data only.
- A _fuzzer_ makes random changes to small documents. Each run uses a seed, and thus you can do each run again. The fuzzer makes sure that the parser gives a result or an `XmlError` for each input. The parser must not give a different error, a stack overflow or a slow parse.

**Results:** The tests found one real problem, and we corrected it. With a higher attribute limit, the time of the duplicate-attribute check increased with the square of the number of attributes. 20,000 attributes used 1.2 seconds. Now the check uses a hash set if an element has more than 16 attributes.

On the released parser, the fuzzer did 1.5 million inputs. Each input gave a result or an `XmlError`. The slowest input used 1.2 ms. The CI does 50,000 inputs for each push.

### 4.8 The W3C conformance suite

**Question:** How well does the parser obey the XML 1.0 standard?

**Test:** We used the official W3C XML Conformance Test Suite (version 20130923). The test parses each document from bytes. Thus, the test also examines the encoding detection. We did not use 576 tests that do not apply. These are tests for XML 1.1, tests for earlier editions of the standard, and tests that use external files.

**Results:** The parser passes 1,263 of 1,736 applicable tests (72.8%). Each failure has one of four known causes. Each cause is a decision about the scope of the parser.

| Cause                                                                                       | Failed tests |
| ------------------------------------------------------------------------------------------- | -----------: |
| The parser does not read the DTD. Thus, it accepts incorrect DTD declarations.              |          335 |
| The parser does not expand entities from the DTD. Thus, it rejects documents that use them. |           42 |
| The parser does not reject forbidden characters, for example control characters.            |           74 |
| The parser does not apply namespace rules.                                                  |           22 |

The suite found three real errors in the parser. We corrected them:

- The parser accepted a DOCTYPE without a name.
- The parser accepted a byte order mark that did not agree with the declared encoding.
- The parser rejected versions such as `1.7`. The standard permits a 1.0 parser to accept them.

We measured the cost of one check that the parser does not do. The rejection of forbidden characters increases the CPU time by 0–5% on ASCII documents, but by 44–205% on two-byte documents. For this reason, the parser does not do this check.

### 4.9 Performance pass

**Question:** Which parts of the parser use the most time? Can we make the parser faster?

**Results:**

- The primary parser function uses 86% of the time. The entity decoder uses 4%, and garbage collection uses 1.5%.
- In 300 parses in sequence, V8 did no major garbage collection. The result trees have a short life, and V8 removes them with little work.
- Two ideas did not make the parser faster, and we did not use them. A table for ASCII name characters was faster on SVG and Word documents (−12% and −16%). But it was slower on RSS and S3 lists (+10% each). More saved search positions gave no measurable difference.

## 5. Comparison with other parsers

We compared the parser with two popular parsers:

- **txml** is very fast, but it does almost no checks, and it does not decode entities.
- **fast-xml-parser**: We used its `preserveOrder` mode. This mode gives the result that is most similar to our result.

Total CPU time of the first 100 parses in a new isolate, in milliseconds (a low number is better):

| Document (~100 KB) | This parser | txml | fast-xml-parser |
| ------------------ | ----------: | ---: | --------------: |
| RSS feed           |      **73** |   92 |             439 |
| SVG image          |     **135** |  237 |             999 |
| SOAP response      |     **115** |  161 |             773 |
| S3 list, minified  |      **98** |  111 |             504 |
| Word document body |      **96** |  199 |             936 |
| Sitemap            |      **86** |  123 |             570 |
| RSS feed, 3.5 KB   |     **5.4** |  9.3 |            59.5 |

Memory that the result tree keeps, in KB (a low number is better, and the input string is not included):

| Document           | This parser | txml | fast-xml-parser |
| ------------------ | ----------: | ---: | --------------: |
| RSS feed           |     **106** |  218 |             225 |
| SVG image          |         331 |  272 |         **255** |
| SOAP response      |     **271** |  401 |             423 |
| S3 list, minified  |     **175** |  425 |             432 |
| Word document body |     **313** |  504 |             425 |
| Sitemap            |     **270** |  529 |             501 |
| RSS feed, 3.5 KB   |     **3.4** |  7.7 |             9.7 |

**Targets that we did not reach:**

- Our target was that both competitors use at least 1.5 times more CPU time than this parser. fast-xml-parser uses 5–11 times more on all documents. txml uses at least 1.5 times more on the SVG, Word and small documents. On RSS, S3, SOAP and sitemap, txml uses only 1.13–1.44 times more. On these documents, our parser uses much time for work that txml does not do: the entity decode and the checks.
- On the SVG image, our tree is 22% larger than the tree of txml. Our flat attribute lists keep a copy of each short attribute name. The other parsers use object keys, and all objects share one copy of each key.

## 6. How the parser operates

### 6.1 The result

`parse()` gives `{ root, children }`. `root` is the root element. `children` is a list of all top-level nodes in the sequence of the document, with the comments. All nodes have the same three fields:

```js
{ name: "item", attrs: ["id", "1"], children: [ … ] }
```

- `name` is the name of the element. The name of a comment is `"#comment"`. The name of a processing instruction is `"?"` and then its target.
- `attrs` is a flat list `[name, value, name, value, …]`, or `null`.
- `children` is `null` if the element is empty. If the only child is text, `children` is this text. In all other conditions, `children` is a list.

The README gives the full description of the result and of the helper functions.

### 6.2 From the input to text

If the input is a string, the parser uses the string directly.

If the input is bytes, the parser first finds the encoding:

1. If the input starts with a byte order mark, the mark sets the encoding (UTF-8, UTF-16LE or UTF-16BE).
2. If there is no byte order mark, the `encoding` in the XML declaration sets the encoding, for example `<?xml version="1.0" encoding="ISO-8859-1"?>`.
3. If the input does not declare an encoding, the encoding is UTF-8.

Then the parser decodes all bytes one time with the built-in `TextDecoder`. Incorrect bytes cause an error. After this step, bytes and strings go through the same code.

### 6.3 The primary loop

The parser is one function with one loop (`src/parse-string.ts`). The parser keeps a list of the open elements. It also has a shared work area, where it puts the children of the open elements. The loop has these steps:

1. The parser finds the next `<` with `indexOf`. All data before this `<` is text.
2. The parser processes the text:
   - If the text contains only whitespace, the parser removes it.
   - If not, the parser examines the text for `]]>`. It decodes the entities if the text contains `&`. It changes the line ends if the text contains `\r`.
   - If the text does not need these changes, the parser cuts it from the input with `slice`.
3. The parser examines the character after `<`:
   - `/` starts an **end tag**. The parser makes sure that the name agrees with the open element. It closes the element and copies the children from the work area into the element. If the only child is text, the element keeps the text as a string.
   - `!` starts a **comment**, a **CDATA section** or the **DOCTYPE**. A comment becomes a `#comment` node. CDATA becomes usual text and joins the text around it. The parser examines the start of the DOCTYPE and does not read the rest.
   - `?` starts a **processing instruction** or the **XML declaration**. A processing instruction becomes a node with the name `?` and the target. The parser examines the declaration, but it does not keep it.
   - All other characters start an **element**. A regular expression examines the name. Then the parser reads the attributes one at a time: the name, `=` and a value in quotes. `indexOf` finds the end of each value. The parser compares each name with the names before it, to find duplicates. The parser adds the element to the work area. If the element does not end with `/>`, the parser also adds it to the list of open elements.
4. The parser does these steps again until the input ends. At the end, all elements must be closed, and there must be exactly one root element.

Two details keep the loop fast:

- **Saved positions.** The parser searches one time for each rare character: `&`, `\r`, `]]>`, and tab or line break in attribute values. It keeps the position of the next one. It searches again only after it moves past that position.
- **One search for two functions.** After a start tag, the parser searches for the next `<` from the start of the tag, not from its end. If it finds a `<` in the tag, the tag is incorrect. Thus, one search moves the parser forward and also examines the tag.

### 6.4 Errors and limits

If the input is not correct, the parser gives an `XmlError`. The error contains the position (`offset`), the `line` and the `column`. The parser calculates the line and the column only when an error occurs. Thus, correct documents do not pay for this calculation. The error messages do not contain parts of the input.

Three limits give protection against dangerous input:

| Limit                     | Default value    |
| ------------------------- | ---------------- |
| Nesting depth             | 256              |
| Attributes in one element | 200              |
| Length of a name          | 1,000 characters |

You can change these limits with the options. The maximum size of a DOCTYPE is 64 KiB.

### 6.5 Memory

If a text or a value has 13 or more characters, the parser does not copy it. V8 keeps a reference to the input. This is not true for text that the parser changed, for example text with entities or with changed line ends. This method keeps the tree small. But the full input stays in memory while your code uses a part of the result. Use the result only in the request that made it.

The parser makes its work area and its list of open elements one time for each isolate. It uses them again for each parse. After each parse and after each error, the parser removes all data from them. Thus, they do not keep old documents in memory.

### 6.6 The warm-up

`warmup()` parses two small documents that are part of the library. It does 10 parses in total. It also decodes one of the documents from bytes one time.

The two documents use all features and all code paths of the parser. We examined this with the V8 coverage tool. The tool showed that the two documents run all parts of the parser, but not the error code and some simple steps. V8 does not use data for these simple steps.

One document contains only one-byte characters. The other document contains characters above U+00FF. Thus, V8 sees both string formats.

To use the warm-up:

1. If your Worker parses documents of different types, import `warmup` from the library.
2. Call `warmup()` one time in the global scope of your Worker module.

**NOTE:** A second call does nothing.

**NOTE:** The warm-up adds approximately 3 ms to the start of each new isolate. Section 7.1 tells when this time can increase the latency of a request.

### 6.7 What the parser does not do

- **DTDs:** The parser does not read the DTD in `<!DOCTYPE …>`. It does not expand entities that the DTD declares. Documents that use these entities cause the error "unknown entity". The parser never loads data from outside.
- **Namespaces:** Prefixes stay part of the name, for example `"soap:Body"`. The parser does not apply namespace rules.
- **Forbidden characters:** The parser does not reject control characters and lone surrogates. This check can make the parse up to 3 times slower on non-ASCII documents.
- **XML 1.1:** The parser rejects XML 1.1.
- **Streams:** The full document must be in memory.

## 7. Questions and answers

### 7.1 Who pays for the warm-up when an isolate starts? Does the warm-up add latency to the first request?

**Short answer:**

- The warm-up runs one time in each isolate, when the isolate starts. It runs before the isolate processes its first request.
- Frequently, a request is the cause of the isolate start. Then this request waits for the startup, and the warm-up can add approximately 3 ms to its latency.
- We did not measure this latency directly. Our decision for the warm-up used the CPU time, not the latency of the first request.

**When does the warm-up run?** Cloudflare runs the global scope of a Worker module when it starts an isolate. The warm-up runs in the global scope. Thus, it runs one time for each isolate, before the first request that the isolate processes.

**How much time does it use?** For each deploy, Cloudflare measures the startup time of the Worker. For our test Worker, the startup times were:

| Test Worker                       | Startup time |
| --------------------------------- | -----------: |
| Without the warm-up               |         1 ms |
| With the warm-up of version 2.0.0 |         3 ms |
| With the extended warm-up         |         4 ms |

Thus, the warm-up uses approximately 3 ms of CPU time for each new isolate. The Cloudflare limit for the startup is 1 second.

**When does Cloudflare start an isolate?** Cloudflare starts an isolate when a request arrives and no isolate of the Worker is ready on that server. Thus, a request is frequently the cause of the start. Two Cloudflare functions decrease this effect:

- Cloudflare can start the isolate during the TLS handshake of a new connection, before the request arrives. Then the startup and the handshake occur at the same time. In 2020, Cloudflare wrote that this method hides startups of approximately 5 ms. Our warm-up is in this range. But a request on a connection that is already open has no handshake.
- Since 2025, Cloudflare sends requests to servers that already have a started isolate ("sharding"). Cloudflare reports that this decreased the cold starts of large customers from 0.1% to 0.01% of the requests.

**Did we examine the latency of the first request?** No. We measured the startup time (the table above) and the CPU time of each request. We did not measure the full time that the client waits for the first request. Our data cannot answer this question, for these reasons:

- The records of `wrangler tail` do not show the startup as a separate value. The CPU time and the wall time of each request are almost equal, in full milliseconds.
- In the tests with the warm-up, a `/health` request without a parse was the first request to the isolate. The test tool did not record this request.
- From the client, the network time changes by 10–20 ms between requests. This change is larger than the 3 ms of the warm-up.

For the same reasons, we do not know if Cloudflare adds the startup time to the CPU time of the first request.

**What is the result for you?** The warm-up has these effects:

- It adds approximately 3 ms of CPU time to the start of each isolate. If a request causes the start, this request can wait up to 3 ms more.
- It prevents recompilations of 24–36 ms when the document type changes. These recompilations occur during a request. They add to the CPU time and to the latency of that request.
- One recompilation takes approximately 10 times more time than the warm-up. With sharding, cold starts are rare.

Thus, for a Worker that parses documents of different types, the warm-up decreases the total CPU time. For a Worker that parses only one type of document, the warm-up gives little and adds its startup time.

**Open task:** Measure the latency of the first request with and without the warm-up. This measurement must use many deploys, because each deploy gives only one cold start.

### 7.2 Does the CI run benchmarks on real Cloudflare Workers?

**Short answer:** Yes. The check `perf-remote` runs for each pull request, each push to `main` and each night. It shows the result in the pull request, but it does not block a merge.

**What the check does:**

- It puts two parsers in one bench Worker: the base and the candidate. The base is the tip of the base branch. The candidate is the pull request.
- It deploys 4 of these Workers to Cloudflare, with new names for each run. Two Workers have the base first, and two Workers have the candidate first.
- It sends requests to the two parsers in a random sequence. It reads the CPU time of each request from `wrangler tail`.
- It calculates the change for each Worker, and then one change for all 4 Workers together.
- It deletes the Workers at the end of the run.

**Why the check does not block a merge:** We did 5 test runs with two equal parsers on Cloudflare. In one isolate, the two equal copies had speeds that were up to 35% different. The faster copy changed from run to run. The cause is the state of the isolate, for example the time of the compilation and the state of the garbage collection. Local workerd does not show this effect.

With this noise, one isolate cannot find a change of 10%. In a test, the Cloudflare report did not show a parser that we made 14% slower. Many more isolates would make each run too long. For this reason, the local check blocks, and the Cloudflare check only reports.

**Why the nightly run failed before:** `wrangler tail` sends only approximately one event each second for each Worker. The earlier tool sent requests quickly and stopped at the first lost event. The new tool sends one request each 1.05 seconds to each Worker. If an event is lost, it sends that round again.

**Limits:**

- Pull requests from forks and from Dependabot get no secrets. For these pull requests, the check reports "skipped".
- The check measures the warm speed only. The local check `perf-local` measures the cold start (section 7.3).

### 7.3 Can I easily see if a pull request makes the benchmarks better or worse than `main`? Does the CI fail when the speed decreases?

**Short answer:** Yes. Each pull request gets one comment with a table for the local check and a table for the Cloudflare check. The comment shows the change in percent and a 99% confidence interval for each document. A significant decrease of speed in the local check fails the check, and the merge is blocked.

**The two checks:**

| Check         | Where                              | Measurements                                                                              | Gate |
| ------------- | ---------------------------------- | ----------------------------------------------------------------------------------------- | ---: |
| `perf-local`  | Local workerd on the GitHub runner | Total CPU time of the first 100 parses in a new isolate, and the time for each warm parse |   5% |
| `perf-remote` | 4 real Cloudflare Workers          | CPU time for each warm parse                                                              | none |

Both checks run the base and the candidate in the same process or the same Worker, in a mixed sequence. Thus, changes of machine speed have the same effect on both.

**When a check fails:** A row is a regression if two conditions are true. The change is at the threshold or more, and the 99% confidence interval is completely above 0. Thus, noise alone cannot cause a failure. In test runs with two equal parsers, no row was a regression. On a GitHub runner, a parser that we made 14% slower failed in 17 of 20 local rows.

**Blocked merges:** A ruleset on `main` makes the check `perf-local` necessary for a merge. If a slower parser is correct, for example because of a bug fix, add the label `perf-regression-accepted` to the pull request. The checks then run again. They show the regression, but they pass.

**The local check is as real as possible:**

- It uses the same bench Worker as the Cloudflare check.
- The parser gets its input through `Response.text()`, as it does after a `fetch()`.
- It uses only the V8 settings that Cloudflare also uses in production.
- The cold measurement sends 100 separate requests, with one parse in each request.
- The memory measurement needs special V8 settings. For this reason, the report shows memory, but memory does not block a merge.

**To do the comparison on your computer:**

1. Run `npm run bench:pr` for the local comparison against `origin/main`.
2. Run `npm run bench:pr:remote` for the comparison on Cloudflare. This command needs `wrangler login`.

## 8. Words used in this document

| Word                                    | Meaning                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Baseline                                | The earlier result that the CI compares with the result of a pull request                                                 |
| CDATA section                           | `<![CDATA[ … ]]>`: text in which `<` and `&` have no special function                                                     |
| CI                                      | Continuous integration: the GitHub Actions jobs that run for each push and each pull request                              |
| Cold start                              | The start of a new isolate, before V8 has compiled code or data about it                                                  |
| Deoptimization                          | V8 removes optimized code because its assumptions about the data are incorrect. Then V8 must compile the code again       |
| DTD                                     | Optional grammar rules and entity declarations in `<!DOCTYPE …>`                                                          |
| Entity                                  | An escaped character, for example `&amp;` for `&`. A character reference, for example `&#65;`, gives the character number |
| Fuzzer                                  | A program that gives random, changed input to code to find errors                                                         |
| Garbage collection                      | V8 removes data from memory when no code uses the data                                                                    |
| Global scope                            | The code of a module outside of functions. Cloudflare runs it one time when it starts an isolate                          |
| Ignition, Sparkplug, Maglev, Turboshaft | The four V8 tiers, from the interpreter to the compiler that makes the fastest code                                       |
| Isolate                                 | A separate instance of the V8 engine that runs a Worker. Cloudflare starts and stops isolates frequently                  |
| Latency                                 | The time that a client waits for the response to a request                                                                |
| One-byte / two-byte string              | The V8 string format: one byte for each character if all characters are U+00FF or lower, else two bytes                   |
| Processing instruction                  | `<?target data?>`: an instruction for an application. The parser keeps it in the result                                   |
| Spike                                   | A short, temporary experiment for one design question                                                                     |
| Total-100                               | Our primary measurement: the total CPU time of the first 100 parses in a new isolate, with the compilation time           |
| V8                                      | The JavaScript engine in Chrome and in Cloudflare Workers                                                                 |
| Wall time                               | The real time from the start to the end of an operation, with the time of waits                                           |
| workerd                                 | The open-source runtime of Cloudflare Workers. We did all local measurements in workerd                                   |
| µs                                      | Microsecond: 0.001 milliseconds                                                                                           |

## 9. Where to find more information

| Subject                                             | File                                            |
| --------------------------------------------------- | ----------------------------------------------- |
| Facts, corrections and all design decisions         | `research/SYNTHESIS.md`                         |
| Scanner experiment (4.1)                            | `research/spikes/s1-scanner.md`                 |
| Tree experiment (4.2)                               | `research/spikes/s2-tree-building.md`           |
| Bytes experiment (4.3)                              | `research/spikes/s3-bytes-input.md`             |
| Cost of correctness (4.4)                           | `research/spikes/s4-correctness-costs.md`       |
| Compiler behavior and Cloudflare tests (4.5, 4.6)   | `research/spikes/s5-jit-behavior.md`            |
| Conformance suite (4.8)                             | `research/conformance.md`                       |
| Performance pass (4.9, 5)                           | `research/spikes/m7-performance.md`             |
| Cloudflare startup, cold starts, sharding (7.1)     | `research/v8-jit-tiering-workers-production.md` |
| Measurement tools and CI benchmarks (3.4, 7.2, 7.3) | `bench/README.md`                               |
| Milestones of the parser                            | `docs/implementation-plan.md`                   |
| API and use                                         | `README.md`                                     |
