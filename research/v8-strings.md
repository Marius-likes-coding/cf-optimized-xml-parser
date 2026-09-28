# V8 strings for a scan-and-slice XML parser (V8 14–15, 2025–2026, workerd V8 15.1)

Scope: `main` (~15.6) checked Sept 2026. workerd x64 uses pointer compression, so "compressed" sizes apply. Pipeline in this era is Ignition → Sparkplug → Maglev → Turboshaft (TurboFan sea-of-nodes retired; Maglev-as-frontend = "Turbolev"). Flagged below where pre-V8-12 advice is stale.

Legend: [source] = verified in V8/workerd source or spec, [docs] = maintainer docs/blog, [3rd-party] = others' benchmark, [inference] = my reasoning. "No evidence" means I looked and did not find it.

## 1. Representations

### Class layout and header sizes

Chain [source]: `HeapObject{map}` in `src/objects/heap-object.tq`, `Name{raw_hash_field:uint32}` in `src/objects/name.tq` / `name.h`, `String extends Name{length:int32}` in `src/objects/string.tq` + `src/objects/string.h: String::length_`:

- https://github.com/v8/v8/blob/main/src/objects/string.h
- https://github.com/v8/v8/blob/main/src/objects/string.tq (`Cons{first,second}`, `Sliced{parent,offset:Smi}`, `Thin{actual}`, `External{resource,resource_data}`, `SeqOneByte{chars}`, `SeqTwoByte{chars}`)

Pointer compression [source] `src/common/globals.h: kTaggedSize=4` if `V8_COMPRESS_POINTERS` else 8:

- https://github.com/v8/v8/blob/main/src/common/globals.h

`ObjectTraits<T>::kHeaderSize = sizeof(T)` [source] `src/objects/string.h`:

- https://github.com/v8/v8/blob/main/src/objects/string.h#L815

Computed sizes (fields verified, totals computed, not literals):

| type | compressed ON (workerd x64, align 4) | OFF (64-bit, align 8) |
|---|---|---|
| `String` base `map+hash+length` | `4+4+4=12B` | `8+4+4=16B` |
| `SeqOne/TwoByte` header | `12B`, total `ALIGN(12+n*1or2,4)` | `16B`, total `ALIGN(16+n*1or2,8)` |
| `ConsString` 2×Tagged | `12+8=20B` fixed | `16+16=32B` |
| `SlicedString` parent+offset(Smi) | `20B` fixed | `32B` fixed |
| `ThinString` 1×Tagged | `12+4=16B` fixed | `16+8=24B` fixed |
| `UncachedExternal` +1 ext ptr | `16B` w/ sandbox, `20B` w/o | `24B` |
| `External` +2 ext ptr | `20B` w/ sandbox, `28B` w/o (`static_assert sizeof(OneByte)==sizeof(External)` in `string.h`) | `32B` |

Examples compressed [inference from formula]: `SeqOneByte(13)=ALIGN(25,4)=28B`; `SeqTwoByte(13)=ALIGN(38,4)=40B`. Allocation rounding [source] `src/objects/string-inl.h: DataSizeFor/SizeFor = OBJECT_POINTER_ALIGN(...)`.
Whether workerd enables `V8_ENABLE_SANDBOX` (16 vs 20B external): no evidence.

### Minimum lengths

- `ConsString::kMinLength = 13` [source] `src/objects/string.h#L1094`
- `SlicedString::kMinLength = 13` [source] `src/objects/string.h#L1204`
- Unchanged since at least V8 9.3 [source] tag history. Use [source]: `src/heap/factory-base.cc: if(len<kMinLength)` copy-flat else cons; `src/heap/factory.cc: if(!v8_flags.string_slices || len<kMinLength) return NewCopiedSubstring`; `src/builtins/builtins-string-gen.cc: SubString: GotoIf(len<kMinLength)`.
- `--string_slices` flag can disable `SlicedString` entirely [source] same files. Default ON; do not assume it in benchmarks — check `workerd` flags. No evidence workerd disables it.

### One-byte vs two-byte selection

