# 32-bit mode (`-mptr32`, e2k32)

**For completeness only: the GCC port targets 64-bit unprotected mode.**
This document records how lcc's 32-bit mode differs from the 64-bit ABI
of the other documents in this directory; anything it doesn't mention
is as there ([README.md](README.md)). Protected mode (`-mptr128`) is a
different mode ([protected-mode.md](protected-mode.md)). v7 is out of
scope.

Marks as in [README.md](README.md). **kernel** paths are relative to
`OpenE2K/linux/arch/e2k/` (generic files start with `linux/`), **glibc**
paths to `OpenE2K/glibc/`. Line numbers are those of the submodules'
current commits.

Probes, in `tools/abi/probes/mode32/` (`run.sh [TARGET] --remote HOST
[--ssh-port N] [--ship-libs]` builds and runs them all):

| Probe | What it shows |
|---|---|
| `layout32.c` | the data layout, as `_Static_assert`s; must compile with `lcc -mptr32 -c` |
| `callconv32.c` | the calling convention and code sequences, read with `lcc -mptr32 -S` (and `-fPIC`) |
| `run32.c` with `run32-lib.c`, `run32.h` and `mode32.s` | sizes, calls across a shared library, system calls through each entry, signals, `ldgd*` and `getpl` at run time, TLS, threads, atomics, contexts, the address space. Built as `run32` (dynamic), `run32s` (static), `run32t` (static, `-D_TIME_BITS=64 -D_FILE_OFFSET_BITS=64`) and `run64` (the same probe as a 64-bit program, without the `ldgd*` and `getpl` tests) |
| `cxx32.cc` | a C++ exception through four frames, dynamic and static |
| `dlmix.c` with `mixlib.c` | linking and `dlopen` across the modes; `dlmix32pie` is a 32-bit PIE |
| `rt32.c` | lcc's AddressSanitizer, OpenMP and `-pg` runtimes |
| `lat32.c` with `gen_lat32.py` (writes `lat32.s`, `lat32-v5.s` and their `-cases.h`) | the latencies of `ldgd*`/`stgd*` against `ld*`/`st*`, store–reload steps, load and store issue, and `getpl` → `ct`/`call` against `movtd` and `disp`, all in one 32-bit process ("Timing"); `run.sh` runs it under the shared timing lock |
| `asan32.c` | replays compiler-rt's start-up check of `/proc/self/maps` on the process's own maps ("C runtime") |
| `atom32.c` | 16-byte atomics: what lcc emits (`-S`), and two threads adding to one `__int128` while a third counts torn loads; `atom32mix` and `atom32mixlock` mix v3 and inline code on one object ("16-byte atomics") |
| `dbg32.c` with `dbg32.gdb` and `dbg32.sh` | gdb on 32-bit programs (dynamic and static), `gcore`, and kernel core dumps after `abort` and `SIGSEGV` ("C runtime") |

**hw** here means lcc 1.29.16's `e2k-v3` code on the 4C (static, and
dynamic through lcc's own `lib32` ld.so: `run.sh --ship-libs`),
`e2k-v5.8c2` code on the 8C2 and `e2k-v6.2c3` code on the 2C3 (dynamic
and static) print the same, unless a row names a machine.

## Summary

| | 32-bit mode | 64-bit mode |
|---|---|---|
| lcc option; macro | `-mptr32` (`-m32`); `__ptr32__` | `-mptr64` (`-m64`, the default); `__ptr64__`, `_LP64` |
| `long`, pointers, `size_t` | 4 bytes | 8 bytes |
| Memory access | `ldgd*`/`stgd*`: two 32-bit operands, summed modulo 2³², relative to `GD` | `ld*`/`st*`: a 64-bit address |
| Indirect call | `getpl %rN, %ctprN` | `movtd %drN, %ctprN` |
| Narrow integer arguments and results | not extended: the 32-bit value, written under `dbl = 0` | extended to 64 bits |
| ELF | `ELFCLASS32`, `e_machine` 175, the same `e_flags` | `ELFCLASS64` |
| Dynamic linker | `/lib32/ld-linux.so.2` | `/lib64/ld-linux.so.2` |
| System calls | entry 1, fast calls entry 5 | entry 3, fast calls entry 6 |
| Executable's TLS | TP + 8 (8-byte TCB) | TP + 16 |
| User addresses | below `0xf000_0000` (`TASK32_SIZE`) | below `0xd000_0000_0000` |
| `time_t`, `off_t` | 32 bits; 64 with `_TIME_BITS=64` and `_FILE_OFFSET_BITS=64`, but times past 2038 still fail | 64 bits |

## Running 32-bit programs

| Item | Fact | Source |
|---|---|---|
| Kernel | `CONFIG_BINFMT_ELF32` selects the generic compat ELF loader and `CONFIG_COMPAT` depends on it; all three machines' kernels have both (and `CONFIG_PROTECTED_MODE`) | kernel `Kconfig:861-869`; [hw: `/proc/config.gz`] |
| Elbrus Linux (8C2, 2C3) | ships `/lib32` (21 files: `ld-linux.so.2`, `libc.so.6`, `libm.so.6`, …) and `/usr/lib32` (start files, `libgcc_s`, `libomp`, `libgfortran`, …) | [hw: `ls`] |
| ALT Linux (4C) | `/lib32` is a link to an empty `usr/lib32`, so a dynamic 32-bit program fails with `cannot execute: required file not found`. Static programs run, and dynamic ones run when lcc's `fs/lib32/ld-linux.so.2` and libraries are copied over and the program is started as `./ld-linux.so.2 --library-path . ./prog` | [hw: 4C, kernel `6.1.158-mcst-e4c-alt1.9.1`] |
| MCST's qemu-e2k | loads only `ELFCLASS64`: "Invalid ELF image for this architecture" | qemu-e2k-mcst `linux-user/e2k/target_elf.h:9`; [run] |
| Community qemu-e2k32 | runs lcc's 32-bit programs: calls, variadic calls, TLS, threads, atomics, C++ exceptions, `_TIME_BITS=64`, a PIE (at `0xa000_1c00`). It differs from the hardware: a call through entry 3 or 6 stops qemu ("QEMU internal SIGSEGV {code=ACCERR, addr=0xe0001800}"); there is no `GD` bound (an `ldgdw` at `0xf000_0000` + x is `SEGV_MAPERR` at that address); all 4 GiB can be mapped; `makecontext_e2k` returns −1; the auxiliary vector has no `AT_FAST_SYSCALLS` or `AT_SYSTEM_INFO`; the signal frame is laid out differently; and `ftruncate64` past 2 GiB succeeds without `O_LARGEFILE`. With a `RUNPATH`, its ld.so falls back through `-L` to the host's `/etc/ld.so.cache`, so give `-E LD_LIBRARY_PATH=` with the sysroot's `lib32` directories (`run.sh` does) | qemu-e2k-community `configs/targets/e2k32-linux-user.mak`, `target/e2k/cpu-param.h:10-14`; [run: `run.sh` without `--remote`] |

