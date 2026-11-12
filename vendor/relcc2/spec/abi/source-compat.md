# Source-level conventions: macros, inline assembly, options

What a compiler must provide, beyond the binary interface, so that code
and headers written for lcc build unchanged: predefined macros,
inline-assembly constraints and register names, the lcc options and
behaviours that change generated code, and lcc's pragmas. It also
records where lcc's C and C++ differ from GCC's: code written for lcc
may rely on those differences, and is then fixed in the package, not
in the compiler. Probes:
`tools/abi/probes/asmops.c`, `tools/abi/probes/execstack.sh` (nested
functions, Fortran internal procedures),
`tools/abi/probes/glibcbuild_lcc.py` (what building glibc's E2K code
asks: register-variable names, pointer-size options, C cleanups,
pragmas); macros from `lcc -dM -E -xc /dev/null`.

## Predefined macros (lcc, unipro, lcc-doc)

| Macro | lcc | Unipro | Used by | For a new compiler |
|---|---|---|---|---|
| `__e2k__` | 1 | 1 | glibc (177 files), Linux, gdb | define |
| `__iset__` | ISA version: 3..7 | same | glibc (142 files: ISA-specific code) | define, from `-march` |
| x86 feature macros: `__MMX__`, `__SSE__` … `__SSE4_2__`, `__SSSE3__`, `__AVX__`, `__AVX2__`, `__FMA__`, `__AES__`, `__SHA__`, `__BMI2__`, `__POPCNT__` and more (lcc-builtins.md) | 1 on every target, no option needed | ? | programs choosing an x86 SIMD path; lcc's `<immintrin.h>` emulates the intrinsics | don't define (owner's decision: no x86 intrinsics in the GCC port; lcc-builtins.md) |
| `__elbrus_4c__`, `__elbrus_8c__`, `__elbrus_1cplus__`, `__elbrus_8c2__`, `__elbrus_12c__`, `__elbrus_16c__`, `__elbrus_2c3__`, `__elbrus_48c__`, `__elbrus_8v7__` | with `-mtune=<cpu>` (or a CPU-specific lcc such as `e2k-v3.4c`) | no | glibc (14 files) | define with `-mtune` |
| `__ptr64__` (`__ptr32__`, `__ptr128__` in the other modes; `__PROTECTED__` is a deprecated alias of `__ptr128__`: [protected-mode.md](protected-mode.md)) | 1 | `__ptr64__` | glibc (`__ptr128__`: 137 files), Linux | define |
| `_LP64`, `__LP64__` | 1 | 1 | everything | define |
| `__LCC__` (version: 129, 131), `__LCC_MINOR__`, `__MCST__` | yes | no | glibc's installed headers: see below | **do not define** |
| `_REENTRANT` 1 with `-pthread` (the only macro `-pthread` adds) | yes | ? | configure scripts: autoconf's `AX_PTHREAD` rejects `-pthread` without it (xz) | define with `-pthread` (`CPP_SPEC "%{pthread:-D_REENTRANT}"`, as GCC's aarch64 and riscv Linux targets) |
| `__LCC_MAS_NO` 0, `__LCC_MAS_SPEC` `0x10000000`, `__LCC_MAS_VOLATILE` `0x20000000`, `__LCC_MAS_CLEARTAG` `0x40000000`, `__LCC_CHAN_ANY` −1 | yes | yes | arguments of the `__builtin_loadmas_*`/`storemas_*` builtins; glibc (2 files) | define if those builtins are supported |
| `__SIZEOF_LONG_DOUBLE__` 16, `__SIZEOF_FLOAT80__` 16, `__SIZEOF_FLOAT128__` 16, `__LDBL_MANT_DIG__` 64 | yes | `__SIZEOF_LONG_DOUBLE__`, `__FLOAT128__` | glibc (`bits/floatn.h`) | define (GCC does from the modes) |
| `__LONG_DOUBLE__` 80 | yes (1.31.05 expands it to the undefined name `TARGET_LONG_DOUBLE_BITSIZE`, a bug) | no | nothing found | not needed |
| `_LITTLE_ENDIAN` | 1 in every mode (C and C++, `-ansi`, `-std=c99` … `gnu++20`, `-mptr32`, `-mptr128`); the manual marks it deprecated (**lcc-doc** `predefined_macro.html`) | no: `__LITTLE_ENDIAN__` 1, as clang on every little-endian target | portable headers that don't know E2K: virtualgl 2.6.5's copy of boost's `endian.h` reads glibc's `__BYTE_ORDER` only when `__GLIBC__` is already defined, then these macros and a CPU list, else `#error` ("needs to be set up for your CPU type"); MCST's opencv E2K code (`3rdparty/emlx`, whose build passes `-D_LITTLE_ENDIAN` itself for GCC and clang) | the owner's call: GCC defines it on little-endian PowerPC, C6x and MicroBlaze (`gcc/config/rs6000/rs6000.h:618-619`, `c6x/c6x.h:83`, `microblaze/microblaze-c.cc:45-46`); otherwise the package tests `__BYTE_ORDER__` or `__e2k__` |
| `__REGISTER_PREFIX__`, `__USER_LABEL_PREFIX__` | empty | `__USER_LABEL_PREFIX__` empty | | empty |
| `__GNUC__` | 11 (`-gcc-version` selects 7, 9 or 11) | 4 | | the GCC version |

glibc's installed headers test `__LCC__` to tell lcc from GCC (`stdio.h`
format attributes, `math.h` and `bits/mathinline.h`, `bits/floatn.h`,
`sys/cdefs.h`, `pthread.h`, ...). Without it they take the plain-GCC
branch, which is what a GCC port wants; that branch expects `__float128`
and, from GCC 7, `_Float128` with the `f128` suffix (`__HAVE_FLOAT128`
= 1). `bits/mathinline.h` (lcc only) shows the inline-asm style
below.

lcc's other predefined macros are its EDG front end's (`__EDG__`,
`__EDG_VERSION__` 604, `__EDG_SIZE_TYPE__`, `__EDG_PTRDIFF_TYPE__`; in
C++ also `_BOOL`, `_WCHAR_T`, `__RTTI`, `__PLACEMENT_DELETE`,
`__ARRAY_OPERATORS`, `__VARIADIC_TEMPLATES`,
`__CHAR16_T_AND_CHAR32_T` and more `__EDG_*`), `__SIGNED_CHARS__`
(with `-funsigned-char`, `__CHAR_UNSIGNED__` instead, as in GCC;
**lcc-doc** `predefined_macro.html`) and the markers `LCC_BUG_148755`
and `LCC_BUG_158436` [lcc: `-dM` of 1.29.16 against the
proof-of-concept GCC, C and C++, `-O2`]. MCST's patches test `__EDG__`
in seven packages (range-v3, blender and blender-tools, cmake,
coreutils, emacs, glib), to work around lcc's front end in code that
another compiler skips, and none of the others [source: OS Elbrus
9.5.5's PDK]. A new compiler defines none of them.

**How build systems tell lcc from GCC** [source, gcc]. CMake tests
`__LCC__` (`Modules/Compiler/LCC-C-DetermineCompiler.cmake`, CMake
4.3.4), and glibc's configure looks for `lcc:` in `$CC -v` ("Options
and behaviours that change generated code" below). meson reads
`--version`: output containing both `e2k` and `lcc` (case-sensitive)
is lcc's, even after its "Free Software Foundation" line made it GCC
(`mesonbuild/compilers/detect.py:353-356` for C and C++, `:751` for
Fortran; meson 1.12.1; OS Elbrus's 1.7.0 has the same code at
`detect.py:341, 711, 1511`). meson then
takes the version from `__LCC__` and `__LCC_MINOR__` (`:1553`), 1.00.0
when they are missing, and offers only that version's standards
(`c.py:329-346`, `cpp.py:621-641`): for 1.00.0, `c89` to `gnu99` and
`c++98`. lcc 1.29.16's `--version`
(`lcc:1.29.16:Jan-22-2026:e2k-8c2-linux.cross:x86_64-linux`, then
`gcc (GCC) 11.3.0 compatible`) makes it lcc 1.29.16. The
proof-of-concept crosses print `e2k-linux-gnu-gcc (relcc2 PoC 0.6+23
…) 17.0.0`, `e2k` from the program name and `lcc` inside "relcc2", so
meson takes them for lcc 1.00.0 and refuses `c_std=c11` ("None of
values ['c11'] are supported by the C compiler"); the same compiler
printing "RELCC2 PoC" is gcc 17.0.0 [gcc: `meson setup` with a cross
file]. So a GCC for E2K keeps a lower-case "lcc" out of its
pkgversion and program name. A sound test for meson would be
`__LCC__`, which GCC must not define (above).

CPUs and ISA versions, as lcc's `-mtune` and `-march` take them
(**lcc-doc**): `elbrus-4c` v3; `elbrus-8c`, `elbrus-1c+` v4; `elbrus-8c2`
v5; `elbrus-12c`, `elbrus-16c`, `elbrus-2c3` v6; `elbrus-48c`, `elbrus-8v7`
v7. `-march=elbrus-v3`..`v7` (v2, `elbrus-2c+`, was dropped in 1.30).
`-mtune` overrides `-march` and marks the binary as runnable on that CPU
only (`EF_E2K_INCOMPAT`, [elf.md](elf.md)). Run-time CPU checks are
below.

Both options also take `native` (**lcc-doc** `lcc_options.htm`, 1.29.16
and 1.31.05; lcc lists it first among the valid arguments;
`-mcpu=native` is an unrecognized option). A native lcc puts the
machine in its place: `-mtune=native` is the machine's CPU (on the 4C
the same code as `-mtune=elbrus-4c`, with `__elbrus_4c__` and
`EF_E2K_INCOMPAT`; on the 8C2 `elbrus-8c2`), and `-march=native` the
machine's ISA without a CPU (`elbrus-v3` on the 4C; `elbrus-v5` on the
8C2, whose lcc is otherwise tuned for `elbrus-8c2`: no
`__elbrus_8c2__`, `e_flags` 0x5000000). It reads no file to find out
(no `/proc/cpuinfo` under strace on the 4C). A cross lcc puts its own
default in its place, which then overrides like any value:
`-march=elbrus-v6 -march=native` gives the default ISA, and since
`-mtune` overrides `-march`, `-mtune=native` with any `-march` gives
the compiler's default target (`e2k-v3`: v3 with no CPU; `e2k-v5.8c2`:
`elbrus-8c2`); alone, either changes nothing [lcc:
`tools/abi/probes/folda54_native.c`, the 1.29.16 crosses for v3,
v3.4c, v4.8c, v5.8c2 and v6.2c3, 1.31.05's for v3, v4.8c, v5.8c2 and
v6.2c3, native lcc on the 4C and 8C2]. Build systems pass them
(modem-manager-gui's `Makefile_h`, mumps's CMake for GNU Fortran).
Other GCC targets find the CPU in a native compiler's driver
(`host_detect_local_cpu`: `config/i386/i386.h:649-688`,
`config/aarch64/aarch64.h:1578-1588`; LoongArch reads `cpucfg`,
`config/loongarch/loongarch-cpu.cc`) [source].