- Test is map encoding bit: `IsOneByteRepresentation()` [source] `src/objects/string-inl.h`, content scan `NonOneByteStart/IsOneByte(chars,len)` (`>0xFF`) [source] `src/objects/string.h`.
- Literals/`NewStringFromOneByte` always one-byte [source] `src/heap/factory-base.cc`.
- `NewStringFromTwoByte(u16*,len)` scans; all-Latin1 → `SeqOneByte` copy else `SeqTwoByte`; len 1 → single-char cache [source] `src/heap/factory.cc`.
- UTF-8/WTF-8 decode picks by `decoder.is_one_byte()` [source] `src/heap/factory.cc: NewStringFromBytes`.
- `fromCharCode/fromCodePoint` optimistic one-byte buffer, widen on `>0xFF` (`kMaxOneByteCharCode=0xFF=255`, `kMaxUtf16CodeUnit=0xFFFF` in `string.h`) [source] `src/builtins/builtins-string.cc`.
- Concat `NewConsString(l,r)`: `is_one_byte = l.IsOneByte && r.IsOneByte`; `len<13` → flat copy via `WriteToFlat`; len 2 → two-char cache; `>kMaxLength` throws [source] `src/heap/factory-base.cc`.

### Slice of two-byte parent that is Latin-1-only — key result

- Long slice (`len>=13`, slices enabled) **keeps `TWO_BYTE` flag, no downgrade, no content scan** [source]:
  - `Factory::NewProperSubString` (`src/heap/factory.cc`): flattens, unwraps slice/thin, then `map = str->IsOneByteRepresentation() ? sliced_one_byte : sliced_two_byte`.
  - CSA `SubString` (`src/builtins/builtins-string-gen.cc`): `is_one_byte = to_direct.IsOneByte()` (parent flag) → `AllocateSlicedOne/TwoByteString`.
- Short-slice copy (`len<13`) **downgrades**: `NewCopiedSubstring` (`src/heap/factory.cc`) checks `flat.IsOneByte() else IsOneByte(data+begin,len)` → `SeqOneByte` if subset; CSA `AllocAndCopyStringCharacters` scans 8-at-a-time, all `<=0xFF` → `SeqOneByte` [source] same files.
- **Flatten never downgrades** [source] `String::SlowFlatten` (`src/objects/string-inl.h` / `string.tq:StringSlowFlatten`): `cons.map==kConsOneByte ? one-byte : two-byte`.
- `NewProperSubString` extras [source]: `len 0→empty`, `1→LookupSingleCharacter`, `2→MakeOrFindTwoCharacter`, full-length returns original, flattens input first.

> Implication: if the whole XML document is two-byte (one CJK/emoji anywhere), every tag-name/attr slice `>=13 chars` stays two-byte (2× memory, slower compare). Short names `<13` are fine.

### External strings

Layout [source] `src/objects/string.h: UncachedExternal{resource}`, `External:Uncached{+resource_data}`; cached `GetChars()=resource_data`, uncached via resource (`string.tq`).
When used [source] `src/heap/factory.cc: NewExternalStringFromOneByte/TwoByte` (embedder resource, `IsCacheable()?cached:uncached`, `RegisterExternalString`); `SupportsExternalization`/`MakeExternalDuringGC` in `src/objects/string.cc` (fails if `Size<sizeof(Uncached)`, RO-space, young-gen, encoding mismatch). Uncached bails to runtime in generated code [source] `ComputeExternalStringMap`. Whether workerd passes request bodies as external: no evidence — measure with `%DebugPrint` in local workerd (d8 only).

### Length limit

`include/v8-primitive.h: kMaxLength = (1<<28)-16` 32-bit else `(1<<29)-24` [source]:

- https://github.com/v8/v8/blob/main/include/v8-primitive.h
- 64-bit `536,870,888` (~536.8M chars), 32-bit `268,435,440`, `LOWER_LIMITS 1<<20`. Enforced in `NewRawString/NewConsString/NewProperSubString/...` → `InvalidStringLength`. Irrelevant in workerd (see §7).

## 2. Operations: allocate / flatten / inline / C++

Tiers: Ignition has **no** `CharCodeAt/Slice/IndexOf` bytecode — only `ToString`, `Add→StringAdd`, `TestEqual→CSA StrictEqual` [source] `src/interpreter/interpreter-generator.cc`. Methods stay generic `Call` until Maglev/Turboshaft. Outdated pre-2023 advice about "ignition handlers" for these is stale.

