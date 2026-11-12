# Building MCST's Linux kernel: what it asks of a compiler

What compiling `OpenE2K/linux` (MCST's 6.1-1.19 tree, commit
51c316e1d536; `arch/e2k`, `arch/l` and what they pull in) needs from a
C compiler beyond the user-mode ABI: the lcc options the kernel passes
and what they change, the kernel's global registers, functions that
must not touch the data stack, the inline-asm idioms it relies on, the
code a compiler must not emit in kernel mode, and the tools that read
compiler output back. Every kernel-mode effect (trap entry, the TLB, the
AAU, physical mode) is privileged and comes from the kernel sources;
what lcc does comes from compiling probes and kernel files on the host.
Nothing here ran on hardware except the proof-of-concept back end's own
kernel, booted on the 8C2 (`tools/distro`): where a section says how a
GCC-built kernel failed, the boot showed it, and its objects and
compile-only probes gave the cause. That kernel's source changes are
commits on branch `mcst-linux-6.1.y-gcc` of `OpenE2K/linux`, cited
below as "kernel branch" and a commit.

Marks as in [README.md](README.md), with: **[source]** read in the
kernel tree (the README's **kernel**) or, for what GCC does, in GCC's
sources (`toolchains/gcc`, paths `gcc/...`); **[lcc-doc]** lcc's manual
(1.29.16 and 1.31.05 `doc/lcc`, changelogs 1.24–1.31); **[lcc]** lcc
output, compile only: lcc 1.29.16 for `e2k-v3`, `e2k-v5.8c2` and
`e2k-v6.2c3` (the erratum option also `e2k-v3.4c`, `e2k-v4.8c`,
`e2k-v4.1c+` and `e2k-v6.16c`) and 1.31.05 for `e2k-v3`, `e2k-v5.8c2`
and `e2k-v6.2c3`, which agree unless a version is named; **[gcc]**
GCC's own target-independent behaviour (front end, middle end, generic
options), observed with the proof-of-concept back end
(`toolchains/gcc-claude`) or with GCC on another target (the host's GCC
16.2.1 for x86-64 and i386), compile only. What that back end itself
lacks is not recorded here; the requirements below say what any port
needs. Kernel paths: `asm/` is `arch/e2k/include/asm/`; other paths are
under `arch/e2k/` unless they start with `include/`, `scripts/`,
`arch/l/`, `crypto/`, `drivers/`, `kernel/sched/`, `kernel/trace/` or
`mm/slub`, or say "top".

Probe: `tools/abi/probes/kernelbuild.py` (sections `options`, `gregs`,
`gvars`, `gregapi`, `barrier`, `attrs`, `attrs2`, `open`, `modifiers`,
`asmops`, `pragmas`, `codegen`, `jumptab`, `blockmove`, `bug123567`,
`int128`, `relocs`, `pg`, `wsz`; `--compare-wsz` for objects). The
kernel files were built out of tree on the host with `make O=... ARCH=e2k
CROSS_COMPILE=e2k-linux- CC=<lcc> defconfig prepare <objects>` (lcc
1.29.16 `e2k-v3`, `arch/e2k/configs/defconfig`: generic v3 kernel,
`CONFIG_SEMI_SPECULATIVE_KERNEL=y`, `CONFIG_FUNCTION_TRACER=y`, `-O3`;
prepare takes 13 s, `ttable.o` and seven more objects about 40 s at
`-j4`, with lcc's binutils in `PATH`; `V=1` prints each command line).

## Options the kernel passes [source, lcc-doc, lcc]

`scripts/Makefile.compiler:45-72` defines `lcc-option` and
`lcc-options`. `lcc-option` keeps the option if `$(CC) -Werror <flags so
far> <option> -c -x c /dev/null` succeeds, else the same option spelled
`-flb-option=<option>` (the clang spelling) if that succeeds, else
nothing. `lcc-options` tries the whole group and also the group with
every option spelled `-flb-option=`, and keeps whichever succeeds. A
group fails as a whole: one option a compiler rejects drops every
option in it, and nothing reports it.

| Option | Where | lcc's meaning | GCC [gcc] |
|---|---|---|---|
| `-fkernel` | `arch/e2k/Makefile:30`, a group with `-gline -mdmodel=large -fno-devirtualize` | build the Linux kernel; "assumes interrupts are disabled while system registers are handled" and a "non-standard API for global registers". Implies `-fno-semi-spec-ld -fsemi-spec-ld-glob -fsemi-spec-ld-stack -fsemi-spec-ld-greg -fforce-inline -fprefetch -fno-global-regs -fnon-std-greg-api -fno-loop-peeling -fno-inline-part -fno-lcv -fno-params-to-locals -fno-use-memcpy -mstrict-align` (1.29 and 1.31 manuals). 1.26 replaced its ban on semi-speculative loads by the partial one above and dropped `-fno-loop-apb` and `-fno-strict-aliasing` from it; 1.31 turned full peeling of counted loops on (`changelog_126.html`, `changelog_131.html`) [lcc-doc] | group dropped: `-gline` is "unrecognized debug output level" |
| `-gline` | same group | line numbers for `ldis` only ([stack-and-unwinding.md](stack-and-unwinding.md), "Debug information") | (dropped with the group) |
| `-mdmodel=large` | same group | dynamic objects over 4 GiB allowed ([source-compat.md](source-compat.md)) | (dropped) |
| `-masm-inline` | `:31`, `cc-option` | lcc may parse and schedule GNU asm with the surrounding code (below, "State-register reads"); off by default at every `-O` level [lcc] | rejected, dropped |
| `-fglobal-regs -ffixed-g16` … `-ffixed-g25` | `:32-35`, one `lcc-options` group | use global registers for temporaries [lcc-doc]: `%g16`–`%g31`, lcc's user-mode default [lcc]; never allocate `%g16`–`%g25` | `-fglobal-regs` rejected, so the fixed registers go too (next section) |
| `-fno-spec-volatile-st` | `:36` | no speculative stores through `volatile` pointers, for memory types that forbid speculative accesses (External nonPrefetchable, External Configuration) (1.30+) [lcc-doc] | rejected; 1.29.16 rejects it too |
| `-Wassign-where-compare-meant`, `-finline-functions-called-once` | `:37-38` | | the first rejected, the second accepted |
| `-mfixed-gregs-base` | `:39` | assume `abg`/`abgc`/`modbgv` never move the base of `%g24`–`%g31` (1.31) [lcc-doc]; [source-compat.md](source-compat.md), "Rotating globals" | rejected; 1.29.16 rejects it too |
| `-fno-loop-apb -fsemi-spec-ld` or `-fno-loop-apb -fno-semi-spec-ld` | `:41-46`, after `-fkernel` ("Must go after -fkernel"), by `CONFIG_SEMI_SPECULATIVE_KERNEL` (`y` in `defconfig`, `n` by default; `Kconfig:598-616`) | no array prefetch; semi-speculative loads everywhere, or none (fully speculative ones remain; "Speculative loads" below) | group dropped |
| `-fno-ident` | `:78-81`, for any compiler but GCC | | (not passed to GCC) |
| `-ffix-lcc-bug123567` | `:107-109`, for an E8C2 machine kernel and whenever `CONFIG_CPU_E12C` or `CONFIG_CPU_E16C` is set, which every generic kernel with `CONFIG_CPU_ISET_MIN` ≤ 6 has (`Kconfig:544-548`) | in no lcc manual; below, "Erratum #123567" [lcc] | rejected |
| `-march=elbrus-vN` (generic) or `-mtune=elbrus-<cpu>` (machine kernel; `-mcpu` for clang) | `:62-70, 87-142` | | |
| `-fexclude-ctpr2 -fno-semi-spec-ld`, and `-fno-dam` if `CONFIG_MIGHT_HAVE_CPU_HWBUG_L1I_RBRANCH_CALLS` (`CPU_ISET_MIN` ≤ 6); `-fglobal-regs` and `-fsemi-spec-ld` removed | `kernel/Makefile:57-82`: `ttable.o`, `ttable_tmp.o` (trap entry and exit) | no `%ctpr2` ("needed when building the Linux kernel" [lcc-doc]); no DAM | rejected |
| `-fno-global-regs` | `kernel/cpu/Makefile:14-16` (`iset_v3.o`, `iset_v5.o`: they save and restore `%g16`–`%g31`), `p2v/Makefile:30` (`boot_head.o`), `kvm/Makefile:47, 57-58`, `kernel/libeprof/Makefile:5` | no global temporaries | rejected |
| `-fno-semi-spec-ld -fno-spec-ld -fno-jump-tables -ftrivial-auto-var-init=uninitialized` | `p2v/Makefile:11-13`, `kernel/Makefile:139-142` (kexec), `boot/Makefile:10-11`, `kvm/guest/Makefile:56-57`: code that runs at physical addresses | no speculative loads at all; no jump tables (but see "Volatile stores, jump tables, alignment"; what else GCC must not add there: "Physical mode") | `-fno-jump-tables` and `-ftrivial-auto-var-init` accepted, the rest rejected |
| `__no_semispec` | `asm/compiler.h:212-222` on every `.uaccess_functions` function (`asm/uaccess.h:397-411`: a `noinline` wrapper around an `always_inline` body) | lcc ≥ 1.31.05: `optimize("-fno-semi-spec-ld")`, `optimize("-fno-loop-apb")`: no semi-speculative load (fully speculative ones with recovery instead) and no APB; 1.29.16 ignores both silently, hence `optimize("O1")` for older lcc: no speculative load at all. Both reach the inlined body [lcc: `tools/abi/probes/foldp103_nosemispec.py`]. clang `optnone` | **not defined**: `uaccess.h:411` fails to parse ("expected ';' before 'long'"); what a port needs is under "Speculative loads" |
| `-pg` | top `Makefile:789` (`CONFIG_FUNCTION_TRACER`) | below, "ftrace" | passes the empty-file test, but the proof-of-concept back end then says "sorry, unimplemented" for any function |
| `-Wframe-larger-than=6144` | `kernel/Makefile:6-8` (`CONFIG_VIRTUALIZATION`; 4096 or 8192 in the KVM code) | accepted | accepted; top `Makefile:879-883` passes `CONFIG_FRAME_WARN` (0 in `defconfig`) to every compiler but lcc |

So a GCC gets none of the kernel's code-generation restrictions and no
fixed global registers, and nothing in the build says so. lcc 1.29.16
itself loses `-fno-spec-volatile-st` and `-mfixed-gregs-base` the same
way (1.31.05 takes both). On `ttable_tmp.o` lcc 1.29.16 gets, among
others, `-fkernel … -ffixed-g16` … `-ffixed-g25 … -fno-loop-apb …
-ffix-lcc-bug123567 -march=elbrus-v3 … -O3 … -ftrivial-auto-var-init=zero
… -pg … -fexclude-ctpr2 -fno-semi-spec-ld -fno-dam -DGENERATING_HEADER`,
without `-fglobal-regs` and `-fsemi-spec-ld` (host build, `V=1`) [lcc].

## Global registers

### The kernel's convention [source]

`asm/glob_regs.h:22-24, 26-72`: `%g0`–`%g15` are "global for user
applications according to ABI" (`GLOBAL_GREGS_USER_MASK`; lcc never
allocates them, [registers.md](registers.md)), `%g16`–`%g25` hold
kernel state while in the kernel, and `%g26`–`%g31` are the compiler's
scratch (`SCRATCH_GREGS_START` = 16 + `KERNEL_GREGS_MAX_NUM` 10).