## CPU detection at run time (lcc, lcc-doc)

lcc's builtins (`builtin_mcst.html`; [lcc-builtins.md](lcc-builtins.md)
has what each compiles to): `__builtin_cpu_init ()`,
`__builtin_cpu_is ("elbrus-8c2")`, `__builtin_cpu_name ()`,
`__builtin_cpu_arch ()` (deprecated) and `__builtin_e2k_get_cpu_iset ()`
(the ISA version, 0 if unknown; the manual misspells it
`__builtin_e2k_cpu_iset`, which lcc doesn't know). `__builtin_cpu_supports`
is not supported ("unknown built-in function").

`__builtin_cpu_is` compiles to a load from a 64-byte object
**`__cpu_info`** (hidden visibility) and a compare [lcc]:

| Offset | Holds | `__builtin_cpu_is` names |
|---|---|---|
| +0 | ISA version | `elbrus-v1` … `elbrus-v7`: 1 … 7 (deprecated forms) |
| +4 | lcc's CPU code | `elbrus` 1 (the v1 CPU), `elbrus-s` 2, `elbrus-2c+` 3, `elbrus-4c` 4, `elbrus-2cm` 5, `elbrus-8c` 6, `elbrus-1c+` 7, `elbrus-8c2` 8, `elbrus-12c` 9, `elbrus-16c` 10, `elbrus-2c3` 11, `elbrus-48c` 12, `elbrus-8v7` 13 |

Any other name is an error, `unknown argument "NAME" for
"__builtin_cpu_is"` (`elbrus-2c`, `elbrus-3m1`, `elbrus-1c`,
`elbrus-v8`; the names are case-sensitive) [lcc: 1.29.16 and 1.31.05;
`tools/abi/probes/folda33_cpuis.c`]. MCST's glibc (`ldsodefs.h:96-100`,
`:175-181`, `:261-264`) and gdb (`e2k-linux-nat.c:236-240`) also ask
for `"elbrus-maket32c"` (gas `-mcpu=elbrus-maket32c`: v7, ELF machine
26), but only under `__MCST_SUPPORT_ELBRUS_MAKET32C__`. Neither lcc
predefines it, and both reject the name even with it defined [lcc;
source: glibc, binutils], so those builds leave it out and a GCC port
need not know the name.

These codes are not `%idr`'s model numbers
([semantics.md](../isa/semantics.md), "Other facts"). `__cpu_info` and
`__cpu_init`, which fills it, are defined in lcc's proprietary
`liblcc.a` (`cpuinfo_init.o`; `__cpu_init` runs as a `.ctors.65434`
constructor, priority 101), which lcc's driver always links.

**MCST's static glibc needs it.** glibc is built by lcc and calls
`__builtin_cpu_is` when it checks a library's `e_flags` against the CPU
(`runtime_compatible_host`, `sysdeps/unix/sysv/linux/e2k/ldsodefs.h`).
`ld-linux.so.2` has its own local copy, but `libc.a`'s `dl-load.o`
leaves `__cpu_info` undefined, so a static link by another compiler that
pulls in `dlopen`, NSS or iconv fails ("hidden symbol `__cpu_info'
isn't defined") unless something else defines and fills it. The
proof-of-concept backend's libgcc does that from `%idr`, matching lcc's
values under qemu (v3, v5, v6) and on the 4C
(finding A10).

**`__cpu_init` must work before ld.so is relocated, and twice.** ld.so's
`_start2` calls it first, before `_dl_start` relocates ld.so (glibc
`sysdeps/e2k/dl-machine.h:335-338`;
[kernel-interface.md](kernel-interface.md), "Process entry"), because
ld.so checks libraries with `__builtin_cpu_is` before it runs any
constructor of its own. Then `_dl_init` runs it again, relocated: the
`.ctors.65434` entry is the only `DT_INIT_ARRAY` slot of
`ld-linux.so.2` (an `R_E2K_64_RELATIVE` to `__cpu_init`), and
`LD_DEBUG=files` prints "calling init: /lib64/ld-linux.so.2" [lcc:
`readelf` of the sysroot's and the 4C's `ld-linux.so.2`; hw: 4C].
glibc's lcc build links `liblcc.a` into ld.so (`elf/Makefile:1333-1341`:
`-lgcc -llcc`) and into `libc.so` (`Makeconfig:743-751`); a build by
another compiler links only `-lgcc`, so `__cpu_init` and `__cpu_info`
must then come from libgcc. Either way `__cpu_init` may use only hidden
symbols, addressed PC-relatively or `@GOTOFF` from a PC-relative
`_GLOBAL_OFFSET_TABLE_` (glibc's `PI_STATIC_AND_HIDDEN`,
`sysdeps/e2k/configure.ac`): no GOT loads, no calls through the PLT, no
absolute literals. lcc's `cpuinfo_init.o` is exactly that: its code
carries one `R_E2K_64_PC_LIT _GLOBAL_OFFSET_TABLE_` and 18
`R_E2K_64_GOTOFF_LIT __cpu_info` relocations and calls nothing, its only
absolute relocation is the constructor entry, and both symbols are
hidden in the object and local in `ld-linux.so.2` [lcc: `readelf -r`
and `-s` of `liblcc.a`]. The proof-of-concept libgcc's `cpuinfo.o`
likewise has only `PC_LIT` and `GOTOFF_LIT` relocations in its code
[gcc].

## Inline assembly (lcc-doc, lcc)

Constraints, as lcc 1.28+ defines them:

| Constraint | Register | Sizes |
|---|---|---|
| `r` | ordinary ("non-extended") 64-bit registers | 1–8 bytes: one register; 9–16 bytes: an even-aligned pair (`%r2`+`%r3`), for every type |
| `x` | one extended register: 80-bit on v1–v4, 128-bit ("quadro-packed") on v5+ | `sizeof` 16 only: `long double` on any ISA; 16-byte vectors, `__int128` and so on on v5+ |

- Transition (lcc 1.28–1.31): by default (`-mold-asm-constraint-r`)
  lcc still treats `r` on a `long double` or a 16-byte vector as `x` and
  warns. `-mno-old-asm-constraint-r` gives the meaning above, which MCST
  says will become the default. glibc's `bits/mathinline.h` uses `x` for
  lcc ≥ 1.28 and `r` otherwise. A new compiler should implement the new
  meaning.
- Operands print as the base register name whatever their size or
  constraint: `%0` becomes `%r2` for a `long`, an `__int128` pair or an
  `x` operand (`asmops.c`). The operation decides the width (`fxsqrtixx
  %1, %0` in mathinline.h); mathinline.h uses no operand modifiers.
  lcc's modifiers are listed below.
- An `x` value must be copied only with `movx` (or rebuilt with
  `movif` from its two halves): a 64-bit copy (`addd`) drops the 16-bit
  extended part. lcc packs an `x` input with `movif`, emits `movx r, r`
  after an asm with an `x` output before reading it with `movfi`, and
  switches such functions to `setwd nfx = 0` [lcc]. The `movx` after the
  output turned out unnecessary on the 4C and under MCST's qemu
  (finding A12); why lcc emits it is not known.
  glibc's `bits/mathinline.h`, the only user of `x` in the sysroot, is
  included only under `__LCC__`.
- lcc accepts `_Pragma("asm_inline")` before an `asm` (it allows lcc to
  schedule the asm with surrounding code, `-masm-inline`), and checks the
  asm's text unless `-mno-asm-check`. `-masm-inline` is off by default
  at every `-O` level; MCST's kernel turns it on, and then lcc parses the
  asm text: it deletes an unused `rrd`, folds pure operations such as two
  identical `addd`, and merges two `rrd %lsr`, but keeps every read of
  `%upsr`, `%ip`, `%clkr`, `%sclkr` and `%fpsr` [lcc 1.29.16, 1.31.05:
  `kernelbuild.py` `open`; [kernel-build.md](kernel-build.md),
  "State-register reads"]. GCC ignores the pragma with a warning
  ("Pragmas" below).