### `charCodeAt`, `codePointAt`, `str[i]`/`charAt`

Torque [source] `src/builtins/builtins-string.tq: GenerateStringAt`, `src/codegen/code-stub-assembler.h: StringCharCodeAt/StringFromSingleCharCode/LoadSurrogatePairAt`:

- `ToThisString` (may runtime `ToString`), `ToInteger`, unsigned `index>=length → OOB`.
- In-bounds `StringCharCodeAt`; `charCodeAt→Smi`, `charAt/at→StringFromSingleCharCode`, `codePointAt→LoadSurrogatePairAt` (surrogate-pair load = extra branch, slower).
- Allocate? `charCodeAt/codePointAt/str[i]` return `Smi/Number/heavy-undefined` — **no alloc**. `charAt/at` hit single-char cache (`<=0xFF`) → no alloc; miss → `AllocateSeqTwoByteString(1)` [source] same + §5.

Maglev [source] `src/maglev/maglev-ir.h: StringAt, BuiltinStringPrototypeCharCodeOrCodePointAt` (all `Call/CanAllocate/DeferredCall`, i.e. not pure), backend `maglev-assembler-*.cc: StringCharCodeOrCodePointAt`: seq fast `movzx`, loop `thin→actual`, `sliced parent+offset`, `flat-cons→first`, else deferred `Runtime::kStringCharCodeAt/kStringCodePointAt`. `TryReduceStringPrototypeCharCodeAt/CodePointAt` moved to `MaglevReducer` 2025. Turboshaft [source] `src/compiler/turboshaft/operations.h: StringAt/...`, lowering in machine-lowering; `StringFromCodePointAt/FromCharCode` in `src/builtins/builtins-string-tsa.cc`. `SimplifiedLowering/string-refs` details: no evidence fetched beyond op list.

CSA `StringCharCodeAt` [source] `src/codegen/code-stub-assembler.cc` loops indirect **without full copy** except non-flat cons → `Runtime::kFlattenString`. So per-char loop over `SlicedString` input costs `O(depth)` pointer chase per access (depth 1 for direct `slice`), over non-flat `ConsString` costs one `O(n)` flatten then fast.

### `indexOf` (1 char vs N chars, 1-byte vs 2-byte)

Core [source] `src/strings/string-search.h: StringSearch/SearchStringRaw/FindFirstCharacter`, `src/objects/string.cc: String::IndexOf`, `src/objects/string.tq: AbstractStringIndexOf`, `src/builtins/builtins-string-gen.cc: SearchOneByteInOneByteString/...`:

- Policy: `len==1→SingleCharSearch`, `1<len<7→LinearSearch`, `>=7→InitialSearch→BoyerMooreHorspool→BoyerMoore` (`kBMMinPatternLength=7`, `badness` counters). Yes BM/BMH for long patterns.
- `FindFirstCharacter` uses **libc `memchr`** (`subject+pos`, byte search), then align+verify full `uc16`. For 2-byte subject searching byte `0x00` falls back to scalar loop (comment: "`memchr` mostly fails…every other byte 0"). **No `simdutf`/SSE/AVX intrinsics in `string-search.h`/`string.cc`/`builtins-string-gen.cc` (grep 0)** — only SIMD is inside libc `memchr` itself. Claims of "V8 uses SIMD for indexOf" are [inference]/libc-dependent, not V8-intrinsic.
- Torque dispatch: 4 overloads (`u8/u8`, `u16/u8`, `u16/u16`, `u8/u16`) → `SearchStringRaw`; only `u8 subj/u8 pat len==1 → SearchOneByteInOneByteString` calls `memchr` directly in CSA; others are `ExternalReference::search_string_raw` C-calls. Even 1-char 2-byte goes through C++ `SingleCharSearch→memchr`.
- `String::IndexOf(receiver,search,start)`: `searchLen==0→start`, bounds `→-1`, **`Flatten(receiver); Flatten(search)`**, `GetFlatContent`, dispatch on `IsOneByte(pat)`. **Allocates only via flatten**; result `Smi`, no string alloc.
- One-byte vs two-byte differ only in `Subject/Pattern` template instantiation and the `memchr`-then-verify path above; `sizeof(Pattern)>sizeof(Subject)+!IsOneByte(pat)→fail (-1)` fast reject.