| Register | Kernel use | Declared by |
|---|---|---|
| `%g16` | VCPU state (paravirtualisation; pairs with `%g17` for tagged saves) | `GUEST_VCPU_STATE_GREG`, no C variable |
| `%g17` | `current` (task pointer) | `asm/current.h:15` |
| `%g18` | per-CPU offset `__my_cpu_offset` | `asm/percpu.h:17` |
| `%g19` | CPU number and preempt count `__cpu_preempt_reg` | `asm/smp.h:98`, `asm/atomic_api.h:32`, `asm/preempt.h:10` (the same declaration three times) |
| `%g20` | `current_mmu_context` | `asm/mmu_context.h:60` |
| `%g21` | `u_root_ptb` (user page-table base for uaccess) | `asm/mmu_context.h:62` |
| `%g22` | `uaccess_max` | `asm/uaccess.h:269` |
| `%g23`, `%g24` | CPU feature bits `cpuhas_greg0`/`1` | `asm/cpu_features.h:58-59` |
| `%g25` | unused (reserved) | |
| `%g26`–`%g31` | compiler temporaries (`-fglobal-regs`) | |

The kernel switches `%g16`–`%g25` between user and kernel values at
trap entry and exit, in C code built with no global temporaries
(`ttable.c`, `iset_v3.c`/`iset_v5.c`; table above), so that nothing
clobbers a user value before it is saved. Fast system calls (entry 6)
switch nothing: they run with the user's `%g16`–`%g25` and read
`current` from a system register instead (`fast_syscalls/fast_getcpu.c`:
`read_CURRENT_reg_value()`), so only `-ffixed-g16` … `-ffixed-g25`
keeps the user's values there, while `%g26`–`%g31` may change
([kernel-interface.md](kernel-interface.md), "Fast system calls").
`barrier()`, `barrier_preemption()` and `barrier_data()` clobber
`"g19", "g18", "g20"` so that per-CPU addresses are recomputed after
them (`asm/compiler.h:114-195`); GCC takes such a clobber for an
overwrite ("Global registers named only in templates and clobbers").

### What lcc does [lcc]

- **A file-scope `register T v asm ("%gN")` does not reserve `%gN`.**
  Functions of the same file that don't use `v` allocate it like any
  other register: with variables at `%g20` and `%g28`, a function needing
  many temporaries used all of `%g16`–`%g31` at `-O3`, also with
  `-fkernel -fglobal-regs` (both versions, v3, v5, v6; `gregapi`). The
  variable only names the register. That is why the kernel adds
  `-ffixed-g16` … `-ffixed-g25`.
- `-fno-global-regs` (implied by `-fkernel` and `-fsysware` [lcc-doc]):
  no global temporaries at all. `-fglobal-regs`: `%g16`–`%g31`, lcc's
  user-mode default. With the kernel's options the temporaries are
  `%g26`–`%g31`. `-fnon-std-greg-api` alone changed nothing in these
  probes.
- Uses of a register variable: read again after a call (a call may
  change it), but two reads with only a store between are merged; two
  writes in a row are both kept.
- `-mfixed-gregs-base` (1.31.05): without it lcc reads a variable in
  `%g24`–`%g31` once per use (two `cpuhas_greg1 & 4` with a store between:
  two reads of `%g24`); with it, once.
- In lcc's own build of `iset_v3.o` and `ttable.o` (host build), every
  use of `%g26`–`%g31` is in the kernel's save and restore asm (`ldrd`,
  `gettagd`, `puttagd`, `movif`, `movfi`, `strd`); the compiled code uses
  none.

### What GCC does [gcc, source]

- GCC makes the register of a file-scope register variable fixed for the
  rest of the file (`gcc/reginfo.cc:737-790`, `globalize_reg`). If the
  register is call-clobbered and not already fixed it warns
  "call-clobbered register used for global register variable"
  (`:764-765`). That warning has no `-W` option, so under the kernel's
  `-Werror` (`arch/e2k/Makefile:60`) **every file that includes
  `asm/current.h` fails to compile**. With `-ffixed-g16` …
  `-ffixed-g25` there is no warning. The three identical declarations
  of `__cpu_preempt_reg` are accepted.
- GCC deletes the first of two writes to a register variable with
  nothing between them; lcc keeps both.
- With the group dropped, a back end that, like lcc, takes temporaries
  from `%g16`–`%g31` uses every one of them that no register variable
  of the file names (`%g16`, `%g25` and `%g26`–`%g31` in files that
  include the declaring headers, all sixteen in a file that includes
  none); in `ttable.o` that clobbers user globals before the kernel
  saves them. `-ffixed-g16` … `-ffixed-g25` alone is not enough for
  `iset_v3.o`: `save_scratch_gregs_v3` stores `%g26`–`%g31` itself, so a
  temporary the compiler puts there before the store would be saved
  instead of the user's value. lcc's `iset_v3.o` touches `%g26`–`%g31`
  only in the kernel's asm.