Unipro's clang lists an `e2k32` target, but `--target=e2k32-linux`
stops with "e2k32 target is not supported yet", so lcc is the only
reference here [unipro 20.1.8].

## Data layout (guide 9.2.1, 9.2.3; lcc; hw)

`layout32.c` compiles with `lcc -mptr32`, and `run32` prints the same
sizes on the three machines and under qemu-e2k32. The guide's mode-32
tables agree.

| Type | 32-bit size/align | 64-bit |
|---|---|---|
| `long`, `unsigned long` | 4/4 | 8/8 |
| pointers, function pointers, `size_t`, `ptrdiff_t`, `intptr_t` (`int`), `va_list` | 4/4 | 8/8 |
| `long long`, `double` | 8/8 (not 4 as on i386) | 8/8 |
| `__int128`, `long double`, `__float128` | 16/16 | 16/16 |
| `_Complex float`, `_Complex double` | 8/4, 16/8 | the same |
| `max_align_t` | 32/16 | 32/16 |
| `struct { char c; long long ll; }` | 16/8, `ll` at 8 | the same |
| `struct { long a : 3; char c; }`, `struct { char c; long a : 30; }` | 4/4, 8/4: a `long` bit-field has a 4-byte container | 8/8, 8/8 |
| `char`; `wchar_t` | signed; signed `int` | the same |

Every other rule of [data-layout.md](data-layout.md) holds.

glibc's types [hw: `run32`, `run32t`, `run64`]:

| Type | 32-bit | `_TIME_BITS=64` | 64-bit |
|---|---|---|---|
| `time_t`, `off_t` | 4/4 | 8/8 | 8/8 |
| `clock_t` | 4/4 | 4/4 | 8/8 |
| `struct timespec` | 8/4 | 16/8 | 16/8 |
| `struct stat`, `struct stat64` | 80/8, 88/8 | 112/8 | 128/8 |
| `sigset_t`, `siginfo_t` | 128/4 | 128/4 | 128/8 |
| `jmp_buf`, `sigjmp_buf` | 80/8 | 80/8 | 80/8 |
| `ucontext_t` | 4040/8 | 4040/8 | 4056/8 |
| `stack_t`, `struct sigaction` | 12/4, 140/4 | the same | 24/8, 152/8 |
| `pthread_t`, `pthread_mutex_t`, `pthread_attr_t` | 4/4, 24/4, 36/4 | the same | 8/8, 40/8, 56/8 |
| C++ `std::string` | 24 | | |

`mcontext_t` (5,296 bytes; 64-bit 5,216) is glibc's SPARC leftover in
both modes; the real context is the `struct sigcontext` in
`ucontext_t` ("Signals", below). `malloc` returns 16-byte-aligned blocks
in both modes (glibc `sysdeps/e2k/nptl/malloc-alignment.h:23`), and the
stack is 16-byte aligned (guide 9.1.4.5; [hw: `getsp` values]).

## Addresses and memory access (guide 9.1.2–9.1.4, 10.6.2, 10.9.2; kernel; lcc; hw)

In 32-bit mode the `GD` (globals) and `CUD` (code) descriptors cover the
whole task, and a pointer is a 32-bit offset from them (guide 9.1.3).
For a 32-bit task the kernel fills the compilation-unit table entry with
code and data base 0 and size `TASK32_SIZE` = `0xf000_0000`, so an
offset is the address (kernel `kernel/process.c:666-672`,
`include/asm/ptrace.h:32`). The entry's index (CUI) is 1 on v3–v5 and 0
on v6 and later; 64-bit tasks use 0 (`include/asm/head.h:181-184`,
"bug 114501"). Only v7's `CUD` has a mode field (`va32`; `cud_m32`,
`include/asm/cpu_regs_types.h:108-112`).

| Operation | What it does | Source |
|---|---|---|
| `ldgdb`, `ldgdh`, `ldgdw`, `ldgdd`, `ldgdq` (v5: `ldgdqp`) | load from `GD.base` + ((src1 + src2) mod 2³²); both operands are 32-bit (registers or literals). Channels ALC0, 2, 3, 5; in ALC0 and ALC3 each takes an ALES half-syllable, which a plain `ld*` doesn't | guide 9.1.2, 10.6.2.1; [reservations.yaml](../isa/reservations.yaml) |
| `stgdb`, `stgdh`, `stgdw`, `stgdd`, `stgdq` (v5: `stgdqp`, `stgdmqp`) | store to the same address; ALC2, 5 | guide 10.6.2.2; reservations.yaml |
| The sum wraps | `ldgdw (gvar + 16) + 0xffff_fff0` and `ldgdw 0x8000_0000 + (gvar + 0x8000_0000)` both read `gvar` | [hw: `run32`] |
| The bound | `ldgdw 0xefff_fff0` is an ordinary fault (`SEGV_MAPERR`, `si_addr` = that address); `ldgdw 0xf000_0000` and `0xffff_fff0` are `SIGSEGV` `SEGV_BNDERR` with `si_addr` = the address of the `ldgdw` itself. The usable range is [0, `0xf000_0000`) | [hw: `run32`]; kernel `kernel/traps.c:1296-1305`, `include/asm/traps.h:24-38` |
| Ordinary `ld*`/`st*` | work in a 32-bit process (`ldw` and `stw` of `gvar` by its 64-bit address). A fault above 4 GiB reports `si_addr` cut to 32 bits (`gvar` + 2³² reports `gvar`), because the compat `siginfo_t` has a 32-bit `si_addr` | [hw: `run32`]; kernel `kernel/signal.c:442` |
| `getpl %rN, %ctprN` | prepares a call or branch to `CUD.base` + `%rN` (a 32-bit operand; into a CTPR only in ALC0, [bundle.md](../isa/bundle.md)). This is how lcc calls through a function pointer, with the `call` 9 cycles later (`nop 7` and an empty instruction): a `ct` or `call` waits until 9 cycles after a `getpl`, as after 64-bit code's `movtd` ("Timing") | guide 9.5.3, 10.9.2; [lcc: `c_indirect`]; [hw: `run32` "getpl into %ctpr1 and call"; `lat32`] |
| `getpl %rN, %drM` | never emitted by lcc. v3–v5: a 64-bit procedure label in `%drM`, the address with tag `0xA` (`ETAGPLD`); `%drM+1` is left alone, and an odd M works. v6: a 128-bit label in an even pair: the low word is the address with bit 61 set (`itag` 1), the high word 0 (the CUI), tags `0xF` and `0xF` (`ETAGPLQ`); an odd M is `SIGILL` `ILL_ILLOPC` | [hw: `run32`; 4C, 8C2: tag `a`; 2C3: `0x2000_0000_0001_4638`, tags `f0f`]; kernel `include/asm/e2k_ptypes.h:153-197`, `include/asm/tags.h:17-18,50,61` |
| In a 64-bit process | not usable: `ldgd*` and `stgd*` are `SIGSEGV` `SEGV_BNDERR`, and `getpl` into a register `SIGILL` `ILL_ILLOPN`, with the semantics probe's operands ([semantics.md](../isa/semantics.md); 4C, 8C2, 2C3). (inferred:) up to v6 the `GD` and `CUD` size fields are 32 bits, and the kernel gives a 64-bit task's entry the size `TASK_SIZE` = `0xd000_0000_0000`, whose low 32 bits are 0. The probes here run `ldgd*` and `getpl` only in 32-bit processes | kernel `include/asm/cpu_regs_types.h:81-135`, `include/asm/cpu_regs.h:869-880` |

