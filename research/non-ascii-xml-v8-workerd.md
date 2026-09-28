# Non-ASCII XML in V8 15 / workerd: UTF-8 bytes vs one-byte vs two-byte strings

Scope: V8 `main` as of 2026 (applies to V8 12–15; target workerd 1.20260815, V8 15.1, `compatibility_date 2026-08-01`). workerd `main` `src/workerd/api/encoding.c++`, `encoding-legacy.c++/h`, `encoding.h`. Pipeline in this era is Ignition → Sparkplug → Maglev → Turboshaft (TurboFan sea-of-nodes retired).

Legend: [source] = verified in V8/workerd source or spec, [docs] = maintainer docs/blog, [3rd-party] = others' benchmark, [inference] = my reasoning. "No evidence" means I looked and did not find it.

Builds on already-verified project facts (not re-researched): whole-document-in-memory input, DOM-style eager output, zero-copy slices, whitespace-only nodes dropped, `SlicedString` threshold 13, `TextDecoder('utf-8')` ASCII-only fast path, legacy labels always two-byte, `TextDecoder` is a regular C++ binding call (not Fast API).

## 1. Does `v8::String::NewFromTwoByte` produce a one-byte string when all code units are ≤ 0xFF?

Yes for the UTF-8 path. Latin-1-only input (`é ü ß`, U+00E9/U+00FC/U+00DF) ends up one-byte in workerd. The "always two-byte" premise only applies to the `LegacyDecoder` labels (`latin1/ascii/windows-1252/x-user-defined`), not to `utf-8`.

* [source] `Factory::NewStringFromTwoByte(const uc16*,int,AllocationType)` in `src/heap/factory.cc`:
  ```cpp
  if (String::IsOneByte(string, length)) {
    if (length == 1) return LookupSingleCharacterStringFromCode(...);
    NewRawOneByteString(...); CopyChars(...); return result;
  } else { NewRawTwoByteString(...); ... }
  ```
  - https://github.com/v8/v8/blob/main/src/heap/factory.cc (`Factory::NewStringFromTwoByte`)
  - https://github.com/v8/v8/blob/main/src/api/api.cc (`v8::String::NewFromTwoByte` forwards here)
* [source] `String::IsOneByte` checks `> unibrow::Latin1::kMaxChar` where `kMaxChar == 0xFF` — `src/strings/unicode.h` (`class Latin1`), word-at-a-time loop in `src/objects/string.h` / `src/objects/string-inl.h`. Threshold is exactly U+00FF, not U+007F.
  - https://raw.githubusercontent.com/v8/v8/main/src/strings/unicode.h
  - https://github.com/v8/v8/blob/main/src/objects/string.h
* [source] V8's own UTF-8 decoder distinguishes three encodings: `src/strings/unicode-decoder.h` `Utf8DecoderBase::Encoding { kAscii, kLatin1, kUtf16, kInvalid }`, `is_one_byte() { return encoding_ <= kLatin1; }`, `is_ascii() { return encoding_ == kAscii; }`. `Factory::NewStringFromUtf8` → `NewStringFromBytes` → `if (decoder.is_one_byte()) AllocateOneByteString` else `AllocateTwoByteString`.
  - https://raw.githubusercontent.com/v8/v8/main/src/strings/unicode-decoder.h
* [source] workerd UTF-8 `TextDecoder` does **not** use that path. `src/workerd/api/encoding.c++` `IcuDecoder::decode()`:
  1. Fast path: `if (encoding==Utf8 && simdutf::validate_ascii(...)) return js.str(buffer);` with comment "we'll interpret as Latin1 since UTF-8 bytes within this range are identical to Latin1 and v8 allocates these more efficiently."
  2. Slow path: `ucnv_toUnicode(... &dest ...)` into `UChar` (UTF-16) stack/heap buffer (`KJ_STACK_ARRAY(UChar,result,limit,512,4096)`), then `return js.str(result.slice(...))`.
  - https://github.com/cloudflare/workerd/blob/main/src/workerd/api/encoding.c++ (`IcuDecoder::decode`, `MAX_SIZE_FOR_STACK_ALLOC=4096`)
  - https://github.com/cloudflare/workerd/blob/main/src/workerd/api/encoding.h (`JSG_METHOD(decode)`, `DecoderImpl = OneOf<LegacyDecoder,IcuDecoder>`)

  `js.str(UChar slice)` is `v8::String::NewFromTwoByte` → `Factory::NewStringFromTwoByte` above, so it re-checks `IsOneByte`. Consequence: `C3 A9` (`é`, U+00E9) → `UChar 0x00E9` → `IsOneByte==true` → `SeqOneByteString`. `E2 82 AC` (`€`, U+20AC), `E2 80 9C` (`"`), `E2 80 93` (`–`), surrogate pairs from emoji → `IsOneByte==false` → `SeqTwoByteString`.