A compiler building this kernel must therefore get `-ffixed-g16` …
`-ffixed-g25` in every file and `-ffixed-g16` … `-ffixed-g31` in the
files lcc builds without global temporaries (`ttable.o`,
`ttable_tmp.o`, `iset_v3.o`, `iset_v5.o`, `boot_head.o`,
`hv_glaunch.o`, `hypercalls.o`, `libkeprof.o`), either by accepting
lcc's spellings (`-fglobal-regs`, `-fno-global-regs`) or through a
kernel Makefile change. Any global register the compiler uses outside
register allocation (a register for a result buffer's address, a
thunk's scratch register) must honour the same reservations.

## Functions without a data-stack frame: `check_stack`

### The attribute [lcc, lcc-doc]

lcc's manual lists three E2K attributes with no description:
`check_stack`, `check_mem`, `avoid_stack` (`attribute_mcst.html`). The
kernel uses the first as `__interrupt` (`asm/sections.h:11-15`; any
other compiler gets `__attribute__((__interrupt__))`). Probed with the
kernel's options at `-O3` (and `-O0`) on v3, v5, v6, both versions
(`attrs`, `attrs2`):

| Function body | no attribute | `check_stack` | `check_mem` |
|---|---|---|---|
| arithmetic only | no frame | no frame | no frame |
| loads and stores through pointers or of globals | | allowed, no frame | **error** "memory access in function 'f' with attribute 'check_mem'" (also a load written in an asm under `-masm-inline`, at `-O3`; at `-O0` that function compiles, with a `getsp`) |
| a call with 1–8 arguments, direct or indirect; a `noreturn` call; a call returning 16 or 32 bytes | `getsp` for the argument area (none for a call without arguments) | **no `getsp`**: the outgoing argument area is not reserved | `getsp` kept |
| a call with 9 or 12 arguments; a variadic call; an 80-byte struct argument or result | `getsp` | **error** "stack access in function with attribute 'check_stack'" | error (memory access) |
| 10 incoming arguments (two on the stack) | | error | error |
| the address of a local passed out; a local array with a variable index (also in an inlined helper); `alloca`; a VLA | `getsp` | error | error |
| 70 values live across a call | no spill (`wsz = 0x30`) | no spill (`wsz = 0x31`, one window unit more) | error |
| 300 values live across a call | spills (`getsp`) | error | error |
| a call returning a 16-byte struct, at `-O0` | | error at `-O0`, allowed at `-O3` | |
| `-pg` | `getsp` before `_mcount` | the `_mcount` call without `getsp` | |

So `check_stack` makes lcc refuse, never silently allocate, anything
that needs the data stack (`USD`): spills, locals in memory, stack
arguments in either direction, the caller's argument area. It doesn't
change callers (a call to a `check_stack` function still reserves the
area). lcc's documented `no_caller_stack` attribute
([source-compat.md](source-compat.md)) is the declared form of that
omission for one callee. `check_mem` forbids every memory access the
compiler would emit but still lets it reserve a frame. `avoid_stack`
behaved like no attribute in every case (1.29.16 gave the local-array
function another window size, `wsz = 0x7` instead of `0x4`/`0xa`; no
other difference). lcc 1.29.16's `ecc64` crashes (SIGSEGV) on a
`check_mem` function that accesses memory at `-O0` with the kernel's
options; 1.31.05 reports the error.

### The kernel's users and their contract [source, lcc, gcc, unipro]

About 90 functions carry `__interrupt`: the fast system calls
(`fast_syscalls/*.c`, `asm/fast_syscalls.h:369, 470`), which entry 6
reaches with `ct`, not `call`, on the user's stacks after its own
`setwd wsz = 0x8` (`kernel/trap_table.S:691-745`); the global-register
save and restore (`kernel/cpu/iset_v3.c:70-161`, `iset_v5.c`,
`kvm/cpu/`); `kernel_data_stack_overflow` and its no-stack dump
(`kernel/ttable.c:186, 205, 275`); `e2k_setjmp`/`e2k_longjmp`, "to make
sure that parent's values of USD are read" and "that %usd is written
correctly" (`kernel/setjmp.c:10-11, 57-58`); `ftrace_stub`
(`kernel/ftrace.c:220`); `relocate_kernel.c:51`; and `always_inline`
helpers such as `native_read_UPSR_reg`
(`asm/native_cpu_regs_access.h:36`). 17 more are privileged hypercalls
(`__priv_hypercall`, `asm/sections.h:33`). The kernel's comment states
the contract: the attribute "makes compiler put all local variables in
registers and do not use stack", so such functions make no variadic
calls and at most 8-argument calls; printk goes through fixed-argument
wrappers (`kernel/e2k_syswork.c:3157-3175`, `asm/e2k_syswork.h:19-28`).

A compiler needs an attribute with `check_stack`'s semantics: an error
whenever the function would need a data-stack frame, spill to memory,
pass or receive stack arguments or reserve the outgoing argument area,
and calls with up to 8 register arguments made without reserving that
area. GCC warns "'interrupt' attribute directive ignored" (an error
under `-Werror`) [gcc]; Unipro's clang ignores both spellings ("unknown
attribute '__interrupt__' ignored", "'__check_stack__' ignored") and
gives both functions a `getsp` [unipro: `clang --target=e2k-linux
-march=elbrus-v3 -O2 -S`].

lcc inlines the `always_inline` ones from `-O1` on (at `-O0` it inlines
nothing, `always_inline` included), into ordinary and `check_stack`
callers alike, and checks the attribute on each function's own code: a
`check_stack` helper that needs the data stack compiles when inlined
into an ordinary function, which then gets the `getsp`, and is the error
when compiled out of line or inlined into a `check_stack` function
[lcc: `tools/abi/probes/foldp102_inline_cs.c`]. GCC inlines a function
carrying an attribute of the target's table only if
`TARGET_FUNCTION_ATTRIBUTE_INLINABLE_P` allows it. The default
(`hook_bool_const_tree_false`) never does, and for these `always_inline`
helpers that is "inlining failed in call to 'always_inline' …: function
not inlinable" in every file that reads `%upsr`
(`gcc/tree-inline.cc:4189-4207, 4241, 4929`; `gcc/target.def:2359-2369`)
[source]. So a port's hook must answer true for this attribute.

What lcc keeps in registers there, a port must too [source, lcc, gcc].
The kernel's register images (`e2k_cud_t`, `e2k_gd_t`, `e2k_psp_t`,
`e2k_pcsp_t`, `e2k_usd_t`, `e2k_cr0_t`, `e2k_cr1_t`,
`asm/cpu_regs_types.h:81-650`) are 16-byte unions of bit-field structs
over the anonymous `e2k_qreg_t { u64 lo, hi; }`
(`asm/base_regs_types.h:40-43`; `-fms-extensions`), aligned to 8. Eight
`__interrupt` functions hold them, or other values, in registers across
calls: `e2k_setjmp` (`kernel/setjmp.c:10-12`), `fast_sys_set_return`
(`fast_syscalls/fast_set_return.c:11-15`, through
`asm/fast_syscalls.h:415`), `fast_sys_getcontext`
(`asm/fast_syscalls.h:369-371`, `static __always_inline` but compiled on
its own because `fast_syscalls/fast_syscalls.c:65` takes its address),
`protected_fast_sys_getcontext` (`fast_syscalls/protected.c:225-227`),
`kernel_data_stack_overflow` (`kernel/ttable.c:275`, through `:205`),
`relocate_kernel` (`kernel/relocate_kernel.c:51-52`, with `new_gd_v6`'s
compound literal, `asm/cpu_regs.h:130-133`), and, without 16-byte
images, `fast_syscall_read_sclkr` (`fast_syscalls/sclkr.c:15-21`) and
`dump_vprintk` (`arch/l/kernel/console.c:255`). lcc compiles the four
shapes these functions take with no `getsp` [lcc 1.29.16 v3, v5.8c2,
v6.2c3 at `-O2`, `-O3`, `-O3 -fkernel`; 1.31.05 v3:
`tools/abi/probes/foldp104_regimage.c`; at `-O0` lcc refuses three of
them]. GCC's defaults put four things on the data stack [gcc: GCC's
source; GCC 16.2.1 for x86-64]:

- **The unions.** Under `STRICT_ALIGNMENT` a record or union aligned
  below its integer mode gets BLKmode (`gcc/stor-layout.cc:1943-1953`),
  and TImode is aligned like `__int128`, to 16
  ([data-layout.md](data-layout.md)). A BLKmode local lives in memory,
  and SRA leaves one that is also copied whole (`jb->psp = p`). Lowering
  TImode's alignment would change `__int128`'s; `STRICT_ALIGNMENT` 0
  would allow misaligned accesses that lcc's `-fkernel` rules out
  (`-mstrict-align`) (inferred). x86-64, without `STRICT_ALIGNMENT`,
  keeps such a union in TImode at alignment 8 (`:1969-1983`). Giving
  word-aligned 16-byte aggregates TImode without raising their
  alignment is a `stor-layout.cc` change (no hook decides it), and it
  would also remove the asm error of "`%L`, `%H` and 16-byte operands".
- **A zero built in a stack temporary.** The gimplifier clears a
  compound literal that leaves bytes out as a whole (`u = {}`,
  `gcc/gimplify.cc:6447-6458`), and DSE trims the clear to the bytes the
  fields leave out (`MEM <char[6]> [&u + 6B] = {}`,
  `gcc/tree-ssa-dse.cc:574-618`). Storing that into an object held in
  registers, `store_field` (`gcc/expr.cc:8290-8294, 8372`) has
  `expand_constructor` build the zero in a stack temporary (`:9573`) and
  reads it back (`:8462`). GCC 16.2.1 does this on x86-64 at `-O2` for
  the probe's `write_gd`.
- **Caller saves.** With `-fcaller-saves` (from `-O2`,
  `gcc/opts.cc:640`), IRA may give a value live across a call a
  call-clobbered register (`gcc/ira-conflicts.cc:919-925`; cost
  `gcc/ira-int.h:1702-1712` against `gcc/ira-color.cc:2257-2293`). LRA
  then saves it in a stack slot around the call
  (`gcc/lra-constraints.cc:6692-6709, 6903-6908`), where a window
  register would keep it for free. The flag can be set per function.
- **Pseudos without a class.** IRA gives a pseudo whose `REG_EQUIV`
  equivalence saves more than it costs class NO_REGS
  (`gcc/ira-costs.cc:2187-2206, 2246-2248`) and expects LRA to substitute
  the equivalence. Where LRA cancels it
  (`gcc/lra-constraints.cc:6031-6091`), the pseudo gets a stack slot.
  `TARGET_IRA_CHANGE_PSEUDO_ALLOCNO_CLASS` (`gcc/ira-costs.cc:2287-2289`)
  can keep the class.

## Inline assembly the kernel relies on

### Non-volatile asm with an unused output [lcc, gcc, source]

The kernel writes many asm statements without `volatile` and with a
dummy output, so that lcc can schedule them freely ("Prevent automatic
volatile", `asm/e2k_api.h:8846`): `barrier()` and `barrier_preemption()`
(`asm/compiler.h:151-188`; the second is empty with `defconfig`'s
`PREEMPT_VOLUNTARY`), `__arch_this_cpu_write` (per-CPU stores,
`e2k_api.h:8841-8849`), `NATIVE_CLEAR_AAU_AADS` (`e2k_api.h:2335-2373`),
`WRITE_UACCESS_REGS` (the `mmurw` to `%root_ptb` and `%cont` that opens
user access, `e2k_api.h:2104-2124`), and on v5+ kernels the per-CPU
atomics whose result is cast to `void` (`this_cpu_add` and friends,
`asm/percpu.h:35-66`, `e2k_api.h:8985-9009`). The ordinary atomics
have `"+m"` memory outputs and are not affected.
`CONFIG_DEBUG_LCC_VOLATILE_ATOMIC` (`Kconfig.debug:49`) makes the ones
written `asm NOT_VOLATILE` volatile (`asm/compiler.h:134-138`): the
barriers, the atomics and `WRITE_UACCESS_REGS`, not the per-CPU stores
or the AAU clearing.

| Asm | lcc | GCC |
|---|---|---|
| `barrier()`: `asm ("" : "=r" (unused) : : "memory", "g19", "g18", "g20")` | kept; memory reloaded after it | **deleted** with its clobbers: a value loaded before it is reused after it |
| per-CPU store `std %dg18, ...` with `"=r" (unused)` and `"memory"`; an `aaurw` with `"=r" (unused)`; `mmurw` to `%root_ptb`/`%cont` | kept | **deleted** |
| `barrier_data(p)` (an input, no output) | kept | kept |

GCC "sometimes discard[s] asm statements if [it determines] there is
no need for the output variables" (`gcc/doc/extend.texi:11700-11711`,
"Volatile"); a `"memory"` clobber doesn't stop it. A GCC-built kernel
needs these asms volatile (a kernel change) or loses per-CPU writes,
the opening of user access, AAU clearing and every compiler barrier.
(The v5+ per-CPU atomics were not probed; that GCC deletes them too
follows from the same rule.) Volatile is not enough where an asm names
a global register only as a clobber or in its template (next section).