### `startsWith(search,position)`, `includes`

[source] `src/builtins/string-startswith.tq`, `string-endswith.tq: IsSubstringAt`, `string-includes.tq`, `string-indexof.tq`:

- `startsWith`: `ToString+IsRegExp check+ClampToIndexRange`, `searchLen>len-start→False`, then `IsSubstringAt` = `TwoStringsToSlices` (flatten) + scalar `ConstSlice` compare loop. No `memchr`/BM, no alloc (Boolean).
- `includes` literally delegates: `index=StringIndexOf(...); return index!=-1` [source] `string-includes.tq`. Same flatten cost + regexp-throw check (prefer `indexOf` in hot loop to skip the extra builtin frame/check [inference]).

### `slice`/`substring`

[source] `src/builtins/string-slice.tq`, `string-substring.tq→SubString`, `src/builtins/builtins-string-gen.cc: SubString`, `src/objects/string.cc: SlowFlatten`:

- `len==0→EmptyString` (no alloc); `len==1→CharCodeAt+FromSingleCharCode` (cache); `len==len(src)&&from==0→return original`; `len<13→AllocAndCopyStringCharacters` (Seq copy, may downgrade §1); else if `string_slices→AllocateSlicedOne/TwoByteString` (no char copy, 20B object); external→copy via fake seq; non-flat cons/uncached-external (`ToDirect` fail) → `Runtime::kStringSubstring` (flatten+copy).
- So slicing is **never a char copy for `len>=13`** — cheapest op. Flatten triggers only for non-flat cons input.

### `===` between strings

[source] `src/codegen/code-stub-assembler.cc: StrictEqual/BranchIfStringEqual`, `builtins-string-gen.cc: GenerateStringEqual/StringEqual_Core/FastLoop/Loop`, `src/objects/string-inl.h: String::Equals`, `src/objects/string.cc: SlowEquals`, `src/objects/string-comparator.cc`:

- `StrictEqual`: `TaggedEqual→true` (except HeapNumber NaN), both `IsString→BranchIfStringEqual`.
- `BranchIfStringEqual`: `length!=→false`, else `kStringEqual(length)`. **No hash, no internalization.**
- `GenerateStringEqual`: caller handles `lhs==rhs`; both internalized `&& !=→false` immediately. Indirect: deref thin/flat-cons (`second==""`) else `Runtime::kStringEqual`. Same-encoding non-external → `FastLoop` word chunks (`kTaggedSize`); else `Loop` 4 combos via `DirectStringData`.
- C++ `Equals`: `other==this→true; both Internalized→false; else SlowEquals` (length+`memcmp`-like `CompareCharsEqual`, hash only as negative filter `TryGetHash(both)&&h1!=h2→false`, `Get(0)` early-out; cons/sliced walked via `ConsStringIterator` without flatten in non-isolate overload, isolate overload flattens then 4-encoding `CompareCharsEqual`).
- So `===` on two equal non-internalized strings = **length check + memcmp, no table lookup** [source]. Using `===` to compare tag names never internalizes — safe.

## 3. Flattening

`String::Flatten` **only handles `ConsString`** [source] `src/objects/string.h: Flatten` doc, `src/objects/string-inl.h: Flatten/SlowFlatten`:

> non-flat cons → alloc `SeqString` + mutate cons to `first=flat,second=empty` (degenerate, `IsFlat()==second.length==0`, GC `IsShortcutCandidate`). Flat cons → unwrap `first`. Thin → `actual`. Seq/External/Sliced → as-is.