What lcc's 32-bit code does [lcc: `callconv32.c`; `objdump` of lcc's
`fs/lib32/libc.so.6`]:

- **Every data access is an `ldgd*` or `stgd*`**: globals, the stack,
  the heap, constants, `va_arg` (guide 9.1.4). The 32-bit `libc.so.6`
  has 51,844 `ldgdw`, 24,495 `stgdw`, 17,036 `ldgdb`, 5,556 `ldgdd`, …
  and no plain `ld*`; its only `std` are the 362 `std 0x0, 0x0, %drN,
  mas = 0x1f` that the 64-bit `libc.so.6` has too (293 there).
- **No `ldcud`.** The guide (9.1.4.3) reads constants placed in the
  text segment with `LDCUD`; lcc puts them in `.rodata` and uses
  `ldgd*`.
- **Pointers are 32-bit values in `%rN`**, added with `adds`/`subs`
  (wrapping at 32 bits) and compared with `cmpbsb`; an index is often
  the second operand of the `ldgd*` itself. `getsp` returns a 64-bit
  value, below `0xf000_0000`.
- **Globals in non-PIC code** use the address as a 32-bit literal:
  `ldgdw 0x0, [ _f32s,_lts1 g ], %r0` (guide 9.1.4.1).

### Timing [hw: `lat32`; 4C `e2k-v3.4c` and `e2k-v3`, 8C2 `e2k-v5.8c2`, 2C3 `e2k-v6.2c3`; six runs on each machine, every line identical but one 8C2 value of 4.94 for 5.00]

`lat32.c` times each case in one 32-bit process: chains of a producer
and its consumer `g` cycles later, 16 and 32 steps, the difference
giving the cycles a step. A step costs `g` from the latency `L` on and
`g + 4 × ceil((L − g) / 4)` below it ([timing.md](../isa/timing.md),
"Stalls cost more than the latency"); `L` below is the smallest `g`
from which every step costs `g`.

| Producer → consumer | 32-bit form | 64-bit form, same probe | 4C (v3) | 8C2 (v5) | 2C3 (v6) |
|---|---|---|---|---|---|
| load → the next load's address, same channel: the base (`ldgdw` in ALC0, 2, 3 or 5; `ldgdd` in ALC0, through its low word) or the index (`ldgdb`, `ldgdh`, `ldgdw`, `ldgdd` in ALC0) | `ldgd*` | `ldb` … `ldd` | 3 | 3 | 5 |
| the same with the sum wrapping past 2³² (`ldgdw %r9, %r6, %r9`, `%r6` = `0x8000_0000`) | `ldgdw` | — | 3 | 3 | 5 |
| load → load address in the other cluster (ALC0 ↔ ALC3) | `ldgdw` | `ldd` | 4 | 4 | 5 |
| load → integer op | `ldgdw` → `adds` | `ldd` → `addd` | 3 | 3 | 5 |
| integer op → load address | `adds` → `ldgdw` | `addd` → `ldd` | 1 | 1 | 1 |
| register-pair load → load, through its low word | `ldgdq` | `ldq` (v5+) | 3 | 3 | 5 |
| 16-byte load → load, through its low word | `ldgdqp` (v5+) | `ldqp` | — | 11 (L2) | 5 |
| issue | four `ldgdw` (ALC0, 2, 3, 5; also each with its own 32-bit literal) or two `stgdw` (ALC2, 5, new addresses) in every instruction | `ldw`, `stw` | 1 cycle an instruction | 1 | 1 |
| `getpl %rN, %ctprN` → `ct`, `call` (an earlier transfer waits) | `getpl` | `movtd` 9, `disp` 5 | 9 | 9 | 9 |

A store, a load of the same word in the next instruction and an integer
op 3 cycles after the load, feeding the next store's data, take 13
cycles a step on the 4C and 8C2 and 17 on the 2C3; with the load 2
cycles after the store, 6 and 10. These are timing.md's store-to-load
costs ("Store to load": a load 1 cycle after a store to its doubleword
is served by L2), and the 64-bit forms measure the same (`stgdw`/`ldgdw`
and `stgdd`/`ldgdd` against `stw`/`ldw` and `std`/`ldd`, ALC2 → ALC0
and ALC5 → ALC3).

So 32-bit addressing costs nothing: each `ldgd*` and `stgd*` takes the
time of the `ld*` or `st*` of its width in every channel and cluster
tried, and the 32-bit sum, wrapping or not, adds no latency. `getpl`
delays a transfer exactly as `movtd` does (a block costs `max(D, 9) +
1` with the prepare `D` cycles ahead; [control-transfer.md](../isa/control-transfer.md),
"Costs"). A `movtd` of a zero-extended 32-bit address also works in a
32-bit process.

## Calling convention (guide 9.5; lcc: `callconv32.c` at `-O0`, `-O1`, `-O2`; hw: `run32` across `librun32.so`)

