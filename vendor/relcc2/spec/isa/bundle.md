# Wide instruction format

This describes how an E2K wide instruction (bundle) is laid out in memory,
as implemented by MCST binutils 2.41-29.023. Main sources:

- `opcodes/e2k-dis.c`: `unpack_instr`, `print_alf`, `print_ss`, `print_cs0`,
  `print_cs1`, `print_pls_syllables`, `print_cds`, `print_ctcond`
- `gas/config/tc-e2k.c`: the `e2k_hs` struct and the packing code that
  follows it

Status markers:

- **[checked]**: verified byte for byte against gas by
  `tools/isa-extract/check_encodings.py`
- **[decoded]**: `tools/isa-decode/e2kdis.py`, written from this document,
  decodes gas output identically to objdump over the corpus in
  `tools/isa-decode/corpus` (compiler output and hand-written bundles, v3–v7).
  This confirms the reading of binutils, not the hardware.
- **[source]**: read from binutils, not yet machine-checked

Every syllable is a little-endian 32-bit word. "Bits a–b" are counted from bit
0, the least significant.

## Overall layout [checked for the parts used by ALU operations]

A wide instruction is 8–64 bytes long, in multiples of 8. It has two parts:

1. **Before the middle point**, in this order, each present only if HS says
   so:

   | Syllable | Present when |
   |---|---|
   | HS | always |
   | SS | HS bit 12 |
   | ALS0 … ALS5 | HS bits 26–31 |
   | CS0 | HS bit 14 |
   | ALES5/ALES2 word | see below |
   | CS1 | HS bit 15 |

   `HS.mdl` gives the position of the middle point.

2. **After the middle point**: 16-bit half-syllables, then any gap, then
   32-bit syllables placed backwards from the end of the instruction.

   - **Half-syllables:** ALES0, 1, 3 and 4 first (those marked in HS), then
     the AAS half-syllables. They are paired into 32-bit words, and **the
     first half of each pair occupies the upper 16 bits** of its word. So
     half-syllable `k` sits at byte offset `mdl + 2*((k & ~1) + 1 - (k & 1))`.
     An odd count leaves an unused half.
   - **From the end, going backwards:** CDS0, CDS1, CDS2 (count in HS), then
     PLS0, PLS1, PLS2 (count in HS), then LTS0, LTS1, … The LTS syllables
     fill whatever space remains down to the half-syllables. Anything between
     them is gap.

### ALES2 and ALES5 [checked]

ALES2 and ALES5 have no half-syllable slots. When needed, they share one
32-bit word just before CS1: ALES5 in bits 0–15 and ALES2 in bits 16–31.

- If HS marks ALES2 or ALES5 but that word is absent, the value is the
  default `0x01c0` (opc2 = EXT, opce = NONE).
- gas omits the word whenever both values are default. Before v4 it never
  emits it at all, so on v1–v3, channels 2 and 5 can only take ALES2/ALES5
  with the default value.
- On v4, an operation with `explicit_ales25_v4` set forces the word to be
  emitted.

The presence test: the word exists if `mdl` equals the current offset plus 4
(no CS1) or plus 8 (with CS1).

### Counting the size [checked: gas; decoded: lcc's code]

A wide instruction holds at most 16 words; gas refuses a larger one
("wide instruction requires 18 syllables which exceeds the maximal
supported size of 16 ones"). gas sizes it by this rule (`tc-e2k.c`, the
packing code after the `e2k_hs` struct), so a compiler that knows each
operation's channel and literals can count it the same way:

1. **Before the middle point**: HS; SS if any of its fields is used (a
   transfer, an explicit `ipd`, `alc`/`abn`/`abp`, `bap`, any `mova`);
   one ALS per busy channel; CS0; the ALES2/ALES5 word (v4+, only when
   either value is not the default); CS1.
2. **Half-syllables**, rounded up to whole words: one for each of
   ALES0, 1, 3 and 4 that an operation marks (the default value counts:
   `getsp` takes ALES0), then the AAS: AAS0 if `mova` channel 0 or 1 is
   used, AAS1 if 2 or 3 is, and one half per `mova` channel used (a
   `movaq` two). A `mova` in channel 2 alone is AAS1 + AAS4, one word
   (AAS, below).
