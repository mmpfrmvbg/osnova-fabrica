# E2K Linux ABI (64-bit mode)

This directory describes the application binary interface used by MCST's lcc
and the system libraries on Elbrus Linux, for 64-bit unprotected mode
(`e2k64`, `-mptr64`). A new compiler must follow it to link with existing
code.

| Document | Contents |
|---|---|
| [data-layout.md](data-layout.md) | Sizes and alignment of types, aggregates, bit-fields |
| [registers.md](registers.md) | Register files, windows, conventions, FP control and status (and MCST glibc's FP bugs: `fesetenv`, `fmod`/`remainder`/`remquo` in `FE_DOWNWARD`, libm after `feclearexcept`, v3 `scalb`, `sqrtf128`; `__float128` in MCST's libgcc and libquadmath), DWARF numbering |
| [calling-convention.md](calling-convention.md) | Calls, argument passing, results, varargs, and the rest of the C++ ABI: mangled names of E2K's types, member pointers, guard variables and their COMDAT groups, array cookies, the visibility of template instantiations |
| [stack-and-unwinding.md](stack-and-unwinding.md) | User stack, hardware stacks, the stack registers and why split stacks are impossible, exceptions, signal frames, cancellation and C cleanups (MCST's broken `__gcc_personality_v0`), backtraces, `setjmp`/`longjmp`, what they cost, scanning for roots (garbage collectors) |
| [elf.md](elf.md) | ELF header, sections, the executable-stack note, relocations, PIC and PLT, TLS |
| [atomics.md](atomics.md) | Atomic read-modify-write, memory orders, 16-byte atomics |
| [source-compat.md](source-compat.md) | Predefined macros (and how build systems tell lcc from GCC), CPU detection, inline-asm constraints, modifiers and clobbers, register names (also lcc's `"FP"` and `"SP"`), lcc options that change code (and what building glibc passes), lcc's pragmas, where lcc's C and C++ differ from GCC's (default standards, wide bit-fields, shift counts, what lcc accepts) |
| [kernel-interface.md](kernel-interface.md) | System calls, process entry (the state a C `_start` meets), auxiliary vector, contexts (also shared between threads), signals and their frames, hardware and data stacks, address space, `-pg`, sanitizers, static PIE |
| [kernel-build.md](kernel-build.md) | What building MCST's Linux kernel asks of a compiler: lcc's kernel options and which a GCC loses, the kernel's global registers, `check_stack` functions without a data stack, the asm idioms it relies on, kernel-mode code generation (speculation, APB, `%ctpr2`, DAM, jump tables, block moves, physical mode, data written before `.bss` is cleared, wide bit-fields, inlining, 128-bit helpers), erratum #123567, and the build tools that read compiler output |
| [mode32.md](mode32.md) | For completeness (the GCC port targets 64-bit mode only): lcc's 32-bit mode (`-mptr32`): data layout, `ldgd*`/`stgd*` and `getpl`, calling convention, ELF32, TLS, system calls and signals, address space, why the modes can't be mixed |
| [protected-mode.md](protected-mode.md) | For completeness (the GCC port targets 64-bit unprotected mode only): protected mode (`-mptr128`, e2k128): descriptors and tags, what the hardware, kernel and lib128 check, calling convention, system calls, lib128, lcc's options, ELF and linking |

## Sources

Each rule is marked with where it comes from:

| Mark | Source |
|---|---|
| **guide** | MCST, "Руководство по эффективному программированию на платформе «Эльбрус»", chapter 9 (CC BY 4.0) |
| **lcc** | Observed in the output of lcc 1.29.16 for `tools/abi/probes/` (1.31.05 where the text says so; `tools/setup/fetch-lcc.sh 1.31.05 e2k-v3`) |
| **lcc-doc** | lcc 1.31.05's user documentation (`doc/lcc/` in the compiler's tree, e.g. `toolchains/lcc-1.31.05-e2k-v3/opt/mcst/lcc-1.31.05.e2k-v3.linux-6.1/doc/lcc/`: changelogs since 1.24, option reference, notes on incompatible changes). MCST publishes it with the compilers, which it distributes freely (dev.mcst.ru/download). Facts are taken from it, not its text, and checked with a probe where possible |
| **unipro** | Observed in the output of Unipro's clang 20.1.8 for the same probes |
| **gcc** | GCC's own target-independent behaviour (front end, middle end, generic options), observed with the proof-of-concept GCC back end (`toolchains/gcc-claude`) or with GCC on another target, compile only. What that back end itself still lacks is not recorded in the spec but in `docs/` (decision 2) |
| **libffi** | MCST's libffi 3.3 E2K port (`src/e2k/`, MIT licence; `tools/setup/fetch-lcc-libs.sh`): an independent implementation of the calling convention by MCST, built with lcc and run against lcc code under qemu |
| **binutils** | MCST's GPL binutils, `OpenE2K/binutils-gdb` (`bfd/elfxx-e2k.c`, `gas/config/tc-e2k.c`) |
| **gdb**, **glibc**, **kernel**, **libgcc** | MCST's GPL sources: `OpenE2K/gdb`, `OpenE2K/glibc`, `OpenE2K/linux`, and the E2K libgcc in lcc's `internal-lcc-libs-open-source` tarball |
| **compiler-rt** | MCST's compiler-rt 11.1.0 (Apache-2.0 with LLVM exceptions) from the same tarball (`lib/compiler_rt-11.1.0`): the sanitizer runtimes lcc links |
| **qemu** | `OpenE2K/qemu-e2k-mcst` and `OpenE2K/qemu-e2k-community` (source or behaviour) |
| **compat** | Checked by the compatibility suite `tools/abi/compat`: caller and callee built by different compilers (or for different targets), run under MCST's qemu-e2k |
| **hw** | Run on hardware: Elbrus 4C (v3), 8C2 (v5) or 2C3 (v6), by the compat suite (`run.py --remote`) or a probe in `tools/abi/probes` |

Where lcc and Unipro disagree, lcc is the reference: it built the system.

A "finding" (A10, I12, P7: ABI, ISA, port plan) is one of the
proof-of-concept GCC back end's reports of what this specification
lacked or got wrong. Each was rechecked with relcc2's own probes or the
sources and folded into the text that cites it.

The compatibility suite runs mixed lcc and Unipro programs under qemu-e2k
and on an Elbrus 4C (v3). On the 4C every pair gives the same results as
under qemu except the tests in "Unused parts of a slot"
(calling-convention.md) that time out under qemu: qemu hangs storing a
register with an empty (not diagnostic) tagged half, which the hardware
stores. Other rules are marked **compat** rather than **hw** until a
hardware run is recorded against them. The suite also passes on the 8C2
(v5) and the 2C3 (v6).

It also mixes targets in one program: lcc's v3 code with its 8C2 and 2C3
code and with Unipro's `-march=elbrus-v3`, `v5` and `v6` code, each as
caller and as callee (`run.py --target v3,v5.8c2` on the 8C2,
`--target v3,v6.2c3` on the 2C3, both also under qemu), and lcc's v3
code with its 4C code on the 4C (`--target v3,v3.4c`). These pass with
no differences beyond Unipro's known ones: the calling convention
doesn't depend on the target. What the linker, ld.so and the kernel do
with objects for different targets is in [elf.md](elf.md), "Mixing
targets in one program".

## Compatibility suite

```
python3 tools/abi/compat/gen.py toolchains/compat/gen
python3 tools/abi/compat/run.py toolchains/compat/gen
python3 tools/abi/compat/run.py toolchains/compat/gen --target v3,v5.8c2
```

`gen.py` writes caller/callee pairs for the rules in
calling-convention.md (scalars, aggregates of every size, layout
attributes, large results, long argument lists, variadic and unprototyped
calls, integer extension, `va_list` passed between compilers, `longjmp`
across compilers, C++ exceptions) plus seeded random signatures.
`run.py` builds every ordered pair of compilers (`--cc NAME=COMMAND` adds
one, e.g. a GCC port, and `--cxx NAME=COMMAND` its C++ compiler), links
with lcc (`l++` for C++) and runs each program under `--runner` (qemu-e2k
by default) or on hardware over SSH (`--remote`). Known differences of
the reference compilers are listed in `tools/abi/compat/known.txt`; any
other failure fails the run. With several targets (`--target
v3,v5.8c2`) each target has its own compilers (`lcc-v3`,
`lcc-v5.8c2`, `unipro-v3`, `unipro-v5`; `--cc NAME@TARGET=COMMAND` adds
one), the default pairs are those whose caller and callee have
different targets, and the programs are linked by the last target's lcc
and run on its CPU (qemu's `-cpu` follows it; with `--remote`, choose a
host with that CPU).

## Probes

```
LCC=/opt/mcst/lcc-1.29.16.e2k-v5.8c2.linux-6.1/bin/lcc    # or toolchains/lcc-1.29.16-e2k-v5/lcc
$LCC -O1 -fno-optimize-sibling-calls -S tools/abi/probes/callconv.c
$LCC -c tools/abi/probes/layout.c    # must compile
```

`layout.c` encodes every rule in data-layout.md as `_Static_assert`s; both
lcc and Unipro's clang compile it.