**As in [calling-convention.md](calling-convention.md):** the register
file, windows, `setwd`/`setbn`/`wbs`; 8-byte argument slots, slots 0–7
in `%dr0..7`, 9–16-byte arguments from an even slot; aggregates packed
into slots as in memory (`struct { void *a, *b; }` is one slot, `a` in
the low half); `long double` in two even slots (mantissa, then the
exponent); results of up to 64 bytes in `%dr0..7`, larger ones written
into the caller's argument area; variadic calls store the last fixed and
every variadic argument; unprototyped calls pass both ways; `va_arg`
aligns 16-byte types by address (`ands 0xf`); `%g12` is the static
chain (MCST's libffi) and `%g13` the thread pointer; atomics are a
lock-wait load (MAS 0x7) and a wait-unlock store (MAS 0x2) with
`rbranch` ([atomics.md](atomics.md)), here `ldgd*`/`stgd*`. MCST's
libffi uses one layout for both modes: 8-byte slots, 8 register slots,
64-byte register results (libffi `src/e2k/ffi.c:44-50`). [hw: a call
with 12 arguments of mixed types (a 12- and a 16-byte struct, `float`,
`double`, `long double`, a pointer, narrow integers), a variadic call,
68- and 12-byte struct results and narrow results give the expected
values through a shared library; two threads doing 200,000
`__atomic_fetch_add` each on an `int` and a `long long` end with the
right totals.]

**What differs:**

- **A 32-bit value fills only the low half of its slot.** `int`, `long`,
  pointers and `float` are written by 32-bit operations under
  `dbl = 0` (`adds 0x0, %r1, %b[k]`), so the upper half keeps whatever
  the register held: a callee must read them at 32 bits
  (calling-convention.md, "Unused parts of a slot"). `long long` and
  `double` fill the slot.
- **Narrow integer arguments are not extended by the caller.** lcc
  passes a `char`, `short`, `_Bool` or `unsigned` argument as the
  unconverted 32-bit source value (`adds,sm 0x0, %r0, %b[k]`, `merges`
  for `_Bool`), not even truncated to the type; in 64-bit mode it emits
  `sxt 0x0/0x4/0x1/0x5/0x2/0x6, %r0, %b[k]` and `merged`. The callee
  re-extends from the type's width (`sxt 0x0`, `0x4`, `0x1`, `0x5`),
  the same code in both modes. So only the type's own bits of a narrow
  argument are significant, and a callee must extend it. The guide
  (9.5.1) extends narrow types to `int` and only mode 64 to 64 bits;
  lcc does not do even the former.
- **Narrow results are not extended by the callee.** `char r (int x)
  { return x * 3; }` ends with `adds …, %r0` and no `sxt` (64-bit lcc
  adds `sxt 0x0`); the caller extends (`sxt 0x0, %b[0]` for `char`,
  `0x5` for `unsigned short`, `0x4` for `_Bool`). `int`, `long` and
  pointer results are 32-bit writes to `%r0`.
- **Variadic slots.** A 4-byte argument is stored with `stgdw`, 4 bytes
  of its slot (64-bit lcc stores 8 bytes, extended, with `std`); the
  exponent of a `long double` with `stgdh` (64-bit: `sth`). `va_list` is
  a 4-byte pointer to the next slot, and `va_arg` of a 4-byte type reads
  4 bytes.
- **Indirect calls** go through `getpl` ("Addresses and memory
  access"). A function's address taken in a library and in the
  executable compare equal [hw: `run32` "call fp"].
- **`dbl`** is chosen per function by the same rule as in 64-bit mode
  ([registers.md](registers.md)); fewer functions need `dbl = 1`, since
  `unsigned long` is 32 bits: `unsigned long f (unsigned a, unsigned b)
  { return a + b; }` has `dbl = 0` with `-mptr32` and `dbl = 1` without
  [lcc `-O2`].
- **MCST's libffi closures** use a 32-byte trampoline,
  `getpl,0 _f32s,_lts0 <ffi_closure_e2k>, %ctpr1`;
  `addd,1 0x0, _f32s,_lts1 <closure>, %dg12`; `ct %ctpr1` (libffi
  `src/e2k/ffi.c:326-335`), and its assembly picks `getpl`, `ldgd*`,
  `stgd*` and 4-byte pointers when `__ptr64__` is not defined
  (`src/e2k/call.S:4-23`).

## 16-byte atomics (lcc; hw: `atom32`)

As in 64-bit mode ([atomics.md](atomics.md), "16-byte atomics"), with
`ldgdqp`/`stgdqp` for `ldqp`/`stqp`. The atomic macros
(`__GCC_ATOMIC_*`, `__GCC_HAVE_SYNC_COMPARE_AND_SWAP_*`) are the same
in both modes for every target [lcc `-dM -E`, `v3`, `v5.8c2`,
`v6.2c3`].

| Target | lcc's `-mptr32 -O2` code | `__atomic_always_lock_free (16)`; `__GCC_HAVE_SYNC_COMPARE_AND_SWAP_16` |
|---|---|---|
| v3, v4 (`v4.8c`, `v4.1c+`: compiled only) | calls `__atomic_load_16`, `__atomic_compare_exchange_16`, …: the pointers in 32-bit slots, the 16-byte value in an even slot pair (`movtq %r0, %b[2]`), the orders after it; the result in `%b[0..1]` | 0; not defined |
| v5, v6 | inline: lock-wait `ldgdqp,0 … mas = 0x7`, wait-unlock `stgdqp,2 … mas = 0x2`, `rbranch`. A seq_cst load is `wait ld_c = 1, st_c = 1` and `ldgdqp`, then the dummy use; an acquire load drops the `wait`. A relaxed load is two `ldgdd` in one wide instruction on v5 (64-bit code: two `ldd`, the same way), one `ldgdqp` on v6 | 1; defined |

- Every lcc tree's 32-bit libatomic (`fs/usr/lib32/libatomic.so.1`,
  `lcc-home/…/lib32/libatomic.a`) is built for its CPU: the `e2k-v3`
  tree's has no quad operation, the `v5.8c2` tree's 147
  `ldgdqp`/`stgdqp` (`e_flags` elbrus-8c2), the `v6.2c3` tree's 257
  (elbrus-2c3). Elbrus Linux's `/usr/lib32/libatomic.so.1` on the 8C2
  and the 2C3 is the same file as the tree's for that CPU [objdump,
  md5sum].
- [hw] Two threads add 2⁶⁴ + 1 to one `__int128` a million times each
  (fetch-add, and a compare-exchange loop) while a third counts loads
  whose halves differ, with acquire and with relaxed loads:
  - every count exact, with no torn load, in every run: the 4C with
    lcc's lock-based libatomic (static, and dynamic through the shipped
    `libatomic.so.1`); v5 and v6 code inline; v3 code
    through the system libatomic, whose `__atomic_is_lock_free (16)` is 1
    there; and v3 and inline code on one object through the system
    libatomic (`atom32mix`). The 8C2's relaxed loads (two `ldgdd` in one
    instruction) tore in none of about 110 million reads, as in 64-bit
    mode (atomics.md);
  - v3 and inline code on one object linked against lcc's lock-based v3
    `libatomic.a` instead (`atom32mixlock`) lose updates: on the 8C2 in
    12 of 12 runs (about 1.50 million of 2 million), one run also ending
    with unequal halves (1,500,182 and 1,500,188) and 3.06 million of
    3.5 million loads torn; on the 2C3 in 3 of 12 (1.78 to 1.89
    million). Mixing breaks as atomics.md says for 64-bit code.

## ELF (binutils, lcc, kernel)

| Item | Value | Source |
|---|---|---|
| Header | `ELFCLASS32`, `ELFDATA2LSB`, `EI_OSABI` 0, `e_machine` 175 (`0xaf`) | [lcc: `readelf -h`, `od`] |
| `e_flags` | the same as 64-bit code's for every lcc target (`e2k-v3` `0x0300_0000` … `e2k-v6.2c3` `0x1700_0010`) | [lcc: `-mptr32` and default builds for each `/opt/mcst` target]; [elf.md](elf.md) |
| Legacy machine | the kernel also accepts `e_machine` 49 (`EM_E2KL`) with `e_ident[7]` (`EI_SEMANTIC`) = 1, "32 unprotected" | kernel `include/asm/elf.h:60-63,85,185-191` |
| gas, ld | lcc runs `as -mptr32` (`elf32-e2k`; symbol literals are 32 bits, `_f32s`) and `ld -melf32_e2k -dynamic-linker /lib32/ld-linux.so.2`; non-PIE text starts at `0x10000`, as in 64-bit mode | [lcc `-v`]; binutils `gas/config/tc-e2k.c` |
| Relocations | `RELA` (12-byte entries). 32-bit objects use the 32-bit and common types below; the 64-bit types (50–69, 76, 82, 83, 85, 256–258) are not used, and those from 256 up cannot be | binutils `include/elf/e2k.h:25-95` |