Register variables (`register T v asm("...")`, lcc 1.29+): a name without
a prefix is ordinary registers, so a 16-byte variable at `%g2` occupies
`%g2`+`%g3`; the prefix `x` names one extended register (`%xg5`, odd
numbers allowed). By default (`-mold-register-asm-long-double`) a `long
double` named without `x` is still placed in the extended register, with
a warning. A file-scope register variable only names its register: lcc
does not reserve it, and the file's other functions use that register
for temporaries (`%g16`–`%g31` under `-fglobal-regs`, lcc's default)
unless `-ffixed-gN` is given. lcc reads such a variable again after a
call, merges two reads with only a store between and keeps two
consecutive writes [lcc: `tools/abi/probes/kernelbuild.py` `gregapi`,
`gvars`]. GCC instead makes the register fixed for the rest of the file,
warns (with no `-W` switch to turn it off) when it is call-clobbered and
not already fixed, and deletes the first of two consecutive writes
[source: `gcc/reginfo.cc:737-790`; gcc]. MCST's kernel relies on
`-ffixed-g16` … `-ffixed-g25` ([kernel-build.md](kernel-build.md),
"Global registers").

A local register variable (`register T v asm ("g16")` in a function)
is its register wherever lcc reads or writes the variable, outside asm
too: a read at entry takes what the caller, or a jump into the
function, left there; the register is read again after every call, so
`"b[0]"`–`"b[7]"` variables read a call's result; and a plain
assignment writes the register and is kept up to the next call [lcc
1.29.16 v3 and v5.8c2 (v6.2c3 read with `-S`), 1.31.05 v3 and v5.8c2,
`-O0` and `-O3`; hw: `tools/abi/probes/folda53_regvar.c`, 4C and 8C2].
MCST's LibreOffice UNO bridge relies on it
(`bridges/source/cpp_uno/gcc3_linux_e2k`): `cpp_vtable_call` takes the
method's index from `%g16`, which MCST's code snippet sets before it
jumps there, and `callVirtualMethod` calls the method through a
pointer to a `void` function, then reads the result from
`b[0]`–`b[7]` [source]. GCC promises a local register variable's
register only for extended-asm operands and calls other uses
unsupported (`gcc/doc/extend.texi:13369-13412`) [source]. x86-64 GCC
16.2.1 at `-O2` reads the register at the first read but takes two
reads with calls between them for one value, read after the last call
[gcc]; the proof-of-concept GCC, which zeroes a register it finds read
before it is written (one answer to
[gcc-port-plan.md](../../doc/gcc-port-plan.md), D7, "A register that
may hold no value"), reads 0 at entry and after the calls and drops the
assignment at `-O2` [gcc; hw: 8C2]. Both compilers honour an empty asm
with the variable as its output (`asm volatile ("" : "=r" (g16))`) for
the entry read and, for the results, a call through a pointer to a
function returning a 64-byte struct, which comes back in those
registers ([calling-convention.md](calling-convention.md), "Results")
[lcc, gcc; hw: lcc on the 4C and 8C2, the proof of concept on the 8C2]. Where the bridge puts its stack arguments is
in calling-convention.md, "Stack argument area".

lcc also binds two names that are not registers, each with or without
`%` [lcc 1.29.16 and 1.31.05 at `-O0` and `-O2`;
`tools/abi/probes/glibcbuild_lcc.py`]:

| Name | Reads | Used by |
|---|---|---|
| `"FP"`, `"%FP"` | the stack pointer at function entry, the top of the frame: the frame's `getsp` result plus the frame size (`getsp 0` without a frame), unchanged by `alloca`; equal to lcc's `__builtin_frame_address (0)` (their difference folds to 0) | glibc's `_start` (`sysdeps/unix/sysv/linux/e2k/start.c:59`) and ld.so's `_start2` (`sysdeps/e2k/dl-machine.h:329`), to find `argc` ([kernel-interface.md](kernel-interface.md), "Process entry") |
| `"SP"`, `"%SP"` | the current stack pointer: the frame's `getsp` result (`getsp 0` without a frame), the new bottom after `alloca` | only `sysdeps/e2k/memusage.h:21`, which nothing includes: glibc 2.35 dropped `memusage.h` (upstream commit 83b8d5027d), and `libmemusage` takes the stack pointer from `__builtin_frame_address (0)` instead (`CURRENT_STACK_FRAME`, `sysdeps/e2k/e2k64/nptl/pthreaddef.h:32`, through `sysdeps/unix/sysv/linux/machine-sp.h`) |

Other spellings (`fp`, `sp`, `USD`, `%usd`), the 64-bit names `dr0`
and `dg16`, and state registers (`ip`, `lsr`, `pfpfr`) are error #1118
"unknown register name"; `pred0` and `ctpr1` are refused ("cannot be
used for allocation"). `"r9"` is window register 9, and lcc moves the
rotating base up a pair (`setbn rbs` 5 instead of 4) to keep it out of
`%b[]`. So glibc 2.35's E2K code needs only `"FP"` from a compiler, or a
patch that uses `__builtin_frame_address (0)` in those two places,
which then must mean the stack pointer at entry, as in lcc (nptl's
`CURRENT_STACK_FRAME` uses it too). In GCC the entry stack pointer is
the argument pointer, which no register variable may name: GCC refuses
the frame and argument pointers when it eliminates them and allows the
hard frame pointer [source: `gcc/varasm.cc:1569-1578`; gcc: GCC 16.2.1
on x86-64 refuses `asm ("argp")` and `asm ("frame")` and accepts `asm
("rbp")`]. A port can bind `"FP"` to a hard frame pointer set to the
entry stack pointer ([gcc-port-plan.md](../../doc/gcc-port-plan.md),
D12). Unipro's clang rejects all four names [unipro].

### Other constraints (lcc, source, binutils, gcc)

lcc 1.29.16 (`e2k-v3`, `e2k-v5.8c2`, `e2k-v6.2c3`) and 1.31.05 (`e2k-v3`)
accept the same letters and print operands the same way
(`tools/abi/probes/asmconv.py` prints every case below; its output is
identical for the four compilers):

| Constraint | lcc | Operand prints as |
|---|---|---|
| `m`, `o` | accepted, also as outputs (`=m`, `+m`) | `%rN, 0x0`: lcc always loads the address into a register and prints base and a zero offset, also for `p->b`, `p[50]`, a global or a local array element. The text fits the address operands of a load or store (`ldd %1, %0`) |
| `i`, `n` | any integer constant | hex, **unsigned at the width of the operand's C type**: `(int) -1` gives `0xffffffff`, `-1L` gives `0xffffffffffffffff`, `(short) -1` gives `0xffff`. A `double` constant prints its bits (`1.5` gives `0x3ff8000000000000`). With `i`, the address of a global prints as gas's literal syntax `[ g ]` (non-PIC; an error with `-fPIC`); the address of a local is an error |
| `I` | 0–31 | as `i` (the range of the 5-bit `src1` literal) |
| `J` | 0–255 | as `i` (the range of an 8-bit ALES literal, `pshufh` and ALOPF11_LIT8; inferred) |
| `g` | accepted | a register in every probe (`%r3`), also for a memory operand |
| `rm`, `mr`, `ri`, `im` | accepted | a constant prints as for `i` |
| `0`–`9` (matching) | accepted | the matched register |
| modifiers `=`, `+`, `&` | accepted | |
| `V`, `<`, `>`, `s`, `X`, `p`, `E`, `F`, `f` | error "asm operand %0 of asm statement have unknown constraint" | |
| every other letter (`K`–`P`, `G`, `H`, `a`–`e`, `h`, `j`–`l`, `q`, `t`–`w`, `y`, `z`, `A`–`D`, `Q`–`U`, `W`, `Y`, `Z`) | error #1121 "unknown asm constraint letter" | |

The unsigned printing matters with 64-bit operations: `(int) -1` passed
with `i` to `addd` reaches gas as `0xffffffff`, which gas encodes as
`_f64 0xffffffff`, that is +4294967295, not −1 ([bundle.md](../isa/bundle.md),
"Literal values"). The installed headers cast such operands to an
unsigned 64-bit type first (`__e2k_syscall_arg_t`).

**A narrow input tied to a wider output** (`asm ("" : "=r" (long_r) :
"0" (1))`, as GCC's `g++.dg/opt/pr23478.C` writes): from `-O1` lcc
clears the output's register with a 64-bit operation and writes the
input with a 32-bit one under `dbl = 0`, in the same wide instruction
for a constant or a value computed from an argument (`addd,1 0x0, 0x0,
%r3` with `adds,2 0x1, 0x0, %r3`; [bundle.md](../isa/bundle.md), "Two
writes of one register"), or in the next one after a load or for a
narrow type. The upper half is therefore 0: an `int` or `unsigned`
input is zero-extended, never sign-extended (`-1` gives `0xffffffff`),
and a `short` or `char` input is computed in 32 bits (`(short) (v +
1)` as `(int) v + 1`, as x86-64 GCC does too) and then zero-extended.
At `-O0` lcc writes only the low half, and the upper half is what the
register held [lcc 1.29.16 v3, v5.8c2, v6.2c3, 1.31.05; hw:
`tools/abi/probes/folda52_tie.c`, 4C and 8C2]. Unipro, always `dbl =
1`, zero-extends from the input's own width (`sxt` 6, 5, 4: `(short)
-1` gives `0xffff`) [unipro]. GCC leaves these bits undefined: LRA
makes the input a lowpart subreg of the output's register
(`gcc/lra-constraints.cc:1165-1176`) [source]. Code written for x86-64
or AArch64, where a 32-bit write zeroes the upper half, relies on
them, GCC's own pr23478 included; a compiler that writes such an input
with a 32-bit operation under `dbl = 0` leaves the caller's upper half
in the output [hw: the probe built by a proof-of-concept GCC that did
so, 4C].

An `m` operand may follow an operation's channel digit with no space:
MCST's kernel writes `"{st"#mem_size_letter ","
mem_model##_ATOMIC_CHANNEL "%[addr], %[tmp], mas=" …`
(`arch/e2k/include/asm/e2k_api.h:4880-4881`, and `:6096-6097`; the
channel is `"5"` for the acquire and relaxed forms when
`CONFIG_CPU_ISET_MIN` ≥ 5, and `"2"` otherwise and for the release and
strong forms, `:4653-4661`), and `asm/sclkr.h:82-83` applies the relaxed
form to the global `prev_sclkr` [source]. gas reads every digit after
the comma as the channel, so the operand must not print starting with a
digit. An address without a register base does start with one, the short
literal base `0x0`, followed by the symbol as a 64-bit literal (which
can't be the base): `{std,50x0, prev_sclkr, %g27}` is "invalid ALC50
specified" (channel 2: "invalid ALC20"; `{ldd,00x0, …}`: "Invalid
argument in position of SRC1"), while the same after a space or a tab
assembles, with `R_E2K_64_ABS_LIT` [binutils: MCST gas 2.41]. lcc's
register base never meets this (`{std,5%g16, 0x0, %r0}` at `-O2`, `%r3`
at `-O0`) [lcc 1.29.16 v3, v5.8c2, v6.2c3; 1.31.05 v3:
`tools/abi/probes/foldp105_asmaddr.sh`]. A compiler that prints a
literal address for an `m` operand must put a space before it inside asm
statements (GCC marks them with `this_is_asm_operands`,
`gcc/final.cc:2632` [source]), or use a register base as lcc does.

Constraints in use: glibc's E2K sysdeps use `r` (137), `=r` (111), `+r`
(58), `ri` (21), `=&r` (2), `i` (1) and `g` (1, protected-mode malloc);
the kernel's uapi headers use `ri` (51), `=r` (13) and `i` (8) [source].

### Operand modifiers (lcc)

| Modifier | lcc prints |
|---|---|
| `%#` | the `wbs` of a call made inside the asm (next section) |
| `%=` | a number unique to this asm in the output (`1`) |
| `%%` | `%` |
| `%[name]` | the named operand |
| `%cN` | a constant without decoration: `5` gives `0x5`, `&g` gives `g`. On a register: error "operand modifier 'c' should only be used for constants" |
| `%nN` | the negated constant: `5` gives `0xfffffffb` (`int` width), `-5L` gives `0x5` |
| `%HN` | the second register of a 16-byte `r` operand: an `__int128` in `%r4`+`%r5` prints `%r4` for `%0` and `%r5` for `%H0`; the same for a 16-byte struct or union, input or `"=&r"` output (`kernelbuild.py` `modifiers`). On an 8- or 4-byte operand, an `x` operand or a constant: error "operand modifier 'H' should only be used with quadro" |
| `%LN` | the first register of a 16-byte `r` operand, the one `%N` prints (`%r4` above), for `__int128`, `unsigned __int128`, a `struct { u64, u64 }` or a union of them, input or `"=&r"` output. On an 8- or 4-byte operand, an `x` operand or a constant: error "operand modifier 'L' should only be used with quadro". MCST's kernel uses it 27 times, beside `%H`, all in `asm/e2k_api.h` ([kernel-build.md](kernel-build.md), "`%L`, `%H` and 16-byte operands") [lcc 1.29.16 v3, v5.8c2, v6.2c3; 1.31.05 v3: `kernelbuild.py` `modifiers`] |
| `%a`, `%l`, `%P`, `%p`, `%w`, `%d`, `%x`, `%X`, `%h`, `%b`, `%q`, `%s`, `%z`, `%k`, `%V`, `%K` | error "unknown operand modifier" |

- In a basic asm (no colons) `%` is not special: `asm volatile ("%#")`
  prints `%#` as written.
- `asm goto` is rejected by lcc 1.29.16 and 1.31.05 ("конструкция asm goto
  пока не поддержана", not supported yet).

### `%#`: the window base for a call inside the asm (lcc)

lcc replaces `%#` with the pair at which `%b[0]` currently starts, `rbs +
rcur` of the function's `setbn`, in hex. lcc's own calls in the same
function use the same `wbs`, and lcc sets `wsz` to `%#` + 4, so `call
%ctpr1, wbs = %#` hands the callee the 4 pairs (`%b[0]`–`%b[7]`) that the
C convention and the kernel's system call entry expect
([registers.md](registers.md), window units; the entries start with
`VFRPSZ_SETWD(4)`, kernel `kernel/trap_table.S:535-555`;
[kernel-interface.md](kernel-interface.md)). `asmconv.py`:

| Function (one `asm volatile`) | lcc `-O` | `setwd` | `setbn` | `%#` |
|---|---|---|---|---|
| leaf, any asm text | `-O0` | `wsz = 0x8` | `rsz = 0x3, rbs = 0x4, rcur = 0x0` | `0x4` |
| leaf, any asm text | `-O1` … `-O3` | `wsz = 0x9` | `rsz = 0x4, rbs = 0x4, rcur = 0x1` | `0x5` |
| asm and a call with 12 arguments | `-O2` | `wsz = 0x9` | `rsz = 0x4, rbs = 0x4, rcur = 0x1` | `0x5` (the call: `wbs = 0x5`) |
| 8 arguments live across the asm | `-O2` (`-O0`: `wsz = 0xc`, `rbs = 0x8`, `%#` 0x8) | `wsz = 0xb` | `rsz = 0x4, rbs = 0x6, rcur = 0x1` | `0x7` |
| the same leaf without the asm | any | `wsz = 0x4` | none | — |

So `wsz − %#` is 4 in every case. The asm may write `%b[0]`–`%b[7]` and
read results from `%b[0]`; lcc reserves no stack argument area for it (no
`getsp`).

`%#` is never below 4 either: a C function inherited 4 pairs, and a
`call` whose `wbs` is smaller than that is SIGSEGV `SEGV_BNDERR` at the
`call`, system calls included ([registers.md](registers.md), window size
limits [hw: `pocabi2.c`]). A compiler that prints `%#` itself must keep
the asm's outgoing pairs at pair 4 or above.

When lcc sets up that area: for every `asm volatile`, with or without
`%#` and whatever its clobbers (also `asm volatile ("")`), and for a
non-volatile asm with a `"call"` or `"b[N]"` clobber. A non-volatile asm
without them gets no rotating base (`-O2`: `wsz = 0x8` and no `setbn`;
`-O0`: `wsz = 0x4`), yet `%#` still prints `0x4`, so a call made there
would not pass `%b[]` to the callee. Every `%#` in glibc and the kernel
is in an `asm volatile` or in an asm that lists `"call"` (the kernel's
four non-volatile ones, `asm/e2k_api.h:3094-3206`). With `_Pragma
("asm_inline")` lcc parses the asm itself and emits the same `wbs`.

Users: glibc's `INTERNAL_SYSCALL` (`sysdeps/unix/sysv/linux/e2k/sysdep.h:229`,
`call %ctpr1, wbs = %#`), the uapi `__E2K_SYSCALL_0` … `_7` macros
(`arch/e2k/include/uapi/asm/e2k_api.h:128-331`) and 25 uses in the
kernel's own `asm/e2k_api.h` (also `hcall …, wbs = %#`). (GCC hands `%`
followed by a punctuation character to the target's operand printer when
`TARGET_PRINT_OPERAND_PUNCT_VALID_P` accepts it, `gcc/final.cc:3574`.)

### Clobber names (lcc)

The same in lcc 1.29.16 (`e2k-v3`, `e2k-v5.8c2`, `e2k-v6.2c3`, `-O0`
and `-O2`) and 1.31.05 (`e2k-v3`) (`asmconv.py`):

| Name | lcc | Effect on a non-volatile asm (`-O2`) | glibc | kernel uapi |
|---|---|---|---|---|
| `"memory"` | accepted | memory values loaded before it are loaded again after it | the spinlocks (`nptl/pthread_spin_*.c`) and every syscall | — |
| `"cc"` | accepted | none seen | — | — |
| `"call"` | accepted | the asm is treated as a call: outgoing area reserved (`wsz = 0x9`), `return %ctpr3` prepared again after it, memory reloaded, operands in window registers instead of `%g16`–`%g31` | `"call", "memory"` on every syscall (`sysdep.h:172-173`) | — |
| `"ctpr1"`–`"ctpr3"`, `"%ctpr1"`–`"%ctpr3"` | accepted; `ctpr0`, `ctpr4` unknown | `"ctpr3"` on a non-volatile asm: `return %ctpr3` prepared after it | `"%ctpr1"`–`"%ctpr3"` (`nptl/pthread_spin_lock.c:40-44`) | `"ctpr1"`–`"ctpr3"` (`E2K_SYSCALL_CLOBBERS`, `e2k_api.h:108-111`) |
| `"b[0]"`–`"b[7]"`, `"%b[0]"`–`"%b[7]"` | accepted; `"b[8]"` and above: error `регистр "%b[8]" нельзя использовать в качетсве clobber'а` (cannot be a clobber; lcc's spelling); `"db[0]"`, `"b0"` unknown | as `"call"`, and `setwd nfx = 0x0` | — | `"b[0]"`–`"b[7]"` (`E2K_SYSCALL_CLOBBERS`) |
| `"pred0"`–`"pred31"`, `"%pred0"`–`"%pred31"` | accepted; `pred32`, `p0` unknown | none seen (lcc kept no predicate live across an asm in any probe) | `"%pred0"` (spinlock) | — |
| `"g0"`–`"g31"`, `"%g0"`–`"%g31"` | accepted; `dg16`, `xg16`, `qg16` unknown | without clobbers lcc may give a non-volatile asm's operands `%g16` and up (leaf functions use them as scratch); with `"g16"` it used `%g17` and reloaded a value it had kept in `%g16`; all of `g16`–`g31`: window registers | — | — |
| `"r0"`–`"r63"`, `"%r0"`–`"%r63"` | accepted; `r64` and above, `dr0`, `xr0`, `qr0` unknown; at `-O0` a clobbered `rN` that holds an operand is an error ("clobber %r0 conflicts with operand %1") | `setwd nfx = 0x0` | — | — |
| state, AAU and special registers (`lsr`, `ilcr`, `pfpfr`, `fpcr`, `fpsr`, `upsr`, `usd`, `wd`, `br`, `psr`, `cr0`, `aasr`, `aad0`, `aasti0`, `empty`, `MLOCK`, `clkr`, `rndpr`, `tst`, `tc`), with or without `%` | error #1118 "unknown register name" | | | |

The kernel's own headers (not uapi) also use `"r0"`–`"r7"`,
`"pred0"`–`"pred31"`, `"%g0"`–`"%g31"`, `"g16"`–`"g31"` and `"%b[0]"`–`"%b[7]"`,
and note that `"lsr"` cannot be named, so they clobber the CTPRs instead
(`asm/e2k_api.h:2786`). Their four non-volatile calls clobber `"call"`,
`"memory"`, `"pred19"` and the global they use (`"g" #greg_no`,
`asm/e2k_api.h:3100-3215`).

GCC accepts a clobber only if it is a register name, an
`ADDITIONAL_REGISTER_NAMES` or `OVERLAPPING_REGISTER_NAMES` alias,
`"memory"`, `"cc"` or `"redzone"`, after stripping one leading `%`;
anything else is "unknown register name" (`gcc/varasm.cc:978-1095`,
`gcc/cfgexpand.cc:3496-3502`). So `"call"` and `"b[N]"` need to be names
the port knows. Both should also clobber `%g16`–`%g31`, as a call does
(lcc treats both as a call, above): a system call through entry 3
returns with those registers emptied, and neither glibc's nor the
uapi's clobber list names them ([kernel-interface.md](kernel-interface.md),
"System calls").

### What lcc assumes an asm does (lcc)

| Asm | lcc |
|---|---|
| `asm volatile`, any clobbers | a barrier for everything: reserves the outgoing area, prepares `return %ctpr3` and loop `disp`s again after it (also with no clobbers: CTPRs are never kept across it), and reloads memory as if `"memory"` were given |
| non-volatile | follows the clobber list: keeps `return %ctpr3` prepared across it unless `"ctpr3"`, `"call"` or a `"b[N]"` is listed; may put operands in `%g16`–`%g31` unless `"call"` or that `gN` is listed; reuses a value loaded before it unless `"memory"`, `"call"` or a `"b[N]"` is listed (`asmconv.py`, "Effects") |
| non-volatile with outputs, opaque (`-mno-asm-inline`, lcc's default) | in every case probed, kept when its outputs are unused, and two identical ones neither merged nor moved out of a loop (`kernelbuild.py` `barrier`, `open`). GCC deletes the first kind and merges or hoists the second (`gcc/doc/extend.texi:11700-11711`, `gcc/cse.cc:2743-2760`) [gcc]; MCST's kernel relies on lcc here for `barrier()`, per-CPU stores and state-register reads ([kernel-build.md](kernel-build.md), "Inline assembly the kernel relies on") |
| non-volatile, opaque (lcc's default; under `-masm-inline`, one after `_Pragma ("no_asm_inline")`), its template writing a global register variable that no operand or clobber names | the template isn't read: two reads of the variable around the asm are merged, as GCC merges them, and at `-O2` without `-ffixed-g16` lcc may keep a temporary of its own in a register the template writes. A value copied from the variable before the asm stays in lcc's temporary (`%g16`; `%g26` with `-ffixed-g16` … `g25`; a window register under `-fkernel`), whatever the template names (`folda41_gregasm.c`) |
| non-volatile, parsed (`-masm-inline`, without `no_asm_inline`) | the template is read: lcc knows which global registers the asm reads and writes, copies a variable before an asm that overwrites it, and uses the register directly where the template leaves it alone (`folda41_gregasm.c`) |
| non-volatile, opaque or parsed, listing as a clobber only a global register variable written just before it | the write is kept, opaque or parsed: lcc never deletes a write to a register variable (`folda41_gregasm.c`) |

The uapi system call macros list neither `"memory"` nor `"call"`, so they
rely on this (inferred). GCC does not treat `asm volatile` as a memory clobber and may
move it relative to other code (`gcc/doc/extend.texi:11797-11801`,
`12423-12434`), so with GCC, values loaded before such a call are
reused after a system call that wrote them. GCC's tree optimizers see
an asm write memory other than its own `m` outputs only when its
clobbers include the literal `"memory"` or it is a non-empty basic asm
(`gimple_asm_clobbers_memory_p`, `gcc/gimple.cc:3058-3074`, which
`gcc/tree-ssa-operands.cc:753-755` asks), volatile or not, and no target
hook changes that: a memory clobber added in `TARGET_MD_ASM_ADJUST`
reaches only RTL [source]. Host GCC 16.2.1 `-O2` (x86-64) reads
`buf[0]` once across `asm volatile ("..." : : "r" (buf))`, after the
asm, and before and after it with `"memory"`. lcc reads it again after a
uapi-style `read` (`tools/abi/probes/pocplan.c` `sys_read_twice`: `ldb`
before and after the asm) [lcc 1.29.16 `-O2` and `-O3`, v3.4c, v5.8c2,
v6.2c3; 1.31.05 `-O3`, v3, v6.2c3].

**Global register variables.** GCC knows an asm only by its operands
and clobbers ("the type of access must be provided to the compiler via
constraints", `gcc/doc/extend.texi:13272-13277`) [source; gcc: GCC
16.2.1 `-O2` on x86-64, `tools/abi/probes/folda41_gregasm.c -DVOL`;
lcc, for the rows above: the same probe, 1.29.16 and 1.31.05, v3 and
v5.8c2, at `-O2` and `-O3 -fkernel -masm-inline`, opaque also v6.2c3]:

- A register the template writes without a clobber is unchanged for
  GCC, so a copy taken before the asm may be read from the register
  after it.
- A clobber is an overwrite that doesn't read: a write to the variable
  just before the asm is dead and deleted. A read after the asm may
  still be merged with one before it by the tree optimizers, which
  don't see clobbers.
- Only an operand (`"+r" (var)`) makes GCC read the variable again and
  keep the write.

So code built by GCC gives an asm each global register variable it
reads or may change as an operand: `"+r"` for "may change", `"=r"` for
an overwrite, `"r"` for a read. A clobber is right only for a register
whose old value is dead. MCST's kernel relies on lcc here in three
macros ([kernel-build.md](kernel-build.md), "Global registers named
only in templates and clobbers").

lcc's `asm_inline`, `no_asm_inline` and `asm_length` pragmas, and what
other compilers do with them, are in "Pragmas" below.

Register names for `-ffixed-<reg>` and `-fcall-used-<reg>` (as in GCC):
`g0`..`g31`, `r0`..`r63`, `pred0`..`pred31`.

## Options and behaviours that change generated code (lcc-doc)

- **Pointer size**: `-mptr64` (`-m64`), `-mptr32` (`-m32`) and
  `-mptr128` (`-m128`) compile for 64-bit, 32-bit and protected mode
  (**lcc-doc** `lcc_options.htm`); `-mptr64` and `-m64` define
  `__ptr64__` and `_LP64`, as the default does [lcc]. glibc's configure
  appends `-mptr64` to `CC` and `CXX` for `e2k` and `e2k64` hosts
  (`-mptr32` for `e2k32`, `-mptr128` for `e2k128`; `configure.ac:58-71`),
  so every configure test and every compile passes it, and MCST's kernel
  build passes it too ([kernel-build.md](kernel-build.md), "ftrace"): a
  compiler that builds either must accept `-mptr64` (a no-op in a
  64-bit-only port). The proof-of-concept GCC rejects all six spellings
  [gcc]; Unipro's clang accepts `-m64` and `-m32` (both still
  `__ptr64__`) but not `-mptr64` [unipro]. No other lcc option reaches a
  glibc build by another compiler: `-fasm-entries-first`,
  `-fno-ipa-attrs`, `-masm-inline`, `-Werrror` (lcc's stricter
  `-Werror`), `-llcc` and the rest are
  added only when configure finds `lcc:` in `$CC -v`
  (`configure.ac:572-579`; `sysdeps/e2k/Makefile:1-22`,
  `Makeconfig:730-751, 919-929`). For such a build MCST's makefiles add
  only `-fno-strict-aliasing` to `s_sin.c`, `s_sinl.c`, `erand48_r.c`
  and `makecontext.c` (the last also `-Wno-stringop-overread
  -Wno-array-bounds`; `sysdeps/e2k/Makefile:72-84`) and build
  `elf/dl-runtime.c` with `-fno-exceptions` (`elf/Makefile:154-170`)
  [glibc].
- **Alignment**: `-mstrict-align` (no unaligned accesses created by
  optimisation) is the default up to v4, which has no efficient unaligned
  access; from v5 the default is `-mno-strict-align`.
- **Data model** (`-mdmodel=`): `medium` (default) assumes no object,
  static or allocated, exceeds 4 GiB, so lcc may compute indices in 32
  bits; `large` allows huge dynamic objects; `huge` (experimental)
  allows both. It changes code, not the binary interface. It does not
  let lcc assume an unsigned 32-bit index doesn't wrap: `p[i + off]`
  with `off = 0xffffffff` reads the wrapped element at `-O1` and `-O3`,
  lcc computing the index with a 32-bit `adds` (zero-extended by
  `dbl = 1`) every iteration [lcc; the proof-of-concept back end's P32,
  on the 4C].
- **Rotating globals**: lcc assumes by default that the rotation base of
  `%g24`–`%g31` may change (`abg`, `abgc`, `modbgv`), and limits
  optimisation of those registers; `-mfixed-gregs-base` (1.31) lifts
  this.
- **Uninitialised variables**: from 1.29, at `-O1` and above lcc
  initialises some variables that may be read uninitialised
  (`-ftrivial-auto-var-init=uninitialized`, its default). This avoids
  "very rare crashes on Elbrus caused by diagnostic tags in registers"
  (see the tag trap in [calling-convention.md](calling-convention.md)).
  A compiler that leaves them alone can store a register holding a
  diagnostic value (an empty one, as in registers a window gains, does
  not trap).
- **Zero-initialized data**: lcc puts every explicitly initialized
  object in `.data` (`.tdata` for `__thread`), also when the
  initializer is zero (`= 0`, `= { 0 }`, `= { }`, `0.0`, a null
  pointer), at file scope and for function-scope statics alike; only
  objects without an initializer go to `.bss` or `.tbss` (common with
  `-fcommon`). It accepts `-fzero-initialized-in-bss` and
  `-fno-zero-initialized-in-bss` silently and places objects the same
  either way. GCC puts zero-initialized objects in `.bss` and `.tbss`
  unless given `-fno-zero-initialized-in-bss`, which then places them
  exactly as lcc does [lcc 1.29.16 v3, v5.8c2, v6.2c3 at `-O0`, `-O2`
  and `-O3 -fkernel`, l++; 1.31.05 v3, v5.8c2; gcc: the
  proof-of-concept back end, GCC 16.2.1 on x86-64;
  `tools/abi/probes/folda40_zerobss.c`]. The ABI doesn't depend on it;
  MCST's kernel does ([kernel-build.md](kernel-build.md), "Data written
  before `.bss` is cleared").
- **Signals**: a fault in a speculative operation only tags its result;
  the program gets `SIGILL` when a non-speculative operation (a store, a
  branch) uses the value, instead of `SIGSEGV`, `SIGBUS` or `SIGFPE`.
  lcc keeps the usual signals at `-O0`/`-O1` and with `-fno-semi-spec-ld`
  and `-fno-spec-fp` (older names: `-fcontrol-spec`, `-fno-fp-spec`). A
  port that speculates must expect testsuites that check those signals
  to fail.
- **Speculation switches** (1.26): `-f[no-]semi-spec-ld` (loads moved
  from under a predicate, semi-speculative), with `-glob`, `-stack` and
  `-greg` variants for loads of globals, the stack and through global
  registers; `-f[no-]spec-ld` (speculative with compensation code);
  `-f[no-]spec-fp`; `-f[no-]spec-ctp` (prepares hoisted out of
  conditions); `-f[no-]spec-volatile-st` (1.30, speculative stores
  through `volatile` pointers). `-fkernel` disables
  semi-speculative loads except those of globals, the stack and through
  global registers; a later `-fno-semi-spec-ld` removes those too, and
  fully speculative loads (`mas=0x3` with `%dt_al` recovery) stay until
  `-fno-spec-ld` [lcc: `kernelbuild.py` `codegen`].
- **Jump tables**: lcc 1.29.16 and 1.31.05 honour `-fno-jump-tables`
  only at `-O0`; from `-O1` on a dense `switch` still becomes a `.T.N`
  table of absolute addresses [lcc: `kernelbuild.py` `jumptab`].
- **DAM**: 1.29.16's `-fno-dam` removes every lock and check load; in
  1.31.05 it leaves the DAM of software-pipelined loops, which
  `-fno-swp-dam` turns off [lcc: `kernelbuild.py` `codegen`].
  `-fno-swp-dam` is 1.30's name for `-fno-dam4swp`, which 1.29.16
  accepts and 1.31.05 still does (**lcc-doc** `changelog_130.html`).
- **Kernel builds**: `-fkernel`, the options MCST's kernel adds
  (`-fglobal-regs`, `-ffixed-g16` … `g25`, `-fexclude-ctpr2`,
  `-fno-dam`, `-fno-loop-apb`, `-ffix-lcc-bug123567`,
  `-mfixed-gregs-base`, ...) and the attributes `check_stack`,
  `check_mem` and `avoid_stack` are in [kernel-build.md](kernel-build.md).
- **`swapcontext`** is treated like `setjmp` (returns twice) since 1.28;
  without that it "could cause runtime errors". GCC marks only `setjmp`,
  `sigsetjmp`, `savectx`, `vfork` and `getcontext` (`gcc/calls.cc`,
  `special_function_p`).
- **`setcontext`** is treated as a function that never returns: lcc
  1.29.16 at `-O1` to `-O4` and `-Os`, and 1.31.05 at `-O1` and `-O3`.
  `-fno-builtin`, `-fno-builtin-setcontext` and `-ffreestanding` don't
  change it, and glibc's declaration says only `__THROWNL`. lcc emits
  nothing after the call except the `ct %ctpr3` it prepared before it. A
  call empties `%ctpr1`–`%ctpr3`, so when `setcontext` fails (`ESRCH`
  for an unknown key) and returns, that `ct` traps and the process dies
  with SIGILL [lcc, hw: `tools/abi/probes/ctxsig.c` section 1 on the 4C,
  8C2 and 2C3]. At `-O0`, or when the function is called through another
  name with `__asm__ ("setcontext")`, lcc keeps the code after the call.
  A compiler that wants lcc's behaviour can mark `setcontext` noreturn
  by name; one that doesn't is correct in both cases.
- **`__attribute__((cleanup))`**: lcc runs the cleanup only on a normal
  exit from the scope: not while a C++ exception unwinds through a C
  function, and not when the thread is cancelled or calls
  `pthread_exit` inside the scope (GCC with `-fexceptions` runs it in
  all of these). lcc emits no personality, LSDA or landing pad for it
  in C, with or without `-fexceptions`, at `-O0` and `-O2`, although
  `-fexceptions` makes it define `__EXCEPTIONS` for C as GCC does
  [lcc 1.29.16 and 1.31.05: `glibcbuild_lcc.py`; hw:
  `tools/abi/probes/glibcbuild_cancel.c`, 4C, 8C2, 2C3]. glibc's
  internal `__libc_cleanup_push` is such a cleanup whenever
  `__EXCEPTIONS` is defined (`sysdeps/nptl/libc-lockP.h:161-183`), so
  MCST's lcc-built libc never runs those handlers on cancellation
  ([stack-and-unwinding.md](stack-and-unwinding.md), "C cleanups and
  cancellation").
- **`__attribute__((no_caller_stack))`** (lcc only): for functions whose
  arguments and result all fit in registers; the caller may omit the
  argument area the convention otherwise reserves, so the callee must not
  use it.
- **v7**: `-mcheck-nv` makes v7 hardware trap when an operand that must
  be numeric carries another tag (default only in protected mode);
  `-mset-prepare-ct-delays-e48c` applies the 48C's prepare-to-transfer
  delays (default with `-mtune=elbrus-48c`), so those delays differ on
  that CPU.

## Pragmas (lcc-doc, lcc, gcc, unipro)

lcc's own pragmas, from **lcc-doc** `pragma_mcst.html` (1.29.16; 1.31.05
adds `apb_cache (N)`, `apb_aligned` and `no_rtmd`). lcc 1.29.16 and
1.31.05 accept the loop and asm pragmas silently under `-Wall -Werror`
(`tools/abi/probes/glibcbuild_lcc.py`) [lcc]. Uses are counted in
`OpenE2K/glibc`'s `sysdeps/e2k` and `sysdeps/unix/sysv/linux/e2k`, and
in `OpenE2K/linux`'s `arch/e2k` (lines, files), leaving out those a GCC
build never compiles: under an `#if` on `__LCC__` that is false for GCC,
or in a header only lcc includes (the script's survey):

| Pragma | Meaning (lcc-doc) | glibc E2K | Linux `arch/e2k` | For a GCC port |
|---|---|---|---|---|
| `loop count (N)` (the manual also writes `loop_count`) | the next loop runs about N iterations (ignored under `-fprofile-use`) | 223, 40 | 37, 17 | accept and ignore: GCC has no pragma for an iteration estimate |
| `unroll (N)`, `unroll` | unroll the next loop N times, or fully without N; also raises an unknown iteration estimate to N times the pipelining minimum | 84, 18 | 18, 7 | `GCC unroll N`; the bare form has no counterpart (below) |
| `noprefetch`; `prefetch` | no array prefetch (APB) for the loop's regular loads; or force it. Software prefetch is not affected | 122, 25; 0 | 3, 1; 0 | accept; a port that uses APB honours `noprefetch` (below) |
| `ivdep` | assume no loop-carried dependence where none is proven (1.31: ignored with `-m128`) | 0 | 16, 3 | `GCC ivdep` |
| `novector`; `vector always`, `vector aligned`, `vector unaligned`, `vector nontemporal` | no vectorising; force it, assume aligned (8 bytes on v1–v4, 16 from v5) or unaligned accesses, keep stores out of the caches | 0 | 6, 1; 3, 2 (`aligned`) | `GCC novector`; ignore the rest |
| `no_dam`, `no_rtmd` (1.31) | no data speculation (DAM), no run-time memory disambiguation in the loop | 0 | 4, 1 (`no_dam`) | ignore unless the port does either |
| `swp`, `noswp`, `comb_oper`, `no_comb_oper`, `cache_opt`, `no_cache_opt`, `reduce recurrence`, `spmv`, `nonesting`, `split_fuse` (ignored by lcc), `apb_cache (N)`, `apb_aligned` (1.31) | force or forbid software pipelining, combined operations, early loads in pipelined loops (`cache_opt`), recurrence breaking; mark a sparse matrix-vector loop; no loop nesting; the cache levels APB loads fill; APB loads aligned to their format | 0 | 0 | ignore |
| `asm_inline`, `no_asm_inline` | let lcc schedule the next `asm` with the code around it, or not (as `-masm-inline` does for all); anywhere but right before an `asm` they are error #3350 | 109, 74 (49 more in `bits/mathinline.h`, which `math/math.h:1344-1346` includes only for lcc); 6, 4 | 0; 2, 2 | ignore |
| `asm_length (N)` | the next `asm` takes N cycles (0–14) | 0 | 24, 2 (`barrier ()`, `asm/compiler.h:43-67, 152-158`) | ignore |
| `diag_suppress N` and the other `diag_*`, `diagnostic push`, `pop` | EDG's message numbers | 0 (8 `diag_suppress` in 7 generic files, lcc only) | 3, 1 | ignore |
| `unknown_control_flow (f)`, `no_inline (list)`, `hot (list)`, `no_side_effect (list)`, `no_instrument_function (f)`, `no_profile_instrument_function (f)` (all deprecated) | `returns_twice`, `noinline`, `hot`, nothing (ignored), `no_instrument_function`, `no_profile_instrument_function` | 0 | 0 | the attributes, if ever needed |

So a GCC build of glibc meets 544 lines in 113 of its E2K files. The
generic files MCST changed guard theirs: `stdlib/strtod_l.c`, `lshift.c`
and `rshift.c` (21 `loop count`) with `#if defined __e2k__ && defined
__LCC__`, the `diag_suppress`es and `locale/lc-ctype.c`'s
`no_asm_inline` with other `__LCC__` tests. glibc's E2K code puts
`asm_inline` or `no_asm_inline` before its asms
(`sysdeps/e2k/dl-machine.h:89-95`, `sysdeps/e2k/fpu/e_coshf.c:44`), the
kernel `no_asm_inline` and `asm_length` (`__no_asm_inline` is both,
`asm/compiler.h:43-101`; [kernel-build.md](kernel-build.md), "lcc's
pragmas"), and MCST's libgcc `no_asm_inline` (`__e2k_clear_cache`,
`config/e2k/clear-cache.c`). lcc in turn warns about GCC's loop pragmas
and ignores them (`GCC unroll`, `GCC ivdep`, `GCC novector`: warning
#1675 "unrecognized GCC pragma", under `-Wunknown-pragmas`, so an error
only with `-Werror`; lcc-doc `pragma_gnu.html`: not supported "since lcc
has its own"), and accepts `GCC diagnostic` without acting on it
(lcc-doc; glibc's makefiles work around that, e.g.
`stdlib/Makefile:235-241`) [lcc].

**lcc-doc** `pragma_gnu.html` covers only the pragmas of GCC 11.3's
manual (section 6.62), not GCC's preprocessor pragmas. lcc accepts
`#pragma GCC poison` without a word, also under `-Wall -Werror`, and
does nothing with it: a poisoned name can still be used and defined,
`#ifdef` and `defined` test it as any other name, and `lcc -E` passes
the pragma through. `GCC warning`, `GCC error` and `GCC dependency`
get warning #1675 (also without `-Wall`) and nothing else, so `GCC
error` doesn't stop the compile [lcc 1.29.16 (lcc and l++) and
1.31.05: `tools/abi/probes/folda55_poison.c`]. GCC rejects every use
of a poisoned name after the pragma, `#ifdef` included [gcc]. So code
built only by lcc may use names its own headers poison: MCST's qemu
7.2.0 tests `TARGET_E2K` in `include/hw/boards.h`, which
target-independent code includes too and where qemu poisons every
`TARGET_*` name, and `HOST_WORDS_BIGENDIAN` in
`hw/e2k/sim-iohub/e2k-chipset.h`, a name qemu 7.2 poisons everywhere
(`qemu/osdep.h`); lcc takes both as undefined [source]. This is GCC's front end, nothing for the port; such a package
tests the names only where they are allowed (under `NEED_CPU_H`;
qemu 7.2's `HOST_BIG_ENDIAN` in place of the other).

**Under `-Wall -Werror` lcc's pragmas are errors for other
compilers.** `-Wall` enables `-Wunknown-pragmas` (GCC
`c-family/c.opt:1599-1601`); every lcc pragma tried is an error with
the proof-of-concept GCC [gcc] and with GCC 16.2.1 on x86-64, and
with Unipro's clang except `unroll` with or
without N, which clang knows [unipro]. glibc builds with `-Wall` and, by
default (`--enable-werror`, `configure.ac:312-318`), `-Werror`
(`Makeconfig:913-929`); the kernel likewise
([kernel-build.md](kernel-build.md), "What a GCC build meets first"). So
a GCC build of glibc stops at the first E2K string or math file unless
the compiler registers the pragmas, glibc is configured with
`--disable-werror`, or `-Wno-unknown-pragmas` is added. GCC does not
report a `_Pragma` that comes from a macro defined in a system header:
user code that expands the installed `fpu_control.h` (`_FPU_GETCW` and
the like, lines 86-89) or `bits/fenv.h` (`__fenv_getpfpfr` and the like,
lines 95-102) builds cleanly under GCC's `-Wall -Werror`, and fails only
when the header is included from a non-system directory, as glibc's own
build includes `sysdeps/e2k/fpu/fpu_control.h:88-91`, or with
`-Wsystem-headers` [gcc; GCC 16.2.1 on x86-64]. Unipro's clang reports
them from the installed headers too [unipro].

How a GCC port registers them matters [source, gcc]. GCC's C and C++
parsers take only `GCC unroll`, `GCC ivdep` and `GCC novector` between
such a pragma and its loop (`gcc/c/c-parser.cc:16291-16354`,
`gcc/cp/parser.cc:57772-57850`), so a pragma registered the usual way
(`c_register_pragma`, deferred: the parser sees it as a token) after a
mapped one is "for, while or do statement expected" ("'#pragma' is not
allowed here" in C++) [gcc: GCC 16.2.1 on x86-64]. glibc's E2K string
functions have 52 such runs and the kernel's `arch/e2k` 10: `unroll
(N)` or `ivdep`, then `loop count (N)`, sometimes `noprefetch`;
`asm/xor.h` puts `loop count` between `ivdep` and `unroll (1)` [glibc,
kernel: `tools/abi/probes/foldp101_pragma_runs.py`]. A pragma the port
ignores therefore belongs in the preprocessor (`cpp_register_pragma`,
which runs a handler and leaves no token, as Darwin's `#pragma mark`,
`gcc/config/darwin.h:1199-1203`, when not only preprocessing). The
mapped ones are deferred pragmas with GCC's ids (`PRAGMA_UNROLL`,
`PRAGMA_IVDEP`, `PRAGMA_NOVECTOR`; `gcc/c-family/c-pragma.cc:1857-1867`).
lcc's bare `unroll`, which lcc and l++ accept (l++ inside templates
too) [lcc], has no GCC counterpart. GCC's unroll pragma needs a count in
C and C++, so a port that maps lcc's `unroll` to `PRAGMA_UNROLL` makes
the bare form an error ("expected expression before end of line" in C,
"expected primary-expression" in C++), while GCC for other targets
ignores it as an unknown pragma, with a warning under `-Wall` [gcc: the
proof of concept; GCC 16.2.1 on x86-64]. `OpenE2K/glibc` and MCST's
libgcc E2K files have none. In the kernel tree only BPF selftest
programs use it (14 lines in 3 files), and clang or bpf-gcc builds
those for the BPF target [glibc, kernel:
`tools/abi/probes/foldp101_pragma_runs.py`; libgcc].

Ignoring them loses only hints, except perhaps `noprefetch` in a port
that uses array prefetch: lcc `-O3` puts `bap` and two `mova`s into
glibc's `strlen` loop shape for `v5.8c2` and `v6.2c3` and none with
`noprefetch` (`loop count (8)` and `unroll (1)` alone leave them; lcc's
`v3` code has no APB in that loop) [lcc 1.29.16, 1.31.05]. glibc's
comment gives the reason as "otherwise APB is applied, 1 cycle"
(`sysdeps/e2k/strlen.c:77`): presumably APB costs these short string
loops more than it gains (inferred; neither loop was timed).

## Where lcc's C and C++ differ from GCC's (lcc, lcc-doc, gcc, source, hw)

lcc's front end is EDG's (`__EDG__`, "Predefined macros"). Code
written for lcc may rely on the differences below, and then doesn't
build, or computes something else, with GCC. None of them is ABI: such
code is fixed in the package (owner, 2026-11-02: GCC gets no lcc
compatibility for the sake of packages). What GCC has and lcc lacks is
in the next section; how lcc treats GCC's pragmas is in "Pragmas".

### Language standards and old C (lcc-doc, lcc, gcc)

lcc compiles C as `-std=gnu18` and C++ as `-std=gnu++17` unless told
otherwise, "nominally compatible" with GCC 11.3 and its libstdc++; it
calls its C23 support minimal and its C++20 support experimental
(**lcc-doc** `lang_std.html`). The C default dates from 1.26 (1.25:
`gnu11`), the C++ one from 1.28 (1.24–1.27: `gnu++14`, before:
`gnu++98`) (**lcc-doc** `changelog_124.html`, `_126`, `_128`). lcc
1.29.16 and 1.31.05 predefine `__STDC_VERSION__` 201710L and
`__cplusplus` 201703L, and no `__STRICT_ANSI__` [lcc]. GCC 17.0.0, the
proof-of-concept's base, defaults to `gnu23` and `gnu++20` (202311L,
202002L; `gcc/c-family/c-opts.cc:265-266, 278-280`) [gcc].

lcc accepts the old C that GCC 14 and later reject unless given
`-fpermissive` (the default only for `-std=c89` and `gnu89`;
`gcc/doc/invoke.texi:6843-6864`) [lcc 1.29.16 v3, v5.8c2, 1.31.05 v3;
gcc: `tools/abi/probes/folda47_dialect.c`]:

| Construct | lcc | GCC: error under |
|---|---|---|
| implicit `int` in a declaration (`static x = 1;`, `f (void) {…}`) | no diagnostic; warning #260 with `-Wall` | `-Wimplicit-int` |
| an old-style parameter without a type (`int g (p) {…}`) | warning #1051 | `-Wimplicit-int` |
| a call to an undeclared function | warning #223 | `-Wimplicit-function-declaration` |
| an integer returned from a pointer function | warning #3311 | `-Wint-conversion` |
| a `long *` returned as `int *` | warning #3309 | `-Wincompatible-pointer-types` |
| `return;` in an `int` function | warning #117 | `-Wreturn-mismatch` |
| a parameter name without a type in a declaration (`void f (i);`) | warning #92 | `-Wdeclaration-missing-parameter-type` |

C's `bool` without `<stdbool.h>` is error #20 ("identifier "bool" is
undefined") in lcc and a keyword in C23. Configure scripts see that:
ncurses 6.4's, run with GCC's C23, finds that C has a `bool` of its own
(`configure.in:1927`, `1992-2004`), and its `curses.h` then defines
`bool` as `NCURSES_BOOL` (`unsigned char`) for C++ too
(`include/curses.h.in:272-291`), which libstdc++'s C++20 `<concepts>`
rejects [source]. OS Elbrus's packages are written for lcc's dialects;
a GCC that builds them gives lcc's answers to the probe's cases with
`-std=gnu17 -fpermissive` for C and `-std=gnu++17` for C++ [gcc]. That
concerns building those sources, not the ABI: the port's own defaults
stay GCC's (for the installed `fenv.h` under C23, "Headers" below).

### Bit-fields wider than `int` (lcc, gcc, hw)

lcc gives a bit-field of 33–63 bits its declared type in expressions
(`unsigned long long`, `long`), as clang and C++ do. GCC's C gives it
a type of exactly the field's width (C11 6.7.2.1p10, as GCC reads it),
so `<<`, `~`, `+` and `*` wrap there, and for a signed field overflow
there:

| `u64 ip : 45` = 0xe20000080830 >> 3 | lcc, clang, C++ | GCC's C |
|---|---|---|
| `ip << 3` | `e20000080830` | `20000080830` |
| `~ip` | `ffffe3bffffefef9` | `3bffffefef9` |
| `ip + ip` | `38800002020c` | `18800002020c` |
| `(ip << 3) > 0x100000000000` | 1 | 0 |
| `(u64) ip << 3` | `e20000080830` | `e20000080830` |
| `long h : 36` = 0x7ffffffff, `h << 12` | `7ffffffff000` | `fffffffffffff000` |

A field of up to 31 bits promotes to `int` and one of 32 bits stays
`unsigned int` in both (`a << 16` of a 20-bit 0xfffff is
`ffffffffffff0000`; a 32-bit `b << 4` and `b + 1` wrap at 32 bits in
both). A 64-bit field is `unsigned long long` in both, and `sizeof` of
a 33–63-bit field's expression is 8 in both [lcc 1.29.16 v3 at `-O0`
and `-O2`, l++, v5.8c2; 1.31.05 v3; hw:
`tools/abi/probes/folda42_bitfield.c`, 4C, 8C2; gcc: GCC 16.2.1 on
x86-64 and the proof-of-concept back end; clang 22]. Code built by GCC
casts such a field to its declared type before arithmetic that can
exceed the field's width. MCST's kernel relies on lcc's rule
([kernel-build.md](kernel-build.md), "Wide bit-fields"). The layout is
the same in both ([data-layout.md](data-layout.md), "Bit-fields").

### Shift counts of the width or more (lcc, gcc, glibc, hw)

lcc compiles a C shift by a count it can't see as the hardware
operation, which takes the count modulo 64 (32 for 32-bit shifts;
[semantics.md](../isa/semantics.md), "Shifts and rotates"): `if (x &
0x80) return 1ULL << x;` is a `shld` of x, so x = 0x81 gives 2. A
count that inlining makes constant folds the same way (`v << 70`
becomes `scld 1, 6`); only a literal constant expression (`1ULL <<
64`) folds to 0, with warning #63 [lcc 1.29.16 v3 and v5.8c2 at `-O0`
to `-O3`, v6.2c3 `-O3` (`-S`); 1.31.05 v3 `-O3`; hw:
`tools/abi/probes/folda43_shift.c`, 4C, 8C2]. For GCC such a shift is
undefined, and its optimizers use that: that function returns 0, and
from `1LL << spec` they conclude `spec < 64`. `SHIFT_COUNT_TRUNCATED`
only lets RTL drop a mask [gcc: the proof-of-concept back end, which
defines it, at `-O2` (at `-O0` it gives the hardware's result); GCC
16.2.1 on x86-64 from `-O1`]. MCST glibc relies on lcc here:
`strcspn`, `strpbrk` and `strspn` (`sysdeps/e2k/strcspn.c:100-125`,
`strpbrk.c:106-130`, `strspn.c:101-125`), for a set of more than 8
bytes (16 on v6), build a 256-bit table with `1LL << spec` for bytes
up to 255 and test bytes the same way. Built by GCC they miss every
byte from 0x40 up (`strcspn ("xyzzyc", "abcdefghi")` is 6), which
broke busybox ash's word splitting (the proof-of-concept back end's
finding A43; `& 63` on both counts fixes them: `OpenE2K/glibc` branch
`glibc-2.35-mcst-gcc`, 3600718857e). Code built by GCC masks such
counts (`& 63`); `-fsanitize=shift` finds more at run time.

### What lcc accepts and GCC doesn't (lcc, gcc)

lcc 1.29.16 (v3, v5.8c2) and 1.31.05 (v3) take these without a word,
also under `-pedantic-errors` (with `-std=c11` or `-std=c2x` in C,
`-std=c++17` in C++); x86-64 GCC 16.2.1 and the proof-of-concept GCC
reject them [lcc, gcc: `tools/abi/probes/folda56_const.c`,
`folda58_memberns.cc`]:

| Construct | lcc | GCC | Met in |
|---|---|---|---|
| A statement expression of constants (qemu 7.2's `MAX`) where C wants an integer constant: a block-scope array's bound, a `case` label, a block-scope `static` array's bound, `_Static_assert` | folds it to a constant, so the array is no VLA and may be initialized (`char label[MAX (30, 20) + 32] = "label=";` is 62 bytes); at file scope it is error #1166 "statement expressions are only allowed in block scope", and a real VLA still can't be initialized (#145) | never a constant: the array is a VLA ("variable-sized object may not be initialized except with an empty initializer"), the others are errors | MCST's qemu 7.2.0, `target/e2k/boot` (`BOOT_STRING_SIZE`) |
| A C `const` integer variable with a constant initializer, taken as an integer constant as in C++: in `aligned (…)`, a file-scope array's bound, an enumerator, a `case` label, a block-scope array's bound | takes it: `.align 4096`, a 4096-byte array, an initialized block-scope array that is no VLA | errors ("requested alignment is not an integer constant", "variably modified … at file scope", "enumerator value … is not an integer constant", the VLA error), also with `-std=gnu17`; only the `case` label is taken, as an extension (a `-Wpedantic` warning) | MCST's kexec-e2k 1.0.1 (`aligned (alignment)`) |
| A member function defined by its qualified name in a namespace that doesn't enclose its class: an unnamed one, an unrelated named one, an unnamed one inside the class's | takes it and gives it the usual global symbol (`N::S::f`: `GLOBAL DEFAULT _ZN1N1S1fEv`); a static data member or a namespace's function defined that way is error #551 "… cannot be defined in the current scope" | a permerror, static data members included ("definition of … is not in namespace enclosing …", `gcc/cp/decl.cc:12189`): with `-fpermissive` a warning and the same symbol; the namespace's function is an error in GCC too | MCST's LibreOffice 6.3 E2K bridge (`cpp2uno.cxx`: `VtableFactory`'s members in an unnamed namespace) |

C23's `constexpr` is no way out that both take: GCC 16 with `-std=c23`
still says "requested alignment is not an integer constant" for
`aligned` of a `constexpr` variable, and lcc doesn't know `constexpr`
in C (error #20) [gcc, lcc]. These are front-end rules, the same on
every GCC target, so a port has nothing to do: code that relies on
them is fixed in the package (a macro or an enumerator for the
constant, as qemu's `MAX_CONST`; the namespace closed before the
definitions).

## GNU extensions lcc lacks (lcc, lcc-doc, unipro)

lcc 1.29.16 and 1.31.05 (v3, v5.8c2, v6.2c3, `-O2`) reject GNU nested
functions in every form: one that is only called, one whose address
escapes and that uses its parent's variable, and one whose address
escapes but uses nothing from its parent. All three stop at the nested
definition with `error #65: expected a ";"`
(`tools/abi/probes/execstack/nested-*.c`, compiled by
`tools/abi/probes/execstack.sh`). `-fnested-functions`, `-ftrampolines`
and `-ftrampoline-impl=heap` are "unrecognized command line option"s,
and the manual lists `-Wtrampolines` as ignored (lcc-doc,
`lcc_options.htm`). So there is no nonlocal `goto` out of a nested
function either. Unipro's clang rejects nested functions too ("function
definition is not allowed here"). `__builtin_setjmp`,
`__builtin_longjmp` and `__builtin_apply` are "unknown built-in
function"s (lcc 1.29.16 and 1.31.05). No E2K code depends on any of
them and there is no ABI to match, so a new compiler may leave them out
at first. A nested function whose address escapes needs a trampoline
([gcc-port-plan.md](../../doc/gcc-port-plan.md), D1, "Trampolines"),
and a trampoline on the stack needs an `"x"` GNU-stack note
([elf.md](elf.md), "Executable stack"). Nonlocal `goto` and
`__builtin_longjmp` also need the chain stack unwound, which glibc's
`longjmp` does through the kernel. A `jmp_buf` whose saved IP is
replaced by a label's address re-enters the frame there
([stack-and-unwinding.md](stack-and-unwinding.md)).

lcc's output never needs an executable stack (inferred from these
probes and from lcc never writing the note). Its Fortran (`lfortran`,
1.29.16 and 1.31.05) passes an internal procedure as an actual argument
(Fortran 2008) without a trampoline. It passes a static thunk
(`__outer__add__thunk_1`), which reaches the host's variables through a
`.bss` slot (`__outer__add__ext_1`); before the call the host stores
there the address of the variable (`total`). The slot stays static with
`-frecursive` and `-fopenmp`, so two threads in the host share it
(inferred). By default lfortran rejects such an argument in a
`recursive` host ("Internal procedure 'add' is used as actual argument
at (1) in recursive procedure 'outer'"). That is MCST's check
`-ffortran-check-internal-func` (lcc-doc; that it is on by default is
inferred from this error). `-fno-fortran-check-internal-func` accepts
the host, and the code still uses the one static slot, so a recursive
activation would overwrite its caller's (inferred)
(`tools/abi/probes/execstack/internal.f90`, `internal-rec.f90`). GCC's
gfortran has no such error, only an F2008 notice
(`gcc/fortran/resolve.cc:2142-2149`). It lowers internal procedures to
nested functions, so passing one needs a trampoline (inferred).

**Labels as values** are different in lcc: `&&label` is the label's
index among the address-taken labels of its function (0, 1, 2, ...),
not a code address, and `goto *p` dispatches on that index (probed
with lcc 1.29.16 at `-O0` and `-O2`: a table `{ &&a, &&b, &&c }` holds
0, 1, 2 and computed goto through it works). Code that keeps label
values only for `goto *` in the same function works with either
compiler; code that prints them, compares them across functions or
uses them as code addresses (GCC's documented uses for profiling or
`__builtin_return_address` comparisons) gets 0, 1, 2 from lcc.
At `-O3` every `goto *p` of a function branches to one shared block:
a range check of the index (`cmpbedb` against the highest index, an
`ibranch` out when it fails), `sxt` and `shld`, a load of the code
address from a second, compiler-made table (`.T.N`), and `movtd,0,sm`
into `%ctpr1` with the `ct` 9 cycles later. Lua 5.4.7's `vmfetch`
handlers in `luaV_execute` each load the index (from `disptab`, some
under a predicate) and branch to that block: about 28 cycles on v6
from loading the instruction word to the transfer (lcc 1.29.16 `-O3`,
v3 and v6.2c3; the proof-of-concept back end's P72) [lcc]. A GCC port
that keeps `&&label` a code address saves the index load, the range
check and the second table.

## Headers (source)

The e2k `bits/fenv.h` in lcc's sysroot (and in `OpenE2K/glibc`,
`sysdeps/e2k/fpu/bits/fenv.h`) defines `femode_t` only under
`__GLIBC_USE (IEC_60559_BFP_EXT)`, while `fenv.h` declares `fegetmode`
under `__GLIBC_USE (IEC_60559_BFP_EXT_C2X)`, as x86's copy does for
both. So `#include <fenv.h>` fails under `-std=c23` / `gnu23` (GCC's
default) without `_GNU_SOURCE`: "unknown type name 'femode_t'". lcc
1.29.16 fails the same way under `-std=c2x` [lcc; hw]. The header is
the same in lcc 1.29.16's v3, v5.8c2 and v6.2c3 sysroots, in
`/usr/include` on the 4C and the 8C2 and in `OpenE2K/glibc`, except for
its copyright comment: one line in the sysroots, three on the machines
and in `OpenE2K/glibc`, whose copies are byte-identical. In each, the
line to change is the `#if __GLIBC_USE (IEC_60559_BFP_EXT)` before
`femode_t` (line 104 in the sysroots, 106 elsewhere), which must read
`IEC_60559_BFP_EXT_C2X` [glibc, lcc; hw]. lcc 1.31.05's
glibc 2.41 already guards `femode_t` with `IEC_60559_BFP_EXT_C23` (line
118) and needs nothing.

A port can do without `-std=gnu17` or `-D_GNU_SOURCE` by a fixincludes
rule for `e2k*-*-linux*` that rewrites that exact line of `bits/fenv.h`
and skips a file that already names `IEC_60559_BFP_EXT_C2X`. GCC runs
fixincludes over the target's headers when it is built, so the rule
covers a cross sysroot and, for a native compiler, the machine's own
`/usr/include`. The proof-of-concept back end's rule
(`glibc_e2k_femode`, gcc-claude `d5d98c3c4a9`) fixes only `bits/fenv.h`
there, and its native compilers on the 4C and the 8C2 compile
`#include <fenv.h>` under `-std=c23` [gcc; hw]. Without a fix,
libquadmath still builds, but without `<fenv.h>`: its `configure`
(`AC_CHECK_HEADERS(fenv.h)`, `libquadmath/configure.ac:139`, autoconf
2.69) finds the header present but not compilable and leaves
`HAVE_FENV_H` undefined. The library then ignores the rounding mode,
and `fmaq` loses its round-to-odd step (`quadmath-imp.h`'s fallbacks;
inferred from GCC's source, not built). `config.h`'s `_GNU_SOURCE`
doesn't help: `quadmath-imp.h` includes `<errno.h>` and `<stdlib.h>`
before `config.h`.
