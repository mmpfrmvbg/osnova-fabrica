# lcc-compatible builtins

What lcc offers C and C++ programs beyond GNU C for using E2K
operations directly: the `__builtin_e2k_*` builtins, the MAS, barrier,
CPU-detection and system-register builtins, and the helpers of
`<e2kintrin.h>`. This is the interface a GCC port provides to build code
written for lcc unchanged (owner's decision, 2026-10-06: these builtins,
but no x86 or NEON intrinsics; see the end). It describes **lcc
1.31.05**, the newest lcc; 1.29.16's differences are noted.

## Sources and checks

| What | Source | Data |
|---|---|---|
| Names and signatures | lcc's manual, `doc/lcc/builtin_mcst.html` (**lcc-doc**) | [lcc-builtins.yaml](lcc-builtins.yaml), `tools/isa-extract/extract_lcc_builtins.py`; descriptions are not copied |
| Every name lcc knows, and what `<e2kintrin.h>` adds | lcc as a black box (**lcc**): `tools/abi/probes/find_builtins.py` calls each of 59,796 candidate names (every operation mnemonic and alias of binutils, alone and with the suffixes lcc and binutils use; every E2K-looking `__builtin_` name in lcc 1.29's and 1.31's manuals and changelogs; every `__builtin_e2k_` name in lcc's and Unipro's headers; the non-operation names with their first word changed) on every target, in 64-bit, 32-bit and protected mode, with and without `<e2kintrin.h>`; the header's macro, type, enumerator and function names and its constants' values come from lcc's preprocessor and compiler (`-dM -E`) | [lcc-builtins-names.yaml](lcc-builtins-names.yaml) |
| What each operation builtin compiles to | lcc: `tools/abi/probes/gen_builtins.py` compiles each with the lcc build of its ISA version (v7: the v6.2c3 lcc with `-march=elbrus-v7`) at `-O2` and traces the result symbolically: arguments `a0, a1, …` in C order, the result `ret` | [lcc-builtins-check.yaml](lcc-builtins-check.yaml) |
| The other builtins and the header's helpers | lcc: `tools/abi/probes/gen_builtins_misc.py`, one function per case, 516 cases | [lcc-builtins-misc.yaml](lcc-builtins-misc.yaml) |
| Behaviour | hardware: `tools/abi/builtins/` (below) runs every register-only operation builtin on fixed inputs and checks reference models of everything else; on the 4C (v3), the 8C2 (v5) and the 2C3 (v6) all 13,551 / 18,051 / 18,051 checks pass with lcc 1.31.05 | this page |

**lcc's headers are not a source.** `e2kintrin.h`, `e2kbuiltin.h` and
the x86 and ARM intrinsic headers lcc ships say "Copyright ZAO MCST. All
rights reserved". Nothing is copied from them: only names, parameter
counts and constant values, which lcc's preprocessor reports, are taken,
and every behaviour on this page was measured by compiling and running
code. A GCC port writes its own headers under the same names.

## What exists