Relocation types lcc's 32-bit code uses [lcc: `readelf -r` of
`callconv32.c` built with and without `-fPIC`, and of the linked
`run32` and `librun32.so`]:

| Number | Name | Use |
|---|---|---|
| 0 | `R_E2K_32_ABS` | a 32-bit literal or data word holding an address: non-PIC globals, function addresses, `_GLOBAL_OFFSET_TABLE_@ABS`; also dynamic |
| 2 | `R_E2K_32_PC` | PIC: the `_GLOBAL_OFFSET_TABLE_` literal; `.eh_frame`, `.gcc_except_table` |
| 108, 109 | `R_E2K_GOT`, `R_E2K_GOTOFF` | `x@GOT`, `x@GOTOFF` literals |
| 110 | `R_E2K_DISP` | `disp %ctprN, f` (to the PLT entry when needed) |
| 75 | `R_E2K_32_TLS_LE` | `x@TLS_LE` |
| 74, 70, 71 | `R_E2K_TLS_IE`, `R_E2K_TLS_GDMOD`, `R_E2K_TLS_GDREL` | IE and GD |
| 8, 9, 10 | `R_E2K_32_JMP_SLOT`, `R_E2K_32_COPY`, `R_E2K_32_RELATIVE` | dynamic |
| 80, 81, 84 | `R_E2K_TLS_32_DTPMOD`, `R_E2K_TLS_32_DTPREL`, `R_E2K_TLS_TPOFF32` | dynamic TLS; 81 also in `.debug_info`, for a TLS variable's `DW_OP_addr` [lcc: `-mptr32 -g`] |

Code sequences [lcc: `callconv32.c` at `-O1`, with and without `-fPIC`;
the 64-bit ones are in [elf.md](elf.md), "Code sequences"]:

| Purpose | 32-bit sequence |
|---|---|
| Global, non-PIC | `ldgdw 0x0, [ _f32s,_lts1 g ], %r` |
| GOT base, PIC | `rrs %ip, %g16`; `adds 0x0, [ _f32s,_lts0 _GLOBAL_OFFSET_TABLE_ ], %g17`; `adds %g16, %g17, %r3` |
| Global, PIC | `ldgdw %r3, [ _f32s,_lts0 g@GOT ], %t`; `ldgdw %t, 0x0, %r` |
| Local data or function address, PIC | `adds %r3, [ _f32s,_lts0 x@GOTOFF ], %r` |
| Function address, non-PIC | `adds 0x0, [ _f32s,_lts1 f ], %r` |
| Call | `disp %ctpr1, f` (through the PLT if `f` may be preempted); indirect: `getpl %r, %ctpr1` |
| TLS LE | `ldgdw %g13, [ _f32s,_lts1 x@TLS_LE ], %r` |
| TLS IE (non-PIC) | `adds 0x0, [ _f32s,_lts1 _GLOBAL_OFFSET_TABLE_@ABS ], %g16`; `ldgdw %g16, [ _f32s,_lts0 x@TLS_IE ], %g16`; `ldgdw %g13, %g16, %r` |
| TLS GD | `ldgdw %r3, [ x@TLS_GDMOD ], %b[0]`; `ldgdw %r3, [ x@TLS_GDREL ], %b[1]`; `disp %ctpr1, __tls_get_addr`; `call` |

**PLT** [lcc: `objdump -d -j .plt` of `run32` and `librun32.so`]. The
entries are elf.md's ("PLT and lazy binding") with `ldgdw` for `ldd` and
`getpl %r8` for `movtd`:

- **Entry, non-PIC:** `{ ldgdw 0x0, _f32s <.got.plt slot>, %dr8; setwd
  wsz = 0x8 }`, `getpl %r8, %ctpr1`, `ct %ctpr1`.
- **Entry, PIC:** `{ rrs %ip, %r8; setwd wsz = 0x8 }`,
  `ldgdw %r8, _f32s <slot − entry>, %dr8`, then the same.
- **Header:** loads the 4-byte `.got.plt[1]` (the link map) and `[2]`
  (`_dl_fixup`) into `%dr8` and `%dr10`, `getpl %r10, %ctpr1`,
  `call %ctpr1, wbs = 0x4`, then `getpl %r8, %ctpr1`, `ct %ctpr1`.
- **Secondary entries:** `addd 0x0, _f32s <relocation offset, in steps of
  12>, %dr9; ibranch <header>; setwd wsz = 0x8`.
- `DT_E2K_LAZY_GOT` (`0x7000_0003`) is present, as in 64-bit mode, and
  elf.md's window and clobber rules hold.

**TLS** (elf.md, "Thread-local storage", otherwise):

- Variant I, TP in `%g13`. `TLS_INIT_TP` clears the whole register, then
  writes the 32-bit pointer (glibc `sysdeps/e2k/nptl/tls.h:24-27,112-113`).
- The TCB `{ dtv_t *dtv; void *private; }` is 8 bytes
  (`tls.h:39-43`), so the executable's first 4-byte-aligned TLS variable
  is at TP + 8, in the main thread and in threads, dynamic and static
  [hw: `run32` "tls - g13 main 8 thread 8"; `run64`: 16].
- `__tls_get_addr (module, offset)` takes two 32-bit arguments [lcc].

**Exception tables** [lcc: `l++ -mptr32 -O2 -c cxx32.cc`, with and
without `-fPIC`; hw: `cxx32` catches an exception thrown through four
frames, dynamic and static]: CIE augmentations `zR` and `zPLR`, FDE
encoding `0x1b`, no CFI instructions, as in elf.md, "Exception tables".
PIC objects use personality encoding `0x9b` (`indirect|pcrel|sdata4`,
through a `DW.ref.__gxx_personality_v0` word, `R_E2K_32_PC`) and LSDA
`0x1b` where 64-bit code has `0x9c`/`0x1c`, and `.gcc_except_table`
refers to type infos through `DW.ref.*` words with `R_E2K_32_PC`.
Non-PIC objects use `absptr` (`0x00`) for both and refer to type infos
directly, with 4-byte `R_E2K_32_ABS` words (64-bit: 8 bytes,
`R_E2K_64_ABS`).

## C runtime (glibc, lcc, gdb)