3. **LTS: one more than the highest LTS used**, not the number of
   literals (gas counts from the highest busy half). Left to gas the
   slots are dense, in every order of 16-, 32- and 64-bit literals we
   tried; an explicit `_f32s,_lts2` alone costs three words,
   `_f16s,_lts1hi` alone two. What fits and what is free ("Literal
   values"): a constant 0–31 written as `src1` takes no LTS and gas
   never swaps operands, operations that use one value share its LTS,
   and `setwd` takes LTS0.
4. **PLS0 … PLSn** up to the highest one used: a `landp` of two
   conditions one word, of three two, of four three
   ([predicates.md](predicates.md)). **CDS**: two RLP/MRGC entries a
   word.
5. The total, rounded up to an even number of words.

The control operations take what [reservations.yaml](reservations.yaml)
lists: a lock load (MAS 0x4) or a check load (MAS 0x3) CS1, the check's
`rbranch` SS and CS0 (with one ALS that is 6 words), `aaurr*`/`aaurw*`
always CS1, which they share with MAS accesses.

`tools/isa-extract/check_reservations.py` checks every wide instruction
it decodes against this rule (with the PLS and CDS counts HS gives), and
its `--selftest` assembles the cases of this section (`SIZE_CASES`) and
compares gas's size or error with it. The rule gives the size of every
one of the 1,661,756 wide instructions of lcc 1.29.16's code we
checked (`libc.so.6` for v3, v5.8c2 and v6.2c3; SQLite 3.53.4's
amalgamation at `-O3` for v3.4c and v5.8c2), of its CoreMark builds and
of the decoder corpus (v3–v7), gas's padding aside. lcc names its
literal slots itself and leaves a lower one empty (LTS0 and LTS2 used,
LTS1 not) in 331–340 instructions of each `libc.so.6`.

How close lcc's code comes to the limit [decoded: lcc 1.29.16, gas's
padding left out; the counts are `check_reservations.py`'s notes]:

| Code | Wide instructions | 14 words or more | 16 words | of them a function's first (`setwd`) | of them using 15 words |
|---|---|---|---|---|---|
| v3 `libc.so.6` | 409,374 | 0.44% | 182 (0.04%) | 31 | 142 |
| v5.8c2 `libc.so.6` | 408,456 | 0.26% | 98 (0.02%) | 0 | 82 |
| v6.2c3 `libc.so.6` | 405,944 | 0.30% | 127 (0.03%) | 0 | 107 |
| SQLite, v3.4c `-O3` | 221,058 | 0.98% | 294 (0.13%) | 111 | 247 |
| SQLite, v5.8c2 `-O3` | 216,924 | 0.63% | 142 (0.07%) | 0 | 115 |

The v3 function entries at the limit have one shape (all 31 in
`libc.so.6`, 110 of the 111 in SQLite): `setwd` (CS1, LTS0), a prepare
with `ipd` (SS, CS0), `getsp` (ALS0 and its ALES0 half) and five more
ALU operations with literals in LTS1–3: 15 words, rounded to 16. One
more word still fits there (a CDS word for one or two predicated
operations, or one `mova`'s AAS halves beside the ALES0 half); two more
don't [checked: gas]. The other 16-word
instructions are bodies heavy with predicates: 80–85% of them hold six
ALU operations, 79–94% two or three PLS words, 69–86% a CDS word or
more, and 52–80% three or four LTS. 78–84% of all 16-word instructions
use 15 words and have a word to spare from the rounding.

gas's own padding is separate empty wide instructions of 4–16 words
before the labels it moves (about 2,000 in each `libc.so.6`, 82–85% of
them starting at offsets 0x1c0–0x1ff of a 1 KiB block: `CODE_PLACEMENT`,
[hwbugs.md](hwbugs.md)), so a count per instruction leaves it out.

## HS: header syllable [decoded]

| Bits | Field | Meaning |
|---|---|---|
| 0–3 | `mdl` | Middle point: number of 32-bit words before it, minus one |
| 4–6 | `lng` | Length in 64-bit units, minus one |
| 7–9 | `nop` | Empty cycles to insert after this instruction |
| 10 | `lm` | Loop mode (`loop_mode`) |
| 11 | — | Reserved |
| 12 | `s` | SS present |
| 13 | `sw` | Set by `set_mark` |
| 14 | `c[0]` | CS0 present |
| 15 | `c[1]` | CS1 present |
| 16–17 | `cd` | Number of CDS syllables |
| 18–19 | `pl` | Number of PLS syllables |
| 20–25 | `ale` | ALES0 … ALES5 present |
| 26–31 | `al` | ALS0 … ALS5 present |

An HS where everything except `lng` is zero is an empty instruction (`nop`).

## ALS: ALU operation syllable [checked]

| Bits | Field |
|---|---|
| 31 | `sm`: speculative mode (`,sm` in assembly) |
| 24–30 | `opc`: opcode |
| 16–23 | `src1`, or `opce` for formats without src1 |
| 8–15 | `src2` |
| 0–7 | `dst`, `src3` for stores, or a predicate destination |

### Operand encodings [checked for window registers and src3 literals; other literals decoded]

Applies to `src1`, `src2`, `src3` and `dst` bytes:

| Value | src1 | src2 | src3 | dst |
|---|---|---|---|---|
| `0xxxxxxx` | `%b[x]` rotating-base register | same | same | same |
| `10xxxxxx` | `%rx` window register | same | same | same |
| `110xxxxx` | 5-bit literal `x` | see next rows | literal forms (v7 `_lt3`) | special registers |
| `1100xxxx` | — | 4-bit literal `x` | — | — |
| `11010hll` | — | 16-bit literal: LTS`ll` (0 or 1), half `h` | — | — |
| `110110ll` | — | 32-bit literal: LTS`ll` | 32-bit literal (v7 `_lt3`) | — |
| `110111ll` | — | 64-bit literal: LTS`ll` and LTS`ll+1` | — | — |
| `111xxxxx` | `%gx` global register | same | same | same |

Special destinations (`110xxxxx`): 13 `%tst`, 14 `%tc`, 15 `%tcd`, 17–19
`%ctpr1`–`%ctpr3`, 30 `%empty.lo`, 31 `%empty.hi`. Other values are reserved.

The register's width (`%r`, `%dr`, `%qr`, `%qpr`) comes from the operation,
not from the encoding.

#### Literal values [checked: gas and objdump, `tools/isa-extract/check_literals.py`; extension: source and lcc's code]

| Literal | Encoding | Values | Extended to the operand's width | gas / objdump spelling |
|---|---|---|---|---|
| 5-bit | `src1` `110xxxxx` | 0–31 | zero | `0x1f` |
| 4-bit | `src2` `1100xxxx` | 0–15 | zero | `0xf` |
| 16-bit | `src2` `11010hll`: half `h` of LTS0 or LTS1 | −32768–32767 | sign | `_f16s 0xffa0` (−96); explicit slot `_f16s,_lts1hi 0xffa0` |
| 32-bit | `src2` `110110ll`: LTS0–LTS3 | −2^31–2^31−1 | sign (to 64 bits for a 64-bit operand) | `_f32s 0xffffffa0` |
| 64-bit | `src2` `110111ll`: LTS`ll` (low half) and LTS`ll+1` (high half), `ll` 0–2 | any | — (a 32-bit operand reads only LTS`ll`, MCST qemu) | `_f64 0x100000000` |
| `src3` | — | — | — | no literal before v7: MCST qemu decodes `110xxxxx` there as illegal; gas rejects a literal store datum ("Register should be specified for SRC3"), also with `-mcpu=elbrus-v7` |
| AAU (`ldaa*`, `staa*`) | ALS `lt` field: one LTS | 32 bits | zero (both qemus) | `_f32s,_lts1 0x8` |

- Sources for the extension: binutils says so ("4 and 5 bit literals
  unlike 16 and 32 bit ones are extended by zeroes rather than by sign",
  `gas/config/tc-e2k.c:2108-2110`), objdump prints 16- and 32-bit
  literals only as `_f16s`/`_f32s` (`opcodes/e2k-dis.c:433-475`), and both
  emulators sign-extend them (MCST qemu `target/e2k/decoder.h:160-195`,
  `tcg/translate-al.c:1660-1700`: `int16_t`, `int32_t`; community qemu
  `target/e2k/translate.c:1449-1472`: `sextract32`, `(int32_t)`). lcc's
  code depends on it: lcc 1.29.16's v3 `libc.so.6` has 8,179 loads and
  7,478 stores with a negative `_f16s` offset, and lcc's `-O0` functions
  reserve their argument area with `getsp _f16s,_lts1hi 0xfff0` (−16) and
  similar.
- A 16-bit literal in LTS2 or LTS3 is invalid: objdump prints `<illegal
  _f16s,_lts2…>`, MCST qemu reads 0, the community qemu raises an
  illegal-opcode exception. A 64-bit literal at LTS3 likewise.
- gas's format specifiers are `_f16s`, `_f16`, `_f32s`, `_f32` and `_f64`
  (`tc-e2k.c:1814-1819`); there is no `_f16u` or `_f32u`. `_f16` and
  `_f32` only parse the value as unsigned and encode the same bits, which
  are then sign-extended: `addd %dr0, _f32 0xffffffff, %dr1` adds −1, and
  objdump prints it as `_f32s 0xffffffff`. Slot specifiers: `_lts0lo`,
  `_lts0hi`, `_lts0`, `_lts1lo`, `_lts1hi`, `_lts1`, `_lts2`, `_lts3`
  (`tc-e2k.c:1853-1862`).

What gas picks for a bare constant (`tc-e2k.c:2137-2150`;
`check_literals.py`):

| Value | `src2` of a 64-bit operation (`ldd`, `std`, `addd`) | `src2` of a 32-bit operation (`adds`, `getsp`) |
|---|---|---|
| 0–15 | 4-bit | 4-bit |
| 16 to 32767, −32768 to −1 | `_f16s` | `_f16s` |
| 32768 to 2^31−1, −2^31 to −32769 | `_f32s` | `_f32s` |
| anything else | `_f64` | `_f32s`, **truncated to 32 bits without a message** (`0x100000000` becomes `_f32s 0x0`) |

In `src1` gas takes only 0–31; any other value, negative ones included,
is "Invalid argument in position of SRC1", and gas never swaps the
operands. So there is no free negative literal: −8 costs half an LTS,
+8 nothing.

gas pitfalls (`check_literals.py`):

- A minus sign right after a specifier is read as subtraction: `_f16s
  -1` assembles as the expression `_f16s - 1`, an undefined symbol
  `_f16s` with an `R_E2K_64_ABS_LIT` relocation and a `_f64` literal, with
  no message (`_f32s -1`, `_f64 -1` too). Write `_f16s 0xffff`, `_f16s
  (-1)` or a bare `-1`.
- A value too large for an explicit format is truncated silently:
  `_f16s 0x12345` encodes `0x2345` (`tc-e2k.c:2152`: "Currently this check
  won't catch anything").
- gas shares one LTS among the operations of a wide instruction that use
  the same value (two `ldd … 0x12345` take one LTS), and puts a 16-bit
  literal in a `hi` half first (`tc-e2k.c:2265-2270`).
- Room: four LTS per wide instruction, so at most four 16-bit literals in
  the halves of LTS0 and LTS1, four 32-bit literals or two 64-bit ones;
  a fifth 16-bit value goes to a 32-bit LTS. More distinct values: error
  "literals cannot be packed into a wide command". `setwd` takes LTS0
  (CS1, below) [source]; after it 16-bit literals have only LTS1's two
  halves (a third goes to a 32-bit LTS) and at most one 64-bit literal
  fits, a second being "literals cannot be packed" [checked: gas,
  `check_reservations.py --selftest`]. How many LTS words an instruction
  takes: "Counting the size".

lcc writes every literal that needs an LTS with its format and slot
(`_f16s,_lts0lo 0x38`, `_f32s,_lts1 0xffffffa0`, `[ _f64,_lts0 sym ]`)
and does not always pick the smallest: 2,441 loads in its v3 `libc.so.6`
carry a `_f32s` value that fits 16 bits.

#### Address operands [gas, lcc]

Loads (ALOPF1, ALOPF11: `ldb` … `ldd`, v5 `ldq`, `ldqp`) and stores
(ALOPF3, ALOPF13: `stb` … `std`, v5 `stq`, `stqp`, `stmqp`) address
`src1 + src2`; a store's datum is `src3` and must be a register. Every
displacement fits in the operation itself; a larger one costs literal
syllables, not instructions:

| Address | Encoding | Literal space |
|---|---|---|
| register + register | `src1`, `src2` registers | none |
| register + 0…15 | `src2` 4-bit | none |
| register + 16…31 | `src1` 5-bit, base in `src2` (lcc: `ldd,3,sm 0x10, %dr2, %dr2`; 6,378 loads and 2,996 stores in its v3 `libc.so.6`) | none |
| register + −32768…32767 | `src2` `_f16s` | half an LTS |
| register + −2^31…2^31−1 | `src2` `_f32s` | one LTS |
| register + any 64-bit value, `sym`, `sym+off` | `src2` `_f64` (`R_E2K_64_ABS_LIT` for a symbol) | two LTS |
| register + `sym@GOT`, `@GOTPLT`, TLS offsets | `src2` `_f32s` with a relocation ([elf.md](../abi/elf.md)) | one LTS |
| absolute | `src1` 0…31 + `src2` literal (`ldd 0x0, sym, %dr4`) | as the literal |

There is no scaled index, no register + register + displacement and no
negative short literal. AAU accesses (`ldaa*`, `staa*`) add a 32-bit
literal that both emulators zero-extend (MCST qemu
`tcg/translate-al-c11.c:153-156`, community qemu `translate.c:4320-4335`).

### Operand roles per format [checked except where marked]

`args` in `binutils-ops.yaml` lists the operand formats in this order:

| Format | Operands | Extra fields |
|---|---|---|
| ALOPF1, ALOPF11 | src1, src2, dst | ALOPF11: ALES = `opc2 << 8 \| opce` |
| ALOPF21 | src1, src2, src3, dst | src3 in ALES bits 0–7; ALES bits 8–15 = `opc2` |
| ALOPF2, ALOPF12, ALOPF22 | src2, dst | `opce` in the src1 field; ALOPF12 also has ALES; ALOPF22 has ALES `0x01c0` |
| ALOPF7 | src1, src2 → predicate | `cmpopce` in dst bits 5–7, predicate number in bits 0–4 |
| ALOPF17 | src1, src2 → predicate | ALES = `0x0200 \| cmpopce`; dst bits 5–7 are zero |
| ALOPF8 | src2 → predicate | src1 field = `0xc0` (none); `cmpopce` in dst bits 5–7 |
| ALOPF3, ALOPF13 | src1 (address), src2 (offset), src3 (data, in the dst byte) | stores; ALOPF13 also has ALES = `opc2 << 8 \| opce` |
| ALOPF11_LIT8 | src1, src2, 8-bit literal, dst | literal in ALES bits 0–7 |
| ALOPF12_PSHUFH | src2, 8-bit literal, dst | `opce` in the src1 field; literal in ALES bits 0–7 |
| ALOPF12_IBRANCHD, ALOPF12_ICALLD [decoded] | src2 (target), dst | v6+. `icalld` keeps `wbs` in the src1 field; the condition comes from `SS.ctcond` |
| ALOPF15 | src2 → state register | register number in the dst byte, `opce` in the src1 field, ALES `0x01c0` (`rws`/`rwd`) |
| ALOPF16 | state register → dst | register number in the src1 field, the table's `src2` value in the src2 field, ALES `0x01c0` (`rrs`/`rrd`) |
| ALOPF10, ALOPF19 | AAU store/load (`staa*`/`ldaa*`): `%aadD [ %aastiI + literal ]`; the data (store) is in the dst byte | ALS bits 8–23 form a 16-bit field: `lt` bits 0–1 (LTS number + 1, or 0 for none), `am` bit 2, `incr` bits 4–6, `ind` bits 7–10, `d` bits 11–15. ALES `0x01c0` (`0x02c0` for `staaqp`/`ldaaqp`) |
| AAURR, AAURW | AAU register read/write | Same opcodes as `ldaa*`/`staa*` with MAS `0x3f` in CS1; ALS bits 8–23 select the register (`registers.yaml`) |

When the table lists fewer formats than the struct's array holds, the
remaining operands are 32-bit (`s`), as C zero-initialises them. The
extractor pads `args` accordingly.

On v7, the `_lt3` forms (ALOPF21_LT_PACK_CODE) take src3 as a literal; gas
always encodes it as a 32-bit literal in an LTS (`110110ll`).

The operand formats in the table are not always exact: `plog`/`qplog` are
listed with 64-bit operands (`ARGS_DDDD`), although `qplog` works on 128-bit
packed registers (the older generator output has `ARGS_PPPP`). gas accepts
either register width.

### Operations that take two channels [checked]

Operations with a 128-bit (`q`) operand in certain positions occupy a pair of
channels. Which pair follows from the format and operand formats alone:

| Operation | Pairs |
|---|---|
| 128-bit result: ALOPF11 with dst `q`, or ALOPF2/12/22 with dst `q` | (0, 1) and (3, 4) if the operation is allowed in ALC1; otherwise (0, 2) and (3, 5) |
| 128-bit store data: ALOPF13 with src3 `q`; `staaq`, `aaurwq`, `ldaaq`, `aaurrq` | (2, 5) |

The operation may be written with either channel of its pair.

- **Before v7:** both channels are encoded with the same opcode. In the upper
  one, every `q` operand names the odd half (N+1) of the register pair.
  The exception is a `q` src1 of a load (ALOPF11 with MAS) or of a pair-(2, 5)
  operation, which is the same in both channels.
- **From v7:** only the lower channel is encoded; the upper one is reserved
  implicitly (offset 1, 2 or 3; see `implicit_paired_alc_delta` in
  `include/opcode/e2k.h`).

objdump hides the upper half only for a hard-coded list of names, so for
other paired operations (`movt{c,r,rc}q`, `cudtoap`, `ldod{w,r,p}q`,
`getsod`) it prints both channels.

## SS: stubs syllable [decoded for type 0, except `dtbp`]

Bits 0–9, 30 and 31 are common to both types. `type` is bit 20.

| Bits | Field | Meaning |
|---|---|---|
| 0–8 | `ctcond` | Control-transfer condition (see below) |
| 9 | `dtbp` | v7 |
| 10–11 | `ctop` | `ct %ctprN` with N = ctop; 0 means `ibranch` or `call` via CS0/CS1 |
| 12–15 | `aa0`–`aa3` | AAS half-syllables present (type 0 only) |
| 16 / 17 | `alct` / `alcf` | `alc`: advance loop counters |
| 18 / 19 | `abpt` / `abpf` | `abp`: advance the predicate rotation base |
| 20 | `type` | |
| 21 / 22 | `abnt` / `abnf` | `abn`: advance the register rotation base |
| 23–24 | `abg` | `abgi`, `abgd` |
| 25 | `crp` | |
| 26 | `vfdi` | |
| 27 | `srp` | `crp` and `srp` together encode `slrp` |
| 28 | `bap` | Begin array prefetch |
| 29 | `eap` | End array prefetch |
| 30–31 | `ipd` | Instruction prefetch depth |

Without an SS, `ipd` takes a default value other than 0 (binutils MCSTBug
#163454). On the 4C, 8C2 and 2C3 a prepare without SS fetches as deep as
one with `ipd 3` (the value gas writes in an SS it makes for a `ct`).
Both fetch all of a cold 768-byte target given about 640 cycles from
memory, where `ipd 2` loses 50–130 cycles, and both lose as much as
`ipd 2` on a 1.5 KiB target ([control-transfer.md](control-transfer.md),
"Code not in the instruction cache"; `tools/isa-probes/ctlleft.c`
`f_fardiv48l3_*`, `f_fardiv48l6_*`) [hw]. The instruction-fetch
monitors count 3 lines for it, as for `ipd 3` (`tools/isa-probes/pmu2.c`
`ib_depth_*`; [monitors.md](monitors.md)).

**Type 1 (SF2) [source; run]:** used from v6 for `abgc`/`rbgc`, which replace
`abg`. `abgc NUM` (1–7) puts NUM in bits 13–15 (the `aa1`–`aa3` positions of
type 0) together with a condition. objdump prints no type-1 fields, so this
can't be checked by decoding, but gas's encoding does what it should on
the Elbrus-2C3 (`ctl6.c`: `abgc N` adds N to `%bgr.cur`, also under a
predicate; loops.md, "v6").

### ctcond [decoded for types 0–9, 14, 15; type 9 run; type 11 source]

Bits 0–4 are `psrc`; bits 5–8 are the condition type:

| Type | Condition |
|---|---|
| 0 | never |
| 1 | always |
| 2 / 3 | `%predN` / `~%predN` |
| 4 | `%LOOP_END` |
| 5 | `%NOT_LOOP_END` |
| 6 | `%predN \|\| %LOOP_END` |
| 7 | `~%predN && %NOT_LOOP_END` |
| 8 | `%MLOCK`, optionally `\|\| %dt_al…` (psrc bits 0–3) |
| 9 | `%MLOCK \|\| ` a compare or CLP result: `psrc` = (compare index 0–3 for ALC 0, 1, 3, 4) << 1 \| negation; or 8 \| (0 for `%cmp0 \|\| %cmp1`, 1 for `%cmp3 \|\| %cmp4`) << 2 \| first negated << 1 \| second negated; or 16 \| N << 1 \| negation for `%clpN` (gas `parse_pl_ctcond`). v3+ |
| 11 | Same as 9 without `%MLOCK` (v7 only) |
| 14 | `~%predN \|\| %LOOP_END` |
| 15 | `%predN && %NOT_LOOP_END` |
| 10, 12, 13 | Reserved (and 11 before v7) |

gas accepts conditions involving `%MLOCK` only on `ibranch` (and `rbranch`) and, from v6, `ibranchd`. In types 8, 9
and 11, `%dt_alN`, `%cmpN` and `%clpN` refer to operations in the same
bundle: a speculative operation in ALC N (true when it has a diagnostic
operand; [speculation.md](speculation.md)), a compare in ALC N, and the
CLP that produces `@p(4 + N)`. gas accepts type 9 only from v3
(`rbranch L ? %cmpN` too) and only when an integer compare with its
channel written (`cmpedb,1 …`) is in each ALC named; FP compares and
`cctop*` don't count (`check_for_cmp`, `tc-e2k.c:9935-9941`, MCST bug
148965). On the 4C, 8C2 and 2C3 type 9 does what it says
([predicates.md](predicates.md), "Control transfers"; `ctlleft.c`).

## CS0: control syllable 0 [decoded, except `puttsd`, which gas does not accept]

Bits 30–31 are `ctpr` and bits 28–29 are `ctp_opc`. Together they select the
operation:

| ctpr \ ctp_opc | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| 0 | `ibranch` | `pref` | `puttsd` | `done` (also `iret`/`hret`/`glaunch`, chosen by `param` bits 0–2 = 2/3/4) |
| 1 | `disp` | — | `sdisp` | `gettsd` |
| 2 | `disp` | `ldisp` | `sdisp` | `gettsd` |
| 3 | `disp` | — | `sdisp` | `return` (`gettsd` if `param` bits 0–2 = 1) |

- **`disp`, `ldisp`, `ibranch`, `puttsd`:** bits 0–27 hold a signed
  displacement in 8-byte units, relative to the start of the instruction.
- **`sdisp`:** bits 0–4.
- **`pref`:** `%iprN` in bits 0–2, `ipd` in bit 3, displacement in bits 4–27.
- **`ibranch`, `done`, `iret`, `hret`, `glaunch`** need an SS with `ctop` = 0;
  the condition comes from `SS.ctcond`.

## CS1: control syllable 1 [decoded, except `vfbg`, which gas does not accept]

Bits 28–31 are the opcode:

| opc | Operation | Fields |
|---|---|---|
| 0 | `setwd` (+ `setbn`/`setbp`) | `setwd` takes `wsz` (bits 5–11), `nfx` (bit 4) and `dbl` (bit 3, v3+) from **LTS0** |
| 1 | `vfrpsz` + `setwd` (+ `setbn`/`setbp`) | `rpsz` in LTS0 bits 12–16 |
| 2 | `setei` / `setsft` | `setei`: value in bits 0–7. Bit 27 set means `setsft` |
| 3 | `wait` | `all_c` bit 0, `all_e` 1, `st_c` 2, `ld_c` 3, `fl_c` 4, `ma_c` 5, `trap` 6 (v2+), `sas` 7, `sal` 8 (v5+), `las` 9, `lal` 10, `mt` 11, `int` 12, `mem_mod` 13 (v6+), `macp` 14, `fl_c_mode` 15 (v7) |
| 4 | `setbn` / `setbp` | Applies to opcodes 0, 1 and 4: `setbn` (bit 26) uses `rbs` bits 0–5, `rsz` bits 6–11, `rcur` bits 12–17; `setbp` (bit 27) uses `psz` bits 18–22 |
| 5 | `call` | `wbs` in bits 0–6, target from `SS.ctop`. With `ctop` = 0, bits 7–9 = 1/2 select `icall`/`hcall`, and CS0 holds the displacement |
| 6 | MAS | 7-bit memory access specifiers for ALC0 (bits 21–27), ALC2 (14–20), ALC3 (7–13) and ALC5 (0–6) |
| 7 | `flushr` / `flushc` / `fillr` / `fillc` | Bits 0–3; `fill*` is v6+ |
| 8 | `vfbg` | `umask` bits 0–7, `dmask` 8–15, `chkm4` 16 |

**`wait` fields** [checked: gas; source: gas `tc-e2k.c`
`parse_wait_args`, kernel `asm/e2k_api.h:5072-5080`]. gas accepts each
field only from the version shown ("Invalid `las=' WAIT parameter for
elbrus-v5"). It sets `st_c` along with `sas` or `las`, and `ld_c` along
with `sal` or `lal`, unless they are written, and rejects `st_c = 0,
sas = 1` (and `fl_c_mode` without `fl_c = 1`). MCST's kernel encodes
its `wait`s with `.word` (`__E2K_WAIT`), so it can set a modifier
alone. v5 ignores bits 9–11: a `wait` with only them is an empty
1-cycle instruction, and with `ld_c` or `st_c` it costs what those
alone cost [hw: 8C2, `tools/isa-probes/memleft.c` `wait`, raw
encodings]. objdump prints none of bits 9–15 (Known objdump bugs); our
decoder (`tools/isa-decode/e2kdis.py`) prints them, and
`compare_objdump.py` checks each such line by assembling it with gas
(corpus `wait*.s`, v3–v7) [decoded]. What the fields cost and order: timing.md,
"Every v3 operation"; [atomics.md](../abi/atomics.md).

## PLS: predicate logic syllables [decoded, except `%bgrpred`, which gas does not accept as a `pass` source]

PLS0 and PLS1 each contain two ELPs and one CLP. PLS2 contains only a CLP.

- **ELP** (7 bits; at bits 24–30 and 16–22) loads a primary predicate
  `@pK`:

  | ELP value | Source |
  |---|---|
  | `0x00` | `%lcntex` |
  | `0bbbbbb`, nonzero | `%spred`, bits 0–5 naming ALC0–5 (objdump prints only 0–4): the instruction doesn't wait for those channels' operands, and the predicate is true if one wasn't ready |
  | `0x40` | `%bgrpred` |
  | `0x41`–`0x4f` | `%rndpred1`–`%rndpred15` (v3+): pseudo-random, from `%rndpr` |
  | `11nnnnn` | `%predN` |

  What each source does: [predicates.md](predicates.md).

- **CLP/MLP** (bits 0–15) combines two primary predicates:

  | Bits | Field |
  |---|---|
  | 14–15 | opcode: 0 `andp`, 1 `landp`, 3 `movep` (MLP: `%pred` = p0 ? p1 : `%pred`, [predicates.md](predicates.md)) |
  | 13 | neg0 |
  | 10–12 | p0 |
  | 9 | neg1 |
  | 6–8 | p1 |
  | 5 | vdst: also write the result to a register predicate |
  | 0–4 | pdst: the destination `%predN` |

  The result goes to `@p(4 + i)`. A CLP may read the result of another
  CLP of the same instruction, **two levels at most**: gas rejects a
  third ("maximal supported cascading of 2 exceeded for {C/M}LP2",
  `tc-e2k.c`, `verify_pls_insns`, citing MCST's iset description), so
  four conditions in one instruction are a tree, `landp (landp (c1, c2),
  landp (c3, c4))`; lcc never chains three. Run on the 4C and the
  Elbrus-8C2 for all 16 inputs (`preds.c`, `tree_*`).

## CDS: condition syllables [decoded for RLP and MRGC on ALC0–5]

Each CDS holds two 16-bit RLP/MRGC entries. The second entry is printed
first.

| Bits | Field |
|---|---|
| 14–15 | Opcode: 0 RLP for ALC0–2, 1 RLP for ALC3–5, 2 MRGC for ALC0–2, 3 MRGC for ALC3–5 |
| 10–13 | Mask: which of the three channels the entry applies to. Bit 3 is AM2/AM5 (the AAU increment of `staa`) in an RLP, and in MRGC entry 0 the `srp`/`crp`/`slrp` condition |
| 7–9 | Per-channel negation; bit 9 (ALC2/5) also negates the AM2/AM5 and recovery-point conditions |
| 0–6 | Predicate: `10nnnnn` `%pcntN`, `11nnnnn` `%predN`; the guide and MCST's qemu read `0xxxxxx` as `%lcntex`, which gas cannot write |

gas shares one entry among the channels of a cluster that use the same
predicate, each with its own negation; how many entries a wide
instruction needs, and what the conditions do: [predicates.md](predicates.md).

## AAS: array access syllables [decoded]

Present only with an SS of type 0, selected by `SS.aa0`–`aa3`.

- **AAS0 and AAS1** each hold two 8-bit destinations. The order is swapped:
  movement j=0 is in the upper byte.
- **AAS2–AAS5** each describe one movement:

  | Bits | Field |
  |---|---|
  | 15 | `be` |
  | 12–14 | opc: 1 `movab`, 2 `movah`, 3 `movaw`, 4 `movad`, 5 `movaq`, 7 `movaqp` |
  | 6–10 | `area` |
  | 1–5 | `ind` |
  | 0 | `am` |

Which halves an instruction has [checked: gas]: AAS0 when `mova`
channel 0 or 1 is used, AAS1 when 2 or 3 is, then AAS2+N for each
`mova` channel N used (`movaq` takes N and N + 1), in that order;
`SS.aa0`–`aa3` mark the channels. A `mova` in channel 2 alone brings
AAS1 and AAS4, two halves: with one ALS and a 16-bit literal that is 6
words, not 8 ("Counting the size").

## APB instructions [hw]

An array prefetch program is a sequence of 16-byte APB instructions, not
wide instructions: a left half (APS0, APLS0) and a right half (APS1,
APLS1), each a 32-bit field word and a 32-bit `disp`. objdump prints the
halves as `apb` (API_L, API_R) and recognises them only when the bytes
don't parse as a wide instruction (`print_apb_instr`). Field layout,
semantics and generations: [apb.md](apb.md). Programs written by gas
from `fapb` lines ran as described there on the 4C.

## Bundling restrictions [source: gas]

gas rejects these combinations within one wide instruction:

- a store in ALC2 together with a load in ALC3;
- a store in ALC5 together with a load in ALC0. "Store" includes the
  AAU stores (`staa*`) and the AAU register writes (`aaurw*`, which are
  `staa` with MAS `0x3f`), "load" a prefetch (`ldb,sm … mas=0x20`), so a
  scheduler must reserve these as stores and loads [checked, v3, v5,
  v6; found by the proof-of-concept back end, I46];
- `disp` and `ldisp` together (both need CS0);
- two operations in the same channel;
- a load or store with a MAS together with `setwd`, `setbn`, `setbp`,
  `wait` or a `call` ("cannot encode MAS: CS1 syllable is busy with
  set-instructions", for each of them): the MAS goes in CS1, which those
  also use [checked, v3, v5, v6]. An `aaurw*` or `aaurr*` is such an
  access (its MAS 0x3f always goes in CS1, "Counting the size"): beside
  `setwd`, `setbn`, both, `wait` or a `call` an `aaurw` gets the same
  error, while beside a lock load, a MAS store or an `aaurrd` in
  another channel it assembles [checked:
  `tools/abi/probes/foldp132_cs1.sh`, v3, v5, v6; found by the
  proof-of-concept back end, P132]. CS1 has a MAS field for each of ALC0,
  2, 3 and 5 (opc 6, above), so MAS accesses don't exclude each other:
  two lock loads (`ldd,0,sm … mas=0x4` and `ldd,3,sm … mas=0x4`), or two
  locks and two checks (`ldd,0,sm … mas=0x4`, `ldd,2 … mas=0x3`,
  `ldd,3,sm … mas=0x4`, `ldd,5 … mas=0x3`) with one `rbranch`, as lcc's
  NPB IS `full_verify` loop has them, assemble in one wide instruction,
  and each acts on its own entry ([hw] `tools/isa-probes/damwb.c`
  `four_*`, 4C, 8C2 and 2C3; speculation.md);
- `ibranch` or `rbranch` together with a prepare (`disp`, `ldisp`,
  `sdisp`, `return`, `pref`: "CS0 in the current wide instruction is
  already busy", since `ibranch` keeps its displacement in CS0, above)
  or a `ct` ("SS.ctop in the current wide instruction is already busy")
  [checked, v3, v5, v6]. So the instruction of a DAM check with its
  `rbranch` holds neither a prepare nor a loop's `ct`.

The same rules as data for a scheduler's pipeline description are in
[reservations.yaml](reservations.yaml), written by
`tools/isa-extract/gen_reservations.py`: per operation and ISA version
the channels, channel pairs, ALES use, literal sizes and load, store and
MAS class; which syllable or field each control operation takes (CS0,
SS, the CS1 groups, PLS, CDS, AAS, LTS); these restrictions with their
sources; and the ALC5 divider's measured issue distances.
`tools/isa-extract/check_reservations.py` checks every wide instruction
of compiled code against it, and its `--selftest` that each rule it
checks catches an instruction composed to break it. No violation in 7.6
million wide instructions: lcc 1.29.16's v3, v5 and v6 system
libraries, its `libc.so.6` for v3.4c, v4 (1c+, 8c), v6.16c and the v3
protected mode, its CoreMark builds, Unipro's CoreMark and the decoder
corpus (v3–v7) [decoded].

### Two writes of one register [hw]

Two operations of one wide instruction may write the same register when
predicates enable at most one of them, as lcc does in if-converted code
(`addd,3 … %dr0 ? ~%pred0` with `addd,4 … %dr0 ? %pred0`); the enabled
one's value lands, for two ALU operations in one cluster or across
clusters and for a load against an ALU operation. With both enabled the
higher channel's result is left: ALC1 over ALC0 in either source order,
ALC3 over ALC0, an ALC1 `addd` over an ALC0 `ldd` although the load
completes later (`tools/isa-probes/pocchk.c`; 4C, 8C2 and 2C3 alike),
and a load in the higher channel wins as well: an ALC2 `ldd` over an
ALC0 `addd`, an ALC5 `ldd` over an ALC3 `addd`, the ALC2 one of two
loads (ALC0 and 2) and the ALC3 one (ALC2 and 3), while an ALC3 `addd`
beats an ALC2 `ldd` (`preds.c` `ww_*`, all three). gas accepts all of
these without a warning. lcc relies on the rule: 1,010 instructions in
its v3 libraries put an unpredicated default in a lower channel and a
predicated override in a higher one (`addd,0,sm 0x0, %dr0, %dr3;
addd,1 %dr0, 0x1, %dr3 ? %pred1`), and 165 hold two unpredicated
writes (`getsp,0` and `ldd,2` into one register) ([predicates.md](predicates.md)).

A 32-bit write under `dbl = 0` in the higher channel replaces only the
low half: with `addd,0 0x0, %dr0, %dr1` and `adds,1 0x1, 0x0, %r1` in
one instruction (or `addd,1` with `adds,3`, across clusters) `%dr1`
holds `%dr0`'s upper half and 1; with the channels swapped, `%dr0`;
under `dbl = 1` the 32-bit result, zero-extended, wins whole. lcc uses
the first form to zero-extend an asm input
([source-compat.md](../abi/source-compat.md), "Other constraints") [hw:
`tools/abi/probes/folda52_tie.c` `ww_*`; 4C, 8C2; not run on the 2C3].

### Memory accesses in one wide instruction [hw]

Memory accesses to one address in one wide instruction are **not**
simultaneous: on the 4C (`tools/isa-probes/samewi.c`, 1,000 runs each,
also found by the proof-of-concept backend, findings
I9 and I12) they take effect in the order ALC2 before ALC5, and a load
before a store in the same cluster:

| Load + store of one doubleword | The load returns |
|---|---|
| load ALC0, store ALC2 | the old value |
| load ALC3, store ALC5 | the old value |
| load ALC2, store ALC5 | the old value |
| load ALC5, store ALC2 | **the new value** (also when the store writes only part of it, `stw` into the upper half) |
| load ALC3, store ALC2; load ALC0, store ALC5 | gas rejects these |

Two stores to one address: the **ALC5 store wins**, whichever value
it writes. So a compiler may put a load and a store that may alias in
one instruction only when the load is meant to see the old value and
is not in ALC5 with the store in ALC2 (gas chooses channels for
operations written without `,N`, so in practice: keep them apart), may
never put a load that must see a store in the same instruction as the
store, and should not put two stores that may alias in one instruction
unless it places them in channels. Other cores may see two stores of
one instruction in either order (atomics.md). A failed check load in
ALC5 also sees an ALC2 store of its own instruction (I12). A DAM lock
load (`ld*,sm … mas=0x4` in ALC0 or ALC3) and a store in its cluster
(ALC2 or ALC5; gas rejects the other pairings as for any load) keep
this order too: the lock reads the old value, and a store that writes a
locked byte removes the entry the lock has just made, so the check
reloads [hw: `tools/isa-probes/memorycxx_dam.c`; 4C, 8C2, 2C3;
speculation.md, "What keeps or loses an entry"]. That needs no bundling
restriction.

Channel lists in `binutils-ops.yaml` don't depend on the operands, but
one rule does: `movtd` and `getpl` **into `%ctpr1–3` go only in ALC0**
(gas: "may be encoded in the 0-th channel only", citing every
`iset-vX.single`; checked for v3 and v6), while into an ordinary
register they take ALC0, 1, 3 or 4.

## Assembler syntax notes [decoded]

- **Store operand order.** By default gas reads stores as *data, address,
  offset*. The directive `.ignore ld_st_style` switches to *address, offset,
  data*, which is the order objdump prints and the order Unipro's clang emits
  (it puts the directive at the top of every file).
- **`%empty`** is gas's name for the `%empty.hi` destination (`0xdf`). Unipro's
  clang writes `%empty.hi`, which gas rejects.

What a compiler can rely on (MCST gas 2.41-29, checked by assembling and
disassembling; literals, register widths, channels and braces, and
operands also by the proof-of-concept back end, its finding I3):

- **Literals.** A bare constant, symbol or relocation operator is
  accepted as src2 without the `[ _f64,_lts0 ... ]` decoration
  (`0x12345678`, `-1`, `sym`, `sym+8`, `sym@GOT`, `sym@GOTOFF`,
  `x@TLS_LE`, `x@TLS_IE`, `x@TLS_GDMOD`, `x@TLS_GDREL`); gas picks the
  literal syllables and the smallest form (`-1` becomes `_f16s 0xffff`,
  a symbol `_f64`).
- **Register widths.** The width prefix is ignored for operands whose
  width the operation fixes: `addd %r0, %r1, %r2` assembles as `addd %dr0,
  %dr1, %dr2`.
- **Channels and braces.** Without braces each operation is its own wide
  instruction; inside braces gas still assigns channels to operations
  written without `,N`. `nop N` inside braces sets the header's `nop`.
- **Groups that act within one instruction** come out split without
  braces. gas rejects two of the splits: a predicate-logic chain
  ("undefined @p0 used as an incoming parameter for CLP0") and an
  `rbranch ? %dt_alN` away from its speculative operation. It assembles
  the rest without a message: a loop end's `alc`, `abn` or `abp` away
  from its `ct` (a split `alc` counts down before the `ct` reads
  `%LOOP_END`, so N iterations become N − 1 from N = 2 on); a DAM check
  or a wait-unlock store away from its `rbranch` (`%MLOCK` holds only in
  their instruction: [speculation.md](speculation.md),
  [atomics.md](../abi/atomics.md)); and `rrd %ip` away from the
  PC-relative literal added to it (16 bytes off) [checked: gas; hw:
  `tools/isa-probes/foldp117_split.c`, 4C, 8C2; not run on the 2C3;
  found by the proof-of-concept back end, P117].
- **Operands.** `merged a, b, dst, ~%predN` takes a negated predicate;
  `getsp %rN, %drM` and `getsp 0, %drM` (read the stack pointer) work; a
  constant address works as `ldd 0x0, sym, %dr4` / `std 0x0, sym, %dr4`.
- **Labels and `.loc` inside braces.** A label written between the
  operations of a wide instruction gets the instruction's start address,
  and so does a `.loc` with a `view` operand; without `view`, gas places
  `.loc` rows late ([stack-and-unwinding.md](../abi/stack-and-unwinding.md),
  "Debug information"). `.label NAME` before an operation instead gives
  NAME the address of the syllable that encodes the operation: in `{
  setwd; disp; addd,1; addd,3 }` the `addd,1` label is at +4 (ALS1), the
  `addd,3` label at +8 (ALS3) and the `disp` label at +0xc (CS0). lcc's
  `-gline` uses this. [checked: `tools/abi/probes/debuginfo_loc.sh`;
  `tc-e2k.c:382-394`, `:9240-9300`]
- **What lcc emits** (1.29.16): `.ignore ld_st_style` and `.ignore
  strict_delay` at the top of every file; `.type sym, #function` /
  `#object` (SPARC style); `.align` in bytes; 64-bit data as `.uadword`
  (constants) or `.dword` (relocated values such as pointers), 32-bit as
  `.uaword`; strings as `.ascii`. gas also accepts `.quad` and `.8byte`.
  lcc emits no `.machine` or other target directive: the target reaches
  gas only on its command line (`e2k-linux-as -mcpu=elbrus-v3 -mptr64`),
  which also sets the ELF `e_flags` ([elf.md](../abi/elf.md)).
  Every object gets a weak absolute marker symbol naming the compiler
  (`elbrus_optimizing_compiler_v1.29.16_Jan_22_2026 = 0x0`); nothing
  depends on it.

## Known gas bugs [checked: gas 2.41-29.018, ours and lcc's; 2.41-29.023 native on the 4C and the 8C2]

- **Two AAU stores with literal offsets in one wide instruction** (`{
  staad %b[39], %aad2[ %aasti1 + 0x8 ]; staad %b[45], %aad2[ %aasti3 +
  0x18 ] }`, as in lcc's kernels) fail with "literals cannot be packed
  into a wide command", with or without explicit channels (2, 5), for v3
  and v5. Written with each literal's slot, as lcc does (`_f32s,_lts1
  0x8` and `_f32s,_lts0 0x18`, either way round), they assemble; one AAU
  store with a literal next to a `std` with a 32-bit literal assembles
  without (found by the proof-of-concept backend, I42).

- **Internal error on a label after a short label difference.** A label
  defined in `.text` after a `.rodata` `.short` or `.byte` holding the
  difference of two `.text` labels makes gas abort ("Internal error in
  check_current_insn_or_label_alignment at tc-e2k.c:9164"), even after
  an `.align 8` and a following function's label; a 4-byte `.long`
  difference, or no later label, is fine. GCC emits such tables for
  narrowed computed-goto offset tables and with `-g` its end-of-text
  label follows them (gcc.c-torture/compile/labels-3.c; found by the
  proof-of-concept backend, I8); a port should keep case-vector and
  label-difference tables at 4 bytes (`CASE_VECTOR_SHORTEN_MODE`).
  lcc never emits such tables.

## Known objdump bugs

- `staa*`/`ldaa*` without a memory specifier are printed as `aaurw*`/`aaurr*`
  with `%unknown_aau_reg`, and the `incr` that may accompany a `staa` is
  dropped. So objdump can never show `staa` or `incr` correctly, and their
  encodings are marked [source] here. `print_alf` accepts the AAU register forms when
  ALES is `0x01c0` *or* MAS is `0x3f`; it should require MAS `0x3f`.
- `wait` prints none of bits 9–15 (`las`, `lal`, `mt`, `int`,
  `mem_mod`, `macp`, `fl_c_mode`), and prints `sas`/`sal` only when
  `st_c`/`ld_c` are set (`opcodes/e2k-dis.c:2152-2190`): a raw `wait`
  with `sas` alone shows no `sas`.
