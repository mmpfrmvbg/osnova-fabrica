# ELF, relocations, PIC and TLS

How e2k64 objects, executables and shared libraries are laid out, how the
assembler and linker relocate them, and the code a compiler emits to
address data, call functions and reach thread-local storage in each code
model. Marks as in [README.md](README.md); **binutils** is MCST's
`OpenE2K/binutils-gdb` (`include/elf/e2k.h`, `bfd/elfxx-e2k.c`,
`gas/config/tc-e2k.c`).

Run on hardware (Elbrus 4C, v3) by `tools/abi/probes/dso/run.sh`: a
shared library with global and `static` TLS variables, used from a PIE, a
non-PIE executable (with a copy relocation, an IE access and function
pointer equality) and a fully static executable, with lazy and immediate
binding (`LD_BIND_NOW=1`), all built by lcc 1.29.16 for `e2k-v3`.
Unipro's PIC output can't be assembled with gas (see "Unipro" below), so
only lcc's sequences are run.

## ELF header (binutils, kernel)

| Field | Value |
|---|---|
| `EI_CLASS` | `ELFCLASS64` |
| `EI_DATA` | `ELFDATA2LSB` |
| `e_machine` | `EM_MCST_ELBRUS` = 175 |
| `e_flags` bits 24–31 | Machine: the ISA version or a CPU model (below) |
| `e_flags` & `0x10` | `EF_E2K_INCOMPAT`: code runs only on that machine, not on later ones |
| `e_flags` & `0x20` | `EF_E2K_PM`: protected mode ([protected-mode.md](protected-mode.md)) |
| `e_flags` & `0x40` | `EF_E2K_PACK_SEGMENTS` (protected mode) |
| `e_flags` & `0x3` | `EF_E2K_IPD`: instruction prefetch depth; 0 is the default (readelf: "default ipd") |
| `e_flags` & `0x4`, `0x8` | `EF_E2K_X86APP`, `EF_E2K_4MB_PAGES` (binary compiler, kernel; not used by a compiler) |

Machine codes: 2–7 = `elbrus-v2`…`elbrus-v7` (`-march`); 19 = 8C,
20 = 1C+, 21 = 12C, 22 = 16C, 23 = 2C3, 24 = 48C, 25 = 8V7, 26 = maket32c
(`-mtune` models). 0 and 1 are legacy and rejected by the linker. (An
older encoding put a 3-bit machine in bits 28–30 with
`e_machine` = `EM_E2K_OLD`; binutils still reads it.)

What each lcc target writes (lcc):

| lcc directory | `e_flags` | readelf |
|---|---|---|
| `e2k-v3` | `0x03000000` | elbrus-v3 |
| `e2k-v3.4c` | `0x03000010` | elbrus-4c |
| `e2k-v4.8c` | `0x13000010` | elbrus-8c |
| `e2k-v4.1c+` | `0x14000010` | elbrus-1c+ |
| `e2k-v5.8c2` | `0x05000010` | elbrus-8c2 |
| `e2k-v6.16c` | `0x16000010` | elbrus-16c |
| `e2k-v6.2c3` | `0x17000010` | elbrus-2c3 |

So `-march=elbrus-vN` code is forward compatible (no `INCOMPAT`), and code
tuned for one CPU is marked `INCOMPAT` with either its ISA version or its
model code.

The **kernel** (`arch/e2k/include/asm/elf.h`) execs a 64-bit ELF only if
`EF_E2K_PM` is clear and the machine fits the CPU: versions 2–5 run on that
version and, without `INCOMPAT`, on later ones; versions 6 and 7 on that
version or later; model codes only on that model. The **linker** gives
every input the set of CPUs it runs on, intersects the sets, and fails if
nothing is left; the output gets the most general machine that matches,
with `INCOMPAT` if any input had it. Shared libraries don't take part.

### Mixing targets in one program (binutils, glibc, lcc, unipro, qemu, compat, hw)

Measured with MCST's GNU ld 2.41, the linker lcc 1.29.16's driver runs:
a small object from each lcc target and from Unipro's
`-march=elbrus-v3`…`v7`, linked with lcc `e2k-v3` code by the `e2k-v3`
driver, whose startup files are generic v3:

| Other object | Output `e_flags` | readelf |
|---|---|---|
| lcc `e2k-v3`, Unipro `-march=elbrus-v3` | `0x03000000` | elbrus-v3 |
| lcc `e2k-v3.4c` | `0x03000010` | elbrus-4c |
| lcc `e2k-v4.8c` | `0x13000010` | elbrus-8c |
| lcc `e2k-v4.1c+` | `0x14000010` | elbrus-1c+ |
| lcc `e2k-v5.8c2` | `0x05000010` | elbrus-8c2 |
| lcc `e2k-v6.16c` | `0x16000010` | elbrus-16c |
| lcc `e2k-v6.2c3` | `0x17000010` | elbrus-2c3 |
| Unipro `-march=elbrus-vN`, N = 4…7 | `0x0N000000` | elbrus-vN |

- Inputs with no CPU in common are an error (``input file `f.o' for
  `elbrus-2c3' architecture is incompatible with `elbrus-8c2' output``):
  two different CPU targets (`v5.8c2` with `v6.2c3`, `v3.4c` with
  `v5.8c2`), or generic code for a later version than a CPU target
  (Unipro `-march=elbrus-v6` with `v5.8c2`).
- **A program is no more general than its startup files.** Every file in
  an lcc tree carries the tree's `e_flags`: `crt1.o`, `crti.o`, `crtn.o`,
  `crtbegin.o`, `libgcc.a`, `liblcc.a`, `libc_nonshared.a`, `libm.a` and
  `libc.so.6` are `0x03000000` in `e2k-v3`, `0x05000010` in `e2k-v5.8c2`
  and `0x17000010` in `e2k-v6.2c3`. So whatever the `e2k-v5.8c2` driver
  links runs only on the 8C2, even when every object of its own is v3
  code, and a cross compiler gives forward compatible programs only with
  the `e2k-v3` sysroot. The installed systems are the same: on ALT Linux
  (the 4C) the system's `crt1.o`, `libc_nonshared.a`, `libc.so.6` and
  `libatomic.so.1` are generic v3 (`0x03000000`); on Elbrus Linux 9.5.5
  they are `0x05000010` on the 8C2 and `0x17000010` on the 2C3, so a
  native link there makes a program for that CPU only (hw).
- ld's `--relaxed-e2k-machine-check` skips the check and leaves the
  output at `elbrus-v2` (`0x02000000`), which the kernel runs on any CPU:
  lcc v3 code linked this way with 2C3 code ran on the 4C, the 8C2 and
  the 2C3 (hw; the 2C3 function used no v6 operation). Not for a
  compiler.