- Alloc type `kYoung` default, `kOld` if cons not in young; `SlowShare` uses `kSharedOld` [source] same.
- **No depth threshold in `Flatten`**; `ConsStringIterator::kStackSize=32` is traversal stack, not flatten trigger. No evidence of auto-flatten on depth.
- `charCodeAt` cost on user `ConsString`: first hit `O(n)` `WriteToFlat2` copy (reverse-DFS, `SmallVector 32`) [source] `src/objects/string.cc`, rest `O(depth)`; on `SlicedString`: never flattens, `O(depth)` chase (`index+=offset; string=parent`) [source] `src/codegen/code-stub-assembler.cc: StringCharCodeAt`.
- `indexOf` cost on unflattened: always `O(n)` copy + search (except empty needle early-return) [source] `String::IndexOf`.
- `GetFlatContent` is **non-flattening**: `SlowGetFlatContent` returns `NON_FLAT` for non-flat cons; caller checks `IsFlat()` [source] `src/objects/string.cc`. `TryGetFlatContentFromDirectString` only Seq/External.
- `String::Get` dispatch [source] `src/objects/string-inl.h: GetImpl`, `src/objects/string.cc: ConsString::Get` (iterative `left.len>index?l:r` walk `O(depth)`), `Sliced::Get: parent->Get(i+offset)`, `Thin::Get: actual->Get(i)`.

Cheap force-flatten from JS (production, no `%FlattenString` — `Runtime::kFlattenString` is d8-only [source] `src/runtime/runtime-strings.cc`):

- `s+''` **creates Cons, anti-pattern** [source] `NewConsString`; constant-fold `<=100` flat else cons (`kConstantStringFlattenMaxSize=100` in `src/compiler/common-utils.cc`).
- `s.indexOf('')` **does not flatten** (early return before `Flatten`) [source] current `String::IndexOf`. Old blog advice to use it is outdated for V8 ≥12.
- `str.length` is just field load, no flatten [inference].
- Do flatten [source]: `Number(s)/ToNumber` (pays parse), `s.charCodeAt(i)` slow path (`Runtime_StringCharCodeAt: Flatten`), `s.indexOf(nonEmpty)`, `lastIndexOf`, `localeCompare` (`Flatten(str1,str2)` in `builtins-string.cc`), `ConvertCase`, `split`/`ToArray`. `Array.join` flatten: no evidence.
- Recommendation [inference]: no zero-cost intrinsic. For a tokenizer, **warm once with a real non-empty search** (e.g. the first `indexOf('<')` you already do) — it flattens at `O(n)` scan+copy amortized over the token loop. Avoid `s+''`, `s.indexOf('')`.

## 4. Internalization and string table

In-place only for `SEQ_*/EXTERNAL_*/SHARED_*` old-space [source] `src/objects/string-inl.h: IsInPlaceInternalizable`; Cons/Sliced/Thin → false.
Path [source] `src/objects/string-table.cc: LookupString` (moved from `src/strings/`, old path 404s): `Flatten→EnsureRawHash→InternalizedStringKey→LookupKey`; on miss `ComputeInternalizationStrategyForString`: `kInPlace` = map rewrite, `kCopy` = `NewInternalizedStringImpl` (`WriteToFlat` copy). Cached external moves resource, else copies. `SetInternalizedReference`: shared/forwarding-table → index else `MakeThin(internalized)` (`set_actual; map=thin_...`) — one-way [source] `src/objects/string.cc: MakeThin`.
Cost [source] `src/strings/string-hasher-inl.h: HashSequentialString` + `src/objects/string.h: kMaxHashCalcLength=16383`: try int/array-index parse, `len>16383→GetTrivialHash(len)=len` (not hashed!), else rapidhash (+8-bit second pass for 2-byte). Then off-heap open hash `FindEntry` (quadratic probe, `kMinCapacity=2048`) + possible alloc+copy. Write-mutex only on miss.
When [source+inference]: property keys (`ToName/ToPropertyKey`, literal keys, `o[k]`, `in`, `TryStringToIndexOrLookupExisting` fast path) internalize; comparisons do **not**; `Map` keys use `SameValueZero`, no internalize (callsite not fetched — [inference]).
`===` on equal non-internalized: pointer miss + `SlowEquals` memcmp, no internalize (§2).
`SlicedString` as key: `Flatten` + `kCopy` → new `SeqInternalized` + original `MakeThin` (mechanism [source] `LookupString`; exact `KeyAccumulator/ToName` callsite not fetched — [inference] but copy unavoidable since sliced not in-place-internalizable).

## 5. Creating strings from char codes