| Item | Fact | Source |
|---|---|---|
| glibc configuration | `e2k/e2k32` implies `wordsize-32`; `slibdir` and `rtlddir` are `lib32`; the dynamic linker is `/lib32/ld-linux.so.2` | glibc `sysdeps/e2k/e2k32/Implies`, `sysdeps/unix/sysv/linux/e2k/e2k32/configure.ac:4`, `sysdeps/unix/sysv/linux/e2k/shlib-versions`; [lcc: `PT_INTERP`] |
| Start files, link line | `fs/usr/lib32/crt1.o crti.o`, lcc's `lib32/crtbegin.o`, … `-lgcc --as-needed -lgcc_s --no-as-needed -llcc -lmvec -lc` …, `crtend.o crtn.o`; `Scrt1.o`, `rcrt1.o`, `gcrt1.o`, `grcrt1.o`, `Mcrt1.o` exist | [lcc: `-mptr32 -v`; the sysroot] |
| lcc's runtime | `lcc-home/1.29.16/<target>/lib32` has the same 43 files as `lib64` (libgcc, `libgcc_eh`, `libgcc_s`, libstdc++, `liblcc`, `libmvec`, libatomic, OpenMP, Fortran, quadmath, the compiler-rt sanitizers). MCST's E2K unwinder tests only `__ptr128__`, and C++ exceptions work | [lcc tree]; libgcc `config/e2k/unwind-dw2-e2k.c`; [hw: `cxx32`] |
| AddressSanitizer | reports `rt32-asan`'s heap overflow on the 4C (through lcc's shipped ld.so), but stops at start on the 8C2 and 2C3, with an `e2k-v3` build as with the CPU's own: `AddressSanitizer CHECK failed: sanitizer_posix.cpp:219 "((start1 <= end1)) != (0)" (0x0, 0x0)`, in `MemoryRangeIsAvailable` called by `InitializeShadowMemory` from `__asan_init`. **Cause:** MCST's `ReadProcMaps` drops the last three lines of `/proc/self/maps`, taking them for the hardware stacks, and the remaining lines are parsed into a 32-bit `uptr`. The 4C's kernel puts three mappings above 4 GiB (`[procedure stack]`, `[chain stack]`, `[cut]`; its `[trampolines]` is in the 32-bit `mmap` area: "Address space", below). The 8C2's and 2C3's kernels put `[trampolines]` there too, so the `[procedure stack]` line (`c2dfffffe000-c2e000002000` on the 8C2, `c25fffffe000-c26000002000` on the 2C3) is parsed, as start `0xffff_e000` and end `0x2000`, and fails `CHECK (start1 <= end1)`; the printed `(0x0, 0x0)` are the values the CHECK compared | compiler-rt 11.1.0 in MCST's runtime sources (`internal-lcc-libs-open-source-1.29.16`, `lib/compiler_rt-11.1.0/lib/sanitizer_common/`): `sanitizer_procmaps_linux.cpp:27-49` (the e2k patch), `:65-67`, `sanitizer_procmaps_common.cpp:37-64`, `sanitizer_posix.cpp:217-240`; [hw: `rt32`; `asan32`, which replays the parse on its own maps: "line 13 fails a CHECK" on the 8C2 and 2C3 (line 6 static), "every parsed line passes" on the 4C; gdb on the 8C2, a breakpoint on `__sanitizer::CheckFailed`; kernels 6.1.158-mcst-e4c-alt1.9.1, 6.1.0-1.17-e8c2-nn, 6.1.0-1.18-e2c3] |
| OpenMP, `-pg` | work: `rt32-omp`'s four-thread reduction is right, and gprof counts `rt32-pg`'s million calls | [hw: `rt32`] |
| ldconfig, ldd | 32-bit libraries are cached with `FLAG_ELF_LIBC6`, 64-bit ones with `FLAG_E2K_LIB64` (`0x0800`), protected ones with `FLAG_E2K_LIB128` (`0x0900`). ldconfig adds the `lib32`, `lib64` and `lib128` siblings of each system directory, and `ldd` tries all three loaders | glibc `sysdeps/unix/sysv/linux/e2k/readelflib.c:41-72`, `sysdeps/generic/ldconfig.h:43-46`, `sysdeps/unix/sysv/linux/e2k/dl-cache.h:20-60`, `…/e2k/ldd-rewrite.sed` |
| System calls | `__SYSCALL_TRAPNUM` 1 and `__VSYSCALL_TRAPNUM` 5; arguments are moved with `adds 0x0, …` (32-bit writes; the kernel zero-extends them, below) and the result taken from the low half (`adds 0x0, %db[0]`). The 32-bit `libc.so.6` has 577 `sdisp %ctpr1, 0x1`, 4 `sdisp %ctpr1, 0x5` and no other entry | glibc `sysdeps/unix/sysv/linux/e2k/e2k32/sysdep.h:42-58,105`; [lcc: `objdump`] |
| `time_t` | 32 bits. With `_TIME_BITS=64` (glibc requires `_FILE_OFFSET_BITS=64` with it) programs use glibc's 64-bit-time functions, but neither glibc's E2K system call list nor the kernel's 32-bit table has the time64 calls (the table has only `recvmmsg_time64`, 417), so glibc falls back to the 32-bit calls: reading the time works, and setting a time past 2038 fails (`utimensat` to 2³² s: −1, `EOVERFLOW`; `0x7fff_ff00` s works) | glibc `sysdeps/unix/sysv/linux/e2k/e2k32/time64-compat.h`, `…/e2k/arch-syscall.h`; kernel `kernel/systable.c:547,1009`; [hw: `run32t`] |
| Large files | a 64-bit offset is passed as two 32-bit arguments, low then high [hw: a raw `ftruncate64 (fd, 7, 2)` makes the file `0x2_0000_0007` bytes]. `ftruncate64` past 2 GiB on a file opened without `O_LARGEFILE` is `EINVAL` (the 64-bit `run64`: 0): the kernel's 32-bit `ftruncate64` calls the non-LFS `ftruncate`, as x86's compat one does; `open64` and `_FILE_OFFSET_BITS=64` set `O_LARGEFILE` | kernel `kernel/sys_32.c:81-85`, `linux/fs/open.c:156-183,202-210`, `linux/arch/x86/kernel/sys_ia32.c:61-65`; [hw: `run32`] |
| Threads, contexts | `pthread_create`/`join`, `setjmp`/`longjmp` through 20 frames, `getcontext`, `makecontext_e2k`, `swapcontext`, `freecontext_e2k` work | [hw: `run32`] |
| gdb | the `e2k32` OS ABI: `ptr_bit` 32, `addr_bit` 64 (the hardware stacks lie outside `GD`), the SVR4 ILP32 link map. Each machine's gdb 15.2 (MCST's on the 8C2 and 2C3, ALT's on the 4C) debugs 32-bit programs, dynamic and static, as it does 64-bit ones: breakpoints, a backtrace through every frame, `info frame` (window registers saved in the procedure stack at their 64-bit addresses), arguments, locals and globals of every type (`sizeof (long)` and pointers 4), `ptype`, `finish` with the return value, a hardware watchpoint, `info sharedlibrary` (`/lib32/ld-linux.so.2`, `/lib32/libc.so.6`), `$pc`, `$sp`, `$r0` with its tags, `x/i`, and TLS variables in dynamic programs (through the host's 64-bit `libthread_db`). In static programs TLS is "Cannot find thread-local storage", as in static 64-bit programs without threads; a static 64-bit program that links `pthread_create` reads TLS through `libthread_db` ([elf.md](elf.md), "Thread-local storage"). On the 4C (no `/lib32`) a program run under gdb as `./ld-linux.so.2 --library-path . ./prog` needs `add-symbol-file ./prog` for its symbols | gdb `gdb/e2k32-tdep.c:28-37`, `gdb/e2k32-linux-tdep.c:30-55`; [hw: `dbg32.sh`, all three machines] |
| `gcore` | writes an `ELFCLASS64` core (`elf64-e2k`, `e_flags` 0) for a 32-bit process too, with the 32-bit layouts of `NT_PRPSINFO` (128 bytes, 136 for a 64-bit process), `NT_AUXV` (160 against 304 bytes) and `NT_FILE`; gdb reads it back (backtrace, globals) | gdb `e2k32-linux-tdep.c:55`; [hw: `dbg32.sh`; `readelf -n` of `gcore` files of 32- and 64-bit processes, all three machines] |
| Kernel core dumps | the compat loader uses the 64-bit core writer ("Hardware stacks lie above 4Gb boundary in 32-bit applications"). A 32-bit process's core is `ELFCLASS64`, `e_machine` 175, `e_flags` the CPU's ISA version × 2²⁴ (`0x0500_0000` on the 8C2, `0x0600_0000` on the 2C3), as a 64-bit process's. Its notes are the 64-bit ones (`NT_PRSTATUS` 5,048 bytes, `NT_PRPSINFO` 136, `NT_SIGINFO`, `NT_FILE`), except `NT_AUXV` in the 32-bit form (160 bytes; 304 in a 64-bit core). It has a `LOAD` segment for each mapping, the hardware stacks above 4 GiB included, and after them one `PT_E2K_TAGS` (`0x7000_0000`) segment of tags for each `LOAD`, a sixteenth of its size in the file. gdb reads it (a backtrace through `abort ()` in `/lib32/libc.so.6`, globals, `ip`). The 4C's `core_pattern` is `/`, so its kernel writes no core in either mode | linux `fs/binfmt_elf.c:84-95,121-126`; kernel `include/asm/elf.h:30,50`; [hw: `dbg32.sh`, `abort` and `SIGSEGV`, static and dynamic, 32- and 64-bit; 8C2 and 2C3] |
| DWARF | lcc's 32-bit objects use DWARF version 2 in the 32-bit format with 4-byte addresses (a 4-byte `DW_OP_addr`; a TLS variable is `DW_OP_addr` and `DW_OP_GNU_push_tls_address`, relocated with `R_E2K_TLS_32_DTPREL`; the other debug relocations are `R_E2K_32_ABS`). 64-bit objects use the 64-bit format ([stack-and-unwinding.md](stack-and-unwinding.md), "Debug information"). The register numbers, frame bases and locations (`DW_OP_reg0` …, `DW_OP_fbreg`) are the same in both modes, and neither has `.debug_frame` | [lcc 1.29.16 and 1.31.05: `dbg32.c` with `-g -c`, with and without `-mptr32`; `readelf --debug-dump=info`, `-x .debug_info`, `-r`] |