lcc 1.31.05 knows 497 E2K builtin names (the same in 64-bit and 32-bit
mode) and 20 more in protected mode. All are in its manual except one,
`__builtin_e2k_get_cpu_iset`, which the manual misspells; no other
candidate is known to lcc (besides GCC's own builtins). `<e2kintrin.h>`
defines the same names in all three modes.

| Kind | Count | Where | Notes |
|---|---|---|---|
| Operation builtins `__builtin_e2k_<op>` | 448 (v1 146, v2 10, v3 34, v4 3, v5 162, v6 54, v7 39) | 411 built into the compiler, 37 macros or inline functions of `<e2kintrin.h>` | one operation each, with exceptions below |
| Memory access with a MAS | 11 | compiler | `__builtin_loadmas_{8u,16u,32u,64u,128v}`, `__builtin_storemas_*`, `__builtin_pstoremas_128v` |
| Barriers | 4 | compiler | `__builtin_e2k_{read,write,mem}_barrier`, `__builtin_e2k_barrier`, each with a `wait` mask; new in 1.31 |
| CPU detection | 5 | compiler | `__builtin_cpu_init`, `_is`, `_name`, `_arch`, `__builtin_e2k_get_cpu_iset` |
| System registers | 9 | compiler | `__builtin_e2k_get_cpu_mode`, `_set_cpu_mode`, `_rrq`, the `%rwap`/`%rwsap` fields |
| Protected mode | 20 | compiler, `-mptr128` only | descriptors and tags |
| Short forms `_e2k_<op>` | 444 | `<e2kintrin.h>` | the same as `__builtin_e2k_<op>` |
| Helper macros, types, constants | 46 | `<e2kintrin.h>` | data alignment, transposes, byte counts, `%pfpfr` access, cache sizes |

Not E2K: 7 SPARC E90 builtins in the manual (`__builtin_loadasi_*`
etc.), unknown to the E2K compilers.

**Changes from 1.29.16**: 24 new v1 operation builtins (`fstoid`,
`fmaxs`, `fmins`, `fcmp{eq,lt,le,uod,neq,nlt,nle,od}s`, `frcps`,
`fsqrts`, `frsqrts`, `fmaxd`, `fmind`, `fsqrtid`, `fsqrttd`, …; lcc 1.29
treats them as unknown functions); the barriers `__builtin_read_barrier
()`, `__builtin_write_barrier ()`, `__builtin_mem_barrier ()`,
`__builtin_barrier ()` were replaced by the `__builtin_e2k_*_barrier
(mask)` ones (1.31 no longer knows the old names); 6 new
protected-mode builtins. Everything else is the same.

**Errors in the manual** (lcc rejects calls written as documented):

| Builtin | Manual | lcc 1.29.16 and 1.31.05 |
|---|---|---|
| `__builtin_e2k_cpu_iset ()` | returns the ISA version | **misspelt**: the builtin is `__builtin_e2k_get_cpu_iset ()` (the name lcc 1.29's changelog gives), a load of `__cpu_info`'s ISA word; `__builtin_e2k_cpu_iset` is an unknown function to lcc |
| `qpacksshb`, `qpacksswh`, `qpackushb`, `qpackuswh` | `(v2di, uint64)` | `(v2di, v2di)` |
| `qpfstofd`, `qpfstoid`, `qpfstoidtr` | `(v2di)` | `(uint64)`: two floats in 64 bits |
| `qpidtofs` | returns `v2di` | returns `uint64` |
| `prefetch` | returns `uint64` | returns nothing |
| `qpsrad` | under v5 (and again under v6) | v6 only (the operation is v6) |

## Types and availability

- Operands and results are integers whatever the data: `unsigned int`
  (the manual's `uint32`) for 32-bit formats, `unsigned long long`
  (`uint64`) for 64-bit ones, `long long __attribute__ ((vector_size
  (16)))` (`v2di`) for 128-bit ones; `long double` for `fxscalesx`;
  `unsigned __int128` (`uint128`) for `__builtin_e2k_rrq`; `enum
  __e2k_hint` for `prefetch`. `<e2kintrin.h>` also defines x86-style
  vector typedefs: `__v2di`, `__v2du`, `__v2df`, `__v4si`, `__v4su`,
  `__v4sf`, `__v8hi`, `__v8hu`, `__v16qi`, `__v16qs`, `__v16qu` (16
  bytes), `__v1di`, `__v2si`, `__v2sf`, `__v4hi`, `__v8qi` (8 bytes),
  `__di`.
- **The compiler builtins need no header.** lcc knows the 411 operation
  builtins and the others on every target, in C and C++; `<e2kintrin.h>`
  only adds the 37 header ones, the short forms and the helpers.
- **ISA gating**: a builtin of a later ISA version than the target is
  rejected at the call ("built-in function … is not supported for
  current cpu mode"), though its name is known; code tests
  `__iset__ >= N`. The 128-bit header helpers exist only for
  `__iset__ >= 5`, the v6/v7 short forms from their version.
- lcc folds calls with constant arguments (`_e2k_paddb (1, 2)` emits no
  `paddb`); a port may too, as long as the result is the hardware's.

## Operation builtins [lcc, hw]

**The rule: `__builtin_e2k_<op> (a0, …, an)` is the operation `<op>`
with the arguments in C order as its source operands and the result
as its destination**, `<op> a0, …, an, ret` in gas syntax; what it
computes is the operation's ([operations-v3.md](../isa/operations-v3.md)
and the later pages, [semantics.md](../isa/semantics.md)), including its
differences between generations: on the 4C and the 8C2 only `pshufb`
(mask bits 4–6), `getfs`/`getfd` (the sign bit's source) and `pextrh`
with an index above 7 give different results, as the operations do
(semantics.md); the 8C2 and the 2C3 agree on every builtin up to v5.
357 of the 448 follow the rule exactly. The others
(lcc-builtins-check.yaml has each one's code):

| Builtins | What lcc does |
|---|---|
| `psllqh`, `psllql`, `psrlqh`, `psrlql`, `pextrh`, `pinsh`, `pshufw` (last argument), `qpinss_lt3`, `qpinsd_lt3`, `qppermb_lt3` (last argument) | the rule, with that argument a **constant** emitted as the operation's literal |
| `plog`, `qplog`, `qptbl` (first argument), `qplog_lt3` (first and last) | the first argument is the operation's table and becomes the mnemonic's suffix: `__builtin_e2k_plog (0x96, a, b, c)` is `plog_0x96 a, b, c`; the other arguments follow the rule |
| `pcmp{eq,gt}{b,h,w,d}{ap,op}`, `qpcmp{eq,gt}{b,h,w,d}{ap,op}` (v6) | the operation writes a predicate; the builtin returns it as an `int` 0 or 1 (`merged 0, 1, ret, pred`) |
| `punpck{h,l}{bh,hw,wd}` | real operations on every version, but lcc emits `pshufb a0, a1, mask` with the mask that gives the same result (`punpckl*` puts `a1`'s lanes at the even positions, semantics.md) |
| `pshufh (a, imm)` | `pshufb 0, a, mask`: halfword k of the result is halfword `(imm >> 2k) & 3` of `a`, as x86 `pshufw` |
| `qpunpck{h,l}{bh,hw,wd,dq}` (header) | not operations (binutils has none): `qppermb a0, a1, mask`, the 128-bit form of the 64-bit rule (low or high 8 bytes interleaved, `a1`'s lanes at the even positions) |
| `qppackdl (hi, lo)` | no operation: the `v2di` `{lo, hi}` |
| `qpswitchd (x)` | no operation: the halves swapped |
| `fxscalesx (long double, uint32)` | `movif` to make the 80-bit operand, then `fxscalesx` |
| `puttagd`, `puttagqp` (header inline functions) | the operations |
| Memory helpers (header) | below |

**Constant arguments**: lcc requires a constant where the operation
takes a literal or a table (the table above, and `prefetch`'s hint).
It accepts any integer and uses it **modulo 256** (`psllqh (a, b, 1000)`
is `psllqh a, b, 0xe8`; `plog (300, …)` is `plog_0x2c`), `qptbl`'s table
modulo 8; only `prefetch` checks its range (0–3). (constant_args in
lcc-builtins-check.yaml lists what lcc emits for each value tried.)

**Short forms**: lcc 1.30 added them and deprecated the header's
`__builtin_e2k_ld_*`/`st_*` macros in their favour (they are to be
removed; lcc-doc, changelog 1.30), so new code writes `_e2k_ld_64s_be`
and so on. Every operation builtin but four v7 ones
(`qpack{hb,wh}{ss,us}`) also has a header macro `_e2k_<op>`, which
compiles to the same code; `_e2k_ld_128_sm` is broken in 1.31.05 (it
takes one argument and expands to the two-argument builtin, so any use
is an error).

### Memory helpers (header) [lcc, hw]

Verified on the 4C, 8C2 and 2C3 by `models.c`; `be` means byte-swapped
(MAS 0x8, all 4, 8 or 16 bytes reversed), the hints are cache hints
([timing.md](../isa/timing.md), "Memory"):

| Builtin | Is |
|---|---|
| `ld_32u_be (p)`, `ld_64s_be (p)`, `ld_128_be (p)` | a load with MAS 0x8: the value byte-swapped (`ld_128_be`: `ldqp`, all 16 bytes reversed) |
| `ld_{32u,64s,128}_{t1,t2,nta} (p)` | a load with MAS 0x20, 0x40, 0x60 (`_128`: two `ldd`) |
| `ld_64s_sm (p, off)`, `ld_128_sm (p, off)` | a speculative load (`,sm`) from `(char *) p + off` (`_128`: two `ldd,sm` and `qppackdl`) |
| `ld_64s_cleartag (p, off)`, `ld_128_cleartag (p, off)` | the same, then `puttagd`/`puttagqp` 0 |
| `st_32u_be (v, p)`, `st_64s_be (v, p)`, `st_128_be (v, p)` | a store with MAS 0x8 (`stqp` for 128) |
| `st_32u_nt`, `st_64s_nt (v, p)` | a plain store up to v4, MAS 0x60 from v5 |
| `st_128_nt (v, p)` | `stqp` with MAS 0x60 |
| `pst_128 (v, p, mask)`, `pst_128_sm` | `stmqp` (`,sm`): byte j written when mask bit j is set |
| `pst_128_be (v, p, mask)` | `stmqp` with MAS 0x8: the 16 bytes reversed, the mask applied **before** the reversal (bit j guards data byte j, stored at byte 15 − j) |
| `prefetch (p, hint)` | `ldb,sm` to `%empty` with MAS by hint: `E2K_HINT_NTA` (0) 0x60, `E2K_HINT_T2` (1) 0x40, `E2K_HINT_T1` (2) and `E2K_HINT_T0` (3) 0x20 (generic v3–v6 targets and the 12C, 16C and 2C3; code tuned for the 4C, 8C, 1C+, 8C2 or v7 gets no MAS for hint 3: timing.md, "Software prefetch"); the same as GCC's `__builtin_prefetch (p, rw, hint)`, which lcc implements the same way for either `rw`. Measured, 0x20 fills only L2, 0x40 only the 8C2's L3 and 0x60 nothing (timing.md) |
| `clflush (p)` | `wait st_c = 1`, a store of 0 with MAS 0xf (`mod` 7) to `p`, `wait fl_c = 1` (inline asm; libgcc's `__clear_cache` runs the same stores in user mode, timed by `tools/isa-probes/native.c`, x86-support.md) |

### Memory access with a MAS [lcc, hw]

`__builtin_loadmas_N (p, mas, channel)`, `__builtin_storemas_N (v, p,
mas, channel)` (N = `8u`, `16u`, `32u`, `64u`, `128v`; 128 needs v5) and
`__builtin_pstoremas_128v (v, p, mask, mas, channel)`:

- `mas` and `channel` must be constants.
- `mas`: the low bits are the MAS, emitted as given (0x3, 0x4, 0x7 …;
  [speculation.md](../isa/speculation.md) and [atomics.md](atomics.md)
  say what they do), plus flags (source-compat.md has their values):
  `__LCC_MAS_SPEC` makes the access speculative (`,sm`);
  `__LCC_MAS_VOLATILE` changes nothing in the operation (the access is
  treated as volatile); `__LCC_MAS_CLEARTAG` adds `puttag` 0 to a load
  only together with `__LCC_MAS_SPEC` (a non-speculative load gets
  nothing) and is rejected on stores. On v3, lcc drops MAS 0x60 from
  stores (a plain store) up to v4, as in `st_*_nt`.
- `channel`: the ALU channel, or `__LCC_CHAN_ANY` (−1) for lcc's
  choice: loads 0, 2, 3, 5; stores 2, 5; other values are rejected
  ("invalid channel number"). A 128-bit load without a MAS is split
  into two `ldd` and `qppackdl`, and its channel is ignored.

### Barriers [lcc]

`__builtin_e2k_read_barrier (mask)`, `_write_barrier`, `_mem_barrier`,
`__builtin_e2k_barrier (mask)` keep the compiler from moving loads,
stores, both, or anything across them, and emit one `wait` whose fields
are the bits of the constant `mask`: bit 0 `all_c`, 1 `all_e`, 2 `st_c`,
3 `ld_c`, 4 `fl_c`, 5 `ma_c` ([bundle.md](../isa/bundle.md)). Higher bits
are dropped (also for v6, whose `wait` has more fields), and mask 0 emits
a `wait` with every field 0. lcc 1.31.05 for v3 failed with "internal
error: Cannot expand HW_BARRIER oper" on the four in one larger function
(not reproduced in a small one).

### CPU detection [lcc, hw]

See [source-compat.md](source-compat.md), "CPU detection at run time",
for `__cpu_info`. The builtins:

- `__builtin_cpu_is ("name")` takes a string literal (a variable is
  rejected) and compares one word of the hidden `__cpu_info`: `+0` the
  ISA version (`"elbrus-v1"` … `"elbrus-v7"`), `+4` lcc's CPU code (the
  CPU names, `"elbrus"` for the v1 CPU among them: see source-compat.md's
  table; `"elbrus-s"` and `"elbrus-2cm"` are still accepted though 1.31's
  manual no longer lists them); an unknown name is rejected. It returns
  0 or 1.
- `__builtin_e2k_get_cpu_iset ()` (the manual: `__builtin_e2k_cpu_iset`)
  returns `__cpu_info`'s ISA word (0 for an unknown CPU).
- `__builtin_cpu_init ()`, `__builtin_cpu_name ()`, `__builtin_cpu_arch
  ()` call `__cpu_init`, `__cpu_name`, `__cpu_arch` in lcc's `liblcc.a`.
- On our machines: the 4C reports `elbrus-4c`, `elbrus-v3`,
  `__cpu_info` = {3, 4}; the 8C2 `elbrus-8c2`, `elbrus-v5`, {5, 8}; the
  2C3 `elbrus-2c3`, `elbrus-v6`, {6, 11}.

### System registers [lcc]

| Builtin | lcc 1.31.05 |
|---|---|
| `__builtin_e2k_rrq ("psp" / "pcsp" / "usd" / "cud" / "gd")` | two `rrd` of the `.hi` and `.lo` registers, as `unsigned __int128` (high 64 bits from `.hi`); other names rejected |
| `__builtin_e2k_get_cpu_mode ("core_mode.descr_v7")` | for v7: `rrs %core_mode` and bit 7; for earlier targets the same, but 0 unless `__cpu_info`'s ISA version is 7 or more (0 on all our machines); `"core_mode.macp_enbl"`, `"madmr.mode_ld"`, `"madmr.mode_st"` only in v7 protected mode. `rrs %core_mode` (and `rrd`) runs in user mode with or without `,sm` and never traps on the 4C, 8C2 or 2C3 [hw: `tools/isa-probes/sregs.c` `width`]. It reads 0x2 on the 4C and 8C2 and 0x26 on the 2C3: bit 1 is `no_stack_prot`, which the kernel sets on every v3–v6 CPU (`e2k_syswork.c:1844`, "bug 115090"); bit 2 `sep_virt_space` and bit 5 `pt_v6` are set on the 2C3; `descr_v7` (bit 7) is 0 (kernel `e2k_core_mode_t`). The value is ready 4 cycles after the read (timing.md, "Every v3 operation"). A compatible builtin may emit a plain `rrs`; lcc's `,sm` only lets it schedule the read freely (inferred). MCST's qemu stops at any read of `%core_mode` ("exception handling is unimplemented") and the community qemu reads 0, so test this builtin on hardware |
| `__builtin_e2k_set_cpu_mode` | the `core_mode` fields are read-only ("unknown argument"); the `madmr` fields only in v7 protected mode (`mmurr`/`mmurw`) |
| `__builtin_e2k_get_rwap_{base,size,curptr} (uint128)` | field extraction (`getptr`, `getmi`, `getind` and masks), choosing the v7 descriptor format by `%core_mode.descr_v7` at run time |
| `__builtin_e2k_get_rwsap_*` | protected mode up to v6 only |

### Protected mode [lcc]

The 20 descriptor and tag builtins exist only with `-mptr128`; four
(`get_ap_color`, `create_ap_subarray_color`, `apincr_color`,
`size_to_align`) only for v7. lcc-builtins-misc.yaml has their code.
The protected-mode probes ([protected-mode.md](protected-mode.md)) ran
`is_ptr_ap`, `is_ptr_pl`, `is_ptr_nv`, `get_ap_base`, `get_ap_size` and
`get_ap_curptr` on the 4C, 8C2 and 2C3; the others are untested.

### `<e2kintrin.h>` helpers [lcc, hw]

Verified on the 4C, 8C2 and 2C3 by `models.c` on random inputs:

| Helper | Does |
|---|---|
| `E2K_PREPARE_ALIGN (al, spec)`, `E2K_ALIGN_DATA (s1, s2, dst, spec)` | `dst` = bytes `al` … `al + 7` of the 16 bytes `s2:s1` (`s1` the low 8): `(s1 >> 8al) \| (s2 << (64 − 8al))`, `dst = s1` for `al` 0; `al` 0–7. `spec` is a `pshufb` mask (lcc: `al` broadcast to every byte plus `0x0706050403020100`) |
| `E2K_PREPARE_ALIGN_BE`, `E2K_ALIGN_DATA_BE` | big-endian data, `s1` the earlier word: `(s1 << 8al) \| (s2 >> (64 − 8al))` |
| `E2K_PREPARE_ALIGN128 (al, spec)`, `E2K_ALIGN_DATA128 (s1, s2, dst, spec)` (v5+) | `dst` = bytes `al` … `al + 15` of the 32 bytes `s2:s1`; `al` 0–15; `spec` a `qppermb` mask |
| `E2K_PREPARE_ALIGN128_BE`, `E2K_ALIGN_DATA128_BE` (v5+) | byte k of `dst` is byte `k − al` of `s1` for `k ≥ al`, else byte `16 + k − al` of `s2` |
| `E2K_PREPARE_ALIGN_ARITH (ptr, a)`, `_ARITH_BE` | `a` is in and out: a byte offset becomes a bit count, `a = 8a`; `ptr` is not used |
| `E2K_ALIGN_DATA_ARITH (s1, s2, dst, a)`, `_BE` | the same results as `E2K_ALIGN_DATA`/`_BE` by shifts, for `a` = 8 × (0–7) |
| `E2K_PREPARE_ALIGN_ARITH32 (ptr, a)`, `E2K_ALIGN_DATA_ARITH32` | 32-bit words: `a = 8a`; the low 32 bits of `dst` are `(s1 >> a) \| (s2 << (32 − a))` (`s1` for 0); byte offsets 0–3 |
| `E2K_PREPARE_ALIGN_INSF32 (ptr, a)`, `E2K_ALIGN_DATA_INSF32` | the same result through `insfs` and `scrs`, with `a = 512a` |
| `E2K_ALIGN_PTR (p, n)`, `E2K_ALIGN_PTR_BACK (p, n)` | `p` rounded up, down to a multiple of `n` (a power of two) |
| `E2K_BYTES_TO_ALIGN (p, n)`, `E2K_BYTES_FROM_ALIGN (p, n)` | `−p & (n − 1)`, `p & (n − 1)` |
| `__CLZB (n, x)`, `__CTZB (n, x)`, `E2K_CLZB`, `E2K_CTZB` (the same) | `n` = leading, trailing zero **bytes** of the 64-bit `x` (8 for 0): `lzcntd` (and `bitrevd`) then a shift by 3 |
| `E2K_TRANSPOSE2_64F (r0, r1, d0, d1)` (v5+) | `d0 = {r0[0], r1[0]}`, `d1 = {r0[1], r1[1]}` |
| `E2K_TRANSPOSE4_32F (r0, …, r3, d0, …, d3)` (v5+) | the 4 × 4 transpose of 32-bit lanes: lane i of `dj` is lane j of `ri` |
| `__GETPFPFR (w)`, `__SETPFPFR (w)` | `rrs %pfpfr`, `rws %pfpfr` (read 0x1fbf at start on all three machines) |

Constants: `E2K_SIZE_L1` 65,536 on every target; `E2K_SIZE_L2`
2 MiB for v3 and v6, 512 KiB for v4 and v5, 1 MiB for v7;
`E2K_SIZE_L3` 16 MiB; `SIZE_L1`, `SIZE_L2`, `SIZE_L3` the same (`SIZE_L3`
only for v4, v5 and v7 targets); `_TOIF_RC_NEAREST` 0, `_DOWN` 1, `_UP` 2,
`_ZERO` 3, `_CURRENT` 4, `_IGNORE_INEXACT` 8 (the rounding argument of
`fdtoifd`, `fstoifs` and their packed forms, semantics.md); `enum
__e2k_hint` `E2K_HINT_NTA` 0, `E2K_HINT_T2` 1, `E2K_HINT_T1` 2,
`E2K_HINT_T0` 3; `__E2K_INLINE` and the include guard `_E2KINTRIN_H`.

## Testing a compiler's builtins

`tools/abi/builtins/` is the acceptance test for a port's builtins:

- `gen.py` writes `ops.c`, which calls each of the 419 register-only
  operation builtins up to the target's ISA (192 inputs each: integer,
  packed and FP edge values and pseudo-random ones; every accepted value
  of a constant argument from a set of 12) and prints a hash of its
  results.
- `models.c` checks the builtins that are not one operation, the MAS
  builtins and the header helpers against C models of the descriptions
  above, and prints the CPU-detection results.
- `run.py --target v3 --cc gcc='…' --remote claude@ringo.lan` builds both
  with lcc 1.31.05 and the given compiler, runs them on the machine and
  reports each builtin whose hash differs from lcc's and every failed
  model check.

lcc against itself at `-O0` agrees on all 173 builtins of the v3 build
on the 4C.

## GNU builtins [lcc-doc, lcc]

lcc implements GCC 11.3's builtins (`builtin_gnu.html`) with a few
restrictions a GCC port doesn't share: `__builtin_return_address` and
`__builtin_frame_address` take only 0; NaN payloads in `__builtin_nanq`
and `__builtin_nansq` are limited to 64 bits; `__builtin_cpu_supports`
is not supported; no `_FloatN` types or their builtins. One group a GCC
port must add as target builtins, as x86 GCC does: lcc knows the six
`__float128` builtins `__builtin_fabsq`, `__builtin_copysignq`,
`__builtin_infq`, `__builtin_huge_valq`, `__builtin_nanq`,
`__builtin_nansq` (not `ceilq`, `floorq`, `sqrtq`); it calls
`__fabstf2` and `__copysigntf3` for the first two, which MCST's GPL
libgcc has (`config/e2k/tf-signs.c`).

## x86 intrinsics [lcc]

lcc predefines the x86 feature macros on **every** E2K target, without
options: `__MMX__`, `__SSE__` to `__SSE4_2__`, `__SSSE3__`, `__SSE4A__`,
`__AVX__`, `__AVX2__`, `__AVXVNNI__`, `__FMA__`, `__FMA4__`, `__XOP__`,
`__AES__`, `__PCLMUL__`, `__SHA__`, `__BMI__`, `__BMI2__`, `__ABM__`,
`__POPCNT__`, `__LZCNT__`, `__F16C__`, `__TBM__`, `__RDSEED__`,
`__3dNOW__`, `__3dNOW_A__` (lcc 1.29.16 for v3, v5.8c2 and v6.2c3 alike).
So portable programs that pick an SSE or AVX code path by these macros
take it on E2K under lcc, through lcc's `<immintrin.h>` and the
per-extension headers (MMX to AVX2, AVX-VNNI, FMA, FMA4, XOP, SSE4A,
AES, PCLMUL, SHA, BMI, BMI2, POPCNT, LZCNT, F16C, TBM, ADX, RDSEED,
3DNow!); `<arm_neon.h>` exists too, without `__ARM_NEON`. Their
implementation maps each intrinsic to E2K operations; a sample (`-O2`):

| Intrinsic | v3 | v5 and v6 |
|---|---|---|
| `_mm_add_epi8` | 2 × `paddb` | `qpaddb` |
| `_mm_shuffle_epi8` | 2 × (`andd`, `pshufb`) | `qpand`, `qpshufb` |
| `_mm_movemask_epi8` | `pmovmskb` | `qpsgn2mskb` |
| `_mm_madd_epi16` | 2 × `pmaddh` | `qpmaddh` |
| `_mm256_add_ps` | 4 × `pfadds` | 2 × `qpfadds` |
| `_mm_fmadd_ps`, `_mm_fmadd_pd` | `pfmuls` + `pfadds` per half: **two roundings** | v5: `qpfmuls` + `qpfadds`, **two roundings**; v6: `qpfmas`, `qpfmad`, fused as on x86 |

So the FMA intrinsics give results that differ from x86 in the last bit
before v6. lcc's FMA headers call `__builtin_e2k_vf*` names
(`vfmsubpd`, `vfnmaddps256`, …) that lcc does not know as builtins; they
are not part of the E2K interface. Unipro's clang does the same: it
predefines 16 of these macros (`-march=elbrus-v5`) and ships
`e2k_wrappers/` headers. Its x86 headers are LLVM's (Apache-2.0 with the
LLVM exception; two also carry a Unipro "all rights reserved" line) and
call `__builtin_ia32_*` builtins, which its `e2kbuiltin.h` maps onto E2K
operations; that file, its `e2kintrin.h` (424 of lcc's names, plus one
of its own) and `cpuid.h` are MCST's, "all rights reserved", like lcc's. lcc's own
`e2kbuiltin.h` is that layer for lcc: about 1,000 `__builtin_ia32_*`
definitions on E2K builtins and 8 internal helper macros
(`E2K_16F_TO_32F` and the like). It includes `<e2kintrin.h>`, and lcc's
x86 headers reach it through `ia32intrin.h` (`lcc -H`, 1.29.16 and
1.31.05; Unipro's `e2kbuiltin.h` includes its `e2kintrin.h` too) [lcc,
unipro].

The operation builtins need no header, but MCST's own patches include
`<e2kbuiltin.h>` all the same (OS Elbrus 9.5.5's PDK) [source]. In
openssl, nettle, botan and gost-engine it stands only for operation
builtins: 277 calls of 16 (`qppackdl`, `qpmgme`, `qppermb`, `qpxor`,
`addcd_c`, `qpkuzebgn`, `addcd`, `umulhd`, …). kamailio, firefox and
thunderbird use its x86 layer. kamailio's `membar ()` is
`__builtin_ia32_pause ()`, which the header makes an asm `nop`: a
compiler barrier without `wait`, so no hardware fence (without the
header lcc warns #223 and calls an external `__builtin_ia32_pause`)
[lcc]. firefox and thunderbird call `_xgetbv` from it, with
`__cpuidex` from lcc's `<cpuid.h>`, in Skia's and xsimd's x86 CPU
detection. Beyond these, MCST's patches of 21 packages add an
`#include` of an x86 intrinsic header (openssl's `sha512.c` takes
`__rolq` and `__rorq` from `<x86intrin.h>` under `__e2k__`, its v7 AES
code `_mm_*` from `<wmmintrin.h>`), and those of 20 add `__e2k__` to a
test for x86 (40 packages in all) [source].

## For a GCC port

- **Operation builtins**: one GCC builtin per operation, expanded to the
  instruction pattern with the arguments in order (357 need nothing
  more), from lcc-builtins.yaml with lcc's corrected signatures
  (lcc-builtins-check.yaml) and the operand formats of
  [binutils-ops.yaml](../isa/binutils-ops.yaml); checked against
  `__iset__`; constant arguments taken modulo 256 (tables as the
  mnemonic suffix); the predicate-result v6 compares returning 0 or 1.
  The 37 header ones, the short forms and the helpers go in the port's
  own `<e2kintrin.h>`, written from this page.
- **The MAS, barrier, CPU and system-register builtins** as above;
  `__builtin_cpu_*` need a runtime with lcc's `__cpu_info` layout
  (source-compat.md). Protected-mode builtins can wait for protected mode.
- **No x86 or NEON intrinsics and no x86 feature macros** (owner's
  decision, 2026-10-06): the compatible E2K builtins are enough. With the
  GCC port, programs with x86 SIMD paths take their generic ones, which
  is correct, only slower. Predefining `__SSE2__` on a non-x86 target
  also misleads code that reads it as "this is x86" (x86 inline asm,
  `cpuid`). If an emulation layer is ever wanted, upstream GCC's model is
  PowerPC's opt-in x86 intrinsic headers (`gcc/config/rs6000/xmmintrin.h`
  and others: `#error` unless built with `-DNO_WARN_X86_INTRINSICS`, no
  `__SSE__` macros), written from the x86 semantics and the E2K operation
  pages, not from `e2kbuiltin.h`.
- **No `<e2kbuiltin.h>`.** Code that includes it only for the operation
  builtins builds once the include is dropped or limited to `__LCC__`;
  code that uses its x86 layer, or takes an x86 path under `__e2k__`,
  needs that branch limited to `__LCC__`, as for any compiler without
  x86 intrinsics. Both are changes to the packages (owner, 2026-11-02:
  GCC gets no lcc compatibility for the sake of packages).
- `tools/abi/builtins/run.py` is the acceptance test.