- The kernel refuses an executable whose machine doesn't fit the CPU
  with `ENOEXEC` ("Exec format error"), as the rules above say (hw,
  programs linked as in the table): on the 4C the `elbrus-v5`,
  `elbrus-8c2` and `elbrus-2c3` ones; on the 8C2 the `elbrus-2c3` one;
  on the 2C3 the `elbrus-8c2` ones, while the `elbrus-v5` one (lcc v3
  code with Unipro `-march=elbrus-v5` code) runs there.
- ld ignores a shared library's `e_flags` (a v3 program linked against an
  `e2k-v5.8c2` or `e2k-v6.2c3` library stays `0x03000000`), but ld.so
  checks each object it loads by the same rules (glibc,
  `sysdeps/unix/sysv/linux/e2k/ldsodefs.h`, `runtime_compatible_host`)
  and stops: "error while loading shared libraries: ./libf6.so: ELF file
  for forward incompatible elbrus-2c3 is incompatible with your
  elbrus-8c2 host". Measured on all three (hw): the 4C refuses both
  libraries, the 8C2 the 2C3 one, the 2C3 the 8C2 one.
- MCST's qemu-e2k ignores the executable's `e_flags` (it runs an
  `elbrus-8c2` program with `-cpu elbrus-v3`), and each of its CPUs is
  one model to ld.so's check, which uses `__builtin_cpu_is`
  ([source-compat.md](source-compat.md), "CPU detection at run time";
  the models are the `%idr` values in qemu's `target/e2k/cpu.c`):
  `elbrus-v3` is a 4C, `v4` an 8C, `v5` an 8C2, `v6` a 2C3 and `v7` an
  8V7. So the `e2k-v4.1c+` and `e2k-v6.16c` sysroots don't run under it:
  ld.so refuses their own `libc.so.6` ("ELF file for forward
  incompatible elbrus-16c is incompatible with your elbrus-2c3 host").
  The community qemu's `elbrus-v6` is a 16C. A run under qemu must
  therefore pick the CPU itself; `run.py` takes it from its last
  `--target`.
- The calling convention doesn't depend on the target. The compat suite
  (`tools/abi/compat/run.py --target v3,v5.8c2`, `v3,v6.2c3`) links
  lcc's v3 code with its 8C2 and 2C3 code and with Unipro's
  `-march=elbrus-v3`, `v5` and `v6` code, each as caller and as callee,
  and passes on the 8C2 and the 2C3 and under qemu with only Unipro's
  known differences (compat, hw); `--target v3,v3.4c` passes on the 4C
  and `v3,v4.8c` under qemu. v5 and v6 code from both compilers moves
  aggregates through quad registers (`qppackdl`, `stqp`, `ldqp`), but
  what it leaves in argument registers and memory is the same. The
  exception is a 16-byte atomic object shared
  by v3/v4 and v5+ code ([atomics.md](atomics.md), "16-byte atomics"),
  which the suite doesn't test.

## Sections and segments (binutils, glibc, lcc)

- Ordinary ELF sections: `.text`, `.data`, `.bss`, `.rodata`, `.tdata`,
  `.tbss`, `.init`/`.fini`, `.init_array`/`.fini_array`, `.eh_frame`,
  `.got`, `.got.plt`, `.plt`, `.rela.dyn`, `.rela.plt`. Only `RELA`
  relocations are used.
- The interpreter is `/lib64/ld-linux.so.2`.
- `PT_E2K_TAG` = `PT_LOPROC` is defined (protected mode); lcc's 64-bit
  output has no such segment. lcc doesn't emit `PT_GNU_STACK` either
  (below, "Executable stack").
- `_GLOBAL_OFFSET_TABLE_` is the start of `.got.plt`, and `DT_PLTGOT`
  points there. Its first three words are reserved: `[0]` = link-time
  address of `_DYNAMIC`, `[1]` = the module's `struct link_map *`,
  `[2]` = address of `_dl_fixup`; ld.so fills in 1 and 2 (lazy binding,
  below). The default linker script puts `.got.plt`, `.igot.plt`, `.got`
  and `.igot`, in that order, into one output section `.got` after the end
  of RELRO, so ordinary GOT entries have positive offsets from
  `_GLOBAL_OFFSET_TABLE_` and the whole table stays writable.

Dynamic tags (binutils, glibc):

| Tag | Value | Meaning |
|---|---|---|
| `DT_E2K_LAZY_DEFECTIVE` | `DT_LOPROC` | Old lazy-binding scheme that patched PLT code; not produced |
| `DT_E2K_LAZY` | `DT_LOPROC + 1` | Lazy binding that patches a literal in each PLT entry; not produced |
| `DT_E2K_LAZY_GOT` | `DT_LOPROC + 3` | Lazy binding through `.got.plt` (current; below). ld.so binds a module lazily only if one of these tags is present |
| `DT_PLTGOTSZ` | `DT_LOPROC + 0x101b` | Size of `.got` |
| `DT_INIT_GOT`, `DT_EXPORT_PL`, `DT_EXPORT_PLSZ`, `DT_REAL_PLTGOT`, `DT_E2K_NO_SELFINIT` | following values | Protected mode ([protected-mode.md](protected-mode.md), "ELF and linking") |

## Executable stack: `.note.GNU-stack` and `PT_GNU_STACK` (lcc, binutils, glibc, kernel, hw)

On E2K, an object without the note, and a program or library without
the segment, count as needing **no** executable stack. MCST's ld sets
`elf_backend_default_execstack` to 0, "to be in line with the Kernel and
glibc" (binutils `bfd/elf64-e2k.c:134-136`, `bfd/elf32-e2k.c:120-122`),
and glibc and the kernel agree (below). LoongArch, RISC-V and 64-bit
PowerPC do the same in binutils (`bfd/elfnn-loongarch.c:140`,
`elfnn-riscv.c:5573`, `elf64-ppc.c:90`). x86-64 differs: there ld treats
an object without the note as needing an executable stack (binutils'
default, `bfd/elfxx-target.h:136-137`), and glibc makes thread stacks
executable when the segment is missing (`sysdeps/x86_64/stackinfo.h:37`),
although the kernel keeps the main stack non-executable (kernel
`arch/x86/include/asm/elf.h:275-280`). lcc never writes the note, so its
programs get non-executable stacks without one, and ld prints no
"missing .note.GNU-stack" warning for its objects. The tools were
checked by compiling and linking (`tools/abi/probes/execstack.sh`), the
run-time behaviour from the sources and the machines' own files. Code on
the stack (trampolines) ran in `RWE` programs and faulted in the others
(below) [hw: `tools/abi/probes/foldp123_tramp.c`, 4C, 8C2].

| Tool | No note in any input | `""` note | `"x"` note | Source |
|---|---|---|---|---|
| lcc 1.29.16 and 1.31.05 (v3, v5.8c2, v6.2c3) | always: no note in the `.s` or the `.o`; the driver runs gas with only `-mcpu=<CPU> -mptr64` (`elbrus-v3`, `elbrus-8c2`, `elbrus-2c3`) | with `-Wa,--noexecstack` | with `-Wa,--execstack` | lcc (`lcc -v`) |
| gas | writes none unless the source has `.section .note.GNU-stack` or `--execstack`/`--noexecstack` is given | an empty `PROGBITS` section without flags | the same with `SHF_EXECINSTR` (readelf `X`) | binutils `gas/as.c:1429-1438`, `gas/config/obj-elf.c:672-675` |
| ld | no `PT_GNU_STACK`, except with `-z stack-size=N` (then `RW` with `p_memsz` N); once any input has a note, inputs without one count as non-executable | `RW` | `RWE`, with the warning "X.o: requires executable stack (because the .note.GNU-stack section is executable)"; `ld -r` keeps the `X` note and gives the same warning | binutils `bfd/elf64-e2k.c:134-136`, `bfd/elf32-e2k.c:120-122`, `bfd/elflink.c:7152-7230` |
| ld `-z noexecstack` / `-z execstack` | `RW` / `RWE` whatever the inputs; the lcc driver passes `-z` to ld itself (`lcc -z noexecstack`) | the same | the same | lcc |

This holds for executables, shared libraries and `-static` executables,
and for the ld of both lcc trees (2.41 in 1.29.16, 2.45.1 in 1.31.05).
In lcc 1.29.16's sysroots (v3, v5.8c2 and v6.2c3; 997 E2K ELF files
each), only `libcompiler_rt.asan.a` (lib32 and lib64) has a note: an
empty one in `asan_interceptors_vfork.S.o`. So `lcc -fsanitize=address`
programs get `RW`. lcc 1.31.05's v3 sysroot (992 files) also has LLVM's
OpenMP runtime with an empty note, in lib32 and lib64: `libomp.so.1.0.0`
(`RW`) and `libomp.a` (`z_Linux_asm.o`). No file has an `"x"` note or
`RWE`. The rest, including `crt1.o`, `libc.a`, `libgcc.a` and the other
shared libraries, have neither a note nor the segment. Not searched:
1.31.05's v5.8c2 and v6.2c3 sysroots and the other 1.29.16 targets; not
checked: whether 1.31.05's `-fopenmp` links the noted `libomp`. Unipro's
clang emits `.section ".note.GNU-stack","",@progbits` (unipro).

What the segment does at run time (kernel, glibc):

| `PT_GNU_STACK` | Main stack at `exec` (the executable's segment) | Thread stacks (glibc) | When ld.so loads the file as a library (`DT_NEEDED` at startup or `dlopen`) |
|---|---|---|---|
| none | not executable | `PROT_READ`, `PROT_WRITE` | nothing changes |
| `RW` | not executable | the same | nothing changes |
| `RWE` | `VM_EXEC` | `PROT_EXEC` added | if the stacks are not executable yet, ld.so makes the main stack and every thread stack executable with `mprotect` |

- Kernel: `fs/binfmt_elf.c:981-986` turns `PF_X` into `EXSTACK_ENABLE_X`
  and a segment without it into `EXSTACK_DISABLE_X`. `fs/exec.c:810-820`
  adds or removes `VM_EXEC`. Without the segment, the stack keeps
  `VM_STACK_FLAGS`, which on E2K has no `VM_EXEC`. E2K's
  `VM_DATA_DEFAULT_FLAGS` is `VM_READ`, `VM_WRITE`, `VM_MAYREAD`,
  `VM_MAYWRITE`, `VM_MAYEXEC` (`arch/e2k/include/asm/page.h:319-320`,
  `include/linux/mm.h:412-428`); the generic default would be
  executable. The `brk` heap uses the same flags (`mm/mmap.c:3137`).
  `VM_MAYEXEC` lets a program `mprotect` its stack executable. The
  protected-mode loader always gives a non-executable stack
  (`arch/e2k/kernel/binfmt_elfe2kp.c:1205-1206`).
- `READ_IMPLIES_EXEC` is never set by `exec`. E2K doesn't define
  `elf_read_implies_exec`, so the generic 0 applies
  (`include/linux/elf.h:9-14`), also in the protected-mode loader
  (`arch/e2k/kernel/binfmt_elfe2kp.c:1196`). When set by hand (`setarch
  -X`), it adds `PROT_EXEC` only to `mmap` and `mprotect` calls that ask
  for `PROT_READ` (`mm/mmap.c:1290-1292`, `mm/mprotect.c:708`). The stack
  and the heap keep E2K's fixed flags (inferred: E2K's `SET_PERSONALITY`
  doesn't touch the personality, `arch/e2k/include/asm/elf.h:248-280`).
- The page tables enforce it. Every protection without `VM_EXEC` maps to
  a PTE with `UNI_PAGE_NON_EX`, or to an invalid one for no access
  (`arch/e2k/mm/init.c:63-80`, `include/asm/pgtable_def.h:527-554`). A
  jump to a trampoline on a non-executable stack (no `PT_GNU_STACK`, or
  `RW`) is `SIGSEGV` with `SEGV_MAPERR` and `si_addr` the entry [hw:
  `foldp123_tramp.c`, 4C, 8C2], not the `SEGV_ACCERR`, "page is not
  executable", of `access_error` (`arch/e2k/mm/fault.c:3224-3226,
  3615-3617, 3694-3697`). With `CONFIG_MAKE_ALL_PAGES_VALID`
  (`arch/e2k/Kconfig:848-850`, default y), such a fetch presumably ends
  at "instruction page protection for valid address" (`fault.c:3850,
  3858-3862`; inferred).
- glibc: `DEFAULT_STACK_PERMS` is `PF_R | PF_W`
  (`sysdeps/e2k/stackinfo.h:31-32`). It is the starting value of
  `_dl_stack_flags` in ld.so and in static programs (`elf/rtld.c:344`,
  `elf/dl-support.c:188`), and of each loaded object's flags
  (`elf/dl-load.c:1099-1102`). A `PT_GNU_STACK` replaces it
  (`rtld.c:1469-1470`, `dl-support.c:376-377`, `dl-load.c:1217-1218`).
  Thread stacks get `PROT_EXEC` only when `_dl_stack_flags` has `PF_X`
  (`nptl/allocatestack.c:334-335`). Any object ld.so maps with `PF_X`, at
  startup or by `dlopen`, makes all stacks executable
  (`dl-load.c:1378-1425`, in `_dl_map_object_from_fd`;
  `sysdeps/unix/sysv/linux/dl-execstack.c:33-80`). MCST didn't change this
  behaviour; its only edit there is a pragma for lcc's protected mode
  (`dl-load.c:1387-1393`).
- [hw] On the 4C (kernel `6.1.158-mcst-e4c-alt1.9.1`), the 8C2
  (`6.1.0-1.17-e8c2-nn`) and the 2C3 (`6.1.0-1.18-e2c3`), the system's
  `cat` has no `PT_GNU_STACK`, its personality is 0, and its own
  `/proc/self/maps` shows `[stack]` and `[heap]` as `rw-p`
  (`execstack.sh --remote` on each, 2026-10-12).

The systems' own files have no `RWE` anywhere, and most have no segment
at all [hw: the machines' own readelf, `execstack.sh --remote` on the
4C, the 8C2 and the 2C3]. The scan covers only the top level of each
directory and only readable files. The `RW` ones include OpenSSH,
OpenSSL, NSS, FFmpeg, x265, perf, 7-Zip, Qt5Core, ICU, TBB, zstd,
libsodium, LuaJIT and sudo's `cvtsudoers`. Why they are `RW` (`-Wl,-z,noexecstack`, or assembly
sources with the note) was not established.

| Machine | Directory | ELF files | No `PT_GNU_STACK` | `RW` | `RWE` |
|---|---|---|---|---|---|
| 4C, ALT Linux (`/bin` and `/lib64` link to `/usr`) | `/usr/bin` | 909 | 893 | 16 | 0 |
| | `/usr/lib64` | 1,293 | 1,257 | 36 | 0 |
| | `/usr/libexec` | 17 | 17 | 0 | 0 |
| 8C2, Elbrus Linux 9.5.5 | `/bin` | 56 | 56 | 0 | 0 |
| | `/usr/bin` | 1,249 | 1,143 | 106 | 0 |
| | `/lib64` | 34 | 34 | 0 | 0 |
| | `/usr/lib64` | 757 | 722 | 35 | 0 |
| | `/usr/libexec` | 34 | 31 | 3 | 0 |
| 2C3, Elbrus Linux 9.5.5 | `/bin` | 58 | 58 | 0 | 0 |
| | `/usr/bin` | 1,343 | 1,239 | 104 | 0 |
| | `/lib64` | 32 | 32 | 0 | 0 |
| | `/usr/lib64` | 776 | 748 | 28 | 0 |
| | `/usr/libexec` | 37 | 34 | 3 | 0 |

For a compiler: lcc writes no note, and an object without one needs no
executable stack, so writing only an `"x"` note, in an object that
builds a trampoline on the stack, leaves every other object as lcc's
are. GCC's `file_end_indicate_exec_stack` also writes `""` into the
others (`gcc/varasm.cc:8189-8199`); a program built from them then
gets an `RW` `PT_GNU_STACK` instead of none, with the same effect at
run time. MCST gas
accepts GCC's spelling, `.section .note.GNU-stack,"",@progbits`.
Mixing these objects with lcc's is harmless and draws no linker warning,
because no note means non-executable. A single `"x"` object makes the
program's main stack and every thread stack executable, with the linker
warning above. A trampoline needs that or a heap allocator
([gcc-port-plan.md](../../doc/gcc-port-plan.md), D1, "Trampolines").

## Literal fields (binutils, gas; lcc)

Relocations in code patch the literal syllables (LTS) of a bundle, or the
`disp` field of CS0 (see [bundle.md](../isa/bundle.md)):

- A 32-bit literal (`_f32s`) is one LTS.
- A 64-bit literal (`_f64`) occupies two adjacent LTS, **high half at the
  lower address**. Relocations on 64-bit literals (the `*_LIT` types and
  `R_E2K_64_TLS_LE`) therefore store the 64-bit value with its 32-bit
  halves swapped; ld.so does the same for the dynamic `R_E2K_64_ABS_LIT`
  and `R_E2K_64_RELATIVE_LIT`. The 64-bit data relocations
  (`R_E2K_64_ABS`, `R_E2K_64_PC`, `R_E2K_64_GOTOFF`) store it unswapped.
- PC-relative fields count from the **start of the bundle** that holds
  them, not from the field. gas implements this by adding the field's
  offset inside the bundle to the addend: a literal at bundle offset
  `0x10` carries addend `0x10`, and the `disp` field (CS0, offset 8 in that
  bundle) carries addend 8. So `rrd %ip` in the same bundle plus the
  literal gives the target address (checked in lcc objects with objdump).

## Relocation types (binutils)

S = symbol value, A = addend, P = address of the field, B = start of the
bundle containing P (so with gas's addend, S + A − P = S − B),
GOT = `_GLOBAL_OFFSET_TABLE_`, G = address of the symbol's GOT entry,
TP0 = start of the module's TLS block minus the TCB (below),
DTP0 = start of the module's TLS segment.

| # | Name | Field | Value | Used for |
|---|---|---|---|---|
| 0 | `R_E2K_32_ABS` | 32 | S + A | data |
| 2 | `R_E2K_32_PC` | 32 | S + A − P | data (`.eh_frame` FDE addresses) |
| 50 | `R_E2K_64_ABS` | 64 | S + A | data; dynamic: GOT entries, absolute data |
| 51 | `R_E2K_64_ABS_LIT` | 64 literal | S + A | absolute address in code (non-PIC) |
| 54 | `R_E2K_64_PC_LIT` | 64 literal | S + A − P | `_GLOBAL_OFFSET_TABLE_` in PIC code |
| 258 | `R_E2K_64_PC` | 64 | S + A − P | data (`.eh_frame` personality, LSDA, `.gcc_except_table`) |
| 69 | `R_E2K_64_GOTOFF` | 64 | S + A − GOT | data |
| 256 | `R_E2K_64_GOTOFF_LIT` | 64 literal | S + A − GOT | address of a local symbol in PIC code |
| 109 | `R_E2K_GOTOFF` | 32 | S + A − GOT (signed) | 32-bit GOT offsets |
| 108 | `R_E2K_GOT` | 32 literal; 32 in data (`.word sym@GOT`) | G − GOT | load of a GOT entry |
| 114 | `R_E2K_GOTPLT` | 32 literal | as `R_E2K_GOT`, or the `.got.plt` slot | `@GOTPLT` |
| 110 | `R_E2K_DISP` | CS0 `disp`, 28 bits | (S + A − P) >> 3; to the PLT entry if the symbol has one | `disp %ctprN, sym` |
| 111 | `R_E2K_PREF` | CS0 `pref`, bits 4–27 | (((S + A) & ~0x7f) − (B & ~0x7f)) >> 7: 128-byte blocks | `pref %iprN, sym` (below) |
| 70 | `R_E2K_TLS_GDMOD` | 32 literal | (GOT entry holding the module ID) − GOT | GD |
| 71 | `R_E2K_TLS_GDREL` | 32 literal | (GOT entry holding the DTP offset) − GOT | GD |
| 74 | `R_E2K_TLS_IE` | 32 literal | (GOT entry holding the TP offset) − GOT | IE |
| 75 | `R_E2K_32_TLS_LE` | 32 literal | S + A − TP0 | LE |
| 76 | `R_E2K_64_TLS_LE` | 64 literal | S + A − TP0 | LE |
| 81, 83 | `R_E2K_TLS_32_DTPREL`, `R_E2K_TLS_64_DTPREL` | 32, 64 | S + A − DTP0 | debug info; dynamic: GD offset |
| 80, 82 | `R_E2K_TLS_32_DTPMOD`, `R_E2K_TLS_64_DTPMOD` | 32, 64 | module ID | dynamic only |
| 84, 85 | `R_E2K_TLS_TPOFF32`, `R_E2K_TLS_TPOFF64` | 32, 64 | TP offset | dynamic only (IE GOT entries) |
| 12, 68 | `R_E2K_32_SIZE`, `R_E2K_64_SIZE` | 32, 64 | symbol size + A | `@SIZE` |
| 63 | `R_E2K_64_JMP_SLOT` | 64 | S | dynamic: `.got.plt` slot |
| 64 | `R_E2K_64_COPY` | – | copy | dynamic |
| 65 | `R_E2K_64_RELATIVE` | 64 | load base + A | dynamic |
| 66 | `R_E2K_64_RELATIVE_LIT` | 64 literal | load base + A | dynamic: text relocation of a literal (shared library from non-PIC code) |
| 67 | `R_E2K_64_IRELATIVE` | 64 | resolver(load base + A) | dynamic: ifunc |
| 115 | `R_E2K_ISLOCAL` | 5-bit src1 of a compare | `0xc0` \| 1 if the symbol binds locally, else `0xc0` | `@ISLOCAL`; **cannot be linked** (see below) |
| 118 | `R_E2K_ISLOCAL32` | 32 literal | 1 if the symbol binds locally, else 0 | `@ISLOCAL32` |
| 13, 257 | `R_E2K_32_DYNOPT`, `R_E2K_64_DYNOPT` | 32, 64 | S + A if defined in the same input object file, else 0; no dynamic relocation | `@DYNOPT` (data only) |
| 112 | `R_E2K_NONE` | – | none | **note: not 0**; 0 is `R_E2K_32_ABS` |
| 119, 120 | `R_E2K_ALIGN_RELAX`, `R_E2K_MCSTBUG_140436_RELAX` | – | none (linker relaxation markers) | |

The 32-bit-mode types (8–11: `R_E2K_32_JMP_SLOT`, `_COPY`, `_RELATIVE`,
`_IRELATIVE`; [mode32.md](mode32.md), "ELF") and the protected-mode types
(3, 4, 100, 101: `R_E2K_AP_GOT`, `R_E2K_PL_GOT`, `R_E2K_AP`, `R_E2K_PL`)
are not used in e2k64.

There is no `GLOB_DAT`: dynamic GOT entries use `R_E2K_64_ABS` against the
symbol, or `R_E2K_64_RELATIVE` for local ones (lcc output). There is no
TLS relaxation: the linker never rewrites GD or IE code, it only resolves
the GOT entries at link time when it can (below).

`R_E2K_PREF` is what gas emits for the label of `pref %iprN, label`;
there is no `@PREF` operator (gas `tc-e2k.c:6165-6170`). It fills CS0
bits 4–27 with the distance in 128-byte units, from the 128-byte block
holding the `pref`'s wide instruction to the target's 128-byte block
(bfd `elfxx-e2k.c:384-387,5593-5612`). Its HOWTO carries the name
`R_E2K_DISP`, so `objdump -r` prints that name. **For a label that is
not global** (`.L` labels and plain local labels alike), gas emits it
against `*ABS*` plus the label's section offset, and after linking the
`pref` points at that offset taken as an absolute address (0x1000 for a
label at `.text`+0x1000); a `pref` of a global symbol is right. So use a
global symbol (`tools/isa-probes/gen_ctlleft.py` does) [source; lcc
1.29.16's gas and ld: `tools/abi/probes/prefrel.sh`]. `pref` runs in
user mode and works ([control-transfer.md](../isa/control-transfer.md), "Code
not in the instruction cache"); no compiler we have emits it.

## Assembler syntax (gas, lcc)

Relocation operators are written after the symbol inside a literal
operand, `[ _f32s,_lts0 sym@GOT ]` or `[ _f64,_lts0 sym@GOTOFF ]`:
`@GOT`, `@GOTOFF` (32-bit literal → `R_E2K_GOTOFF`, 64-bit literal →
`R_E2K_64_GOTOFF_LIT`), `@GOTPLT`, `@PLT`, `@ABS`, `@PCREL`, `@TLS_LE`,
`@TLS_IE`, `@TLS_GDMOD`, `@TLS_GDREL`, `@TLS_DTPREL` (data), `@SIZE`,
`@ISLOCAL32` (32-bit literal), `@ISLOCAL` (only as the 5-bit first
operand of a compare: `cmpedb,0 [ sym@ISLOCAL ], 0x1, %pred0`),
`@DYNOPT` (data directives only). A bare symbol in a 64-bit literal gives
`R_E2K_64_ABS_LIT`, except `_GLOBAL_OFFSET_TABLE_`, which gives
`R_E2K_64_PC_LIT` (PC-relative to the bundle) unless written
`_GLOBAL_OFFSET_TABLE_@ABS`. `disp %ctprN, sym` gives `R_E2K_DISP`,
`pref %iprN, sym` `R_E2K_PREF`.

Data directives take fewer operators (binutils: `e2k_cons_fix_new`,
`tc-e2k.c:11227-11397`): `@GOTOFF` (`.word` → `R_E2K_GOTOFF`, `.dword` →
`R_E2K_64_GOTOFF`), `@GOT` (`.word` only, `R_E2K_GOT`), `@SIZE`,
`@TLS_DTPREL`, `@DYNOPT` and `@ABS` (plain `R_E2K_32_ABS` /
`R_E2K_64_ABS`); `@PLT`, `@GOTPLT`, `@TLS_LE`, `@TLS_IE`, `@TLS_GDMOD`,
`@TLS_GDREL` and `@ISLOCAL` are "unsupported value type". A bare
`_GLOBAL_OFFSET_TABLE_` is PC-relative in data too (`e2k_parse_name`,
`tc-e2k.c:11206-11218`), but data has no relocation for that (nor for
`@PCREL` or `@ISLOCAL32`): `.dword _GLOBAL_OFFSET_TABLE_` (in `.data` or
a debug section), `.word _GLOBAL_OFFSET_TABLE_`, `.dword
_GLOBAL_OFFSET_TABLE_ - .` and `.dword sym@PCREL` stop gas with "symbol
definition loop encountered at `L0'" and an internal error in
`S_SET_SEGMENT`, and `.dword sym - _GLOBAL_OFFSET_TABLE_` with "can't
resolve sym - L0". So in data, write the GOT as
`_GLOBAL_OFFSET_TABLE_@ABS` (`R_E2K_64_ABS`: in a PIE, ld writes the
link-time GOT address into `.debug_info` and makes an
`R_E2K_64_RELATIVE` in `.data`), `sym − GOT` as `sym@GOTOFF`, and a
PC-relative GOT as `_GLOBAL_OFFSET_TABLE_@ABS - .` (`R_E2K_64_PC`).
lcc never names the GOT in data: its debug information gives a static's
address as `.uadword sym`, its initialisers `.dword sym`, and its `-O0`
PIC jump tables `.dword label@GOTOFF` (binutils b4bebd940a3's and lcc
1.29.16's gas and ld: `tools/abi/probes/gotdata.sh`; lcc 1.29.16 v3,
v5.8c2, v6.2c3 and 1.31.05 v3, `-fPIC -g` at `-O0`, `-O2`, `-O3`).

## Code sequences (lcc; Unipro the same unless noted)

No register is reserved for the GOT address: each function that needs it
computes it. Calls never need it, because the PLT finds its own GOT slot.

### Non-PIC (`-fno-pic`, executables)

| Access | Code |
|---|---|
| Address of any symbol | `addd 0x0, [ _f64,_lts0 sym ], %r` (`R_E2K_64_ABS_LIT`) |
| Load/store | the literal as the address operand: `ldw %r, [ _f64,_lts0 sym ]` |
| Call | `disp %ctpr1, sym` (`R_E2K_DISP`), `call %ctpr1, wbs = N` |
| Address of an external function | `R_E2K_64_ABS_LIT`; the linker makes the PLT entry the function's canonical address, so it compares equal to the address taken in the library (hw) |

External data referenced from non-PIC code gets a copy relocation
(`R_E2K_64_COPY`, hw).

### PIC and PIE (`-fPIC`, `-fPIE`)

GOT base, in one bundle (B is that bundle):

```
	rrd,0	%ip, %g16                                   ! B
	addd,1	0x0, [ _f64,_lts0 _GLOBAL_OFFSET_TABLE_ ], %g17   ! R_E2K_64_PC_LIT: GOT − B
	...
	addd,0	%g16, %g17, %r3                             ! %r3 = GOT
```

| Access | Code |
|---|---|
| Address of a preemptible or external symbol (data or function) | `ldd %r3, [ _f32s,_lts0 sym@GOT ], %r` |
| Address of a local symbol | `addd %r3, [ _f64,_lts0 sym@GOTOFF ], %r` (`R_E2K_64_GOTOFF_LIT`) |
| Call (any function) | `disp %ctpr1, sym`; the linker points it at the PLT entry if the symbol may be preempted or is undefined |

In a PIE, symbols defined in the executable use `@GOTOFF` and external
ones `@GOT`. In a shared library lcc goes through `@GOT` for every global
symbol (it may be preempted), and calls global functions through the PLT.

### Function pointers and indirect calls

An indirect call loads the address into a CTPR with `movtd %r, %ctprN`
(lcc issues it speculatively, `movtd,0,sm`) and calls it; the address is
the same in every model (taken as above).

## PLT and lazy binding (binutils, glibc)

A call reaches a PLT entry in a **new window**: the caller's `call`
has already allocated it. The entry is (64-bit, PIC):

```
	rrd,0	%ip, %dr8 ; setwd wsz = 0x8, nfx = 0x1
	ldd,0	[ %dr8 + slot − entry ], %dr8        ! .got.plt slot
	movtd,0	%dr8, %ctpr1
	ct	%ctpr1                                 ! jump, not call
```

(non-PIC: `ldd` from the slot's absolute address in a 64-bit literal;
v7: `ibranchd %dr8` instead of `movtd`/`ct`; v6+: `nop 4` instead of
`nop 2` before the use of the load.) The target's own `setwd` then resizes
the window. Consequences for a compiler:

- At function entry only the argument registers are defined; `%dr8` and
  above and `%ctpr1` may have been changed by a PLT entry.
- The PLT jumps rather than calls, so the target returns directly to the
  original caller.

Lazy binding (`DT_E2K_LAZY_GOT`): each `.got.plt` slot initially holds
the address of a secondary entry (link-time address; ld.so adds the load
base when the object is relocated). The secondary entry does
`setwd wsz = 0x8`, puts the byte offset of the `R_E2K_64_JMP_SLOT`
relocation in `.rela.plt` into `%r9`, and branches to the PLT header. The
header loads `.got.plt[1]` (link map) into `%dr8` and `.got.plt[2]`
(`_dl_fixup`) into `%dr10`, and calls `_dl_fixup` with `wbs = 4`, so its
arguments are `%dr8`, `%dr9`; the original arguments in `%dr0`–`%dr7`
stay untouched below the base. `_dl_fixup` returns the target in its
`%dr0` (the header's `%dr8`), and the header jumps there. No assembly
trampoline saves registers: the window does it. `LD_BIND_NOW` and
`-z now` resolve the slots at load time (hw, both ways).

## Thread-local storage (glibc, binutils, lcc, unipro)

- The thread pointer is **`%g13`** (`%g12` in protected mode). The
  kernel preserves it; code must not change it.
- Layout is **variant I** (`TLS_DTV_AT_TP`): at TP is a 16-byte TCB
  `{ dtv_t *dtv; void *private; }`; the executable's TLS block follows at
  TP + align(16, `p_align` of `PT_TLS`). `struct pthread` lies below TP;
  glibc keeps the stack-protector canary at TP − 8 and the pointer guard at
  TP − 16.
- TP offsets of the executable's TLS are fixed at link time:
  TP0 = start of `PT_TLS` − align(16, its alignment).
- `__tls_get_addr` takes **two arguments**, the module ID and the offset
  in the module's block (`void *__tls_get_addr(size_t m, size_t off)`);
  there is no `tls_index`.

Models and code (no local-dynamic model: lcc uses GD for local and
hidden variables too; no relocation for LD exists):

| Model | Used by | Code |
|---|---|---|
| GD | PIC (shared libraries) | load two GOT entries into the argument registers and call: `ldd %r3, [ _f32s,_lts0 x@TLS_GDMOD ], %b[0]`; `ldd %r3, [ _f32s,_lts2 x@TLS_GDREL ], %b[1]`; `disp %ctpr1, __tls_get_addr`; `call %ctpr1`; the address is in `%b[0]` |
| IE | PIE and non-PIC, for TLS defined elsewhere | `ldd %gotbase, [ _f32s,_lts0 x@TLS_IE ], %t`; then `ldw %g13, %t, %r` (the TP offset is added by the load). Non-PIC code gets the GOT base from `addd 0x0, [ _f64,_lts1 _GLOBAL_OFFSET_TABLE_@ABS ], %r` |
| LE | executables, for their own TLS | `ldw %g13, [ _f64,_lts1 x@TLS_LE ], %r` (64-bit offset; `R_E2K_32_TLS_LE` also exists) |

GOT entries the linker creates:

| Entry | In an executable, local symbol | Otherwise |
|---|---|---|
| GD module ID | 1 (one entry shared by all local symbols) | `R_E2K_TLS_64_DTPMOD` (one shared entry for the module's local symbols) |
| GD offset | DTP offset | `R_E2K_TLS_64_DTPREL` |
| IE offset | TP offset | `R_E2K_TLS_TPOFF64` (ld.so: S + `l_tls_offset`; static TLS) |

The module-ID and offset entries are separate, not a pair, so GD loads
two independent GOT offsets.

**Debug information.** lcc describes a `__thread` variable as
`DW_OP_addr` holding the variable's offset in its module's TLS block,
written `.uadword x@TLS_DTPREL` (`R_E2K_TLS_64_DTPREL`), followed by
`DW_OP_GNU_push_tls_address` (0xe0); an extern TLS variable that is used
but not defined gets no DIE [lcc 1.29.16 and 1.31.05, `e2k-v3`, `-g -O0
-c`; the 32-bit form: [mode32.md](mode32.md), "C runtime"]. gas makes
`R_E2K_TLS_64_DTPREL` of `x@TLS_DTPREL` in any 8-byte data directive
(`.dword`, `.8byte`, `.quad`, `.uadword`) and `R_E2K_TLS_32_DTPREL` in
any 4-byte one (`.word`, `.4byte`, `.long`, `.uaword`), and rejects
other sizes (`tc-e2k.c:11239-11247`) [binutils:
`tools/abi/probes/debuginfo_loc.sh`]. MCST's gdb reads the selected
thread's variable in lcc's form and in GCC's: `DW_OP_const8u` (or
`DW_OP_const4u`) with the offset, then `DW_OP_GNU_push_tls_address`, or
`DW_OP_form_tls_address` from DWARF 5 on [hw:
`tools/abi/probes/debuginfo.sh`, 4C, 8C2, 2C3]. It finds the TLS block
through `libthread_db` (`e2k-linux-tdep.c:526-528`;
`/lib64/libthread_db.so.1` on ALT and OS Elbrus), which works in dynamic
programs and in static ones that link `pthread_create`; a static
program without threads gives "Cannot find thread-local storage" [hw:
`debuginfo_misc.c`, all three].

## Exception tables (lcc, libgcc)

`.eh_frame` CIEs use augmentation `zR` (C) or `zPLR` (C++ with
handlers), with FDE pointer encoding `0x1b` (`pcrel|sdata4`,
`R_E2K_32_PC`). In PIC code the personality is `0x9c`
(`indirect|pcrel|sdata8`, through a `DW.ref.__gxx_personality_v0` word,
`R_E2K_64_PC`) and the LSDA `0x1c` (`pcrel|sdata8`), and
`.gcc_except_table` refers to type infos through `DW.ref.*` words with
`R_E2K_64_PC`. Without `-fPIC` (`l++ -O2 -c`) lcc writes the personality
and LSDA as `absptr` (`0x00`), 8-byte `R_E2K_64_ABS` words, and refers
to type infos directly, also with `R_E2K_64_ABS`. Return-address column
0, no CFI instructions (see
[stack-and-unwinding.md](stack-and-unwinding.md)). lcc emits no
`.eh_frame` for C code at `-O2`. (MCST's readelf can't apply
`R_E2K_64_PC` when dumping an object's `.eh_frame` and warns.)

## Stack protector (lcc, unipro, glibc)

Not required. The protector guards the saved return address, and on E2K
that lives in the chain stack, which a program can't write (see
[stack-and-unwinding.md](stack-and-unwinding.md)); spilled registers are
in the procedure stack, also out of reach, and the caller's `USD` is
restored from the chain stack on return. A buffer overflow on the user
stack can still corrupt other arrays and address-taken locals there,
including function pointers, but cannot redirect a return.

lcc 1.29 and Unipro accept every `-fstack-protector*` option and emit no
check. lcc 1.31 implements them (its changelog says so), but differently
from GCC (lcc 1.31.05, `tools/abi/probes/stackprot.c`):

- The canary is the **constant** 32-bit word `0x000d0aff` (bytes `ff 0a
  0d 00`, a terminator canary), not glibc's random guard. It is stored
  with `stw` in the top 4 bytes of the frame, above the locals.
- Before returning, the function reloads it, compares with `cmpesb` and
  calls `__stack_chk_fail` on a mismatch; if that returns, the function
  returns normally.
- In 1.31.05 plain `-fstack-protector` protects **every** function, even
  one without arrays (GCC's `-all` behaviour; a leaf function gets a
  frame just for the canary). `-fstack-protector-strong`, `-all` and
  `-explicit` emit nothing. This looks like a bug.

No layout rule depends on this: the canary is private to each frame. glibc
stores a random canary at TP − 8 (`THREAD_SET_STACK_GUARD`); a compiler
that implements the protector should use it (GCC's usual TLS guard),
since a constant canary only stops overflows through string functions.

## Unipro

Unipro's clang uses the same relocations and TLS models, but writes the
GOT base as `_GLOBAL_OFFSET_TABLE_-.L0$pb` against a label on the
`rrd %ip` bundle, and calls `__tls_get_addr@GOTOFF` through `disp`; MCST's
gas rejects the label arithmetic, so its PIC assembly can only be
assembled by its own integrated assembler.

## Rarely used operators, ifunc and gold (binutils, hw)

Nothing in glibc, the kernel, gdb or MCST's runtime libraries uses
`@ISLOCAL`, `@ISLOCAL32` or `@DYNOPT`, and lcc emitted none of them for
our probes. Behaviour of MCST ld 2.41, checked by
`tools/abi/probes/elfops/run.sh` on the 4C, and with the same results
built for v5 (`run.sh v5.8c2 --remote claude@geofront.lan`) on the
Elbrus-8C2 under Elbrus Linux 9.5 (glibc 2.35), where the DSO probe
(`dso/run.sh`) also passes, lazily and with `LD_BIND_NOW=1`, and the
same again built for the Elbrus-2C3 (v6, `run.sh v6.2c3 --ssh-port
...`; the output is the 8C2's line for line):

- **`R_E2K_ISLOCAL` cannot be linked.** Its howto declares a 1-bit field
  while `relocate_section` computes `0xc0 | local`, so every use fails with
  "relocation truncated to fit". Use `@ISLOCAL32`.
- **`@ISLOCAL32`** (1 = binds locally):

  | Symbol | non-PIE executable | PIE | shared library | shared library, `-Bsymbolic` |
  |---|---|---|---|---|
  | `static` | 1 | 1 | 1 | 1 |
  | global, same object | 1 | 1 | **0** | 1 |
  | global, `hidden` | 1 | 1 | 1 | 1 |
  | global, another object of the link | 1 | 1 | **0** | 1 |
  | function from another shared library | 1 | 1 | 1 | 1 |
  | weak undefined | 0 | 0 | 0 | 0 |

  So it is 0 for preemptible definitions and undefined weak symbols. It
  is 1 for functions in other shared libraries (reached through the PLT),
  which matches "a direct call is valid" rather than "defined here".
- **`@DYNOPT`** gives the link-time value of symbols defined in the same
  *input object file* and 0 for anything else, with no dynamic relocation.
  So the value is a usable address only in a non-PIE executable; in a PIE
  or shared library it lacks the load base and only tells "defined in
  this object" (non-zero) apart from "elsewhere" (0).
- **ifunc** (`__attribute__((ifunc))`, `STT_GNU_IFUNC`): works in a shared
  library (exported as an `IFUNC` symbol, resolved by ld.so) and in a
  non-PIE executable (`R_E2K_64_IRELATIVE`), lazily and with
  `LD_BIND_NOW=1`, and the address taken in another object compares equal
  (hw). It **fails in a PIE**: lcc takes the ifunc's address with
  `R_E2K_64_GOTOFF_LIT`, which the ifunc branch of `relocate_section` does
  not handle; it falls into a `default` that returns failure without a
  message (a `FIXME` in the source says so), so ld exits with status 1
  and prints nothing. A **static** link with an ifunc makes ld crash
  (segmentation fault). A compiler should reach ifunc symbols through
  `@GOT` in PIC code. All three problems (also `R_E2K_ISLOCAL`, above)
  are still there in the native binutils 2.41-29.023 of ALT Linux on
  the 4C and of Elbrus Linux 9.5 on the Elbrus-8C2 (checked on both).
- **`@GOTPLT`** ("inlined PLT entries" in `elfxx-e2k.c`): `ldd` of
  `[ _f32s,_lts0 f@GOTPLT ]` from the GOT base (lcc's `rrd %ip` +
  `_GLOBAL_OFFSET_TABLE_` idiom) gives the function's `.got.plt` slot;
  `movtd` to a CTPR and `call` through it calls the function without a
  PLT entry, which is what `-fno-plt` code would do (neither lcc, which
  has no `-fno-plt`, nor Unipro emits it). `gotplt.s` on the 4C: correct
  results from a non-PIE executable, a PIE, a PIE linked `-z now` and a
  shared library, the first call through lazy binding included. ld
  makes the slot an `R_E2K_64_JMP_SLOT` in `.rela.plt` (the same slot a
  PLT call would use) for a function from another object and for a
  preemptible one in a shared library; for a function the executable
  defines it needs no dynamic relocation.
- **Copy relocations for data reached only through the GOT depend on
  uninitialized memory.** An executable (PIE or not) that refers to a
  shared library's variable only through `R_E2K_GOT` needs no copy: the
  GOT slot gets an `R_E2K_64_ABS` against the library's symbol. MCST ld
  still adds an `R_E2K_64_COPY` (the slot then points at the
  executable's copy, and every later `.bss` address moves) when the
  symbol's hash entry has `gotoff_ref` set. Only `R_E2K*_GOTOFF*`
  relocations set that bit, but `_bfd_e2k_elf_link_hash_newfunc` never
  initializes it, so it holds whatever the hash table's memory held
  [binutils `bfd/elfxx-e2k.c:1395, 2604-2640, 3690-3696, 4104`]. Both
  outputs work, but two links of the same objects can differ. In
  `tools/abi/probes/folda37_copyrel.sh`'s link, ld 2.41-29.023 makes the
  copy when glibc's `MALLOC_PERTURB_` is even (ld's new memory then
  filled with an odd byte) and not when it is odd or unset, natively on
  the 4C and the 8C2 and as an x86 cross built from
  `OpenE2K/binutils-gdb`, and every output runs [hw; not run on the
  2C3]. The x86 cross ld 2.41-29.018 that lcc in `/opt/mcst` runs made
  no copy either way. Shared libraries are not affected. lcc's and the
  proof-of-concept back end's `libstdc++.a` reach `stdin`, `stdout`,
  `stderr` and `__libc_single_threaded` only through the GOT, so a
  `-static-libstdc++` link meets it: two builds of one native GCC gave
  identical objects but different `gcov`, `gcc` and `cc1plus`, and
  relinking `gcov` with its x86 cross ld made the copy of
  `__libc_single_threaded` in 4 of 8 runs (the proof-of-concept back
  end's finding A37; not rerun).
  Compare builds by their objects, or link with an odd
  `MALLOC_PERTURB_`.
- **gold** has an E2K backend (`gold/e2k.cc`, enabled in
  `gold/configure.tgt`) but MCST does not ship it. Built from source and
  given lcc's link lines, it links a static program correctly but breaks
  dynamic ones: it has no copy-relocation support (a non-PIE executable
  using a library variable gets a text relocation and computes a wrong
  result) and the PIE dies with `SIGILL`. Its output has no
  `DT_E2K_LAZY_GOT`, so ld.so would bind it eagerly. `ld.bfd` is the only
  usable linker.

## Other modes

32-bit mode is in [mode32.md](mode32.md), protected mode (its own
relocation types, `%g12` as the thread pointer, a PLT that hands over 8
register pairs) in [protected-mode.md](protected-mode.md).