Current `TS_BUILTIN(StringFromCharCode)` [source] `src/builtins/builtins-string-tsa.cc` (same in old `builtins-string-gen.cc`):

- `argc==1`: `code&0xFFFF`, `StringFromSingleCharCode` = cache lookup else `SeqTwoByte(1)`. No loop.
- `argc>1`: `one_byte=AllocateSeqOneByteString(argc)`; loop truncate to 16-bit; `>0xFF→two_byte` path: `two_byte=AllocateSeqTwoByteString(argc); CopyStringCharacters(ONE→TWO)`; resume 16-bit stores. Up to 2 allocs, `SizeFor=header+len*sizeof(Char)`.
- `apply/spread` = same builtin with `argc`=arg count; large spread pays args-adaptor+stack+`kMaxLength` check. Exact arg limit: no evidence ([inference] ~65k–500k stack-dependent; chunk it).
- Beats slicing/decoding [inference]: batch `fromCharCode(...codes)` = 1–2 allocs `O(n)` vs looped `+=` = Cons tree (`O(depth)` per Get, `O(n)` per flatten — quadratic if flattened per iter) vs `slice` = `Sliced` keeping parent alive (20B, no copy). Single `fromCharCode(c)` ≈ `charAt`. For tag names you already have as substrings, **slicing wins** (zero copy); `fromCharCode` wins only when accumulating decoded entities (`&amp;` → codes) or normalizing case — batch codes, don't `+=` in a loop.

## 6. Reading past the end

Spec: `charCodeAt(OOB)→NaN`, `charAt→""`, `s[i]→undefined`, `codePointAt→undefined`.
Optimized code **speculates in-bounds** [source] commit `ee2d85a [turbofan] Speculate on bounds checks for String#char[Code]At`, `src/maglev/maglev-graph-builder.cc: TryReduceStringPrototypeCodePointAt` (now `MaglevReducer`): `CheckBounds(index,length)` **deopts**, then unchecked `StringCharCodeAt` with `MaskIndexWithBound`. Only with `DisallowBoundsCheckSpeculation` does it emit `Select(LessThan ? Get : NaN/undefined)`. CSA `StringCharCodeAt` itself has no bounds check — caller must `CheckBounds` [source].
So OOB in hot loop = **deopt (expensive, then interpreter returns NaN), not inlined NaN branch**. It is *correct* as a sentinel but not *free*. Keep explicit `if(i<len)` [inference for perf]: lets range analysis fold `CheckBounds`, avoids deopt storms. Redundant constant checks are coalesced ([source] `1c19bb4 Eliminate redundant constant array bounds checks`). Do not rely on dropping checks — measure.

## 7. Anything else a tokenizer should know

- Single-char cache: **one-byte only, 256 entries `0–255`, internalized** [source] `src/heap/factory.cc: LookupSingleCharacterStringFromCode` (`cache->get/set(code)` for `<=255`, `InternalizeOneByte`); two-byte singletons always fresh `SeqTwoByte(1)`. "128 ASCII" claims: no evidence — code shows `<=kMaxOneByteCharCodeU (255)`. Maglev x64 fast path [source] `maglev-ir-x64.cc: BuiltinStringFromCharCode: <255 LoadSingleCharacterString else AllocateTwoByteString(1)`.
- Hash: `kMaxHashCalcLength=16383` [source] `src/objects/string.h`; beyond → `hash=len` [source] `string-hasher-inl.h: GetTrivialHash`. Old "first 16383 chars hashed" is outdated for `main` (rapidhash + trivial-hash change).
- `kMaxLength` [source] `include/v8-primitive.h`: 64-bit `536,870,888`, 32-bit `268,435,440`. Unreachable in workerd: [docs] `developers.cloudflare.com/workers/platform/limits/` (Sept 2026): **128 MB per isolate**, `Error 1102` on exceed, 64 MiB worker size, CPU 10 ms free / 30 s default. `536M×1B=536 MB>128 MB` → OOM first [inference]. Size outputs accordingly: prefer slices (20B) over copies; two-byte input doubles everything.
- No dedicated v8.dev flattening post found (checked index; only Maglev 2023, CSA 2017, JSON 2025). Rep summary [docs] `docs/objects/strings.md` (Cons/Sliced/Thin) — thin on numbers, use source above.
- `codePointAt` costs a surrogate-pair branch over `charCodeAt`; `str[i]` OOB-`undefined` vs `charCodeAt` OOB-`NaN` — pick by which sentinel your loop already checks [inference].