* [source] Constructor routing: `Utf8` → `IcuDecoder`; `Windows_1252/X_User_Defined` (+ CJK if `TextDecoderCjkDecoder` flag on) → `LegacyDecoder`. Label table `EW_ENCODING_LABELS` maps `ascii/us-ascii/latin1/iso-8859-1/...` all to `Windows_1252`. So `new TextDecoder('latin1')` never touches the ASCII fast path.
  - https://github.com/cloudflare/workerd/blob/main/src/workerd/api/encoding.c++ (`TextDecoder::constructor`, `getEncodingForLabel`)
  - https://developers.cloudflare.com/workers/runtime-apis/encoding
* [source] `src/workerd/api/encoding-legacy.c++` `LegacyDecoder::decode()` decodes via the Rust `encoding_rs` bridge into a Rust-owned UTF-16 buffer, then `return js.str(kj::from<kj_rs::Rust>(result.output))`. `encoding-legacy.h` confirms it wraps `encoding_rs` ("implements full WHATWG decoder algorithms"). `encoding_rs` decodes "into valid aligned native-endian in-RAM UTF-16".
  - https://github.com/cloudflare/workerd/blob/main/src/workerd/api/encoding-legacy.c++ (`LegacyDecoder::decode`)
  - https://github.com/cloudflare/workerd/blob/main/src/workerd/api/encoding-legacy.h
  - https://docs.rs/encoding_rs/latest/encoding_rs