## lcc options and predefined macros (lcc, lcc-doc)

- `-mptr32` (alias `-m32`) compiles in 32-bit mode; `-mptr64` (`-m64`)
  is the default and `-mptr128`, `-mptr128-64` are protected mode
  [lcc-doc: `lcc_options.htm`, `lcc_options_simple.htm`]. `-mptr32`
  works with every `/opt/mcst` target directory and with `l++` [lcc].
- `-fsemi-spec-lintel` (the binary translator's build, implied by
  `-fsysware`) allows only `ldgdb`, `ldgdh`, `ldgdw`, `ldgdd` and
  `ldgdqp` to be made semi-speculative under `-mptr32` (`ldb` … `ldqp`
  under `-mptr64`); the `-mprot-*` options are ignored outside protected
  mode [lcc-doc].
- Predefined macros [lcc: `lcc -mptr32 -dM -E` against the default;
  lcc-doc `predefined_macro.html`]: `__ptr32__` 1, and no `__ptr64__`,
  `_LP64` or `__LP64__` (nor `__ILP32__`); `__SIZEOF_LONG__`,
  `__SIZEOF_POINTER__`, `__SIZEOF_SIZE_T__`, `__SIZEOF_PTRDIFF_T__` 4;
  `__SIZE_TYPE__` `unsigned int`; `__PTRDIFF_TYPE__`, `__INTPTR_TYPE__`,
  `__INT_FAST16_TYPE__` and `__INT_FAST32_TYPE__` `int`;
  `__INT64_TYPE__` and `__INTMAX_TYPE__` `long long int`; `__LONG_MAX__`
  `0x7fffffffL`. The 102 lines in which `-dM` differs all follow from
  these; lcc 1.31.05 differs from 1.29.16 only in its version macros
  (and its `__LONG_DOUBLE__` bug, [source-compat.md](source-compat.md)).

## Kernel (kernel; hw)

**Exec.** The compat loader takes an ELF when `compat_elf_check_arch`
holds: `e_machine` 175 without `EF_E2K_PM` (or the legacy 49 with
`EI_SEMANTIC` 1), `ELFCLASS32`, and a machine code that fits the CPU as
for 64-bit programs (`include/asm/elf.h:185-191`). Every exec sets or
clears the task's `E2K_FLAG_32BIT` from `EI_CLASS` (`elf.h:266-269`),
and the stack top, the `mmap` base and limit, the signal frames and the
compilation-unit entry follow that flag.

**Address space** [hw: `/proc/self/maps` and `run32`; dynamic programs
on the 8C2 and 2C3, static ones on all three; compare
[kernel-interface.md](kernel-interface.md), "Address space"]:

| Item | 32-bit task | Source |
|---|---|---|
| Limit | `TASK32_SIZE` = `0xf000_0000`; `MAP_FIXED` above it is `ENOMEM` | `include/asm/ptrace.h:32`, `mm/mmap.c:67-77`; [hw: `MAP_FIXED_NOREPLACE` at `0xf000_0000`: `ENOMEM`; `run64`: mapped] |
| Non-PIE executable | `0x10000` | binutils ld script; [hw] |
| PIE | `0xa000_0000` (`2 × TASK32_SIZE / 3`) plus up to 1 MiB at random (`main` seen at `0xa000_9c00`–`0xa00f_fc00`) | `include/asm/elf.h:246`; `Kconfig:341-345` (`ARCH_MMAP_RND_COMPAT_BITS` 8 to 16, default 8), `mm/mmap.c:116-127`; [hw: 8C2, 2C3] |
| `mmap`, ld.so, libraries | from `TASK32_SIZE / 3` = `0x5000_0000` plus up to 1 MiB, searched upward to `0xf000_0000`. A hint is only a lower bound, with no fallback below it: `mmap` with the hint `0xf000_0000` is `ENOMEM` | `include/asm/processor.h:57-60`, `mm/mmap.c:80-113,135-141`; [hw] |
| How much fits | 39 blocks of 64 MiB (2,496 MiB) between the `mmap` base and the stack, then 19 more (1,216 MiB) only with a low hint (from `0x100_0000` up to about `0x4d00_0000`): 3,712 MiB in all | [hw: `run32` `exhaust`; 8C2, 2C3, and the 4C's static run] |
| Stack | top `0xf000_0000` minus up to 8 MiB (`[stack]` seen ending at `0xef8e_e000`–`0xeff4_0000`) | `include/asm/stacks.h:133`, `include/asm/processor.h:47-48`; `linux/mm/util.c:295-296` |
| Hardware stacks, `[signal stack]`, `[cut]` | at their 64-bit places above 4 GiB (`0xc2df_ffff_e000` up on the 4C and 8C2, `0xc25f_ffff_e000` on the 2C3), out of reach of a 32-bit pointer | [hw: maps] |
| `[trampolines]` | above 4 GiB on the 8C2 and 2C3 (`0xc2ff_ffff_d000`, `0xc27f_ffff_d000`); in the 32-bit `mmap` area on the 4C's older kernel (`0x5007_1000`–`0x5011_1000` seen) | [hw]; kernel-interface.md, "The trampoline page" |

**System calls** (kernel-interface.md, "System calls"):

- Every unprotected task may call entries 1, 3, 4, 5 and 6
  (`include/asm/traps.h:137-155`). Entry 1 is the 32-bit table
  (`kernel/systable.c:547`), with the same numbers as the 64-bit one
  (glibc's `e2k32/arch-syscall.h` includes the common list).
- **The entry, not the task, chooses the ABI**: the kernel treats a call
  as compat exactly when it came through entry 1
  (`include/asm/compat.h:137-144`).
- Every entry takes the number from the low 32 bits of `%b[0]`; entry 1
  also zero-extends the arguments `%db[1..6]` from 32 bits (`sxt 6`
  under `FORMAT_32`, `kernel/trap_table.S:366-520`). The result is the
  whole `%db[0]` (−errno sign-extended).
- Entry 5 is the 32-bit fast-call table (compat `gettimeofday`,
  `clock_gettime`, `siggetmask` and `getcontext`; `getcpu` and
  `set_return` as in 64-bit mode); it zero-extends its two arguments
  (`fast_syscalls/fast_syscalls.c:72-82`, `kernel/trap_table.S:601-688`).
- From a 32-bit task, entry 4 uses the deprecated table
  (`trap_table.S:554-599`).

[hw: `run32` and `run64`: the same results from a 32-bit and from a
64-bit process]:

| Call | Entry 1 | Entry 3 |
|---|---|---|
| `getpid` with the number's upper half set | the pid | the pid |
| `write` of a buffer below 4 GiB through a pointer whose upper half is `0xdeadbeef` | 33: the pointer is cut to 32 bits | −14 (`EFAULT`) |
| `close (-1)` | `0xffff_ffff_ffff_fff7` | the same |
| `clock_gettime` (267) | two 32-bit words (seconds, nanoseconds) | two 64-bit words |
| fast `clock_gettime` (fast call 1) | through entry 5: two 32-bit words | through entry 6: two 64-bit words |

**Auxiliary vector.** The same as a 64-bit task's
(`COMPAT_ARCH_DLINFO` is `E2K_DLINFO`, `include/asm/elf.h:286-293`):
`AT_FAST_SYSCALLS` `0x1f`, `AT_SYSTEM_INFO` 1, `AT_HWCAP` 0, no
`AT_SYSINFO_EHDR` [hw].

**Signals** (kernel-interface.md, "Signals", otherwise):

- **One frame for all modes.** The `rt_sigframe` is a union of the
  64-bit, 32-bit and protected forms (`include/asm/ucontext.h:62-83`),
  so it has the 64-bit frame's size and place:
  `round_down (USD − 4272, 256)` [hw: every run on the three machines].
- `siginfo_t` is the compat form, 128 bytes with 32-bit pointers
  (`kernel/signal.c:442`); `si_addr` above 4 GiB is cut to 32 bits
  ("Addresses and memory access").
- `ucontext_t` is `struct ucontext_32` (`include/asm/ucontext.h:14-24`):
  4-byte `uc_flags` and `uc_link`, a 12-byte `stack_t`, then
  `uc_mcontext` (the 64-bit `struct sigcontext`) at `0x18`, `uc_sigmask`
  at `0x640`, `uc_extra` at `0x6c0`, size `0xfc8` [hw: offsets 24, 1600,
  1728, size 4040]. The 64-bit offsets are `0x28`, `0x650`, `0x6d0`.
- The handler gets the signal, `&info` and `&uc` in `%dr0`–`%dr2`, all
  below 4 GiB [hw]. It returns to `[trampolines]+0x000`, which calls
  `sigreturn` (119) through entry 1 (`include/asm/process.h:37-40`,
  `kernel/trap_table.S:1194-1214`); `makecontext_e2k`'s return is
  `+0x300`. Where the page is above 4 GiB, a 32-bit handler's
  `__builtin_return_address (0)` gives its low half: `0xffff_d000` on
  the 8C2 and 2C3 [hw].

## Mixing 32-bit and 64-bit code: not possible

| Where | What happens | Source |
|---|---|---|
| ld | "64-bit input file `mix64.o' is incompatible with 32-bit output", "failed to merge target specific data", and the reverse for a 32-bit object in a 64-bit link | [lcc: ld of every target] |
| ld.so | `dlopen` of the other mode's library: "wrong ELF class: ELFCLASS64" in a 32-bit process, "ELFCLASS32" in a 64-bit one | [hw: `dlmix`] |
| Kernel | the mode is set at each exec from `EI_CLASS`, so a process of one mode can exec a program of the other (the 64-bit shell runs every 32-bit probe) | `include/asm/elf.h:266-269`; [hw] |
| Guide | a program cannot be built from modules of different semantic models; the operating system may use another one | guide 9.1.3 |

Beyond `GD` and `CUD`, nothing tested keeps a task to its mode: a
32-bit process can run ordinary 64-bit loads and stores and call
entries 3 and 6 with 64-bit structures, and a 64-bit process can call
entries 1 and 5 and gets the compat behaviour [hw]. But 32-bit code
reaches only the low 4 GiB, a 64-bit process can't use `ldgd*` or
`getpl`, and pointer sizes, structures and libraries differ; no
toolchain supports calls between the modes.

## Not checked yet

- Kernel core dumps on the 4C: its `core_pattern` is `/`, so none are
  written (inferred to be as on the 8C2 and 2C3, from the same
  `fs/binfmt_elf.c`).
- Whether 32-bit AddressSanitizer on the 4C breaks later, when a fourth
  mapping above 4 GiB (a `[signal stack]` after a signal, say) reaches
  a later read of `/proc/self/maps`; only start-up was studied.
- Whether gdb reads TLS in a static 32-bit program that links
  `pthread_create`, as it does in a static 64-bit one ("C runtime",
  gdb; `dbg32.c` creates no threads).
- v4 (no hardware): the timings and the atomics runs.
- v7 (out of scope): binutils has a v7 `getpl` in ALC1/4, and the v7
  `CUD` has a `va32` flag (kernel `include/asm/cpu_regs_types.h:108-112`).