---

## Actionable rules for the parser

- **Keep the input flat and one-byte if you can.** One non-Latin1 char anywhere makes the whole input two-byte and all `len>=13` slices stay two-byte (§1). If bytes input, UTF-8-decode once; if callers pass JS strings, accept two-byte cost — don't re-scan to "downgrade."
- **Slice, don't copy, for names/text `>=13` chars** (`SlicedString` 20B, no char copy). For `<13` V8 copies anyway — same cost, plus downgrade benefit on two-byte parents.
- **Scan with `indexOf`/`charCodeAt`, not `startsWith` chains or regex.** Single-char `u8/u8 indexOf` is the only CSA-direct `memchr` path; multi-char `>=7` gets BM/BMH. `includes` = `indexOf` + wrapper — call `indexOf` directly. `startsWith` is scalar compare, fine for `<`/`?>` checks but no BM.
- **Never `s+''` to "flatten"; warm with your first real `indexOf`.** `s+''` makes a Cons; `indexOf('')` doesn't flatten. Your first `indexOf('<')` flattens for free.
- **Loop `charCodeAt`, not `charAt`/`s[i]`, in hot scan.** No alloc vs cache-miss alloc; `codePointAt` only where astral matters. Hoist `.length`, keep `if(i<len)` — OOB deopts.
- **Compare tag names with `===`, never as keys.** `===` = length+memcmp, no internalization. Don't use slices as object keys (forces flatten+copy+Thin). For dispatch, `if/else ===` chain or `switch` on short names; a `Map` doesn't internalize but still hashes per lookup — measure.
- **Batch `fromCharCode` for entity decoding; never `+=` per char.** Collect codes, one call. For `len==1` it's just a cache lookup.
- **Drop whitespace-only nodes without slicing** (index check, no `slice`) — short-slice copies are pure waste there.
- **Budget memory as: input (n or 2n bytes + 12B header) + 20B per slice + Seq copy per short token.** Two-byte input + many short attr copies is the worst case.

## Open questions that need a benchmark (in workerd itself)

- `indexOf('<')` vs hand-rolled `charCodeAt` loop for `<`, `>`, `&`, `"`, `'` on 1-byte vs 2-byte inputs (10 KB / 1 MB): does libc `memchr`+BM beat the Maglev `StringAt` loop, and where is the `len>=7` BM crossover for `<!--`, `]]>`, `&amp;`?
- Flatten amortization: `ConsString` input (e.g. `chunk1+chunk2` body) — cost of first `indexOf` vs `charCodeAt(0)` warm vs pre-split; `SlicedString` input (e.g. `big.slice(off)` body) — per-access parent-chase cost vs explicit copy (`slice<len13` copy vs `slice+s+''`? no — vs `String(s.slice(...))`).
- Two-byte penalty: same XML as one-byte vs two-byte (append one CJK char) — `indexOf`, `===`, `slice` throughput and heap (process.memoryUsage / workerd `performance` if exposed).
- `===` dispatch vs `Map.get` vs `switch` for ~20 tag names with sliced keys: time + internalization copies (heap growth, Thin count via `--trace-gc` locally).
- `fromCharCode(...codes)` chunk size for entity-heavy text (1k/10k/64k codes) vs `TextDecoder` on bytes input; spread-arg cliff location in workerd.
- Bounds-check style: explicit `if(i<n)` loop vs `NaN`-sentinel `while(!isNaN(c))` — deopt count (`--trace-deopt`) and time in Maglev/Turboshaft tiers.
- `slice` vs `substring` vs `substr` (legacy) codegen identity in 15.1; `string_slices` flag state in workerd 1.20260815 (`--allow-natives` + `%DebugPrint`/processing `v8.getFlagsFromString` if exposed).
- Peak memory under 128 MB: 5/20/50 MB one-byte vs two-byte docs, slices-only vs short-copy outputs — where does workerd OOM (`Error 1102`) vs `kMaxLength` (never).