### Global registers named only in templates and clobbers [lcc, gcc, source]

GCC knows an asm only by its operands and clobbers: accesses to a
register variable "may be optimized as usual", and an asm's access to
one "must be provided to the compiler via constraints"
(`gcc/doc/extend.texi:13272-13277`) [source]. A register the template
writes without a clobber is unchanged for GCC, so a copy taken before
the asm may be read from the register after it. A clobber is an
overwrite that doesn't read, so a write to the variable just before
the asm is dead and deleted [gcc: GCC 16.2.1 `-O2` on x86-64,
`tools/abi/probes/folda41_gregasm.c -DVOL`; the proof-of-concept back
end before gcc-claude `1830fba1c76`, on the kernel (the table below)]. lcc
parses an asm under the kernel's `-masm-inline` unless
`__no_asm_inline` closes it, and then sees which global registers the
template reads and writes; parsed or not, it never deletes a write to
a register variable before an asm that clobbers it
([source-compat.md](source-compat.md), "What lcc assumes an asm does")
[lcc: the same probe, 1.29.16 and 1.31.05, v3 and v5.8c2]. Three of the
kernel's asms rely on lcc here:

| Asm | What it does | lcc (the kernel's `-masm-inline`) | GCC |
|---|---|---|---|
| `ASM_RESTORE_GREG_V5` for `__iset__` ≥ 5 (`asm/e2k_api.h:361-371`; the v3 form and the form for kernels built below v5 clobber `"%g" #numlo, "%g" #numhi`, `:318-341, 373-386`) | `ldrqp` into `%xg16`–`%xg31` in the template, no clobbers | parsed (no `__no_asm_inline`): sees the writes | used `%g17` in place of a local copy of `current` after the asm had loaded the user's `%g17`: the return to user trapped and retried, each retry leaving a `finish_user_trap_handler_sw_fill` frame, until "procedure stack overflow" |
| `barrier()`, `barrier_preemption()`, `barrier_data()` (`asm/compiler.h:131-132, 152-195`) | `"g19", "g18", "g20"` as clobbers meaning "may change" | keeps the write before it | deletes the write before it once the asm is kept (`preempt \|= NEED_RESCHED; barrier ();` became nothing) |
| `WRITE_UACCESS_REGS_CACHED` (`asm/e2k_api.h:2141-2160`; `asm/mmu_context.h:163, 212, 290, 363, 465`) | `mmurw` reads `%g21` and `%g20` in the template, listed only as clobbers | keeps `current_mmu_context = ctx` | deleted it from `handle_sys_call`: the next `copy_to_user` wrote to the MMU the empty `%g20` a system call return leaves (`diag_operand`) |

So making these asms volatile ("Non-volatile asm with an unused
output") is not enough for GCC: their clobbers then delete the writes
to the preempt count and `current_mmu_context` before them. A GCC build
needs each register as an operand of its register variable (`"+r"` for
"may change", `"r"` for a read) and the v5 restore's clobbers, or a
compiler that reads templates and treats a clobbered fixed global
register as used. The kernel branch adds the clobbers (`dca8c245644`:
the v5 restore and two asms that write a `%gN`); the proof-of-concept
back end does the rest in `TARGET_MD_ASM_ADJUST`: an asm uses and
clobbers every global register its template names, and uses every fixed
global register among its clobbers (gcc-claude `1830fba1c76`; its
finding A41).

### State-register reads (`*_OPEN`) [lcc, gcc, source]

Most state registers are read with a non-volatile asm with one output
and no inputs, "read register supported by compiler (see
-masm-inline)" (`NATIVE_GET_REG_OPEN`, `asm/e2k_api.h:954-962`): `%upsr`,
`%psr`, `%cr0`, `%cr1`, `%usd`, `%psp`, `%pcsp`, `%pshtp`, `%wd`,
`%lsr`, `%ilcr`, `%sclkr`, `%ip`, `%pfpfr`, `%fpcr`, `%fpsr`,
`%ctpr1`–`%ctpr3`, `%dimar0`–`%dimar3` and others
(`asm/native_cpu_regs_access.h`), also `%clkr` in fast system calls
(`asm/atomic_api.h:29`). Only reads with side effects use `asm
volatile` (`NATIVE_GET_REG_CLOSED`, `:964-988`); writes are `asm
volatile` with `wait` (`:1000-1080`). Probed (`open`, 14 shapes):

| Pattern | lcc, `-masm-inline` (the kernel's) | lcc, `-mno-asm-inline` (lcc's default) | GCC |
|---|---|---|---|
| two reads of `%upsr` | both kept | both kept | merged into one |
| a read, `rws %upsr` (volatile, `"memory"`), a read | both kept | both kept | **merged across the write** |
| a read, a call, a read (also through an inlined helper) | both kept | both kept | merged: `a ^ b` folded to 0, no read left |
| a read in a loop that writes `%upsr`; a read in a loop with a call | read every iteration | read every iteration | **hoisted out of the loop** |
| `while (read %sclkr < t);` | read every iteration | read every iteration | **hoisted: an endless loop** |
| two reads of `%ip`, `%clkr`, `%fpsr` (an FP divide between) | both kept | both kept | merged |
| two reads of `%lsr` | **merged** | both kept | merged |
| an unused read | deleted | kept | deleted |
| two identical `addd %1, 0x1, %0` | folded | both kept | folded |

So in every case probed lcc without `-masm-inline` neither merged,
moved nor deleted an opaque asm, and with `-masm-inline` it parses the
text: arithmetic is optimised like its own operations, and of the
registers probed only `%lsr` reads are treated as stable
([source-compat.md](source-compat.md), "What lcc assumes an asm does").
GCC treats every non-volatile asm as a pure function of its inputs: it
may move one out of a loop (`gcc/doc/extend.texi:11706-11709`), and CSE
takes two with the same template, constraints and inputs as equal
(`gcc/cse.cc:2743-2760`). A GCC-built kernel needs these reads
volatile.

### A store before a jump [lcc, gcc, source]

The decompressor's secondary CPUs wait for the boot CPU in `while
(unpacking_in_progress) E2K_NOP(7);` (`boot/decompress.c:643-644`), on
a plain `static int unpacking_in_progress = 1` (`:89`, in `.data` by its
initializer: "Data written before `.bss` is cleared"). The boot CPU
clears it with a plain store (`:735`) and jumps into the kernel through
`jump_to_image` (`:591-605`): `E2K_JUMP_ABSOLUTE_WITH_ARGUMENTS_2`, an
`asm volatile` that clobbers `"ctpr1"`, `"r0"` and `"r1"` but not
memory, then `unreachable ()` (`asm/e2k_api.h:7036-7049`), which for
GCC is an empty `asm volatile` and `__builtin_unreachable ()`
(`include/linux/compiler-gcc.h:65-70`) [source].

lcc takes every `asm volatile` for a memory barrier
([source-compat.md](source-compat.md), "What lcc assumes an asm does"),
so it keeps the store and loads the flag in every iteration [lcc
1.29.16 `-O1`, `-O3`, `-O3 -fkernel`, v3, v5.8c2, v6.2c3; 1.31.05
`-O3`, v3, v4.8c, v5.8c2, v6.2c3: `tools/abi/probes/foldp115_deadstore.c`].

GCC deletes the store: nothing reads memory after it, and DSE takes a
store to global memory as dead when its block ends in
`__builtin_unreachable` (`gcc/tree-ssa-dse.cc:1157-1185`). With no
store left, the whole-program visibility pass marks the variable
read-only (`ipa_discover_variable_flags`, `gcc/ipa.cc:790-835`), and
CCP folds every read to the initializer 1. The wait then has no load
(`{nop 7}` and a `ct` back), and the other CPUs never leave it.
`E2K_NOP`'s `"memory"` clobber doesn't help: to GCC the variable is no
longer memory [gcc: the proof-of-concept back end on `decompress.c` and
on the probe; GCC 16.2.1 on x86-64 alike].

The race is in the source: C gives no meaning to a plain flag shared
between CPUs. The other flag, `got_updating_in_progress`, uses
`READ_ONCE`/`WRITE_ONCE` (`:776, 801`) and survives. A GCC-built
decompressor needs the store as `WRITE_ONCE`, or a `"memory"` clobber
on the jump asm, whose target does read memory. A volatile read alone
keeps the load but not the store, and still spins [gcc: the probe;
`-DJUMP_CLOBBERS_MEMORY` adds the clobber]. The kernel branch uses
`READ_ONCE` and `WRITE_ONCE` on this flag too (`9f265f593a4`).

### `%L`, `%H` and 16-byte operands [lcc, source, gcc]

| Operand | `%0` | `%L0` | `%H0` |
|---|---|---|---|
| `__int128`, `unsigned __int128` (also `"=&r"`), `struct { u64 lo, hi; }` (also `"=&r"`), a union of both, with `r` | `%r4` | `%r4` (the first register) | `%r5` |
| 8- or 4-byte `r`, `long double` with `x`, `__int128` with `x` (v5+), a constant | `%r0`, `0x5` | error "operand modifier 'L' should only be used with quadro" | the same error for 'H' |

The kernel uses `%L` 27 times on 23 lines, all in `asm/e2k_api.h` and
beside `%H`, for tagged 16-byte loads and stores, AAU clearing and
128-bit compare-and-swap, with `e2k_qreg_t` (`struct { u64 lo, hi; }`,
`asm/base_regs_types.h:40-43`), `__uint128_t` and union operands,
inputs and `"=&r"` outputs (`e2k_api.h:2338, 3895-3938, 5048-5055,
5821-5855, 5971-5983, 6119-6353`). lcc 1.29.16 and 1.31.05 print the
same. A port needs both modifiers on 16-byte operands, and must take
a 16-byte struct in a register pair for `r` inputs and `"=&r"` outputs,
as lcc does; `%L` and `%H` on an 8-byte operand or a constant are
errors in lcc and should be in a port too. lcc takes any aggregate of
1–16 bytes for `r`: 3- and 7-byte structs in one register, 12- and
16-byte ones in a pair [lcc 1.29.16 and 1.31.05 v3:
`tools/abi/probes/foldp100_blkasm.c`]. In GCC the struct case is a
middle-end matter, not a target hook [source; gcc]: under
`STRICT_ALIGNMENT` a 16-byte struct aligned to 8 is BLKmode
(`gcc/stor-layout.cc:1943-1953`; TImode wants 16, and lowering that
would make `__int128` 8-aligned), `expand_asm_stmt` gives a BLKmode
register-only output a stack slot without a size
(`gcc/cfgexpand.cc:3716-3730`) and warns about such an input
(`:3794-3795`), and the vregs pass then reports either as "impossible
constraint in 'asm'" (`gcc/function.cc:1857-1860`, through
`asm_operand_ok`, `gcc/recog.cc:2376-2382`). `TARGET_MD_ASM_ADJUST`
runs in between (`gcc/cfgexpand.cc:3830`) but can't size the slot.
Either `expand_asm_stmt` moves such operands through the integer mode
of their size (`copy_blkmode_to_reg`, and `copy_blkmode_from_reg`,
static in `expr.cc`), or the kernel's four asms with an `e2k_qreg_t`
output (`asm/e2k_api.h:3894, 3932, 5819, 5971`) take `unsigned
__int128`, as its neighbouring macros already do (`asm/e2k_api.h:5036,
9144`) [gcc: GCC 16.2.1 on x86-64 gives the error for a 3-byte struct;
`foldp100_blkasm.c`]. Both fix only the asm. Giving word-aligned
16-byte aggregates TImode in `stor-layout.cc`, which the `check_stack`
functions need anyway ("The kernel's users and their contract", "The
unions"), fixes the asm too. Which route is the port's choice.

### Operand count [lcc, gcc, source]

`TRAP_HANDLER_DONE` (`asm/e2k_api.h:7359`, used by `ttable.c`) has 39
operands (16 outputs, 19 `r` and 4 `i` inputs). lcc allows up to 50
("more than 50 operands in asm statement" at 51). GCC's limit is
`MAX_RECOG_OPERANDS`, 30 unless a machine-description pattern has more
operands (`gcc/genconfig.cc:285, 320`; `gcc/cfgexpand.cc:3453`), so
`ttable.c` fails with "more than 30 operands in 'asm'".

### lcc's pragmas [lcc-doc, lcc, gcc]

What each of lcc's pragmas means, how often glibc's and the kernel's E2K
code use it and what other compilers do with it is in
[source-compat.md](source-compat.md), "Pragmas". The kernel puts
`_Pragma ("no_asm_inline")` and `_Pragma ("asm_length(N)")` before many
asms (`__no_asm_inline` is both, `asm/compiler.h:43-101`; it never uses
`asm_inline`), and uses lcc's loop pragmas: `loop count (N)`, `unroll
(N)`, `vector aligned`, `novector`, `ivdep`, `no_dam` and `noprefetch`
(`asm/xor.h`, `asm/regs_state.h`, `asm/pgtable.h`, `lib/string.c`,
`lib/checksum.c`, `kernel/traps.c`, `mm/`, `crypto/chacha-e2kv*.c`). lcc
accepts the asm pragmas under `-Wall -Werror`; GCC reports "ignoring
'#pragma asm_length'" and the loop pragmas under `-Wunknown-pragmas`
(part of `-Wall`), an error with the kernel's `-Werror`. A compiler must
accept and ignore (or use) them, and a GCC port must register the
ignored ones in the preprocessor, or a run such as `ivdep` then `loop
count (N)` stops GCC's loop-pragma parsing
([source-compat.md](source-compat.md), "Pragmas").

## Code generation in kernel mode

### Speculative loads [source, lcc, gcc]

The kernel distinguishes three kinds of code [source]: ordinary kernel
code, where semi-speculative loads (`ld,sm`, mod 0) are allowed only
with `CONFIG_SEMI_SPECULATIVE_KERNEL` because each one that misses can
leave an "empty" DTLB entry that `vmap`/`ioremap` must then flush with
system-wide IPIs (`Kconfig:598-616`; a semi-speculative fault in the
kernel outside the allowed cases is warned about and flushed,
`mm/fault.c:2810-2826`); trap entry and exit (`ttable.o`), where nothing
bad may happen "between restoring %cont and %root_ptb registers and
DONE" (`kernel/Makefile:57-60`); and physical-mode code (p2v, boot,
kexec), with no speculative loads at all. User-access functions "must
not use semi-speculative loads" because callers fault pages in by hand
after `pagefault_disable()` (`asm/uaccess.h:399-410`).

What lcc emits for conditional loads [lcc] (`codegen`; "semi" =
semi-speculative `ld,sm`, mod 0; "full" = fully speculative `ld,sm …
mas=0x3`, with an `rbranch ? %dt_alN` recovery where the value is used;
[speculation.md](../isa/speculation.md)):

| Options | Through a pointer | Of a global | Through a global register | In a loop |
|---|---|---|---|---|
| user `-O3` | semi | semi | semi | semi |
| `-O3 -fkernel` | full | semi | semi | full |
| kernel, `SEMI_SPECULATIVE_KERNEL=y` (`defconfig`) | semi | semi | semi | semi |
| kernel, `SEMI_SPECULATIVE_KERNEL=n` | full | full | none | full |
| `ttable.o` | none | none | none | full |
| physical mode (`-fno-spec-ld`) | none | none | none | none |

An explicit `-fno-semi-spec-ld` after `-fkernel` also cancels the
`-glob`/`-stack`/`-greg` exceptions `-fkernel` implies
([source-compat.md](source-compat.md), "Speculation switches"). Fully
speculative loads with recovery stay on unless `-fno-spec-ld` is given.
A kernel compiler needs, per file, semi-speculative loads on or off and
fully speculative loads on or off. Per function (`__no_semispec`) it
needs semi-speculative loads and APB off, reaching the inlined
`always_inline` body as lcc's does; fully speculative loads may stay, as
lcc 1.31.05 keeps them [lcc: `tools/abi/probes/foldp103_nosemispec.py`,
the kernel's options, 1.29.16 and 1.31.05, v3, v5.8c2, v6.2c3]. GCC's
`optimize` attribute takes only `-O` and `-f` options flagged
`Optimization` ("bad option to attribute 'optimize'",
`gcc/c-family/c-common.cc:6248-6263, 6299-6318`) [source; gcc: GCC
16.2.1 on x86-64]. So a `-m` switch needs the `target` attribute, with a
`TARGET_CAN_INLINE_P` that lets the body without it in: the default
refuses, which for `always_inline` is "target specific option mismatch"
(`gcc/targhooks.cc:1908-1923`, `gcc/ipa-inline.cc:435-440`). A port that
names its switches as `-f` options flagged `Optimization` (lcc's
`-fsemi-spec-ld`, `-floop-apb`) would take lcc 1.31.05's spelling
unchanged (inferred from `parse_optimize_options`; not tried).
`optimize("O1")` serves only if the port's `-O1` never speculates (lcc's
doesn't).

### Array prefetch, `%ctpr2`, DAM [lcc, source]

- **APB**: `-fkernel` no longer forbids it (1.26), so the kernel passes
  `-fno-loop-apb` everywhere, and `__no_semispec` repeats it for uaccess
  functions; lcc then emits no `ldisp`/`mova`. A call, a return or a
  `%ctpr2` write stops an APB program ([apb.md](../isa/apb.md)).
- **`%ctpr2`** at trap entry: the kernel keeps lcc from using it "to
  make sure that AAU is not zeroed before we get to it"
  (`kernel/Makefile:57`, `kernel/ttable.c:526, 787`). `-fexclude-ctpr2`
  removed every `%ctpr2` from lcc's code (probe: 0 against 17–326 uses
  without it, by option set, target and version). lcc's own `ttable.o`
  has 16 `%ctpr2` uses, `disp` and `rwd` of the shapes the kernel's asm
  writes (`e2k_api.h:2381, 2393, 7213, 7261`; inferred from their form).
- **DAM and `rbranch`** at trap entry and exit are forbidden on CPUs with
  erratum 124206/135900 ("instruction buffer stops working":
  `CPU_HWBUG_L1I_RBRANCH_CALLS`, E2S, E8C, E1C+, E8C2, and revision 0 of
  E12C, E16C, E2C3; `asm/cpu_features.h:280-292`;
  [hwbugs.md](../isa/hwbugs.md)), hence `-fno-dam` for `ttable.o`. lcc
  1.29.16's `-fno-dam` removes every lock and check load. **lcc
  1.31.05's `-fno-dam` leaves the DAM of software-pipelined loops**;
  `-fno-swp-dam` removes it, and so did `-fno-semi-spec-ld` in the
  probe, which `ttable.o` also gets. `-fno-swp-dam` is 1.30's name for
  1.29's `-fno-dam4swp` (`changelog_130.html` [lcc-doc]): 1.29.16
  accepts only the old one, 1.31.05 both. Neither option removes the
  `rbranch ? %dt_alN` recovery of fully speculative loads (the `ttable.o`
  options still produce it in loops); lcc's own `ttable.o` contains no
  `rbranch` at all, though `do_sigreturn` has 16 fully speculative `ldd,sm
  … mas=0x3`. A compiler needs a switch that turns off DAM and every
  `rbranch` it would emit.

### Volatile stores, jump tables, alignment [lcc, lcc-doc]

- `-fno-spec-volatile-st` (1.30+) is for memory that must not see
  speculative accesses (the manual names External nonPrefetchable and
  External Configuration memory) [lcc-doc]. No probe made lcc emit a
  `,sm` store through a `volatile` pointer, with or without the option.
- **lcc honours `-fno-jump-tables` only at `-O0`**: from `-O1` on, a
  9-case `switch` is still a `.T.N` table of absolute `.dword` addresses
  with `movtd` to a CTPR, also with the kernel's physical-mode options
  (1.29.16 and 1.31.05, `jumptab`). GCC honours it [gcc].
- `-fkernel` implies `-mstrict-align`: on v5 and v6, where lcc's default
  is `-mno-strict-align`, an unaligned 8-byte `memcpy` becomes byte loads
  (`ldb`) instead of one `ldd`.

### Block moves [lcc, gcc, source]

Physical-mode code redirects explicit `memcpy`/`memset` calls to
`boot_memcpy`/`boot_memset` (`asm/string.h:107-115, 196-203`, under
`E2K_P2V`); a call the compiler makes itself reaches the ordinary
function. lcc's `-fno-use-memcpy` (in `-fkernel`) keeps struct copies
and `__builtin_memcpy` inline, also for 4 KiB and variable sizes;
`-fno-use-memset`, which the kernel doesn't pass, would do the same for
`__builtin_memset (p, 0, n)`, which otherwise calls `memset` even in
physical mode. Struct zeroing never called `memset` under `-fkernel`
(`blockmove`). GCC calls `memset` to zero a 128-byte or a 4 KiB
struct and `memcpy` to copy a 4 KiB one or a variable size, and turns
a zeroing loop into `memset` at `-O2` unless `-ffreestanding` or
`-fno-tree-loop-distribute-patterns` is given, neither of which the
kernel passes [gcc].

### Physical mode [source, lcc, gcc]

`p2v/` is the code that runs before the kernel turns on virtual memory:
at the physical address the loader put the image at, with virtual
addressing off (`asm/p2v/boot_v2p.h:38-78`). Its calls and branches are
IP-relative and work. Data is linked at its virtual address, so p2v
reaches it only through `boot_vp_to_pp ()`, `boot_get_vo_value ()` and
the like, which add the image's physical base (`:165-166, 196-197`)
[source]. An object the compiler makes itself and addresses with an
absolute literal (`R_E2K_64_ABS_LIT`) is read at its virtual address.

lcc makes none there. Built with the kernel's options
(`config-mcst-e8c2`, lcc 1.29.16 `e2k-v5.8c2`), its 18 p2v objects read
no object it made and call no function the source doesn't name; the
zero `.LCO` constants it leaves in `boot_init.o`, `boot_map.o` and
`boot_string.o` are unreferenced [lcc]. GCC adds three kinds of
reference there [gcc: the proof-of-concept back end on the kernel and
on `tools/abi/probes/foldp114_physmode.c`]:

| What GCC adds | Where in p2v | What stops it |
|---|---|---|
| a `CSWTCH` lookup table in `.rodata` for an `if`-chain or `switch` that picks constants. If-to-switch runs whenever jump tables or bit tests are allowed (`gcc/gimple-if-to-switch.cc:482-486`), and switch conversion asks only for `-ftree-switch-conversion` (`gcc/tree-switch-conversion.cc:2929-2933`, the table at `:1027-1045`), so `-fno-jump-tables` doesn't cover it | `boot_get_e2k_machine_id` (`p2v/boot_e2k_sic.c:22-54`): a 48-byte table | `-fno-tree-switch-conversion` |
| a `memset` call for a zeroing loop, which reaches the ordinary `memset`, not `boot_memset` ("Block moves") | the 512-entry loops of `boot_pud_alloc`, `boot_pmd_alloc` and `boot_pte_alloc`, inlined into `boot_get_pte` (`p2v/boot_map.c:131-133, 152-155, 174-177`); `boot_string.o` | `-ffreestanding` or `-fno-tree-loop-distribute-patterns` (`gcc/c-family/c-opts.cc:499-504, 961-965`) |
| a 16-byte constant from the constant pool (`.rodata.cst16`) in a vectorized loop, v5 and later | the same loops once they are no longer `memset` | `-fno-tree-vectorize`. A port that builds a zero vector with `qppackdl 0x0, 0x0` instead of loading it from the pool has none for these loops |

The first kernel the proof-of-concept back end built hung reading the
table. With `-fno-tree-switch-conversion -ffreestanding
-fno-tree-vectorize` its p2v objects read no `CSWTCH` table or pool
constant, and name the same undefined symbols as lcc's (kernel branch
`2801f915fb0`) [gcc]. Even under `-ffreestanding`, GCC calls `memset`
or `memcpy` for a large struct copy or zeroing and for a large
`__builtin_memset` ("Block moves"); p2v has none today. lcc's own hazard
there is a different one: it still makes a jump table of absolute
addresses from a 9-case `switch` under `-fno-jump-tables` ("Volatile
stores, jump tables, alignment"), and its p2v objects have none.

The decompressor (`boot/`) is built `-fpic` (`boot/Makefile:118-119`),
so GCC addresses such a table `@GOTOFF` from an IP-relative GOT base,
which works at the decompressor's load address [gcc]. There the problem
is a call. GCC turns `strncmp (s, lit, n)`, with `n` past the literal's
NUL, into `strcmp (s, lit)` (`gcc/gimple-fold.cc:2936-2949`).
`parse_console_params` compares 22 bytes against the 21-character
`"KERNEL_ARGS_STRING_EX"` (`boot/decompress.c:615`,
`arch/l/include/asm/bootinfo.h:31-32`), while the decompressor defines
only `strstr` and `strncmp` (`boot/string_fpic.c:20, 43`). lcc keeps the
`strncmp`; in GCC, `-ffreestanding` (`-fno-builtin`) keeps it (kernel
branch `260133372de`) [lcc; gcc].

### Data written before `.bss` is cleared [source, lcc, gcc]

Physical-mode boot code writes some zero-initialized variables before
it clears `.bss`. `boot_startup` runs `boot_parse_param`, whose
`dump_console=` handler sets `serial_dump_console_num`
(`arch/l/kernel/console.c:47`, `p2v/boot_printk/console.c:64-75`), and
`boot_setup_serial_console`, which sets it from the command line too
(`parse_console_params`, `:94-98`); only then does `boot_init` call
`boot_setup` and so `boot_clear_bss` (`p2v/boot_head.c:678-679, 710`,
then `:644`, `:452`). `boot_cpucount` (`p2v/boot_head.c:49`) and the
boot console's state are written the same way [source]. lcc puts every
explicitly initialized object in `.data`, zero or not
([source-compat.md](source-compat.md), "Zero-initialized data"), so they
survive the clearing; GCC puts them in `.bss` [lcc; gcc:
`tools/abi/probes/folda40_zerobss.c`]. The proof-of-concept back end's
kernel printed its early messages on ttyS0 despite `dump_console=1` and
lost the CPU count, and 558 of the kernel's symbols are `.data` in
lcc's vmlinux and `.bss` in that back end's. MCST knew the hazard in one
place: the decompressor initializes its two cross-CPU flags to 1 so
that they are in `.data` "before .bss section is cleared"
(`boot/decompress.c:84-89`). A GCC kernel build needs
`-fno-zero-initialized-in-bss`, which gives lcc's placement (kernel
branch `715653c1a6b`).

### Forced inlining [lcc-doc, lcc, source]

`-fforce-inline` (in `-fkernel`) inlines every function declared
`inline`, not only `always_inline` ones [lcc-doc]: a large `static
inline` helper called four times was inlined four times under
`-fkernel` and called at plain `-O3` [lcc]. The kernel's `inline` is
`inline __gnu_inline __inline_maybe_unused notrace`
(`include/linux/compiler_types.h:183`), a hint to GCC, which called the
helper [gcc]. Some helpers are correct only when inlined:
`native_exit_handle_syscall` (`asm/trap_table.h:144-148`) runs
`NATIVE_EXIT_HANDLE_SYSCALL` (`asm/e2k_api.h:1350`), which rewrites the
current frame's `%cr0`, `%cr1`, `%usd`, `%sbr` and `%wd`; out of line
it would rewrite its own frame. About 70 lines of asm in
`arch/e2k/include/asm` write `%cr0`, `%cr1`, `%usd` or `%wd`.

### Floating point [source, lcc]

The kernel saves `%fpcr`, `%fpsr` and `%pfpfr` only inside
`kernel_fpu_begin`/`kernel_fpu_end` (`kernel/fpu.c:11-47`); FP data
lives in the ordinary registers. So kernel code must not contain FP
operations the source doesn't ask for: they would run under the user's
rounding mode and set the user's sticky flags. Neither lcc nor GCC put
an FP operation into the integer probes. lcc's `-fforbid-fp` makes FP
an error ("used to build the linux kernel", 1.26 changelog; "forbidden
float instruction in the -fforbid-fp mode"), but the kernel doesn't
pass it.

### 128-bit arithmetic and no libgcc [source, lcc, gcc]

The kernel links no libgcc and `arch/e2k/lib` provides no 128-bit
helpers, but it selects `ARCH_SUPPORTS_INT128` (`Kconfig:70`), so
`mul_u64_u32_shr`/`mul_u64_u64_shr` multiply `unsigned __int128` and
shift the product by a variable count (`include/linux/math64.h:157-171`;
`kernel/sched/fair.c:345`). lcc compiles 128-bit multiplies (`muld` and
`umulhd`) and shifts inline at `-O1`, `-O2`, `-O3` and `-Os`, in cold
code too, and calls helpers only for 128-bit division (`__udivti3`,
`__umodti3`), which the kernel doesn't use. At `-O0` it calls
`__ashlti3`/`__lshrti3`/`__ashrti3` for every 128-bit shift, constant
counts included (never `__multi3`); neither of the kernel's `-O0` files
("Modules") uses `__int128` [lcc 1.29.16 v3, v5.8c2, v6.2c3, 1.31.05
v3: `tools/abi/probes/foldp106_coldshift.c`]. GCC builds a double-word
multiply from `umulditi3`/`mulditi3` at every level
(`gcc/optabs.cc:2143-2188`), but a shift by a variable count only where
`optimize_insn_for_speed_p ()` holds (`:1821-1830`). That is false at
`-Os` and, from `-O1`, in a `cold` function or in a block that runs
below 1/1000 of its function's entry (`gcc/predict.cc:154-186,
352-366`), and there GCC calls the three helpers [gcc]. MCST's kernel
makes most `unlikely()` paths such a block (one inside a loop that runs
often enough stays above the 1/1000): with `CONFIG_MCST`, which
`E2K` selects (`arch/e2k/Kconfig:190`), `unlikely(x)` is
`__builtin_expect_with_probability (!!(x), 1, 0.0001)` for GCC 9 and
later (`include/linux/compiler.h:77-84`); a plain `__builtin_expect`
path stays inline [source; gcc]. So a port must expand 128-bit
multiplies (`muld` and `umulhd`) and variable 128-bit shifts (shift
pairs) itself at every level, or vmlinux is left with undefined symbols
(the proof of concept met it: its P106). `clz`, `ctz`, `popcount`,
`ffs`, `bswap` and `parity` are inline in both.

### Wide bit-fields [source, lcc, gcc]

lcc computes with a bit-field of 33–63 bits in its declared type, GCC's
C in a type of the field's width ([source-compat.md](source-compat.md),
"Bit-fields wider than `int`"; `tools/abi/probes/folda42_bitfield.c`),
and the kernel relies on lcc's rule. `get_cr0_ip (cr0)` is `(cr0.Ip <<
3)` with a 45-bit `u64 Ip` (`asm/cpu_regs_types.h:578-589`;
`E2K_VA_SIZE` is 48, `asm/base_regs_types.h:21`). Built by GCC it drops
the IP's top 3 bits, so `is_from_C1_wait_trap` (`asm/hardirq.h:19-25`)
never matches and an idle CPU's interrupts return into `C1_wait_trap`:
the CPU never leaves idle. `drivers/mcst/e2k-iommu.c` shifts 36-bit
page numbers by `IO_PAGE_SHIFT` (12): `long h_page_table : 36` (`:83`,
`:933`) and `addr : 36` (`:359`, `:1700`), which lose their top bits
from 64 GiB up. Nine more sums or differences of a 48-bit address field
and an index (`PSP_PTR_V6`, `PCSP_PTR_V6`, `USD_BASE_V6`, `ap.Base +
Curptr`, `cutd.base + 32 * index`, `ctpr2.ta_base + …`, `ap_base +
ind`, two `usd.Ptr - usd.Ind`) agree under both rules while the result
is a valid 48-bit address, and generic `drivers/iommu/dma-iommu.c`
shifts the 58-bit `iommu_msi_iova` (`:1744`). These are the sites a
warning for such arithmetic found over `config-mcst-e8c2`'s vmlinux and
modules (the proof-of-concept back end's `-Wbitfield-arith`, gcc-claude
`5a6816627e9`; its finding A42) [source; gcc]. A GCC build must cast
such fields before the arithmetic (`(u64) (cr0).Ip << 3`; kernel branch
`f120941bae6`, and `08fb9a267a6` for the IOMMU).

## Erratum #123567 and `-ffix-lcc-bug123567` [lcc, source]

The kernel's text: "a load after an intersecting store can read wrong
data from L1. Workaround - insert at least 1 real wide instruction
between (i.e. not from `nop X`, X > 0)" (E8C2, E12C, E16C;
`asm/cpu_features.h:271-278`; [hwbugs.md](../isa/hwbugs.md)). The
option is in no lcc manual. What lcc does (`bug123567`): distances in
wide instructions from a store to the next load of a possibly
intersecting address, 0 meaning one instruction with the store in
ALC0–2 and the load in ALC3–5. The probe has a may-alias pair (`*q = x;
return *p;`, the store and load in one instruction by default) and a
surely overlapping one (an 8-byte store, then a `volatile` 4-byte load
of its upper half, in the next instruction by default):

| lcc target | Default | `-ffix-lcc-bug123567` |
|---|---|---|
| `e2k-v3` (generic, runs on the 8C2) | 0 (may alias), 1 (overlapping) | 2: a separate empty wide instruction (`nop` on its own line) after every store, also before a return |
| `e2k-v5.8c2` | **0 and 1: not applied** (`stw,2` with `ldd,5`; in a pipelined loop a DAM check load shares the store's instruction) | 2 (a check load 2 or 3) |
| `e2k-v6.16c`, or `-mtune=elbrus-12c`/`16c` (also with the `e2k-v3` and `e2k-v6.2c3` lcc) | 2: applied by default; `-fno-fix-lcc-bug123567` turns it off | 2 |
| `e2k-v3.4c`, `e2k-v4.8c`, `e2k-v4.1c+`, `e2k-v6.2c3`, or `-mtune=elbrus-8c2`, `2c3`, `4c` with the `e2k-v3` lcc | 0, 1 | ignored |

Where lcc versions a loop on an address-overlap test, the
non-overlapping copy keeps a store and a load in consecutive
instructions (the `e2k-v6.16c` lcc with the kernel's options). So lcc's
user code for the 8C2 does not avoid the pattern, not even for a store
and a load that surely overlap; the kernel asks for the workaround
explicitly for 8C2 and generic kernels. Whether the erratum needs the
empty instruction before a return is not known (below).

## Build contracts: tools that read compiler output

### Window sizes for the trap return (v3 and v4 kernels) [source, lcc]

Without `CONFIG_CPU_HW_CLEAR_RF` (`CPU_ISET_MIN` < 5, `Kconfig:564-565`)
the kernel clears the registers of the trap handler's window before
`done` or a system call return, in code generated at build time:
`ttable_tmp.c` (`#include "ttable.c"` with `-DGENERATING_HEADER`, which
replaces the clearing asm by a dummy with the same operands,
`kernel/ttable-help.h:55-125`) is compiled with `ttable.o`'s options; the
Makefile reads the largest `setwd wsz = 0x…` of `user_trap_handler`,
`ttable_entry8_C`, `__ret_from_fork`, `handle_sys_call`,
`do_sigreturn`, `finish_user_trap_handler_sw_fill` and
`finish_syscall_sw_fill` (and more with KVM) from `objdump -d` with
`sed` (`kernel/Makefile:15-37`), and `mkclearwindow` turns them into asm
that does `setwd wsz=<size>` and zeroes that many registers
(`kernel/mkclearwindow.c`). So a compiler must emit a `setwd` in each of
these functions, keep their names (no clones), and give each function
in `ttable.o` no larger window than in `ttable_tmp.o`, although the two
files differ in asm text; otherwise kernel values reach user
registers. lcc's host build gave `ttable_wbs.h` the sizes 0x4f, 0x3c,
0x1d, 0x3c, 0x48, 0x18 and 0x15 for the seven functions in that order,
and each function's own (prologue) `setwd` in the final `ttable.o` is
the same; the larger `setwd`s there come from the clearing asm itself.