* [inference + open gap] By code reading, that `js.str(utf16-slice)` *should* hit the same `IsOneByte` downgrade, so pure `é` via `latin1` *should* also become one-byte. The project premise says it "always returns two-byte" — I found **no evidence** in `encoding-legacy.c++` of forced-two-byte allocation; if true it must be inside a `jsg::Lock::str(ArrayPtr<char16_t>)` overload bypassing the check (jsg string impl source not located). Trust the premise for design (don't use `latin1` label as binary-string builder), but must benchmark.

Concrete numbers:

* One-byte char = 1 byte, two-byte char = 2 bytes. `src/objects/string.h`: `SeqOneByteString::kMaxCharsSize = kMaxLength`, `SeqTwoByteString::kMaxCharsSize = kMaxLength*2`; `kMaxLength = v8::String::kMaxLength` (~536.8M chars 64-bit, ~268.4M 32-bit).
  - https://github.com/v8/v8/blob/main/src/objects/string.h
* `IcuDecoder` stack array: `512..4096` `UChar` inline, larger on heap; `limit = 2*maxCharSize*buffer.size()` when not flushing.
* workerd `TextEncoder::encode` uses `kj::SmallArray<byte, MAX_SIZE_FOR_STACK_ALLOC>` with `MAX_SIZE_FOR_STACK_ALLOC=4096` — same file, useful analogy for chunk sizing.

Outdated advice to flag: pre-V8-12 posts saying "TextDecoder always produces two-byte" or "any non-ASCII → two-byte". Since at least V8 9–12 the `NewFromTwoByte` + `Utf8DecoderBase(kLatin1)` distinction exists. Latin-1-only is safe.

## 2. Cost of two-byte strings in V8 15

All in `src/strings/string-search.h` (`StringSearch`, `FindFirstCharacter`, `SingleCharSearch`, `LinearSearch`, `InitialSearch`, `BoyerMoore*`), `src/objects/string.h` (`kMinLength=13` for `SlicedString`/`ConsString`), `docs/objects/strings.md`.

* [source] Single-char `indexOf` (`pattern_length==1 → SingleCharSearch → FindFirstCharacter`):
  ```cpp
  search_byte = GetHighestValueByte(pattern_first_char); // max(low,high)
  memchr(subject.begin()+pos, search_byte, (max_n-pos)*sizeof(SubjectChar));
  char_pos = AlignDown(char_pos, sizeof(SubjectChar));
  if (subject[pos]==search_char) return pos;
  ```
  One-byte subject: direct `memchr`, 1 byte/char scanned. Two-byte subject: `memchr` over **2× bytes**, then align + verify. Explicit special case in source: `if (sizeof(SubjectChar)==2 && pattern_first_char==0)` avoids `memchr` entirely (every other byte is 0 in ASCII-heavy text) and does a manual loop.
  - https://raw.githubusercontent.com/v8/v8/main/src/strings/string-search.h (`FindFirstCharacter`, `SingleCharSearch`)

  For `'<'` (U+003C): `search_byte=0x3C`, LE bytes `3C 00 ...`. `memchr(0x3C)` hits only true positions (no false positives), but still scans 2× bytes → ~2× memory bandwidth + align/branch overhead. For patterns whose low/high bytes alias ASCII bytes, false positives add re-loop cost. [inference] Expect ~1.5–2.5× slower than one-byte for `'<'` on ASCII-heavy docs; must measure.
* [source] Multi-char `indexOf`: `< kBMMinPatternLength (7)` → `LinearSearch` (`FindFirstCharacter` on first char + `CharCompare`); `>=7` → `InitialSearch` → `BoyerMooreHorspoolSearch` → `BoyerMooreSearch`. Constants: `kBMMinPatternLength=7`, `kBMMaxShift=Isolate::kBMMaxShift`, alphabets `kLatin1AlphabetSize=256`, `kUC16AlphabetSize=Isolate::kUC16AlphabetSize`. `CharCompare`/`CharOccurrence` on `uint16_t` loads twice the cache footprint; bad-char table is modulo-reduced (`c % kUC16AlphabetSize`) for UC16/UC16, so less selective than the Latin-1 table. Same file as above.
* [source] `charCodeAt` loop: `String::Get(index)` dispatches via `StringShape::DispatchToSpecificType` + `SeqOneByteString::Get` (1-byte load) vs `SeqTwoByteString::Get` (2-byte load) — `src/objects/string-inl.h`, `src/objects/string.h`. No SIMD; cost is ~2× loads + same bounds/map checks if Maglev/Turboshaft hoists them. Maglev (2023+, https://v8.dev/blog/maglev) and Turboshaft (2025) improve bounds-check elimination but not the 1-vs-2-byte load factor.
  - https://github.com/v8/v8/blob/main/src/objects/string-inl.h
* [source] `slice`/`substring`: `SlicedString::kMinLength=13`, `ConsString::kMinLength=13` (`src/objects/string.h`). `len>=13` from a two-byte parent stays `SlicedString` (parent encoding, zero-copy, keeps parent alive); `len<13` copies and can downgrade to one-byte if content allows. `===`: pointer equality → length → representation check → `memcmp` (1× vs 2× bytes).
  - https://github.com/v8/v8/blob/main/src/objects/string.h (`kMinLength`)
  - https://chromium.googlesource.com/v8/v8/+/HEAD/docs/objects/strings.md
* [3rd-party] No published V8-15 `indexOf` one-byte vs two-byte microbenchmark found. Closest illustration (method only, not 1-vs-2-byte): `fabiospampinato` gist `String.prototype.indexOf vs Uint8Array.prototype.indexOf`. Treat all ratios above as [inference] to verify.

## 3. Parsing UTF-8 bytes directly in JS

* [source] `Uint8Array` element load is a bounds-checked external-memory load (backing store + `byteOffset`); `charCodeAt` on a flat one-byte string is a bounds-checked 1-byte heap load. In Maglev/Turboshaft both can hoist map/length checks in tight loops with stable shapes, but neither auto-vectorizes a JS `for` scanner into `memchr`.
  - https://v8.dev/blog/maglev
  - https://v8.dev/docs/torque-builtins
* [source — no evidence for memchr] I found **no evidence** that `Uint8Array.prototype.indexOf` uses `memchr`/SIMD in V8 15. `src/builtins/typed-array.tq` holds only accessors; the search builtin is a CSA/Torque generic with spec-mandated ToNumber coercion, detached-buffer and length checks per call.
  - https://github.com/v8/v8/blob/main/src/builtins/typed-array.tq
  Do **not** call it per byte; call it per delimiter over a range (`bytes.indexOf(60, pos)` for `'<'`), same pattern as string `indexOf`.
* [inference] A pure-JS `while(bytes[i]!==60) i++` cannot approach `memchr` on large gaps: per-iteration Smi bounds check + load + compare + increment vs libc `memchr` (word-at-a-time / SIMD, GB/s class via `simdutf`, https://github.com/simdutf/simdutf). Expect an order-of-magnitude gap for long text runs; gap narrows for dense `'<'` where call overhead dominates. Benchmark `string.indexOf('<',pos)` (one-byte, `memchr`) vs `bytes.indexOf(60,pos)` vs hand-rolled JS byte loop on 10KB–1MB XML with realistic tag density.

## 4. Building strings from byte ranges

Ordered cheapest→dearest for **short ASCII**; reverses for long/non-ASCII. Every per-value cost includes a binding/alloc component.

* [source] `TextDecoder.decode(subarray)` per value: one `jsg` binding call (not Fast API — consistent with `JSG_METHOD(decode)` in `encoding.h`), `simdutf::validate_ascii` fast path for pure ASCII, else ICU `ucnv_toUnicode` + `NewFromTwoByte` alloc. `subarray` itself is cheap (view, no copy) but `decode` copies into a new `SeqString`. Good amortisation only when the value is long. Thresholds chosen by libraries:
  * `@protobufjs/utf8` `utf8.read`: `TEXT_DECODER_MIN_LENGTH=64` — `<64` hand-rolled ASCII fast path (`fromCharCode(c1..c8)` in blocks of 8, bail to `decoder.decode` on first `&0x80`), `>=64` direct `decoder.decode(subarray)`.
    - https://raw.githubusercontent.com/protobufjs/protobuf.js/master/src/util/utf8.js
  * `cbor-x` `readStringJS`: `if (length>64 && decoder) return decoder.decode(src.subarray(...))`; `<16` tries `shortStringInJS`, small blocks try `longStringInJS` (ASCII-prove + `fromCharCode`), else hand decoder with `fromCharCode.apply` flushed every `0x1000` units.
    - https://raw.githubusercontent.com/kriszyp/cbor-x/master/decode.js
  * `mapbox/pbf`: `TEXT_DECODER_MIN_LENGTH=12` with comment "Threshold chosen based on both benchmarking and knowledge about browser string data structures (which currently switch structure types at 12 bytes or more)" — note 12≈13 `kMinLength` above.
    - https://github.com/mapbox/pbf/blob/main/index.js
  * `msgpackr-extract` (native, Node-only): batches up to 256 strings, returns one combined Latin-1 blob for slicing when possible, isolates non-Latin strings. Not available in workerd (no Node addon; WASM only as precompiled module).
    - https://github.com/kriszyp/msgpackr-extract
* [source] `String.fromCharCode.apply` / spread over a subarray: fast for all-ASCII short ranges (stays `SeqOneByteString`, no binding call), but (a) throws `RangeError: Maximum call stack size exceeded` past the arg limit — safe chunk in the wild is 8k–32k args (`cbor-x` uses `0x1000`; test the workerd limit explicitly, V8 default stack `--stack_size ~984KB`), (b) each `apply` is itself a call + spread cost, (c) non-ASCII bytes produce garbage (each byte → U+0080–U+00FF) so only use after proving the range ASCII. Never `apply` an unbounded `subarray`.
  - https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/fromCharCode
* [source] Hand-written UTF-8 decoder feeding `fromCharCode` (msgpackr/cbor-x/protobufjs style): `cbor-x` `readStringJS` is the reference to copy — byte-class dispatch (`1/2/3/4-byte`), strict overlong/surrogate checks (`<0xC2`, `E0/A0`, `ED/A0`, `F0/90`, `F4/90`), `FFFD` on error, `units.push(...)` + `result+=fromCharCode.apply(String,units); units.length=0` every `0x1000`. Only wins below the `TextDecoder` crossover (~12–64 bytes) or when it avoids a second pass.
* [inference] "Binary string" (one char per byte, guaranteed one-byte) from `Uint8Array` in workerd: **no zero-copy API**. `new TextDecoder('latin1').decode()` is *not* a shortcut (goes to `LegacyDecoder`/two-byte per premise; even if it downgraded, still a binding call per chunk). Cheapest is chunked `String.fromCharCode.apply(String, subarray_chunk)` with chunk ~8k–32k (tune; `0x1000` is proven-safe from `cbor-x`), concatenated with `+=` or `Array.join`. Cost is O(N) JS + one `SeqOneByteString` of N bytes. Only pays off if it keeps the *whole parse* one-byte (see §5); for pure-ASCII `Uint8Array` input it is strictly slower than one `TextDecoder().decode(bytes)` (C++ `validate_ascii` + `memcpy`).

Per-call overhead ranking (short values): inline `shortStringInJS` (`fromCharCode(a,b,…)` ≤15 args, no apply) < `fromCharCode.apply` chunk < hand UTF-8 loop < `TextDecoder.decode(subarray)`. Crossover lengths to measure: expect ~12–64 bytes (use 16/32/64 test points; libraries cluster at 12 and 64).

## 5. Hybrid design (binary string + lazy re-decode) vs alternatives

Design: `bytes → one SeqOneByteString B (len==byteLength) → run existing fast string parser on B (one-byte indexOf/slice, zero-copy) → for each value range [s,e) that may contain >=0x80, real = textDecoder.decode(bytes.subarray(s,e)); else real = B.slice(s,e)` (still zero-copy, still one-byte).

* [inference] Cost model per document of N bytes, V value ranges, fraction f containing non-ASCII:
  * (a) decode-once + parse two-byte: `C_decode(N, ICU/simdutf)` + `P_2byte(N)` (all `indexOf`/`slice`/`===` at 2× bandwidth if *any* char >U+00FF poisons the whole string; Latin-1-only stays one-byte so no tax). Peak: `bytes(N)` + UTF-16 string (`2N` if poisoned else `N`) + output tree. One binding call.
  * (b) parse `Uint8Array` directly: no big string alloc, but `P_bytes(N)` is a JS loop / repeated `indexOf` binding calls + per-value decode (`TextDecoder` or hand decoder). Peak: `bytes(N)` + per-value strings only. Slowest scanner, leanest peak.
  * (h) hybrid: `C_bin(N)` (chunked `fromCharCode`, pure JS) + `P_1byte(N)` (fastest scanner) + `f·V` × `TextDecoder.decode(subarray)` + flag-tracking. Peak: `bytes(N)` + binary string (`N`) + per-value decoded strings + output tree ≈ **2N transient** before GC. If input arrived as JS string, skip `C_bin` — the hybrid is moot, just parse the string.
* Pitfalls:
  1. [source] Byte offsets ≠ UTF-16 offsets once any multibyte sequence appears. `B` indices equal byte offsets; decoded lengths differ (`é`: 2 bytes→1 char; `€`: 3→1; emoji: 4→2). Never index the decoded string with `B` offsets. Record `[s,e)` byte ranges during the `B` scan and `subarray` the *bytes*. Spec: WHATWG Encoding `decode()`; V8 `String::length` counts UTF-16 code units.
     - https://encoding.spec.whatwg.org/#decode
  2. [inference] Cheapest non-ASCII test is **during the scan you already do**: OR-accumulate (`seen|=B.charCodeAt(i)` or `bytes[i]`) over the value range, or bail on first `>=0x80`. `charCodeAt` on one-byte `B` is the cheapest check. Do not add a second pass just for detection. `cbor-x`'s `longStringInJS` pattern (ASCII-prove then `fromCharCode`, else fall back) is the template.
  3. [source] `B` values containing `0x80–0xFF` are *not* valid text — `é` appears as `Ã©` (two Latin-1 chars). Only structural bytes (`< > / = " ' ? ! - [ ]`, all <0x80) are safe to compare in `B`. Never emit `B.slice` for a flagged range; always re-decode from bytes.
  4. [source] `slice>=13` on `B` pins the whole N-byte binary string (`SlicedString::kMinLength=13`). Fine request-scoped (output never outlives the request), but don't retain output past the response.
  5. [docs] `TextDecoder.decode` with `{stream:false}` (default) per value is correct for well-split ranges; ensure ranges end at structural ASCII bytes so sequences can't split.
     - https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder/decode

Ranking by document type ([inference] — confirm by benchmark; direction of effects is sourced above):

| Doc type | 1st (fastest/least CPU) | 2nd | 3rd | Why |
|---|---|---|---|---|
| Pure ASCII | (a) decode-once (`TextDecoder`, ASCII fast path → one-byte); if input is `string`, just parse it | (h) hybrid | (b) direct bytes | (a) is one C++ `validate_ascii+memcpy`, stays one-byte, fastest scanner. (h) pays redundant JS `C_bin`. (b) pays JS scanner. Memory: (b)<(a)<(h) transient. |
| Only Latin-1 accents (`é ü ß`, no `“–€`/emoji) | (a) decode-once — **stays one-byte** via `NewFromTwoByte` downgrade | (h) hybrid (unneeded) | (b) direct | No two-byte tax, so hybrid's extra copy + per-value decodes are pure overhead. Key correction vs naive "any non-ASCII → two-byte" thinking. |
| Mostly ASCII + few `“ ” – — €`/emoji (typical RSS) | **(h) hybrid** | (a) decode-once (two-byte) | (b) direct bytes | One poison char makes (a) 2× memory + 1.5–2.5× scanner tax on *all* N bytes. (h) keeps `P_1byte` + pays only `f·V` decodes. (b) avoids tax but JS scanner usually loses to (a)'s `memchr` even with 2× tax on tag-dense XML — verify. |
| CJK-heavy | (a) decode-once | (b) direct | (h) hybrid last | Bulk must go through ICU/simdutf anyway; (h) adds full `C_bin` copy + `V` binding calls with no scanner win (values are the text). Peak worst for (h) (N bytes + N binary + decoded output). |

If input is already a JS `string` (not bytes): skip all byte paths — parse the string.

## Actionable rules for the parser

* Keep two entry points: `parseString(str)` (zero-copy slices) and `parseBytes(bytes)`; never convert string→bytes.
* `parseBytes`: first try single `new TextDecoder().decode(bytes)`; rely on the `validate_ascii` fast path and `NewFromTwoByte` Latin-1 downgrade — do not pre-scan for non-ASCII in JS.
* Add hybrid `parseBytesHybrid` only for the RSS case: chunked `fromCharCode` binary string (chunk 8k–32k, tune upward from proven-safe `0x1000`), one-byte scan, `bytes.subarray(s,e)` + shared `TextDecoder` per flagged value. Reuse one decoder; views, not copies.
* Value decode threshold: hand/ASCII-prove path below ~16–64 bytes, `TextDecoder.decode(subarray)` above; start with 64 (protobufjs/cbor-x) and 12/16 short-inline (`pbf`/cbor-x `shortStringInJS`), tune at 12/16/32/64.
* Track `hasHighByte` inline during the value scan (`OR` of codes); never second-pass just for detection.
* Compare only ASCII structure bytes in binary-string mode; re-decode every flagged value from bytes.
* Keep slices `>=13` in mind: bulk slices pin the parent — acceptable request-scoped, but don't hold the tree past the response.
* Never `String.fromCharCode.apply` unbounded arrays; never `TextDecoder('latin1'/'ascii'/'windows-1252')` as a binary builder (`LegacyDecoder` path).

## Open questions that need a benchmark (in workerd, V8 15.1, compat 2026-08-01)

1. `NewFromTwoByte` downgrade for the `latin1`-label decode: is `new TextDecoder('latin1').decode(é-bytes)` actually two-byte? Source suggests it should downgrade; premise says it doesn't. Needs a direct test.
2. One-byte vs two-byte `indexOf('<')` / `indexOf('-->')` / `charCodeAt` loop / `slice` / `===` ratios on 100KB–2MB XML with 0/1/100 poison chars.
3. `bytes.indexOf(60,pos)` vs `str.indexOf('<',pos)` (one-byte and two-byte) vs hand JS byte loop, varying tag density.
4. `TextDecoder.decode(subarray)` per-call overhead vs value length: crossover sweep (12/16/32/64/256) for ASCII and 2/3/4-byte values; include `fromCharCode.apply` chunk-size sweep (4k/8k/32k).
5. Hybrid end-to-end on the four corpora (pure ASCII / Latin-1-only / RSS-like few-poison / CJK-heavy) × two inputs (string vs bytes): CPU time + peak heap.
6. `Uint8Array` load throughput in a Maglev/Turboshaft tight scanner vs one-byte `charCodeAt` scanner — same loop shape, both inputs — to isolate load cost from `indexOf`.