### ftrace [source, lcc]

e2k selects `HAVE_FTRACE_MCOUNT_RECORD` but not `HAVE_C_RECORDMCOUNT`
(`Kconfig:145-153`), so unless the compiler accepts `-mrecord-mcount`
(`FTRACE_MCOUNT_USE_CC`, `kernel/trace/Kconfig:729-748`; lcc doesn't)
every object goes through `scripts/recordmcount.pl`, which (`:368-377,
381-395, 577-610`):
- reads `objdump -w -dr` and records a call site when a `disp
  %ctprN, _mcount` (relocation `R_E2K_DISP` against `_mcount`) is
  followed by `call %ctprN, wbs = 0x…` with no `ibranch`, `rbranch` or
  `ct` between and no second `_mcount` prepare; an `icall` with an
  `_mcount` relocation counts too;
- assembles its list with the compiler and `-mptr64` appended (`:376,
  637`), so the compiler must accept `-mptr64` (lcc does; GCC doesn't).

The patcher (`kernel/ftrace.c:291-345`) needs the call's wide
instruction to have SS and CS1 (`HS.s`, `HS.c` bit 1) and flips `SS.ct`
between 1 (call) and 0 (no call). `_mcount (frompc)` takes the caller's
`%cr0.hi` in `%b[0]` and finds `selfpc` in its own `%cr0`; the graph
tracer refuses a traced function whose `cr1.wpsz` exceeds
`C_ABI_PSIZE_UNPROT` (4) or whose `wbs` is `E2K_MAXSR` or more
(`ftrace.c:419-455`). lcc's `-pg` sequence
([kernel-interface.md](kernel-interface.md), "Profiling") meets all of
this: the probe, which applies recordmcount.pl's rules to lcc's
objects rather than running the script, found four call sites, each
with `HS.s` 1, `HS.c` bit 1 and `SS.ct` 1, none in a
`no_instrument_function` (`notrace`) function [lcc, `pg`]. 1.31.05
prepares `_mcount` with `ipd 0`, 1.29.16 with `ipd 2`.

### Modules [source, lcc, gcc]

The module loader takes only `R_E2K_32_ABS`, `R_E2K_64_ABS`,
`R_E2K_64_ABS_LIT`, `R_E2K_64_CALL`, `R_E2K_DISP` and `R_E2K_32_PC`
(`kernel/module.c:35-105`); anything else fails the load (`-ENOEXEC`).
`R_E2K_32_ABS`, `R_E2K_64_CALL` and `R_E2K_DISP` are written without a
range check. Modules load from `round_up (KERNEL_END − 1 GiB)` up to
the kernel image (the comment: `0xe1ff_c000_0000`–`0xe200_0000_0000`),
so that `disp` reaches the kernel (`asm/head.h:155-177`). So module code
must be non-PIC and use 64-bit literals for addresses: lcc's non-PIC
code does, whatever `-mdmodel` (`medium`, `large`, `huge`, with
`-fkernel`: `R_E2K_64_ABS_LIT` in code, `R_E2K_64_ABS` in data,
`R_E2K_DISP` for calls); so does GCC's [gcc].

That holds at `-O0` too, and the kernel builds two modules there:
`crypto/jitterentropy.c` (`CFLAGS_jitterentropy.o = -O0`,
`crypto/Makefile:171`; the file stops with `#error` under
`__OPTIMIZE__`, `:53-55`) and smifb's software i2c, under `#pragma GCC
optimize ("O0")` for every compiler but clang
(`drivers/mcst/smi/ddk750/ddk750_swi2c.c:200-203`,
`ddk768/ddk768_swi2c.c:275-278`) [source]. lcc's non-PIC code has no
`_GLOBAL_OFFSET_TABLE_` reference at `-O0` either (also with `-fkernel
-mdmodel=large`); with `-fPIC` it computes the GOT address only in
functions that use it [lcc 1.29.16 v3, v5.8c2, v6.2c3:
`tools/abi/probes/foldp107_gotbase.sh`]. So a port must create a PIC
register only in PIC or PIE code (`flag_pic`), since an
`R_E2K_64_PC_LIT` against `_GLOBAL_OFFSET_TABLE_` fails a module's
load, and in PIC code should load the GOT address only in functions
that use it, as lcc does. Where the target creates one, GCC asks it to
set the register up in every function and keeps an unused load at
`-O0`; from `-O1` it deletes an unused one [gcc; plan D10].

### Stacks and frame sizes [source, gcc]

Kernel stacks per thread (`asm/stacks.h:136-147`): data stack 5 pages
less 256 bytes; procedure stack 6 pages with `SOFTIRQ_ON_OWN_STACK`
(`defconfig`), 9 without, doubled with gcov and tripled with KASAN;
chain stack 2 pages, 256 frames. `-Wframe-larger-than` reaches lcc only
in `arch/e2k/kernel` (6144, `CONFIG_VIRTUALIZATION`), in `arch/e2k/kvm`
(4096, `kvm/Makefile:5`) and in a few `kvm/guest` objects (4096 or
8192, `kvm/guest/Makefile:60-90`). Window sizes decide procedure-stack
use; the proof-of-concept back end's windows in `kernel/sched/core.o`
sum to 2,712 against lcc's 2,994 (303 functions, the back end's larger
in 159, both without `-pg`), in `mm/slub.o` 1,102 against 1,240, in
`arch/e2k/p2v/boot_init.o` 473 against 352 (`--compare-wsz`).

## What a GCC build meets first [gcc, source]

A `defconfig` kernel built on the host with the proof-of-concept
compiler of 2026-10-16, `FUNCTION_TRACER` off, stops on:

| Error | Where | Cause |
|---|---|---|
| `'CONFIG_CC_IS_LCC' is not defined` (`-Werror=undef`) | `asm/compiler.h:215` | `#elif CONFIG_CC_IS_LCC` (kernel) |
| `ignoring '#pragma asm_length'` | `asm/compiler.h:62`, `asm/e2k_api.h` | lcc's pragmas |
| `suggest parentheses around '&&' within '\|\|'`, `cast to pointer from integer of different size` (`(void *) get_cr0_ip (…)` at `asm/system.h:791`: GCC gives the 45-bit `Ip << 3` a 45-bit type, "Wide bit-fields"), `%llx` with a bit-field argument, an unused variable, `static` function used in a non-static `inline` one | many `arch/e2k` headers | warnings lcc doesn't give, with `-Werror` (kernel) |
| `call-clobbered register used for global register variable` | `asm/cpu_features.h:58-59`, `current.h`, ... | the dropped `-ffixed-g16` … `g25` |
| `'interrupt' attribute directive ignored` | `asm/string.h:363, 385`, `native_cpu_regs_access.h:36`, `fast_syscalls.h`, `iset_v3.c` | `__interrupt` |
| implicit declaration of `__builtin_e2k_pshufb`, `popcnts`, `lzcnts`, `scls`, ... (an error by default since GCC 14) | `asm/string.h`, `bitops.h`, `checksum.h` | lcc builtins: 31 distinct ones in `arch/e2k`, all in [lcc-builtins.md](lcc-builtins.md) |
| `expected ';' before 'long'` | `asm/uaccess.h:411` | `__no_semispec` undefined for GCC |
| `more than 30 operands in 'asm'` | `ttable.c` through `TRAP_HANDLER_DONE` | 39 operands |
| `impossible constraint in 'asm'` | `asm/e2k_api.h:3894`, `:3932`, `:5819`, `:5971` (`process.c`, `start_thread` and others) | `e2k_qreg_t` (a 16-byte struct aligned to 8) as a `"=&r"` output: BLKmode on a `STRICT_ALIGNMENT` target, which GCC reports after expansion, past every target hook ("`%L`, `%H` and 16-byte operands") |

Configurations for v5 and later (`config-mcst-e8c2`, `-e2c3`, …;
`defconfig` is v3) also compile `asm/xor.h`'s `xor2_128x16_m12`,
`xor3_128x16_m10`, `xor4_128x16_m8` and `xor5_128x16_m6` (`#if __iset__
>= 5`, `:606-1620`) in `crypto/xor.c` (`XOR_BLOCKS`, a module in every
`config-mcst-*`), which put `__aligned(64)` on their pointer parameters
(`asm/xor.h:688-689, 744-746, 911-914, 1189-1193`). GCC refuses that:
"alignment may not be specified for 'p1_arg'" (`aligned` is for
variables, functions and fields, `gcc/c-family/c-attribs.cc:2321`)
[gcc]. lcc ignores it on a parameter, with no diagnostic under `-Wall
-Wextra`: `__alignof__` says 8, an address-taken slot is not realigned,
and `crypto/xor.c` built with the kernel's own lcc command compiles to
the same code without the attributes, so dropping them changes nothing
[lcc 1.29.16 v3, v5.8c2, 1.31.05 v3:
`tools/abi/probes/folda36_parmalign.c`, and `crypto/xor.c`]. Clang
honours it [unipro].

With `FUNCTION_TRACER` on, every file also stops with "sorry,
unimplemented: profiling" (that back end has no `-pg`; the probe's
`pg` section). With every warning allowed, `-ffixed-g16` … `g25`,
unknown pragmas silenced and `-fpermissive`, `fast_getcpu.o`, `fpu.o`,
`setjmp.o`, `time.o`, `lib/string.o`, `p2v/boot_init.o`,
`kernel/cpu/iset_v3.o`, `kernel/sched/core.o` and `mm/slub.o` compiled;
`ttable.o`, `usercopy.o` and `process.o` did not. Compiling is not the
hard part: the asms above that GCC deletes or moves, the dropped
options and the missing attribute would all build silently once those
errors are fixed.

## Not checked yet

- What lcc's `-fspec-volatile-st` changes: no probe produced a `,sm`
  store through a `volatile` pointer.
- `avoid_stack` and `-fnon-std-greg-api`: no effect found.
- Whether the empty instruction lcc puts between a store and a return
  under `-ffix-lcc-bug123567` is required by the erratum or only lcc's
  caution (the erratum doesn't say; not reproduced on the 8C2,
  hwbugs.md).
- The kernel-mode effects themselves (empty DTLB entries, the AAU reset
  by a `%ctpr2` write at entry, the instruction-buffer erratum
  124206/135900 and whether `rbranch ? %dt_alN` at entry or exit
  triggers it): they are privileged and come from the sources only.
- Whether a GCC `ttable_tmp.o` and `ttable.o` get equal windows: not
  compared (the proof-of-concept back end of 2026-10-16 couldn't compile
  `ttable.c`; its later kernel boots on the 8C2).
- GCC and the v5+ per-CPU atomics cast to `void` (inferred, not
  probed); recordmcount.pl itself on a whole build (the probe applies
  its rules).
- What MCST's own clang (lccrt) does with `__interrupt__` and
  `-flb-option=`: not available as an oracle.
