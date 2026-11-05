# Kernel interface (Linux 6.1, e2k64)

What compilers and language runtimes need from MCST's Linux 6.1 for
64-bit unprotected processes: system calls, the state a process starts
in, the auxiliary vector, contexts, signals, the stacks, the address
space, threads, profiling and static PIE. Marks as in
[README.md](README.md); **kernel** paths are relative to
`OpenE2K/linux/arch/e2k/` (generic kernel files start with `linux/`),
**glibc** paths to `OpenE2K/glibc/sysdeps/unix/sysv/linux/e2k/` unless
they start with `sysdeps/`, `csu/`, `elf/` or `nptl/`; **compiler-rt** is MCST's
compiler-rt 11.1.0 from the same tarball as **libgcc**.

**hw** here means the 4C (ALT Linux, kernel `6.1.158-mcst-e4c`), the 8C2
and the 2C3 (Elbrus Linux 9.5.5, kernels `6.1.0-1.17-e8c2` and
`6.1.0-1.18-e2c3`) agree, unless a row names one of them. The kernels
are three releases of MCST's tree: the 4C's ALT package
`kernel-image-mcst-e4c-6.1.158-alt1.9.1` is MCST's 6.1-1.9 (its
changelog: "updated to 6.1-1.9 mcst source tree"), the others 6.1-1.17
and 6.1-1.18 (`/proc/config.gz`). `OpenE2K/linux` is at 6.1-1.19-open,
and its history holds 6.1-1.9 (commit 6a2673970ea0) and 6.1-1.17-open
(d639a5da9813); line numbers here are 6.1-1.19's unless a commit is
named. The 8C2 has run MCST's `6.1.0-1.19-e8c2` since 2026-11-03; the
results here are from its 6.1-1.17 unless a row says otherwise. Where the 4C differs, the older tree is the reason ("Overflow
signals", the trampoline page, "Contexts and threads"). The probes are
`tools/abi/probes/sysabi.c` (sections 1–10; `./sysabi maps` for the PIE
and static builds), `sigeh.cc` with `sigeh-c.c` (exceptions and
cancellation), `pgprof.c` (`-pg`), `sanitize.c` (`lcc -S`), `ctlcost.cc`
(what the calls on the hardware stacks cost), `hwscan.c` with
`hwscan.s` (what the copies of the stacks hold), `ctxsig.c` with
`ctxsig.s` (user contexts, edited signal frames, globals across system
calls and in handlers, the chain stack seen from a handler),
`stackregs.c` with `stackregs.s` (the stack registers, how the data
stack grows, a context's stack overflowing), `abileft.c` with
`abileft.s` (signals in made contexts, switching from handlers, data
stack overflow in threads and the main thread) and `abileft-san.c`
(lcc's sanitizers), built by each machine's own lcc 1.29.16, and
`accerr.c` with `getsp.s` (the `si_code` and `si_addr` of stack
overflows and bad accesses), `ctxthr.c` (contexts shared between
threads, `fork` and thread exits) and `kernleft.c` with `kernleft.s`
(the disabled system-call entries and entry 4, edited signal frames and
`%bgr`, switching to a context another thread ran), built by the cross
lcc 1.29.16 for each CPU (`e2k-v3.4c`, `v5.8c2`, `v6.2c3`); `ctxtls.c`
(thread-local storage across a switch) is read with `lcc -S`.
`glibcbuild_entry.c` with `glibcbuild_entry.s` (the state a process
starts in, static and dynamic) is built by the cross lcc 1.29.16 for
each CPU (`e2k-v3`, `v5.8c2`, `v6.2c3`).

## System calls

A system call is a `call` through a CTPR prepared with `sdisp %ctprN, E`
([control-transfer.md](../isa/control-transfer.md)). The kernel enables
these entries for a 64-bit task (`%osem`; kernel
`include/asm/traps.h:137-162`, `include/asm/trap_def.h:236-253`; uapi
`unistd.h:15-20`):

| Entry | Use |
|---|---|
| 1 | 32-bit system call table (enabled for 64-bit tasks too: a 64-bit process calling it gets the compat behaviour, pointers cut to 32 bits [hw: [mode32.md](mode32.md)]) |
| **3** | **64-bit system call table**: what glibc and the uapi headers use |
| 4 | deprecated. For a 64-bit task a number N ≥ 0 continues as entry 3; −N calls N in `sys_call_table_deprecated`, an older numbering whose entries are partly `compat_` handlers (32-bit structures) and are all `sys_ni_syscall` from 326 on (kernel `kernel/trap_table.S:553-597`, `kernel/systable.c:1568-1947`). The arguments go through whole: unlike entry 1 it cuts no pointers (format 2, not entry 1's zero-extending format 1, `trap_table.S:424-457`) [hw: `kernleft.c` part 1, 4C, 8C2, 2C3: +20 and −20 gave the pid, −24 the uid, +327 ran `getcpu`, −327 and −119 gave −38 (the old table has no `sigreturn`); `sigprocmask` (126) through entries 3 and 4 wrote an 8-byte set and −126 a 4-byte one through the same 64-bit pointer (compat `sigprocmask`, `linux/kernel/compat.c:40-75`); `%g16` came back empty, as after entry 3] |
| 5, **6** | fast system calls, 32-bit and **64-bit** (below) |
| 7, 8 | fast and ordinary calls of protected mode: protected tasks only |

32-bit code uses entries 1 and 5 ([mode32.md](mode32.md), "Kernel"),
protected code 8 and 7 ([protected-mode.md](protected-mode.md), "System
calls"); both are out of scope here.

**Disabled entries** [hw: `kernleft.c` part 1; 4C, 8C2, 2C3]. The trap
table also has code at entries 0 (hardware traps and interrupts), 7, 8
and 10 (protected mode; 10 is the legacy one), 11 and 12 (the kernel's
own: `osgd_to_gd` and the boot jump-start) and 16–18 (hypercalls, in
kernels built as KVM hosts) (kernel `kernel/vmlinux.lds.S:50-101`,
`kernel/trap_table.S:1138-1145`, `p2v/boot_head.c:92-94`); `%osem`
enables only 1, 3, 4, 5 and 6 for a 64-bit task. The check is made when
the transfer is prepared: `sdisp %ctpr1, N` for any of the disabled
entries leaves `%ctpr1` with `ta_tag` 0 (empty), while entries 3 and 4
give `ta_tag` 5, a system label (`opc` 0 for all; read with `rrd
%ctpr1`, which works in user mode; MCST's qemu models the same, setting
the entry's address with tag 0, `target/e2k/tcg/translate-ctp.c:163-174`).
A `call` through it is then a transfer through an empty CTPR
([control-transfer.md](../isa/control-transfer.md), "Lifetime and
validity"): SIGILL with `si_code` 1 and `si_addr` at the `call`, and no
entry code runs. The kernel handles it as an illegal instruction
address and passes `SEGV_MAPERR`, which has `ILL_ILLOPC`'s value; for
entry 10, whose address the CTPR still holds, it also logs "uses legacy
protected mode implementation.  Have you recompiled it with newer
compiler?" (`kernel/traps.c:992-1038`; the log line appeared for the
entry-10 child on all three). Entries 2, 9, 13–15 and 19–31, which the
trap table does not name, were not tried; their `%osem` bits are clear
too.

```
{ sdisp %ctpr1, 0x3              ; entry 3
  addd  0x0, NR, %b[0]
  addd  0x0, ARG1, %b[1] ... }   ; arguments in %b[1]..%b[6]
call  %ctpr1, wbs = W            ; W = caller's wsz - 4
addd  0x0, %db[0], RESULT
```

(uapi `e2k_api.h:121-311`; glibc `e2k64/sysdep.h:38-86`, `sysdep.h:101-147`.
The uapi macros `__E2K_SYSCALL_0` and `E2K_SYSCALL`, compiled by lcc,
return what `getpid ()` and `write ()` do, and −9 for a bad descriptor:
`sysabi.c` section 9 [hw].)

| Item | Rule | Source |
|---|---|---|
| Window | The caller hands over 1 to 4 pairs (`%b[0]`–`%b[7]` at most); glibc, the uapi macros and lcc hand over 4. glibc's assembly wrappers use `setwd wsz = 9`, `wbs = 5`. The entry starts with `{ vfrpsz rpsz=4; setwd wsz=4; setbp psz=0 }`, so **handing over 5 or more pairs kills the process**: the entry's checks trap at a kernel IP, and the kernel answers that with SIGKILL. `getpid` returns with 1–4 pairs (`wsz − wbs`) and dies with 5–8 [hw: `tools/isa-probes/ctlleft.c` `sc_getpid*`, 4C, 8C2, 2C3]; `getppid` with 6 or 8 pairs and fast call 2 with 6 died too, 2 and 4 pairs worked [hw: `ctxsig.c` section 3]. Which check fires is inferred: in user code, when both fail only the `setwd` one's SIGILL is seen (operations-v3.md, `vfrpsz`), so in entry 3 (`setwd wsz=4`) it is presumably the `setwd`; entry 6's `setwd wsz = 0x8` holds a parameter area of up to 8 pairs (`wsz` counts pairs), so for 5–8 pairs only its `vfrpsz rpsz=4` fails there. Fewer than 4 pairs work while they hold the arguments: `getpid` and `close (-1)` (−9, `EBADF`) with 1 pair, entry 6's fast call 6 (−38, `ENOSYS`) with 1 and `getcpu (0, 0)` with 2 [hw: `tools/abi/probes/pocabi2.c` `wbs`; 4C, 8C2, 2C3]. 0 pairs was not tried (a user-mode call that hands over none is SIGSEGV `SEGV_BNDERR` at the callee's first instruction, [registers.md](registers.md)). The `call`'s own window rule applies as to any call: `wbs` must be at least the pairs the calling function inherited, 4 for a C function, or the `call` is SIGSEGV `SEGV_BNDERR` at the `call`, before the kernel is entered, for entry 3 and entry 6 alike ([registers.md](registers.md), window size limits; the proof-of-concept back end's leaves with `wsz = 5`, `wbs = 1` died so). A compiler that emits system calls inline hands over at most the 4 pairs the convention gives, with `wbs ≥ 4`: a window of at least 8 pairs, as lcc's `%#` (`wsz` = `%#` + 4, `%#` ≥ 4) and glibc's wrappers (`wsz = 9`, `wbs = 5`) give | kernel `kernel/trap_table.S:545-546,698-699`, `include/asm/trap_table.S.h:49`, `kernel/traps.c:915-922,1097-1118`; glibc `sysdep.h:105-106`; guide 9.5.3 |
| Number | `%b[0]`, low 32 bits, zero-extended; numbers ≥ 446 (`NR_syscalls`) go to `sys_ni_syscall` (−ENOSYS) | kernel `kernel/trap_table.S:405-418`; uapi `unistd.h:466` |
| Arguments | `%db[1]`–`%db[6]`, tags cleared by the kernel. The uapi's 7-argument macro also writes `%b[7]`, but entry 3 uses `%dr7` as scratch | kernel `kernel/trap_table.S:405-460`; uapi `e2k_api.h:278-309` |
| Result, error | `%db[0]`; −errno. glibc's C wrappers test `(unsigned long) r > -4096UL`, its assembly `PSEUDO` any negative value (`cmpldb %db[0], 0`) | uapi `e2k_api.h:129`; glibc `sysdeps/unix/sysv/linux/sysdep.h:26-28`, `sysdep.h:117-122` |
| Clobbers | uapi: `"ctpr1"`–`"ctpr3"`, `"b[0]"`–`"b[7]"`; glibc: `"call"`, `"memory"`. Neither list names a global, but a system call through entry 3 returns with **`%g16`–`%g31` set to 0 with tag 5**: the kernel keeps its own values in `%g16`–`%g25`, and its common exit path empties all sixteen. `%g0`–`%g11`, `%g14` and `%g15` are kept [hw: `ctxsig.c` section 3, `getppid`, `tgkill` and the clock fast calls that continue in entry 3; `%g12`, `%g13` not tried]. (`sigreturn` is the exception: it returns to code interrupted outside a system call with the frame's values, "Signals".) Predicates and the window below `wbs` are kept by the call mechanism, and the `call` empties `%ctpr1`–`%ctpr3` like any call (inferred). glibc's `"call"` clobber makes lcc treat the asm as a call, across which `%g16`–`%g31` are not preserved anyway ([registers.md](registers.md); inferred). Code that uses the uapi macros, or its own asm, must not keep a value in `%g16`–`%g31` across a system call | uapi `e2k_api.h:108-111`; glibc `sysdep.h:172-173`; kernel `kernel/ttable-inline.h:756-783`, `include/asm/gregs.h:146-147`, `include/asm/e2k_api.h:909-922` |

**`%#`** in `call %%ctpr1, wbs = %#` (uapi, glibc) is lcc's operand
modifier for the `wbs` that leaves `%b[0]`–`%b[7]` above it: `wsz − 4`
([source-compat.md](source-compat.md), "`%#`"). A compiler that builds
glibc or code including `<asm/e2k_api.h>` must accept `%#` and these
clobbers.

E2K numbers (uapi `unistd.h`): 119 `sigreturn` (173 `rt_sigreturn` is
`sys_deprecated`, kernel `kernel/systable.c:165,219`), 228 `e2k_syswork`
(users get `FAST_RETURN` 58, an empty call, and `FLUSH_CMD_CACHES` 8 →
−EPERM, "Snooping is done by hardware since V3"; kernel
`kernel/e2k_syswork.c:3083-3145`), 229 `clone_thread`, 230 `e2k_longjmp2`,
252–254 `set_backtrace`, `get_backtrace`, `access_hw_stacks`, 260
`el_binary`, 369–372 `setcontext`, `makecontext`, `swapcontext`,
`freecontext`.

**What a call costs** (`sysabi.c` section 9, `%clkr` cycles per call in a
loop of 100,000):

| Call | 4C | 8C2 | 2C3 |
|---|---|---|---|
| `getppid` (entry 3) | 492 | 447 | 420 |
| `sigprocmask` query (fast call 3) | 96 | 104 | 107 |
| `clock_gettime (CLOCK_MONOTONIC)` (fast call 1) | 1,209 | 1,442 | 234 |
| `clock_gettime (CLOCK_PROCESS_CPUTIME_ID)` (entry 3) | 1,304 | 1,187 | 1,385 |

A fast call itself costs about 100 cycles. The clock read is what is
slow on the 4C and 8C2: their clock source is `lt`, a timer behind an
I/O read, while the 2C3 uses `sclkr` (`/sys/devices/system/clocksource`),
which advances in steps of about 330 ns. `%clkr` is cheap but per core
(below, "Time").

Calls on the hardware stacks [hw: `tools/abi/probes/ctlcost.cc`,
`%clkr` cycles, median of 7. Each call is made from one C function
through glibc's `syscall ()`; `getppid ()` costs 531, 493 and 468
there. At depth 10 the chain stack has 19 frames and the procedure
stack 3.4 KB; at depth 100, 109 frames and 17.8 KB]:

| Call | 4C | 8C2 | 2C3 |
|---|---|---|---|
| `access_hw_stacks` mode 4 or 5 (a stack size) | 585–610 | 555–575 | 550–570 |
| mode 6 `READ_CHAIN_STACK_EX`, the top frame | 1,370 | 1,342 | 1,410–1,440 |
| mode 6, the top 32 frames (of 109) | 10,686 | 12,216 | 13,798 |
| mode 6, the whole chain stack, 19 / 109 frames | 6,598 / 33,509 | 7,426 / 38,980 | 8,320 / 43,671 |
| mode 6, the bottom 32 of 109 frames | 17,875 | 19,679 | 22,993 |
| mode 7 `READ_PROCEDURE_STACK_EX`, the top 1 KiB | 2,390 | 2,250 | 2,630–2,660 |
| mode 7, the bottom 1 KiB, under 19 / 109 frames | 3,411 / 12,223 | 3,449 / 13,465 | 3,916 / 15,562 |
| mode 7, the whole stack, 19 / 109 frames | 3,640 / 14,100 | 3,550 / 14,560 | 4,030 / 16,680 |
| mode 8 `WRITE_PROCEDURE_STACK_EX`, 8 bytes 1 KiB below the top | 2,200 | 2,160 | 2,530–2,560 |
| `get_backtrace`, 10 addresses | 2,170 | 2,330 | 2,820–2,850 |

The cost depends on where the range is: for chain reads and for
procedure-stack reads and writes alike, the kernel walks the chain stack
one frame at a time from the top down to the requested range (kernel
`kernel/e2k_syswork.c`: `____parse_chain_stack` 1413-1436,
`__read_current_chain_stack` 2534-2600, `copy_current_proc_stack`
2712-2866). Each chain frame passed on the way
costs about 93 (4C), 97 (8C2) or 119 (2C3) cycles in a chain read, and
98, 111 or 129 in a procedure-stack read. Each chain frame copied costs
296, 348 or 388 more: the kernel builds every copy field by field and
checks whether its return address is in the trampoline page (inferred).
Procedure-stack bytes cost about 0.1 cycle each or less: at depth 100
the 16.8 KB between the bottom 1 KiB and the whole stack add 1,860
cycles on the 4C and 1,100 on the 8C2 and 2C3. A chain read costs about
1,000 to 1,100 cycles plus these. So the size queries and the reads near
the top cost the same at any depth. Reading a whole stack costs about
300 to 390 (chain) or 100 to 130 (procedure) cycles per frame of the
stack. A read or write deep in the stack pays for every frame above it;
this includes libgcc's mode-8 writes into a landing frame d frames down
(inferred from the source, not timed). What `longjmp` (`e2k_longjmp2`),
exceptions and backtraces cost is in
[stack-and-unwinding.md](stack-and-unwinding.md).

## Fast system calls (entry 6)

Entry 6 masks the number in `%dr0` with 7 and jumps to a table entry with
`%dr1` and `%dr2` (tags cleared) as its only arguments; the handler runs
in the entry's window without saving user state or switching stacks and
returns −errno (kernel `kernel/trap_table.S:691-746`,
`fast_syscalls/fast_syscalls.c:60-69`, `include/asm/unistd.h:14-16`).
The calling sequence is the one above with `sdisp %ctpr1, 0x6` (glibc
`e2k64/sysdep.h:39`). Pointers are masked to 48 bits.

| N | Call | Arguments | Notes (kernel `include/asm/fast_syscalls.h`, `fast_syscalls/`) |
|---|---|---|---|
| 0 | `gettimeofday` | `tv`, `tz` | continues in entry 3 inside the kernel if the clock can't be read fast |
| 1 | `clock_gettime` | `clockid`, `tp` | fast for `CLOCK_REALTIME`, `CLOCK_MONOTONIC` and their `_COARSE` forms; other clocks continue in entry 3, so callers need no fallback (`fast_syscalls.h:294-303`) |
| 2 | `getcpu` | `cpup`, `nodep` | the third argument is not passed |
| 3 | `siggetmask` | `oset`, 8 | glibc's `sigprocmask` with a null new set (`sigprocmask.c:73-80`) |
| 4 | `getcontext` | `ucp`, 8 | no ordinary counterpart (below) |
| 5 | `set_return` | `ip`, 0 | rewrites `cr0_hi` of the nearest user chain frame; checks only that `ip` is a user address (`fast_syscalls.h:415-460`). Not advertised; glibc doesn't use it |
| 6, 7 | — | | −ENOSYS |

A fast call keeps `%g0`–`%g11`, `%g14`, `%g15` and `%g16`–`%g25`
(`%g12`, `%g13` not tried), but **may change `%g26`–`%g31`**: the kernel
is compiled to use those six as scratch registers (`-fglobal-regs`;
`SCRATCH_GREGS_START` 26, kernel `include/asm/glob_regs.h:22-24, 57-68`;
the kernel's whole global-register convention, and why only
`-ffixed-g16` … `-ffixed-g25` keeps the user's `%g16`–`%g25` there:
[kernel-build.md](kernel-build.md), "Global registers").
The calls tested changed only `%g26`–`%g28`: fast calls 2 and 3 left
kernel values in all three on every machine, and the clock calls 0 and 1
changed `%g26` on the 2C3. On the 4C and 8C2 the clock calls emptied all
of `%g16`–`%g31`, because their `lt` clock source makes them continue as
ordinary system calls through entry 3 (above; kernel
`fast_syscalls/fast_clock_gettime.c:15-18`) [hw: `ctxsig.c` section 3].
So treat `%g16`–`%g31` as clobbered by every system call, fast or not.

glibc uses a fast call only when its bit is set in `AT_FAST_SYSCALLS`
(glibc `sysdep-vdso.h:26-40`). **There is no vDSO**: `AT_SYSINFO_EHDR`
(33) is defined but never supplied (kernel `include/asm/elf.h:280-293`,
`linux/fs/binfmt_elf.c:253-292`; 0 on all three machines [hw]), glibc's
`libc-vdso.h` is empty, and the time functions go through entry 6.

## Process entry [source; hw: `glibcbuild_entry.c` with `glibcbuild_entry.s`]

The kernel starts a process at its ELF entry as if returning into a
frame that has no caller (kernel `kernel/process.c:953-1148`,
`start_thread`, and `chain_stack_frame_init`, `:2328-2358`). glibc's
`_start` (`crt1.o`, `start.c:46-96`) and ld.so's `_start2`
(`sysdeps/e2k/dl-machine.h:321-352`) are C functions, so this is the
state compiled code meets first. `glibcbuild_entry.s`, linked as the
entry point (`-Wl,-e,glibcbuild_entry`), records it and jumps to
`_start` [hw: lcc 1.29.16, the `e2k-v3` build on the 4C, `v5.8c2` on
the 8C2, `v6.2c3` on the 2C3, each static and dynamic; the three agree
unless a cell names one]:

| State | Static program (the kernel's) | Dynamic program (what ld.so hands the program's `_start`) |
|---|---|---|
| `%dr0` | 0: no `rtld_fini` | `_dl_fini`, in ld.so: ld.so's assembly `_start` calls `_start2`, loads `_dl_fini` from its GOT into `%dr8` and calls the entry `_start2` returned, with `wbs = 4` (glibc `sysdeps/e2k/e2k64/dl-machine.h:155-178`) |
| `%dr1`–`%dr7` | 0 with tag 0: the kernel clears the 4-pair parameter area (`C_ABI_PSIZE_UNPROT`, `process.c:964, 1024-1035`; `%qr0` is 0 outside protected mode) | ld.so's leftovers, tag 0 |
| window | `%wd.psize` 4 pairs (64 bytes), `%br` 0 | the same; called from an 8-pair window with `wbs` 4 (`%cr1.lo` `wbs` 4, `wpsz` 4) |
| frame below | none: `%cr0.hi` (the return address) and `%cr1` read 0 | ld.so's `_start`, which stores to address 0 if the program's `_start` returns |
| `%usd.ptr` (`getsp 0`) | the address of `argc`, a 64-bit word; `argv[0]` at +8, `envp` after `argv`'s null, then the auxiliary vector; 16-byte aligned (`process.c:979`), not always 32 | the same: ld.so's `_start` makes no frame. When ld.so runs a program named on its own command line, `_fix_user_stack` has first moved `argv`, `envp` and `auxv` down over ld.so's arguments (`sysdeps/e2k/dl-machine.h:286-318`) |
| predicates | all false (`cr0` zeroed, `process.c:2335`) | all false |
| global registers | 0 with tag 5 (empty), all 32; on the 4C (6.1-1.9) `%g0`–`%g15` are 0 with tag 0 | `%g13` is the thread pointer; the others hold ld.so's leftovers, on the 4C four of them diagnostic (`%g17`, `%g18` `4000000040000000`, `%g20`, `%g21` `4afafafa4afafafa`, tag 5) |
| FP control | `%pfpfr` 0x1fbf, `%fpcr` 0x37f, `%fpsr` 0x3f (`INIT_FPU_REGISTERS`, `process.c:1103`; [registers.md](registers.md)) | the same |
| other | `%bgr` 0xff; `%rndpr` 0x0003ffff0001ffff (`E2K_INITIAL_RNDPR`, `process.c:1148`); `%rpr` 0 (`:1141`); `%upsr` 1, 0 on the 2C3 ([x86-support.md](../isa/x86-support.md)); `%lsr` 0xff0000000000 and `%ilcr` 0, on the 4C 0x6000000000 and 9 (where these come from: "Not checked yet") | the same, except `%lsr` and `%ilcr`, which hold what ld.so's loops left |

What glibc's C entry code relies on, and so what a compiler that builds
it must provide [glibc; lcc]:

- `register long *fp asm ("FP")` is the stack pointer at entry, here
  `%usd.ptr`: `_start` reads `argc` as `*(int *) fp` and `argv` as
  `fp + 1` (`start.c:59, 84-85`), and `_start2` passes `fp` to
  `_dl_start` and reads `argc` from `*fp` (`sysdeps/e2k/dl-machine.h:329-343`).
  lcc's `crt1.o` does exactly that (`getsp -0x40`, `addd 0x40`, `ldw`
  at +0, `argv` at +8) [lcc]. What `"FP"` means to lcc, and that its
  `__builtin_frame_address (0)` is the same value:
  [source-compat.md](source-compat.md), "Inline assembly" (register
  variables).
- `rtld_fini` is the first argument, `%dr0`.
- `_start` never returns: glibc's stores to address 0 after
  `__libc_start_main` (`start.c:95`), and ld.so's `_start` does the
  same after the program's.
- `_start` inherited 4 pairs, so its calls need `wbs` ≥ 4
  ([registers.md](registers.md), "Window and rotating-base units");
  every C call meets that.
- In a dynamic program the global registers hold ld.so's values, on the
  4C some of them diagnostic: code before `main` must not store a
  global it has not written with a plain store (one of a diagnostic
  value is SIGILL, [speculation.md](../isa/speculation.md), "Diagnostic
  values").

**`__libc_stack_end` is NULL in static programs** [glibc; hw]. E2K's
`_start` passes 0 as `__libc_start_main`'s `stack_end` (`start.c:88-92`)
and the static `__libc_start_main` stores it (`csu/libc-start.c:262`);
in a dynamic program ld.so sets it from `_start2`'s `fp`
(`sysdeps/unix/sysv/linux/dl-sysdep.c:129`), equal to `usd.ptr` [hw].
So in a static program `pthread_getattr_np` fails for the main thread
with `ENOENT` (it looks for the mapping that holds `__libc_stack_end`,
`nptl/pthread_getattr_np.c:84-135`) on all three machines, and code that
finds the main thread's stack that way (garbage collectors, stack
guards) needs `%sbr` or `/proc/self/maps` there
([stack-and-unwinding.md](stack-and-unwinding.md), "What they tell a
collector or a fiber library"). `dlopen` of a library that needs an
executable stack also starts from `__libc_stack_end`
(`elf/dl-load.c:2455`), so it presumably fails in a static program
(inferred, not run).

**ld.so calls `__cpu_init` before it relocates itself**
(`sysdeps/e2k/dl-machine.h:335-338`): it checks every library's `e_flags` with
`__builtin_cpu_is` (`runtime_compatible_host`, `ldsodefs.h:59, 88`)
before its own constructors run, and they then run `__cpu_init` a second
time. What that asks of `__cpu_init` is in
[source-compat.md](source-compat.md), "CPU detection at run time".

## Auxiliary vector [hw]

| Entry | Value | Source |
|---|---|---|
| `AT_FAST_SYSCALLS` (32) | `0x1f`: bit N = fast call N available (0–4); glibc's `__libc_e2k_fast_syscalls` | kernel `include/asm/elf.h:280,288`; uapi `auxvec.h:9`; glibc `dl-auxv.h:26-27` |
| `AT_SYSTEM_INFO` (34) | `0x1`: bit 0 = `vfork` implemented (glibc's `__libc_e2k_system_info`; without the bit its `vfork` calls `fork`) | kernel `include/asm/elf.h:281-289`; glibc `vfork.c:18-19` |
| `AT_BINCOMP_INFO` (35) | absent: only the binary translator's loader passes it | kernel `sec_space/rtc_procfs/binfmt_rtc_elf.c:319` |
| `AT_HWCAP` | 0 | kernel `include/asm/elf.h:229` |
| `AT_PLATFORM`, `AT_HWCAP2`, `AT_SYSINFO_EHDR`, `AT_MINSIGSTKSZ` | absent (`ELF_PLATFORM` is NULL) | kernel `include/asm/elf.h:238`; `linux/fs/binfmt_elf.c:279-290` |
| `AT_PAGESZ` | 4096 | kernel `include/asm/elf.h:218` |

**CPU detection.** The auxiliary vector says nothing about the CPU. An
ifunc resolver gets no arguments (glibc `sysdeps/e2k/dl-irel.h`) and runs
before constructors (static: `csu/libc-start.c:307-310` before
`call_init` at :399; dynamic: `elf/rtld.c` relocates before `_dl_init`),
so lcc's `__cpu_info`, filled by the priority-101 constructor `__cpu_init`
([source-compat.md](source-compat.md), "CPU detection"), is still zero
there. Resolvers, `target_clones` and `__builtin_cpu_supports` must call
`__builtin_cpu_init` first or read `%idr`
([semantics.md](../isa/semantics.md)) (inferred).

## User contexts [source; hw: `ctxsig.c` section 1]

Context switching is done by the kernel, which owns the hardware stacks
(glibc `ucontext.h:51-56` and the `*context.c` files; kernel
`kernel/proc_context.c`). There is **no `makecontext`**
(`stdlib/makecontext.c` is the ENOSYS stub; lcc's sysroot exports none).
[hw] in this section means `tools/abi/probes/ctxsig.c` section 1, on
which the 4C, 8C2 and 2C3 agree apart from addresses.

| Function | Implementation |
|---|---|
| `int getcontext (ucontext_t *)` | glibc stores `%cr0`, `%cr1`, `%usd` with `rrd`; fast call 4 stores the signal mask, the caller frame's stack pointers, `sbr`, `%fpcr`/`%fpsr`/`%pfpfr` and the context key (`fast_syscalls.h:370-412`) |
| `int setcontext (const ucontext_t *)` | system call 369 `(ucp, 8)` |
| `int swapcontext (ucontext_t *, const ucontext_t *)` | system call 371 `(oucp, ucp, 8)`: saves and loads the signal mask, `%cr0`/`%cr1`, the stack registers and the three FP control registers (`proc_context.c:1515-1548, 1828`) |
| `int makecontext_e2k (ucontext_t *, void (*)(void), int argc, ...)` | system call 370 `(ucp, makecontext_helper, 8 * (argc + 4), buf, 8)`; allocates a procedure and a chain stack, so it can fail (−1, errno ENOMEM, EINVAL or EFAULT; `EINVAL` for a 0- or 16-byte stack [hw]) |
| `int freecontext_e2k (ucontext_t *)` | system call 372 `(ucp)`: frees them; `ENOENT` for an unknown context, `EBUSY` only for the calling thread's own running context (`proc_context.c:1264-1295`; a context running in another thread is freed under it: "Contexts and threads" below) [hw: a made context freeing itself and the main context freed from main both gave `EBUSY`. The main context freed from inside a made context while it was suspended gave 0, and the later return through `uc_link` to it failed with `ESRCH`. A finished context gave 0 and a second free `ENOENT`. A made context that never ran, freed through a `memcpy` copy, gave 0, and freeing the original then gave `ENOENT`] |

- The context runs on `uc_stack` (base and size aligned to 256,
  `proc_context.c:1132-1138`). Its top is the context's **key**, which
  `makecontext_e2k` writes to `uc_mcontext.nr_TIRs` (kernel
  `include/asm/ucontext.h:38-55`) [hw]. A switch looks the target up by
  the key in the `ucontext_t` it is given (`ESRCH` if no context has it,
  `EBUSY` if that context is running; `proc_context.c:804-822`,
  `311-330`), so every copy of a `ucontext_t` names the same context.
  From that `ucontext_t`, as it is at the time of the switch, the switch
  also loads the signal mask, `%fpcr`/`%fpsr`/`%pfpfr`, `cr0_hi`, `cr1`
  and the chain-stack position (`proc_context.c:1515-1527`).
- **A context's data stack can overflow into the memory below
  `uc_stack`** [hw, `stackregs.c` section 7; 4C, 8C2, 2C3]. At the start
  its `USD` covers exactly `uc_stack`: the bottom is `ss_sp`, and `%sbr`
  is the top rounded down to a page (`stackregs.c` section 5;
  [stack-and-unwinding.md](stack-and-unwinding.md), "Stack registers").
  A `getsp` past the bottom traps as in the main thread ("The data
  stack" below). The kernel then extends the stack, up to a total of
  `RLIMIT_STACK` (`mm/fault.c:1075`), into whatever mapping holds the
  new bottom. It
  checks for holes only between mappings that end below the stack's top
  (`mm/fault.c:1105-1127`), so it does not see a gap directly below the
  mapping that holds `uc_stack` (inferred from the code and the third
  row). The test put a 64 KiB `uc_stack` in the middle of a 1 MiB
  mapping and ran four nested frames that each allocate and fill
  32 KiB:

  | Directly below `uc_stack` | Result |
  |---|---|
  | the rest of the mapping | the stack grows 32 KiB per frame; 65,640 bytes below `uc_stack` are overwritten (65,656 on the 8C2) and no signal is raised |
  | a `PROT_NONE` page | the stack grows over the page; the first store into it gives SIGSEGV `SEGV_ACCERR` at `ss_sp − 16` |
  | one unmapped page | the stack grows over the gap; SIGSEGV `SEGV_MAPERR` at `ss_sp − 16` |
  | 512 KiB unmapped | the `getsp` fails: SIGSEGV at `ss_sp − 1`, `SEGV_BNDERR` on the 8C2 and 2C3 (`kernel/traps.c:1132-1141`); `SEGV_ACCERR` on the 4C, whose kernel is MCST's older 6.1-1.9 tree ("Overflow signals" below) |

  A fiber library should leave unmapped memory below each context's
  stack, at least one growth step large: the larger of 16 KiB and the
  largest single `getsp`, rounded up to a page. A `getsp` whose new
  bottom falls into that gap fails with SIGSEGV; one that reaches past
  it into another mapping is accepted. A `PROT_NONE` guard page faults
  only when a store lands in it: a frame that the kernel has extended
  past it can write below it unnoticed (inferred). The kernel's comment
  on `expand_user_data_stack` says E2K needs no gap below a stack
  because the hardware bounds catch overflows (`mm/fault.c:1019-1036`).
  The extension into the mapping below is what defeats that.
- glibc passes the arguments as 8-byte slots copied from its `va_list`
  (so no 16-byte arguments) after `ucp`, the function, `argc` and a
  zero. The kernel loads the first 8 slots into `makecontext_helper`'s
  registers and copies the rest to the new stack. The helper calls the
  function with them in `%b[0]`–`%b[7]` (glibc `makecontext.c`,
  `makecontext_helper.S`; `proc_context.c:686-765`). [hw: with 0, 3, 8
  and 12 `long` arguments every one arrived, the 9th to 12th included.]
- **`uc_link` is read twice** [hw, source]. When the function returns,
  glibc's `makecontext_helper` loads `uc_link` from the `ucontext_t` that
  was passed to `makecontext_e2k`, as the field is at that moment, not
  from a copy the context was started through. **It loads only the low
  32 bits** (`ldw` at offset 8, then `cmpedb` with 0; glibc
  `makecontext_helper.S`, where `LDP` is `ldw` for 64-bit code). If they
  are zero, the helper calls glibc's `exit (0)`, which runs atexit
  handlers and ends the process. That also happens for a non-null
  `uc_link` whose low 32 bits are zero, such as an object at a 4 GiB
  boundary. Otherwise the helper returns into `[trampolines]+0x400`. The
  trampoline tests and uses the full 64-bit `uc_link` that the kernel
  **copied at `makecontext_e2k` time** (`proc_context.c:735-753`,
  `proc_context_stacks.c:46-51`) and calls `setcontext` on it. If the
  copied value was null, or that `setcontext` fails, it makes the `exit`
  system call (number 1, not `exit_group`), which **ends only the calling
  thread**: no atexit handlers, no stdio flush. The status is 0 for a
  null value and the error number for a failed `setcontext` (kernel
  `kernel/trap_table.S:1297-1328`). Hardware results:
  - A `uc_link` at 0x7_0000_0000 ran the atexit handler and exited 0.
    The control at 0x7_0000_0100 returned to the main context.
  - Changing `uc_link` from the main context to null after
    `makecontext_e2k` ran the atexit handler and exited 0.
  - Changing it from null to the main context exited 0 without running
    the handler. In a second thread the same change ended only that
    thread: `pthread_join` returned 0 and the process went on.
  - Changing it to another context B, starting from a copy whose
    `uc_link` is B, or starting from a copy whose `uc_link` is null,
    returned to the main context.
  - A `uc_link` naming an unknown key exited with status 3 (`ESRCH`), as
    did one naming a main context freed while it was suspended.

  So set `uc_link` before `makecontext_e2k`, leave it unchanged, and
  never let the context it names lie at an address whose low 32 bits are
  zero.
- **Each context has its own FP control registers and signal mask**
  [hw]. `makecontext_e2k` clears `uc_sigmask` and writes the process
  defaults to `uc_extra` (`fpcr` 0x33f, `fpsr` 0x3f, `pfpfr` 0x1fbf;
  `proc_context.c:954-1035`). A switch loads both from the target
  `ucontext_t` and saves the current ones into `oucp`. The new context
  started with rounding to nearest and all flags set (`%fpcr` read back
  as 0x37f). It set rounding toward zero and overflow, then switched
  back. The main context's upward rounding and inexact flag were
  unchanged, and the context found its own settings again when resumed.
  `getcontext` followed by `setcontext` on one stack also restores the
  FP state saved by `getcontext`. Unlike a signal handler ("Signals"), a
  context switch does keep the FP environment. The signal mask works the
  same way. With USR1 blocked in the main context, a context whose
  `uc_sigmask` got TERM after `makecontext_e2k` started with only TERM
  blocked. It blocked USR2 and switched back, and the main context still
  had only USR1 blocked. The resumed context had USR2 and TERM.

Contexts and their keys [hw]:

| Case | Result |
|---|---|
| Starting a made context through a `memcpy` of its `ucontext_t`; resuming a suspended context through a copy of the state `swapcontext` saved | works |
| `makecontext_e2k` again on a suspended context's stack (same key) | returns 0 and reuses the context; switching to it starts the function again from the top. The state saved at the suspension now names the new context: **switching to that state kills the process (SIGKILL)** |
| `makecontext_e2k` on the running context's own stack, from inside it | returns 0. The new context takes the key (the kernel drops the running one from its table; the comment names gccgo, `proc_context.c:1143-1222`) and runs when switched to. Switching back to the old context's saved state kills the process (SIGKILL) |
| A switch to a context that is running in another thread | −1, `EBUSY`; a switch that lost such a race can still succeed later, from the state it read before ("Contexts and threads" below) |
| `setcontext` or `swapcontext` to a key that no context has | −1, `ESRCH`. The same for a context freed with `freecontext_e2k`: after the suspended main context was freed, the return through `uc_link` to it ended with the trampoline's exit status 3 (`ESRCH`) |
| `getcontext` before the thread's first switch | the key is the top of the thread's data stack (the end of `[stack]`). `freecontext_e2k` of it gives `ENOENT`: the kernel creates the main context at the first switch (`save_main_coroutine`, `proc_context.c:1736-1746`) |

A switch whose saved chain-stack position or IP is not the target
context's top frame is finished by a kernel `longjmp` on the target's
stacks, which assumes the frame was called with 4 pairs handed over
(`proc_context.c:1832-1852`). If the saved position is not on those
stacks, as for a state saved before the context was made again,
`do_longjmp` does not find the frame and **kills the process instead of
returning an error** (kernel `kernel/signal.c:1504-1545`,
`unwind_stack`, `force_sig (SIGKILL)`). So a program may remake a
context only when it no longer needs any saved state of the context's
earlier run.

**Signals in a made context** [hw: `abileft.c` parts 1 and 2; the 4C,
8C2 and 2C3 agree apart from addresses and counts]:

- **A handler runs on the stacks of the context it interrupts.** Its
  frame goes below the context's `USD` inside `uc_stack`, as on the
  main stack ("Signals"; the handler's local was 4,369 bytes below the
  interrupted `usd.ptr`), and its window and chain frames go on the
  context's own procedure and chain stacks (same `psp.base` and
  `pcsp.base` as in the context). With `SA_ONSTACK` only the data frame
  moves to the alternate stack. Returning from the handler resumed the
  context, whose loop values were intact, and the context then left
  through `uc_link`.
- **A frame that does not fit makes the kernel grow the context's
  stack.** When less than the 4,272-byte frame is free, the kernel
  extends the stack by the missing part plus a page, through the same
  `expand_user_data_stack` as for a `getsp` (`kernel/signal.c:1169-1186`;
  "The data stack" below), into the memory below `uc_stack`. A context
  left 1 KiB free at the bottom of a 16 KiB `uc_stack` in the middle of
  a mapping and took a timer signal:

  | Below `uc_stack` | Result |
  |---|---|
  | the rest of the mapping | no error; the frame and the handler changed 2,644 bytes below `uc_stack`, the lowest 3,760 bytes below it (8C2: 2,676 and 3,872) |
  | 512 KiB unmapped | SIGSEGV kills the process (kernel log: `expand_user_data_stack(): user data stack overflow … free size 0x400`, then `setup signal rt frame failed, error -14`) |
  | the rest of the mapping, handler with `SA_ONSTACK` | nothing below `uc_stack` changed |

  So a fiber library should run its handlers with `SA_ONSTACK`, or keep
  room for the frame and the handler's frames below each context's
  deepest use. A handler that switches contexts needs the second way
  when the context may resume in another thread or the thread may take
  another `SA_ONSTACK` signal first ("Contexts and threads" below).
- **A signal that arrives during a switch is delivered on the switch's
  return, in the context switched to.** Under a 500 µs timer, 100,000
  `swapcontext` round trips took signals on both sides (4C: 601 and 611
  in the main context, 614 and 620 in the made one, in two runs), and
  91 to 97% of them interrupted glibc's `swapcontext`, the system call
  (two runs on each machine; the 4C took 1,215 and 1,231 signals, the
  8C2 about 530, the 2C3 about 390). No switch failed (no `EINTR`) and
  each side kept its rounding mode. With ALRM added to the made
  context's `uc_sigmask` after `makecontext_e2k`, that context took none
  and the main context took all of them (4C: 1,352 and 1,348 in 0.68 s).
- **A handler can switch contexts.** Each context runs under its own
  mask. With TERM blocked in main, a USR1 handler (USR1 + TERM blocked)
  `swapcontext`ed to a made context A, which ran with nothing blocked.
  A second USR1 raised in A ran the handler nested, on A's `uc_stack`,
  with USR1 blocked. When A switched back, the first handler had
  USR1 + TERM again, and after its return main had TERM. Main later
  resumed A's saved state and A finished through `uc_link`.
- **The kernel keeps the interrupted states in a `[signal stack]` per
  context.** This privileged mapping holds a copy of each interrupted
  state for `sigreturn`. It is mapped at a context's first signal
  (4 KiB) and grows when needed (`kernel/signal.c:646-735`). A switch
  swaps it with the context (`proc_context.c:1392, 1426`). A
  `setcontext` out of a handler to an earlier `getcontext` point is a
  kernel `longjmp`, which drops the entries of the frames it unwinds
  (`kernel/signal.c:1361-1412`). 1,000 such exits after `raise`, and
  200 after a timer signal, left the mapping at 4 KiB, and the mask was
  the one saved at the `getcontext` point (nothing blocked). A
  `setcontext` from a handler to a made context whose `uc_link` is that
  point also worked 200 times, and the context never ran with USR1
  blocked.
- **A preemptive scheduler works.** A 2 ms ALRM handler that
  `swapcontext`s round robin among three made contexts ran 20 million
  iterations in each (4C: 329 switches in 0.66 s; 8C2: 164; 2C3: 122).
  All loop values and each context's own rounding mode were intact,
  and each context started with nothing blocked. `freecontext_e2k` of
  each context, all three suspended inside their handlers, returned 0.
  The 12 KiB of `[signal stack]` were still mapped right after, since
  the kernel frees a context's signal stack with its hardware stacks,
  later (`proc_context.c:285-300, 351-360`).

A context's hardware stacks, a 16 KiB `[procedure stack]` and a 4 KiB
`[chain stack]`, are mapped by `makecontext_e2k` itself, before the
first switch (kernel `kernel/process.c:714-718`) [hw:
`/proc/self/maps`]. **`freecontext_e2k` does not unmap them**: the
kernel keeps freed hardware stacks in a per-process cache of up to
1 MiB and gives them to the next context or thread (kernel
`kernel/process.c:479-576`; the free itself waits for an RCU grace
period, `proc_context.c:351-405`) [hw: 200 ms after `freecontext_e2k`
the stacks were still mapped, and the next `makecontext_e2k` with a new
key mapped nothing new]. Every switch is a system call.

**What a switch costs** [hw, `ctxsig.c` `cost`; `%clkr` cycles per
iteration over 20,000 iterations (2,000 for the `makecontext_e2k` row),
pinned to the last CPU, min–max of three runs under the shared timing
lock]:

| Operation | 4C | 8C2 | 2C3 |
|---|---|---|---|
| `swapcontext` round trip (two switches between two contexts) | 3,195–3,197 | 3,277–3,308 | 3,293–3,337 |
| `getcontext` (fast call 4) | 146–147 | 146–175 | 158–165 |
| `getcontext` + `setcontext` back to it (same stack) | 2,645–2,649 | 3,209–3,217 | 3,205–3,266 |
| `setjmp` + `longjmp` from one call down | 2,949–2,957 | 3,308–3,314 | 3,349–3,358 |
| `sigsetjmp (b, 0)` + `siglongjmp` | 2,988–2,993 | 3,309–3,312 | 3,347–3,354 |
| `sigsetjmp (b, 1)` + `siglongjmp` | 3,105–3,115 | 3,497–3,502 | 3,474–3,484 |
| `makecontext_e2k` (key reused) + switch + return through `uc_link` | 6,262–6,310 | 6,420–6,433 | 7,025–7,049 |
| `getppid` (for scale) | 513–516 | 454–455 | 431–432 |

A switch costs about 1,600 cycles, three to four plain system calls.
`longjmp` is the `e2k_longjmp2` system call, and a `setjmp` + `longjmp`
costs about as much as a `swapcontext` round trip (glibc's `setjmp` is
the macro `_setjmp` and `_longjmp` an alias of `longjmp`, so `_setjmp` +
`_longjmp` measured the same; more in
[stack-and-unwinding.md](stack-and-unwinding.md), "setjmp/longjmp,
contexts"). Saving and restoring the signal mask adds about 120 cycles
on the 4C and 2C3 and 190 on the 8C2. A coroutine library pays a kernel
entry for every transfer. Runtimes that would use split stacks (gccgo)
must give each goroutine a full-size context:
[stack-and-unwinding.md](stack-and-unwinding.md), "No split stacks".

**The trampoline page.** The kernel maps one read-execute page,
`[trampolines]` (kernel `kernel/trampolines.c`, `include/asm/stacks.h:36-38`;
code `kernel/trap_table.S:1192-1394`; offsets
`include/asm/process.h:36-70`). On the 8C2 and the 2C3 it is the page
below `[cut]` (0xc2ff_ffff_d000, 0xc27f_ffff_d000; `USER_TRAMPOLINES_BASE`,
`include/asm/stacks.h:38`, `kernel/trampolines.c:47`); the 4C's older
kernel (MCST's 6.1-1.9, commit 6a2673970ea0) maps it wherever
`get_unmapped_area` puts it in the `mmap` area
(`kernel/trampolines.c:50` there; 0x45dc_6594_3000 in one run) [hw:
`/proc/self/maps`]. Code must not assume where it is:

| Offset | Code | Return address of |
|---|---|---|
| +0x000 / **+0x100** / +0x200 | 32-bit / **64-bit** / protected signal return: `sdisp %ctpr2, 3` (64-bit), `sigreturn` (119) with `wsz = 8`, `wbs = 4`, then `exit (1)` | a signal handler (+0x100 [hw]: the handler's caller in `_Unwind_Backtrace` and glibc's `backtrace`, `sigeh.cc` section 3) |
| +0x300 / **+0x400** / +0x500 | context return: `setcontext (uc_link, 8)`, else `exit` | `makecontext_helper` |
| +0x600 | `return` | a frame `set_backtrace` sets to IP −1 ("just return") |

`get_backtrace` and `set_backtrace` skip frames returning into this page
(except +0x600), and chain-stack reads through `access_hw_stacks` set
`cr1.pm` in their copy of such frames, "useful for JITs to distinguish
frames with actual user data" (kernel `kernel/backtrace.c:43,176`,
`kernel/e2k_syswork.c:2581-2584`; hw: "Access" below).

### Contexts and threads [source: kernel `kernel/proc_context.c`; hw: `ctxthr.c`]

What a program that moves contexts between threads can rely on: a fiber
library with a pool of worker threads, or libgo, which runs goroutines
on whatever thread is free. [hw] here means
`tools/abi/probes/ctxthr.c`, built by the cross lcc 1.29.16 `-O3` for
each CPU (`e2k-v3.4c`, `v5.8c2`, `v6.2c3`), on the 4C, 8C2 and 2C3.
They agree apart from addresses and race counts, except where a row
names the 4C, whose older kernel frees hardware stacks twice where the
others don't (below). Line numbers without a file are
`proc_context.c`'s.

**Contexts belong to the process, not to a thread.** The kernel keeps
one table of contexts per process (`mm->context.hw_contexts`, lines
13-14; lookup at 804-823), so any thread may switch to any suspended
context [hw]:

| Case | Result |
|---|---|
| A context made in main, first run by thread B | runs in B and returns through `uc_link` to B's saved state |
| One context resumed 2,001 times by A (`swapcontext`) and B (`setcontext` to a `getcontext` point) in turn | no switch failed. Each time the context ran as the resuming thread (its thread id and TLS) on its own data and hardware stacks (the same `usd.ptr`, `psp.base` and `pcsp.base` every time), with its own rounding mode and signal mask; A and B kept theirs, and the context's loop values stayed intact |
| 3,000 nested calls started in A, suspended at the deepest one, resumed by B | B unwound them to the right result. The procedure stack had grown to 384,992 bytes and the chain stack to 96,256, and the kernel had moved both while they grew (`psp.base` 0xc2e0_0007_8000 → 0xc2e0_0017_1000 on the 4C and 8C2); B resumed on the moved stacks |
| A runs a made context C; B switches to the state A saved when it entered C | B runs A's code with B's TLS on A's own hardware stacks. When C ended, its return through `uc_link` to that state brought A back |

A switch (`switch_hw_contexts`, 1347-1434) exchanges the two contexts'
data-stack bounds, hardware stacks, `[signal stack]` and per-context
flags (1390-1393, 1424-1428), old chain-stack areas and data-stack
growth records (1407-1410), and the stack registers, `%cr0`/`%cr1` and
`%wd` (1412-1418). It loads the FP control registers (1420-1422) and
the signal mask (1857-1859, or through `do_longjmp`, 1840-1851) from
the target `ucontext_t`. It does not touch the global registers, so
**`%g13`, the thread pointer, stays with the thread**: TLS and `errno`
are those of the thread that runs the context (the table above).

**A switch into a context that another thread ran last** costs no more
than any switch when that thread ran on the same core, and 500 to 1,700
cycles more when it ran on another [hw: `kernleft.c` `cost`; one
`swapcontext`, `%clkr` read in the switching thread just before it and
first thing in the context, both on the switching core; medians of
3,800 switches, ranges over three or more runs under the shared timing
lock]:

| Into the context | 4C | 8C2 | 2C3 |
|---|---|---|---|
| the same thread ran it last | 1,611 | 1,628–1,632 | 1,644 |
| the same thread, after letting another thread run on its core | 1,631–1,664 | 1,642–1,671 | 1,723 |
| another thread on the same core ran it last | 1,662–1,664 | 1,663–1,683 | 1,719–1,722 |
| another thread on another core ran it last | 3,187–3,235 (on another chip: 3,346–3,348) | 2,112–2,212 | 2,634 |
| `getppid`, for scale | 520–525 | 460–472 | 436–438 |

The kernel does nothing extra for a context that comes from another
thread: on one core the switch costs what it costs after any other
thread ran there. A context last run on another core costs about 1,600
(4C; 1,700 across chips), 500 (8C2) or 1,000 (2C3) cycles more,
presumably its state coming from the other core's caches (inferred).
The switch back to the thread's own context then costs 1,849–1,858 on
the 4C (1,918–2,068 across chips) against 1,605–1,609 after a context
the thread itself ran, 1,672–1,740 against 1,651–1,656 on the 8C2, and
1,800–1,848 against 1,641 on the 2C3. ("User contexts", "What a switch
costs", has the plain round trip.)

**Compilers assume the thread pointer does not change within a
function.** `tools/abi/probes/ctxtls.c` reads a `__thread` variable
`tv`, its address or `errno` before and after `swapcontext` [lcc:
1.29.16 `-O3 -S`; GCC 16.2.1 for x86_64, `-O2` and `-O3`, for
comparison]:

| Before and after the switch | lcc | lcc `-fPIC` | GCC (with or without `-fPIC`) |
|---|---|---|---|
| `&tv` | folded into one value | `__tls_get_addr` called again | folded |
| `tv` | reloaded through `%g13` | read after the switch through the address `__tls_get_addr` gave before it: the old thread's variable | reloaded through `%fs`; with `-fPIC`, read through the address from before the switch |
| `errno` (`__errno_location` is declared const: glibc `stdlib/errno.h:37`) | `__errno_location` called again | the same | called once: the value read after the switch is the old thread's |
| `&tv` returned by a `noinline` function | the function called again | the same | folded (GCC finds the function const); called again when it is `noipa` |
| `tv` returned by a `noinline` function | called again | the same | called again |

[hw, the second row of the first table: `&tv` taken before a switch in
B equalled `&tv` taken after A had resumed the context, so it was B's
variable; a `noinline` function there returned A's.] libgo reads its
`__thread` variable `g` only through such a function for this reason
(GCC's `libgo/runtime/proc.c:198-206`); its `runtime_g` returns the
value, the form GCC does not fold. A GCC port inherits this folding
from the middle end (inferred).

**A context runs in one thread at a time, but a switch can resume it
from an old state** [source; hw]. A switch marks the target busy with a
compare-and-swap (`take_reference`, 311-335; `coroutine_lookup_and_get`,
804-823), and a switch to a context that runs elsewhere fails with
`EBUSY`. In the race below (two threads meet at a barrier, then both
switch to one suspended context, which runs about 300 loop steps and
switches back to whichever thread runs it; 420,000 rounds a run) no two
threads ever ran the context at once, and the context was entered
exactly once per successful switch.

The switch reads the target `ucontext_t`, though, before it marks the
context busy: the mask, the FP control registers, `%cr0`/`%cr1` and the
chain-stack position (`LOAD_CTX`, 1515-1527, read at 1763-1805; marked
at 1815). A thread whose switch read the `ucontext_t` while another
thread's run of the context was ending can succeed after that run and
resume the context with what it read, which may be the state from
before that run. The table counts resumptions that came back with the
rounding mode of the previous suspension, per run (three or four runs
each):

| Rounds | 4C | 8C2 | 2C3 |
|---|---|---|---|
| 20,000 | 0–1 | 0 | 0–1 |
| 200,000, the context suspending at two call depths in turn | 1–5 | 0–1 | 0–1 |
| 200,000, two depths, each thread first waiting 0–4,095 loop steps at random (both threads ran the context, one after the other, in 77–80% of the rounds) | 1,814–1,855 | 0–1 | 289–306 |

So a scheduler must give a suspended context to one thread only, and
only after the switch away from it has returned in the thread it
switched to.

**Freeing or remaking a context that runs in another thread.**
`freecontext_e2k` refuses only the calling thread's own context (1276)
and removes any other from the table (1279). `makecontext_e2k` on the
stack (key) of a context that is busy drops that context from the table
to make the new one (1203-1222, "for programs like gccgo"). Neither
stops the thread that runs the old context [hw]:

| Case | Result |
|---|---|
| `freecontext_e2k` of a context running in B | 0. The context went on in B and switched back to B's state. The state it saved then named no context: a switch to it gave `ESRCH`, a second free `ENOENT`. Its stacks stayed mapped (the stack cache, kernel `kernel/process.c:541-576`) |
| `makecontext_e2k` on the stack of a context running in B | 0; the new context ran when switched to. The old one went on in B; a switch to its saved state then killed the process (SIGKILL, as in "Contexts and their keys") |
| Either, then B exits while still in the context | **the context's hardware stacks are freed twice.** Of four new contexts, two got the same procedure and chain stacks and one of them computed a wrong result; of two new threads (after a free), both got the same stacks and one computed 20 of 20 deep recursions wrongly |
| B exits while in a context nobody freed or remade (control) | 8C2, 2C3: the stacks are freed once (distinct stacks and right results afterwards). 4C: freed twice, as above |

B's busy reference keeps a freed context alive (`context_free_rcu`,
363-374). When B exits, `hw_context_deactivate_mm` (408-441, called
from kernel `kernel/process.c:1908`) drops that reference, and
`release_reference` frees the context's hardware stacks at once
(`free_hw_context`, 285-309). The exit path then frees B's current
hardware stacks (`kernel/process.c:1924`), which are the same ones.
Only `context_free` clears the thread's copy of them (380-388), and
this path does not call it; it does for a context nobody freed, which
is why the control is freed once. Both frees put the stacks in the
per-process cache, and the next two allocations take the same stacks
(kernel `kernel/process.c:479-576`).

**The 4C's kernel frees a thread's hardware stacks twice at every exit
after its first switch** [source; hw]. MCST's 6.1-1.9 (commit
6a2673970ea0) has no lines 380-388 in `context_free`; 6.1-1.17
(d639a5da9813) added them ("to avoid double free"). A thread's own
context, created at its first `setcontext` or `swapcontext`
(`save_main_coroutine`, 911-947), holds a copy of the thread's hardware
stacks (254); the exit frees them through that context and again as
the thread's own. On the 4C, after a thread had only done `getcontext`
and `setcontext` to that point and exited normally, two of four new
contexts got the same stacks (one result wrong), and so did two new
threads (one computed 20 of 20 recursions wrongly); after a thread had
run a made context to its end, returned home and exited, two of four
new contexts did. The 8C2 and 2C3 gave distinct stacks and right
results in the same cases. ALT's newer `kernel-image-mcst-e4c` 6.1.180
package carries MCST's 6.1-1.17 `arch/e2k` ("Overflow signals" below),
so it has the fix [source].

**Threads that exit.** A thread's own context is keyed by the top of
its data stack (`context_current_key`, 164-178; `save_main_coroutine`).
At exit the kernel removes and frees whatever context the thread is
running (`hw_context_deactivate_mm`) [hw]:

| Case | Result |
|---|---|
| A made a context, ran it until it suspended, and exited; main resumes it | runs in main |
| A exits while main runs a context A made | the context goes on and returns to main |
| A makes the `exit` system call inside a made context | that context is gone (`freecontext_e2k`: `ENOENT`). A's own context stays in the table, suspended, with its hardware stacks. The next thread, which glibc put on A's stack (same key), failed its first switch with **`EEXIST`** (the insert at 935-939). After `freecontext_e2k` of the state A had saved (0), the thread after it switched normally |
| A calls `pthread_exit` inside a made context | glibc's unwinder reaches the end of the context's stack and longjmps to the thread's start (glibc `nptl/unwind.c:59-62, 102`), which the kernel does as a switch (`coroutine_switch_and_longjmp`, 1442-1512). A ends in its own context and the made context stays suspended (`freecontext_e2k`: 0). 8C2, 2C3: later threads on A's stack ran. 4C: the next one died at its first switch into a new context (SIGSEGV with the IP in its data stack, 5 runs of 5), which the double free above explains (inferred: it can give the thread and its first new context the same stacks) |
| `uc_link` names the state A saved; A has exited | the return found no context: `ESRCH`, the trampoline's exit status 3. When a new thread ran on A's old stack (same key), the return switched to that thread's own context at A's old position: SIGKILL on the 8C2 and 2C3; on the 4C the process went on |

**A thread that exits in a context with a `[signal stack]` unmaps it
twice** [source; hw]. A context's kernel record keeps the
`[signal stack]` it had when it was last switched out (1392), and the
thread takes it over when the context is switched in (1426); nothing
clears the record. When a thread exits in a context that had a
`[signal stack]` when it was last switched out (a made context that
took a signal before, or the thread's own context after the thread took
a signal and then switched out and back), the exit unmaps the thread's
copy at once (kernel `kernel/process.c:1931`), and a kernel worker
unmaps the record's copy again about an RCU grace period later
(`context_free`, 376-406; `context_free_work_fn`, 351-361;
`free_hw_context`, 299). The kernel maps `[signal stack]`s, like
hardware stacks, in the privileged area from `USER_HW_STACKS_BASE` up
(kernel `kernel/signal.c:655-672`, `include/asm/stacks.h:124`), so the
second unmap removes whatever it has mapped there in between. In the
test a new thread T3 took a signal right after `pthread_join`, waited
300 ms and took another (at least four runs on each machine):

| Case | 4C | 8C2 | 2C3 |
|---|---|---|---|
| B makes the `exit` system call in a made context that took a signal in A | T3's new `[signal stack]`, mapped at the freed address, was unmapped; T3's second signal killed the process (SIGSEGV) | a chain stack that had grown into the freed page during T3's first signal lost it; T3 ended without any signal after its wait, before its second signal, and the process went on (exit 0) | a chain stack that had grown into the freed page lost it; SIGSEGV |
| A takes a signal, switches into a made context and back, and exits | as above | the first page of T3's procedure stack was unmapped; SIGSEGV | the same; SIGSEGV (once a hang) |
| No contexts; or the context holding the `[signal stack]` stays suspended while its thread exits at home; or T3 starts 300 ms after the exit | T3 ran | T3 ran | T3 ran |

**How T3 ends without a signal on the 8C2** [source; the kernel logs
of these runs; inferred where marked]. When a system call returns, the
kernel puts back the caller's chain frames it took off the chain
register file: the hardware refills some and the kernel copies the rest
into the user's chain stack (`native_user_hw_stacks_prepare` and
`user_pcsp_stack_copy`, kernel `include/asm/copy-hw-stacks.h:486-519,
705-775`). The 4C and 8C2 refill only 8 frames (their kernels emulate
the missing `FILLC`: "CF FILL depth: 16 quadro registers" in the boot
log, `kernel/ttable.c:435-459`), the 2C3 up to 29 (`FILLC`;
`include/asm/cpu_regs_types.h:73`, `copy-hw-stacks.h:249-258`). On the
8C2 every run of the first case logged, with T3's thread id, "chain
stack could not be copied … to 0xc2e0_0000_d060 size 0x20", an address
in the lost page, then the same with size 0x120: a system call T3 made
after its wait (while reading `/proc/self/maps`) needed one 32-byte
frame copied there, the copy failed, and the kernel ended the thread
with `do_exit (SIGKILL)` (`copy-hw-stacks.h:772-774`). Only that thread
ends; no signal reaches the process, and `pthread_join` returns as for
a normal exit. The second line is the exit path's own full copy
(`kernel/process.c:1891-1896`). On the 2C3 a system call copies
nothing unless more than 29 frames are in the register file, so T3 went
on to its second signal; setting that up copies every frame the kernel
holds (`kernel/signal.c:1240-1241`), that copy failed (three log lines,
size 0xc0) and the process got SIGSEGV (inferred). So the same loss
ends one thread quietly or kills the process, depending on which kernel
exit first needs the lost page.

**Signals and contexts that move** [hw]:

| Case | Result |
|---|---|
| A signal sent (`pthread_kill`) to the thread running a context that came from another thread | the handler runs in that thread on the context's stacks, its local in `uc_stack` ("Signals in a made context") |
| A context's handler, in A, switches out; B switches to the handler's state | the handler goes on in B and returns there. `sigreturn` restores the context with its own mask and rounding mode: the interrupted state is in the context's `[signal stack]`, which the switch carries (1392, 1426). The process had one `[signal stack]` throughout |
| The same with `SA_ONSTACK` (the frame on A's alternate stack) | works, but B's `sigreturn` makes A's alternate stack B's own (`restore_altstack`, kernel `kernel/signal.c:513`) |
| The same, and A takes another `SA_ONSTACK` signal before B resumes the handler | A is no longer on its alternate stack (kernel `kernel/signal.c:1146`), so the new frame went at its top, over the suspended one. The first handler's locals changed, and its `sigreturn` gave the context A's mask instead of its own |

**fork** [hw; `hw_contexts_init`, 486-599]. The child gets the contexts
that were suspended at the fork; one that is running cannot be locked
for copying and is skipped (514-517). It also gets the forking thread's
current context (557-582).

- The child resumed and freed a suspended context; the parent's copy
  was unaffected (its local variable had its value from before the
  fork).
- `fork` inside a made context goes on in each process's copy of it.
- A context running in another thread at the fork is missing in the
  child: a switch to its saved state gives `ESRCH`, a free `ENOENT`.
  That thread's own context, suspended at the fork, is there.

**`longjmp` across contexts** [hw; 1442-1512, 836-901]. A `longjmp`
from B into a `jmp_buf` set in a suspended context switches B into that
context; B's own context is left suspended, reachable only through a
state B saved. A `longjmp` into a context running in another thread
kills the process (SIGKILL; 857-866, 893-899).

**Rules for a fiber library or a runtime such as libgo** (from the
above):

1. Give a suspended context to one thread only: publish it as runnable
   from the thread it switched to, after that switch has returned
   there, and never let two threads race to switch to it (treat
   `EBUSY` as a bug).
2. After a switch that may resume in another thread, reach TLS and
   `errno` only through an out-of-line function that the compiler
   cannot fold: with lcc a `noinline` one; with GCC one that returns
   the value, or a `noipa` one. Never keep a TLS address, a
   `__tls_get_addr` result or `&errno` across such a switch.
3. Free or remake (on the same stack) only a context that is suspended
   and that no thread will switch to.
4. Keep the threads that run contexts alive until the process exits. A
   thread that exits inside a context someone freed or remade, or in a
   context that had a `[signal stack]` when it was last switched out,
   corrupts later threads and contexts; on the 4C any exit after the
   thread's first switch does. A thread that must exit should end in
   its own original context, never inside a made one: an `exit` there
   leaves the next thread on its stack failing with `EEXIST`.
5. Point `uc_link`, and every saved state you will switch to, at
   contexts that outlive their use. Never use a state saved by a thread
   that may have exited.
6. Do not switch contexts from a handler running on an alternate stack
   if the context may resume in another thread or the thread may take
   another `SA_ONSTACK` signal first; such a handler should run on the
   context's own stack, with room left below each context ("Signals in
   a made context").
7. Never `longjmp` across contexts.
8. After `fork`, keep only the records of contexts that were suspended
   at the fork, plus the current one.

## Signals

**The frame goes directly below the interrupted `USD`** (the stack
pointer), rounded down to 256 bytes: **there is no red zone**, so code
must keep no data below its `USD` (kernel `kernel/signal.c:1137-1197`).
The `rt_sigframe` is **4,272 bytes** [hw]: over 16 stack pointers 16
bytes apart, the frame started 4,272 to 4,512 bytes below `USD` on all
three machines, so it is `round_down (USD − 4272, 256)`. That is the size
with `CONFIG_PROTECTED_MODE`, whose 16-byte-aligned members pad the
4,256-byte frame (kernel `include/asm/ucontext.h:62-83`; computed). It
holds 64 bytes for the handler's incoming arguments, `siginfo_t` (128
bytes) at +64 and `ucontext_t` (0xfd8 bytes) at +192 [hw: the handler's
`uc` is its `si` + 128], then the original return IP. If less than the
frame is free, the kernel grows the stack first, a thread's or a made
context's too (`signal.c:1169-1186`; "User contexts").

The handler is entered as if called from `[trampolines]+0x100`, with
`%dr0` = signal, `%dr1` = `&info` with `SA_SIGINFO`, else
`&uc.uc_mcontext`, and `%dr2` = `&uc` or 0 [hw: `sysabi.c` section 3],
and its stack top at the frame (kernel `kernel/signal.c:932-1040`). Its
window and chain frames go on the **thread's own hardware stacks**, also
with `SA_ONSTACK` (`signal.c:1064-1116`); in a made context they go on
the context's hardware stacks [hw: `abileft.c`; "User contexts"].

`%g16`–`%g31` read 0 with tag 5, the kernel's "empty" value [hw: read
with `gettagd` in an assembly handler before any compiled code, for
`tgkill` and for a timer signal, `ctxsig.c` section 3], and `%bgr` is
0xff (`signal.c:1271-1277`, `include/asm/tags.h:48`) [hw: `kernleft.c`
part 2, read by the handler's first instruction after code running
with 0x1ff, 0x2ff and 0x3ff; the frame's `bgr` held the interrupted
code's value; 4C, 8C2, 2C3]. Reading
the empty registers does not trap. A non-speculative `addd %dg16, 0`
gives 0 with tag 0, and a non-speculative `std` stores 0, which a
fill-MAS load reads back with tag 5. A diagnostic value, such as the
result of a failed speculative load, does trap a non-speculative `addd`
(`ILL_ILLOPN`), in a handler or not. An empty half has bit 30 clear and
a diagnostic one has it set ([speculation.md](../isa/speculation.md),
"Diagnostic values").

`ucontext_t` (glibc `sys/ucontext.h:268-278`, uapi `sigcontext.h`,
`ucontext.h`; offsets printed by `sysabi.c` section 10). The `mcontext_t`,
`gregset_t` and `NGREG` in glibc's `sys/ucontext.h` are SPARC leftovers:

| Offset | Field | Holds |
|---|---|---|
| 0x000, 0x008, 0x010 | `uc_flags`, `uc_link`, `uc_stack` | 0, null (set with `SA_SIGINFO`), `stack_t` |
| 0x028 | `uc_mcontext` (`struct sigcontext`, 0x628 bytes) | starts with `cr0_lo` (predicates) |
| 0x030 | `.cr0_hi` | **interrupted IP**, bits 3–47 (compiler-rt masks `(1 << 48) - 8`; glibc `sigcontextinfo.h`) |
| 0x038, 0x040, 0x048 | `.cr1_lo`, `.cr1_hi`, `.sbr` | window, `ussz`; data stack top |
| 0x050, 0x058 | `.usd_lo`, `.usd_hi` | **SP** = `usd_lo & ((1 << 48) - 1)` [hw] (compiler-rt `sanitizer_linux.cpp:2197-2201`; glibc's `GET_STACK` is 0) |
| 0x060–0x078, 0x080 | `.psp_*`, `.pcsp_*`; `.rpr_*` | hardware stack registers; translator only |
| 0x090, 0x098, 0x130 | `.nr_TIRs`, `.tir_lo[19]`, `.tir_hi[19]` | trap info registers (index of the last) |
| 0x1c8, 0x218, 0x268, 0x278 | `.trap_cell_addr`, `_val`, `_tag`, `_info` [10] | the trapped instruction's pending memory operations |
| 0x2c8, 0x3c8 | `.dam[32]`, `.sbbp[32]` | DAM (0 unless traced); last 32 branches |
| 0x4c8, 0x648 | `.mlt[48]`, `.upsr` | translator only |
| 0x650 | `uc_sigmask` | 128 bytes, the kernel uses 8 |
| 0x6d0 | `uc_extra` (`struct extra_ucontext`, 0x908 bytes) | |
| 0x6d4, 0x6d8 | `.curr_cnt`, `.tc_count` | trap cell being handled (−1 without a trap), count |
| 0x6dc–0x6e4 | `.fpcr`, `.fpsr`, `.pfpfr` | **0 in a signal frame**; only the context calls fill them |
| 0x6e8, 0x700, 0x708 | `.ctpr1`–`3`, `.sc_need_rstrt`, `.ctpr*_hi` (v6) | CTPRs; the interrupted call will restart |
| 0x720, 0x728 | `.chain_stack_offset`, `.proc_stack_offset` | positions for `access_hw_stacks` |
| 0x730–0x848 | `.bgr`, `.g[16]`, `.gtag`, `.gext`, `.gext_tag` | interrupted `%g16`–`%g31`, `%bgr` |
| 0x858–0xfd0 | `.lsr`, `.ilcr`, `.lsr1`, `.ilcr1` (v5), `.aad` … `.aasti` | loop and array prefetch state |

**Filled** (kernel `kernel/signal.c:155-343`): `uc_extra` is cleared;
stack and chain registers, `%g16`–`%g31` and the stack offsets are always
written. A signal from a trap also fills, for every task, the trap cells
(`[0..6]`: `HW_TC_SIZE` 7, `include/asm/ptrace.h:89`), `nr_TIRs`/`tir_*`,
`sbbp`, CTPRs, `%lsr`/`%ilcr` and the prefetch state. Without a trap
(`kill`, delivery after a system call) `nr_TIRs`, `tir_*[0]` and `sbbp`
are 0, `curr_cnt` −1, and the trap cells are stale stack contents.
`upsr`, `rpr_*`, `mlt` are written only for translator tasks (stale
otherwise). [hw, `sysabi.c` section 3: after `raise`, `nr_TIRs` 0,
`curr_cnt` −1, `tc_count` 0; after a load from 0x1000, `si_addr` 0x1000,
`nr_TIRs` 1, `curr_cnt` 0, `tc_count` 1 and `trap_cell_addr[0]` 0x1000.]
MCST's compiler-rt tells a write fault by bit 17 of
`trap_cell_info[curr_cnt]` (`sanitizer_linux.cpp:1942-1947`).

**`sigreturn`** (119) restores the interrupted state from the kernel's
own copy (kernel `kernel/ttable.c:2236-2290`, `signal.c:471-587`). From
the user frame it takes only `uc_stack`, `uc_sigmask`, `uc_extra.g`…
`gext_tag` and `bgr` (→ `%g16`–`%g31`, `%bgr`; not for translator tasks;
privileged descriptors refused) and, **only with `SA_SIGINFO`**,
`uc_mcontext.cr0_hi` as the IP to resume at. If the handler changed the
IP, the trapped instruction's pending memory operations are dropped
unless `uc_flags` has `UC_HANDLE_SIGRETURN_CELLAR` (1, uapi
`ucontext.h:14`) ([x86-support.md](../isa/x86-support.md)). Window
registers, predicates, `cr1`, `usd`, CTPRs, loop, prefetch and FP fields
in the frame are ignored [source]. Checked on hardware with an
`SA_SIGINFO` handler that edits its frame (`ctxsig.c` section 2; the 4C,
8C2 and 2C3 agree; `cr0_hi` not tried):

| Edited in the frame | After the handler returns |
|---|---|
| `uc_sigmask` (+ USR2, − HUP) | applied, after `tgkill` and after a timer signal |
| `uc_extra.g[0..2]` (`%g16`–`%g18`), `gtag[3] = 5` (`%g19`) | applied, tags included, when a timer signal interrupted user code (`%g19` came back with its value and tag 5). When the signal arrived at the end of a system call (`tgkill`, as `raise` sends it), `%g16`–`%g31` came back empty (0, tag 5) whatever the frame held, because the system call empties them ("System calls") |
| `uc_extra.fpcr`, `fpsr`, `pfpfr` (0 at entry) | ignored: the registers stay as the handler left them |
| `uc_mcontext.usd_lo` (−256) | ignored: the stack pointer is unchanged |
| `uc_mcontext.cr1_hi` (`br.rbs` 6 → 7) | ignored: `%b[0]` is the same register |
| nothing; the handler writes `%g16`–`%g19` before returning | after a timer signal the interrupted code gets its own values back; after `tgkill` they are empty (0, tag 5), as above |

More edits, each after a timer signal that interrupted user code [hw:
`kernleft.c` part 2; 4C, 8C2, 2C3]:

| Edited in the frame | After the handler returns |
|---|---|
| `uc_extra.bgr` (0x0ff → 0x37f: `cur` 3, `val` 0x7f) | applied: `%bgr` read 0x37f, and on the 4C and 8C2 `%g24` then named the register the code had used as `%g27`, as after a `rws %bgr`; the 2C3 renames nothing ([loops.md](../isa/loops.md), "Global register rotation") |
| every `g[i]`, `gtag[i]` (0, and 5 for two of them) and `gext[i]` | applied, tags included. `gext` became the 16-bit extension (what `movfi` reads) on the 4C and the whole high half of the 128-bit register on the 8C2 and 2C3 |
| a tag combination that `is_possible_qtag` rejects (`gtag[i]` holds register i's two 2-bit tags, bits 0–1 for the low half): tag 3 in the low half of an odd register (v3–v5), tag 2 in any half (v6) (kernel `include/asm/check_hw_ctx.h:13-28,58-67`) | `sigreturn` fails: the kernel logs "bad frame" and sends SIGSEGV (`SI_KERNEL`) at the interrupted IP (`kernel/ttable.c:2278-2284`). Each machine took the other's combination: `gtag[0]` = 2 came back in `%g16` on the 4C and 8C2, `gtag[1]` = 3 in `%g17` on the 2C3 |
| `g[3]` = 0x4444444444444444 with `gtag[3]` = 5 (bit 30 set in both halves: diagnostic) | accepted; the first non-speculative use of `%g19` was SIGILL `ILL_ILLOPN`. So a frame can give `%g16`–`%g31` tags that `puttagd` refuses to make ([semantics.md](../isa/semantics.md), tag operations) |

The frame's `g[]` holds the values `%g16`–`%g31` had when the code was
interrupted. After `tgkill` these are the values from before the system
call, which the program never sees again.

**The rotating globals in the frame** [hw: `kernleft.c` part 2; source].
The kernels of the 8C2 and 2C3 (MCST's 6.1-1.17 and 6.1-1.18) save
`%g24`–`%g31` after setting `%bgr` to 0x0ff (`include/asm/trap_table.S.h:199-300`),
so `g[8 + j]` is the register that `cur` 0 names `%g(24 + j)`, not the
one the interrupted code named so: on the 8C2, code running with `cur`
1 had its `%g31` in `g[8]`, and `sigreturn` put every value back (`cur`
1, 2 and 3, ten runs each); spinning 100 ms without a signal (the case
described for the 4C below) left them in place in ten runs. The 2C3
does not rename. **The 4C moves
them**: with `cur` c, `g[8 + j]` held what `cur` 0 names
`%g(24 + ((j − c) & 7))`, and after `sigreturn` the code's `%g(24 + n)`
held what it had put in `%g(24 + ((n − c) & 7))`: with `cur` 1, `%g24`
held the old `%g31` (26 of 27 runs over `cur` 1–3; in the other, with
`cur` 2, the frame was as on the 8C2 and the values came back in place).
Left for 100 ms with no signal while a second thread waited to end the
loop, the same code found its values moved by 1–3 places in 5 of 9 runs
and in place in 4, so kernel entries without a signal move them too,
not every one (inferred). The 4C's kernel (MCST's 6.1-1.9, commit
6a2673970ea0, `include/asm/trap_table.S.h:141-239` there) saves
`%g16`–`%g31` with privileged `strd` stores before it sets `%bgr` to
0x0ff, under the interrupted code's `%bgr`; 6.1-1.17 moved the save of
`%g24`–`%g31` after the write. That alone would put the code's own
`%g(24 + j)` in `g[8 + j]`, which is not what the 4C showed, and a
user-mode `std` of `%dg24`–`%dg31` under `cur` 1–3 stores the same
registers an ALU read sees (4C, 8C2), so the mechanism is not known;
`strd` cannot be tried from user mode, and ALT's newer 6.1.180 package,
which carries 6.1-1.17's `arch/e2k` ("Contexts and threads"), was not
tried. lcc never touches `%bgr`, so only code that rotates the globals
itself is affected.

**The FP control registers are not saved or restored around a handler**
[hw]: a handler starts with the interrupted code's rounding mode and
flags, and whatever it sets stays after it returns, for `raise` and for a
timer signal that interrupts a loop (`sysabi.c` section 1: the
interrupted code had rounding upward and inexact; the handler saw both,
set rounding toward zero and overflow, and the interrupted code then ran
with those). `%pfpfr`, `%fpcr` and `%fpsr` are kept only at context
switch (kernel `include/asm/ptrace.h:294-298`, `kernel/fpu.c:22-43`,
`include/asm/regs_state.h:1029,1129`). x86-64 Linux, by contrast, gives a
handler a fresh FP state and restores the interrupted one. So a handler
that does FP work under its own settings must save and restore them
(`fegetenv`/`fesetenv`), and a compiler may not assume the FP
environment is unchanged across a point where a signal can arrive unless
handlers behave. (Faults in lcc's speculative code arrive as SIGILL:
[source-compat.md](source-compat.md), "Signals".)

**Extended register parts**: with `setwd nfx = 1` a signal can clear
the extended parts of the interrupted function's window registers: the
16-bit part of an 80-bit value and, on v5+, the high half of a 128-bit
register. On the 8C2 and 2C3 every handler that ran while one was held
cleared it (0). On the 4C a handler did so when its frames pushed the
interrupted window out of the register file (a handler that recursed,
a 96-pair interrupted window), and otherwise in about one signal in
1,200. Page faults without a signal and system calls (a blocking
`nanosleep` too) kept the 16-bit part; without any signal, 1 of 2,000
and 4 of 4,000 holds of 2 million cycles still lost it on the 4C and
8C2 (none of 3,000 on the 2C3). The 128-bit high half on the 8C2 came
through switches while the frames below the function stayed in the
register file, but after a deep call had returned, context switches
lost it in 2,983–2,999 of 3,000 holds, timer interrupts alone in about
300, and a blocking `nanosleep` too [hw: `tools/abi/probes/foldi55.c`
`ctx`, `sys`; 8C2]. Extended values in `%g16` and `%g20` survived the
SIGSEGV handlers, shallow and recursing (the frame's `gext` restores
them), and with `nfx = 0` nothing was lost [hw:
`tools/abi/probes/pocabi2.c` `ext`; 4C, 8C2, 2C3;
[registers.md](registers.md), `nfx`, has the counts]. So code that holds
an extended value in a window register needs `nfx = 0`, as lcc's does.
Which kernel step clears them was not traced.

**Alternate stacks** [hw, `sysabi.c` section 2]:

- `sigaltstack` refuses less than 4,096 bytes (ENOMEM; the kernel's
  `MINSIGSTKSZ`, uapi `signal.h:88`). glibc's `sysconf (_SC_MINSIGSTKSZ)`
  is 2,048 (no `AT_MINSIGSTKSZ`), and so is the `MINSIGSTKSZ` macro
  without `_GNU_SOURCE`: the size glibc calls the minimum is refused.
  `sysconf (_SC_SIGSTKSZ)` and `SIGSTKSZ` are 8,192; with `_GNU_SOURCE`
  (`_DYNAMIC_STACK_SIZE_SOURCE`) both `SIGSTKSZ` and `MINSIGSTKSZ` become
  `sysconf (_SC_SIGSTKSZ)`, 8,192 (glibc
  `sysdeps/unix/sysv/linux/bits/sigstack.h:27-30`, `bits/sigstksz.h`,
  `sysconf-sigstksz.h`, `dl-parse_auxv.h:36-39`).
- The kernel rounds the base up and the size down to 256 and puts the
  frame **4,352 bytes below the rounded top**; the handler's own frame
  follows. The kernel never grows an alternate stack: if the frame does
  not fit, or the handler runs off the bottom, the process dies with
  SIGSEGV (`expand_user_data_stack(): user data stack overflow`, or
  `setup signal rt frame failed`, in the kernel log). With a base 176
  bytes past a 256-byte boundary, 4,736 bytes ran a small handler and
  4,096, 4,608 and 4,672 died. `SIGSTKSZ` leaves about 3,600 bytes for
  the handler.
- Only the data stack switches: the handler's windows and chain frames
  still go on the thread's hardware stacks.

## Stacks

### Hardware stacks

Each thread and each context has a procedure stack (spilled windows) and
a chain stack (32-byte frames, [stack-and-unwinding.md](stack-and-unwinding.md)),
mapped privileged from `USER_HW_STACKS_BASE` up (kernel
`kernel/process.c:394-470`, `include/asm/stacks.h:118-127`):

| | Procedure stack | Chain stack | Source |
|---|---|---|---|
| Limit (glibc / kernel number) | `RLIMIT_P_STACK` 10001 / 16 | `RLIMIT_PC_STACK` 10002 / 17 | glibc `bits/resource.h:117-120`; kernel `include/asm/rlimits.h:15-16`, `kernel/sys_e2k.c:81-118` |
| Default soft / hard limit | 128 MiB / 128 GiB | 8 MiB / 128 GiB | kernel `include/asm/rlimits.h:9-10`, `kernel/setup.c:503-508`; hw (`/proc/self/limits` lists them as "Max procedure stack size" and "Max chain stack size") |
| Initial size | 16 KiB | 4 KiB | hw (`/proc/self/maps`: `[procedure stack]`, `[chain stack]`, also a 4 KiB `[signal stack]`); also each context's (`makecontext_e2k`, "User contexts") [hw] |
| Per call | 32 bytes × `wbs` (the caller's pairs below the callee) | 32 bytes | hw: with a 1 MiB limit, 8,208 nested calls at `wbs = 4` (128 bytes each) and 32,784 by the chain stack |

`getrlimit`/`setrlimit`/`prlimit64` map 10001/10002 to 16/17.
`RLIMIT_STACK` (the data stack) is 16 MiB on all three machines. A
stack that overflows traps; the kernel grows it by 11/8 (at least a page)
up to the soft limit, moving the procedure stack anywhere above the base
and the chain stack only upwards (old chain areas are kept for `longjmp`)
(kernel `mm/fault.c:1354-1396, 1601-1724`).

**Running out kills the process with SIGKILL** [hw]: recursion until
either stack reaches its limit (1 MiB, or the defaults) ends with
SIGKILL, and a SIGSEGV handler, even on an alternate stack, never runs.
The kernel logs `chain stack overflow (out of memory?)` or `procedure
stack overflow (out of memory?)`: the overflow is found while copying the
user's stacks at a kernel entry, and that path ends in `do_exit
(SIGKILL)` (kernel `include/asm/copy-hw-stacks.h:575-610, 771-774`; the
SIGSEGV of `kernel/traps.c:1220-1240` is for a bounds trap the kernel
cannot handle). With the defaults the chain stack runs out first, at 262,160
nested calls (8 MiB / 32, plus a few). A runtime that must
survive deep recursion has to count depth itself or raise the limits;
it cannot recover from a signal as it can on x86. Both limits are
independent of `ulimit -s`.

**A new thread's hardware stacks start at the creator's current size**
[hw]: after the main thread recursed 100,000 deep (procedure stack
12.4 MiB, chain stack 3.8 MiB), a new thread got stacks of the same sizes
(`sysabi.c` section 4; kernel `kernel/process.c:688-693, 1811`:
`copy_thread` sizes them from a copy of the parent's thread info).

**Access.** User loads and stores can't reach these stacks; the system
calls can (uapi `e2k_syswork.h:30-48`, kernel
`kernel/e2k_syswork.c:2882-3070`). `long access_hw_stacks (unsigned long
mode, unsigned long long *frame_ptr, char *buf, unsigned long buf_size,
void *real_size)` (254):

| Mode | Does |
|---|---|
| 4 `E2K_GET_CHAIN_STACK_SIZE`, 5 `E2K_GET_PROCEDURE_STACK_SIZE` | used size into `*real_size` (chain: + 32, a frame for the current function) |
| 6 `E2K_READ_CHAIN_STACK_EX`, 7 `E2K_READ_PROCEDURE_STACK_EX` | copy `buf_size` bytes from offset `*frame_ptr` (chain frames in the v6 format) |
| 8, 9 `E2K_WRITE_PROCEDURE_STACK_EX`, `E2K_WRITE_CHAIN_STACK_EX` | write at an offset (libgcc stores the landing pad's `%db[0]`/`%db[1]`) |
| 3 `E2K_GET_CHAIN_STACK_OFFSET`, 10 `E2K_READ_CHAIN_STACK_NATIVE` | offset of a chain address (also in a moved area); chain stack in the CPU's format |
| 0, 1, 2 | deprecated reads (EPERM on v7), write from the base |

Chain frames read with mode 6 carry only the predicates (`pf`), the IP,
`ss`, `wbs`, `wpsz`, `ic`, `br`, `wdbl` and `ussz`. `wfx` always reads
0 [source: kernel `kernel/e2k_syswork.c:2560-2590`; hw: frames of
functions with `setwd nfx = 0` and `nfx = 1` both read 0]. A frame that
returns into the trampoline page reads `pm` = 1 and `wbs` = 0 [hw:
`tools/abi/probes/hwscan.c` section 5, the frame below a signal
handler]. Mode 7 copies keep the memory tags [hw: `hwscan.c`, read back
with the fill MAS]. A diagnostic register's slot has tag 5 in the
user's buffer, and on v5+ the second slot (the upper 64 bits) of every
register written by an ordinary 64-bit operation reads 0 with tag 5. An ordinary load returns a
tagged word as a plain number ([speculation.md](../isa/speculation.md),
"Spill and fill"), so C code can scan the copy without trapping.

The kernel spills the stacks itself (no `flushr`/`flushc` needed). A
conservative garbage collector finds callers' register values only
through modes 5 and 7, and Boehm GC does exactly this; the layout
differs between v1–v4 and v5+ [hw:
[stack-and-unwinding.md](stack-and-unwinding.md), "Scanning for
roots"]. `access_hw_stacks` works on the calling thread's or
context's own stacks only: no mode takes a thread or a context
(`kernel/e2k_syswork.c:2887-2911`; [hw, `stackregs.c` section 5]:
inside a `makecontext_e2k` context modes 4 and 5 report that context's
stacks). A collector therefore cannot reach the spilled
windows of a parked context or of another thread; each has to copy its
own, as Boehm GC's stopped threads do in their signal handlers
(inferred). The registers that locate the stacks (`%psp`, `%pshtp`,
`%pcsp`, `%pcshtp`, `%usd`, `%sbr`), what they tell a collector, and
why split stacks are impossible are covered in
[stack-and-unwinding.md](stack-and-unwinding.md), "Stack registers".

`long get_backtrace (unsigned long *buf, size_t count, size_t skip,
unsigned long flags)` (253) returns the return addresses of the caller's
callers, skipping `skip` more and the trampoline frames ("just return"
frames read −1; `flags` must be 0); `set_backtrace` (252) replaces them,
only with addresses in the same file and with the same permissions
(kernel `kernel/backtrace.c:20-100, 160-260`). MCST's unwinder lands in a
catching frame with `set_backtrace`
([stack-and-unwinding.md](stack-and-unwinding.md), "Signal frames").

From a signal handler [hw, `ctxsig.c` section 4; the 4C, 8C2 and 2C3
agree], `E2K_READ_CHAIN_STACK_EX` shows, from the top: the handler and
its callees; one frame whose return address is `[trampolines]+0x100`,
with `cr1.pm` set in the copy and `wbs` 0, `br` 0; then **the
interrupted function's frame, whose return address is the interrupted
instruction itself**. For a timer signal that is an instruction inside
the loop it interrupted. For `raise` it is the instruction after the
`call` of the `tgkill` system call in libc. Then come the callers as
usual. The bottom frame (return address 0) also has `pm` set. In a
context made by `makecontext_e2k`, `makecontext_helper`'s frame is
followed by one returning into `[trampolines]+0x400` (`pm` set, `wbs`
4) and two frames with return address 0.

`get_backtrace (buf, n, 0, 0)` starts with the return address of the
function that calls it, leaves out the `[trampolines]+0x100` frame and
continues with the interrupted frame. `skip` 1 drops the first entry.
Inside a context it ends with a 0 entry (the frame below `+0x400`), so a
reader must stop at 0. glibc's `backtrace` reads the chain stack itself
(glibc `backtrace.c`). It starts one entry earlier, at its caller's own
call site, and keeps the trampoline frames (`[trampolines]+0x100`,
`+0x400`).

### The data stack: growing the main thread's stack costs a walk of the chain stack

On v1–v6, and on v7 CPUs with `CPU_HWBUG_RRD_USINCR`, a `getsp` that
takes the stack pointer below the part of the stack that `USD` covers
traps, even when the memory below is mapped. The kernel then grows
`USD` by **that `getsp`'s amount rounded up to a page, and by at least
16 KiB**, however much was still free, but never beyond a total of
`RLIMIT_STACK` (`kernel/getsp.c:229, 303-306`, `USER_C_STACK_BYTE_INCR` in
`include/asm/stacks.h:129`, `mm/fault.c:1075, 1082`). It then rewrites
the user-stack size (`cr1_hi.ussz`) of **every frame in the chain
stack** (kernel `kernel/traps.c:1148-1186` `parse_and_handle_getsp`,
`mm/fault.c:1037-1172` `expand_user_data_stack`, `:949-967`
`fix_all_chain_stack_sz`). Other v7 CPUs report the amount in
`%usincr`, grow by it with the new bottom rounded down to a page, and
skip the chain walk. [hw, `stackregs.c` section 6; the 4C, 8C2 and 2C3
agree]:

| Main thread | Growth |
|---|---|
| a recursion 20,000 deep with 32-byte locals | 51 growths; the 7 printed were 16,368–16,416 bytes apart and left `0x3fd0`–`0x3ff0` bytes free |
| `alloca (200000)` with about 130 KiB free (`0x209d0` on the 4C) | free size up by 200,704 (49 pages) |
| `alloca` of 1 MiB, of 3 MiB, with less free | by exactly the amount |

So the first time a recursion goes deep, one level per 16 KiB of data
stack traps, and each trap walks all the levels above it: the number of
traps and the length of each walk both grow with the depth, so the cost
is quadratic [hw, `sysabi.c` section 4, a function with a 32-byte
frame]:

| | 4C | 8C2 | 2C3 |
|---|---|---|---|
| First descent to 250,000 levels: seconds per 25,000 levels, first and last block | 0.46 … 9.40 | 0.27 … 4.98 | 0.21 … 4.68 |
| The whole first descent | 49 s | 26 s | 24 s |
| The same descent again | 0.01 s | 0.007 s | under 0.005 s |
| In a thread (its whole stack is mapped up front) | 0.09 s | 0.03 s | 0.03 s |
| In the main thread after one 12 MiB frame was taken and released | 0.08 s | 0.03 s | 0.03 s |
| Recursion without a data-stack frame (assembly), 200,000 levels | 0.07 s | 0.03 s | 0.03 s |

The hardware stacks grow geometrically and cost little; the data stack is
the problem, and only in the main thread, only the first time. A program
or runtime that expects deep recursion can take one large frame early
(an `alloca` of the expected size, touched and released) so that the
kernel hands out the stack in one step. A compiler cannot avoid it: any
function with a data-stack frame `getsp`s.

### Threads [source, except where marked]

| Call | Arguments | Data stack | Source |
|---|---|---|---|
| `clone` (120) | `(flags, stack, ptid, ctid, tls)`; glibc needs a non-null stack | from the stack pointer down to the start of its mapping, both ends aligned to 256, at most 4 GiB − 1 | kernel `kernel/process.c:1603-1660, 1777-1799`; glibc `clone.S` |
| `clone_thread` (229), glibc `clone2 (fn, stack_base, stack_size, flags, arg)` | `(flags, stack_base, stack_size, ptid, ctid, tls)` | the given area | kernel `kernel/process.c:1276-1300`; glibc `clone2.S`, `Versions:8` |
| `clone3` (426), `vfork` (190) | generic | given / the parent's | glibc `vfork.c` |

With `CLONE_VM` the new thread gets its own hardware stacks (kernel
`kernel/process.c:1806-1828`), as large as its creator's at the time
[hw, above]. A thread's data stack is mapped whole: its `USD` covers
the whole mapping above glibc's guard page from the start, so a
thread's recursion never traps [hw, above; `stackregs.c` section 4: the
bottom is the start of the mapping]. `%sbr` in a thread is its top
rounded down to a page: [stack-and-unwinding.md](stack-and-unwinding.md),
"Stack registers". Threads that share user contexts, and what a
thread's exit after context switches does to later threads: "Contexts
and threads" above.

**Overflow** [hw: `abileft.c` part 3; the 4C, 8C2 and 2C3 agree apart
from addresses, except that the 4C reports `SEGV_ACCERR` where the
others report `SEGV_BNDERR`: an older kernel, "Overflow signals"
below]. The kernel grows a thread's `USD` as a
context's ("User contexts"): by the `getsp` amount, at least 16 KiB,
but never beyond a total of `RLIMIT_STACK` (`mm/fault.c:1075`). A
thread of the default size (16 MiB, as `RLIMIT_STACK`) has 5,888 bytes
of that left, and that was its step; a second overflow would fail
(computed). The kernel accepts the `getsp` whenever its new bottom lies
in a mapping, whatever that holds, and no hole lies between mappings
that end below the stack's top (`mm/fault.c:1105-1127`; "User
contexts"). The memory below a glibc stack is always mapped: the kernel
hands out `mmap` space bottom-up, first fit from `mmap_base` (kernel
`mm/mmap.c:101`), so glibc's stack mapping, guard page first, starts
where an earlier mapping ends (inferred from the code). In every run
the page below the guard belonged to an anonymous mapping of 40 to
52 KiB (in some runs it began with a `link_map`, so ld.so had allocated
it).

So only glibc's one-page `PROT_NONE` guard
(`OpenE2K/glibc/nptl/pthread_attr_init.c:46`) catches an overflow, and
only when the frame's first store falls in it. A frame larger than the
guard that is filled from its low end (an array, `alloca`, a VLA)
writes the mapping below first. A 96 KiB frame changed about 36 KiB of
that mapping, just above ld.so's data segment, before its stores
reached the guard; the SIGSEGV handler ran, and its first lazily bound
call (`_exit`) died with SIGILL `ILL_ILLOPN` in `_dl_fixup` (gdb on the
4C; SIGILL on all three; with `LD_BIND_NOW=1` the run ended normally).
A guard larger than the largest frame (`pthread_attr_setguardsize`)
catches such a frame, and so do stores every 4 KiB made page by page
as the frame is allocated ("Probing", below). lcc 1.29.16 and 1.31.05
accept `-fstack-clash-protection` and `-fstack-check` and emit the same
code as without them [lcc].

With `pthread_attr_setstack`, `USD` covers the given stack and
everything below it down to the start of its mapping (the `clone` row
above), so give such a stack a mapping of its own or a `PROT_NONE` page
below it. A `getsp` fails, with SIGSEGV at the old bottom − 1
(`kernel/traps.c:1132-1141`), only when its new bottom is unmapped or a
hole lies between mappings that end below the stack's top (kernel log:
`jumped over a hole`). In the main thread `[stack]` grows with `USD` up
to `RLIMIT_STACK`, and the failing `getsp` gives the same SIGSEGV.
`[stack]` ends at the stack's top, so the hole check never sees the gap
below it: a single `getsp` that reaches past the gap into another
mapping is accepted. The gap then stays unmapped: the kernel finds the
mapping that holds the new bottom and extends nothing
(`find_extend_vma_locked`, `linux/mm/mmap.c:2214-2219`), and a fault never
grows `[stack]` ("Overflow signals" below), so a store into the gap
gets `SEGV_MAPERR`. A SIGSEGV handler on an alternate stack ran in
every case:

| Stack | Below it | Frames | Result |
|---|---|---|---|
| glibc, 64 KiB | one-page guard | 4 KiB | the `getsp` is accepted (the bottom 16 KiB down, in the mapping below the guard); then `SEGV_ACCERR` in the guard; nothing below it changed |
| glibc, 64 KiB | one-page guard | one of 96 KiB, filled upward | the `getsp` is accepted (the bottom 96 KiB down: in ld.so's data on the 4C, in its text on the 8C2 and 2C3); about 36 KiB of the mapping below the guard changed, then `SEGV_ACCERR` at the guard's first byte; then SIGILL (above) |
| glibc, 64 KiB | 128 KiB guard | one of 96 KiB | `SEGV_ACCERR` in the guard; nothing below it changed |
| glibc, default (16 MiB) | one-page guard | 4 KiB | after 4,062 levels a step of 5,888 bytes (into the mapping below the guard), then `SEGV_ACCERR` in the guard |
| `pthread_attr_setstack`, 64 KiB in a 1 MiB mapping | the rest of the mapping | 4 KiB, 64 levels | no signal and no trap: `USD` covered the whole mapping from the start; 204,448 bytes below the stack changed |
| `pthread_attr_setstack`, 64 KiB | a `PROT_NONE` page, then mapped | 4 KiB | `SEGV_ACCERR` in the guard; nothing below it changed |
| the same | the same | one of 96 KiB | 36,064 bytes below the guard changed, then `SEGV_ACCERR` at its first byte |
| `pthread_attr_setstack`, 64 KiB | 64 KiB `PROT_NONE`, then mapped | 4 KiB; one of 96 KiB | `SEGV_ACCERR` in the guard; nothing below it changed |
| `pthread_attr_setstack`, 64 KiB | a `PROT_NONE` page, then unmapped | 4 KiB | the `getsp` fails (kernel log: `user data stack overflow`) |
| `pthread_attr_setstack`, 64 KiB | a `PROT_NONE` page, a 64 KiB hole, then mapped | one of 96 KiB | the `getsp` fails: the guard's mapping ends below the stack's top, so the kernel sees the hole |
| `pthread_attr_setstack`, 64 KiB | one unmapped page, then mapped | 4 KiB | the `getsp` is accepted (the bottom 16 KiB down); `SEGV_MAPERR` in the hole |
| main thread, `RLIMIT_STACK` 2 MiB | unmapped | 4 KiB | the bottom moved 16 KiB every 4 levels and `[stack]` grew with it to exactly 2 MiB; after 507 levels the `getsp` failed |
| main thread, `RLIMIT_STACK` 16 MiB | unmapped | 64 KiB | the same at 16 MiB (255 levels) |
| main thread | a gap of about 3 MiB, then a 1 MiB mapping | one of about 3.75 MiB | the `getsp` is accepted with the bottom inside that mapping; about 638 KiB of it changed, then `SEGV_MAPERR` at its top, in the gap |

**Probing** [hw: `tools/abi/probes/callsstack_clash.c` with
`callsstack_clash.s`; the 4C, 8C2 and 2C3 agree apart from addresses,
except that a refused `getsp` gives `SEGV_ACCERR` on the 4C, as above].
Stores every 4 KiB make a one-page guard enough for one large frame, as
GCC's `-fstack-clash-protection` does on other targets. Two schemes
were tried: **one `getsp`** of the whole frame, then a store every
4 KiB from the frame's top down; and **page by page**, `getsp -4096`
and a store at the new stack pointer, repeated. Each run then filled
the frame from its bottom up, as above:

| Stack | Below it | Frame and probes | Result |
|---|---|---|---|
| glibc, 64 KiB | one-page guard | 96 KiB: one `getsp` and a store every 4 KiB, or page by page | `SEGV_ACCERR` in the guard; nothing below it changed |
| the same | the same | 96 KiB, one `getsp`, a store every 8 KiB | by the frame's phase against the guard: as above, or no probe in the guard, and the probes and the fill wrote all 35,296 bytes between the frame's bottom and the guard (17,737 of them changed value: the fill's upper halves are zero, as was most of that memory), then `SEGV_ACCERR` at the guard's first byte |
| the same | the same | 1 MiB, one `getsp` | the `getsp` is refused (SIGSEGV at the old bottom − 1): its bottom lay past the 40 KiB mapping below the guard (unmapped or past a hole; not determined) |
| `pthread_attr_setstack`, 64 KiB | a 4 KiB `PROT_NONE` guard, then 2 MiB mapped | 96 KiB or 1 MiB, one `getsp` and a store every 4 KiB; 1 MiB page by page | `SEGV_ACCERR` in the guard; nothing below it changed |
| the same | the same | 1 MiB, one `getsp`, a store every 8 KiB | by phase: as above, or 985,568 bytes below the guard written, then `SEGV_ACCERR` at its first byte |
| the same | the same | 96 KiB, one `getsp` and no store, then a register-only loop under a 100 µs SIGALRM timer, the handler on the thread's stack | no SIGSEGV: the handler ran 39,696 bytes below the guard's start, and 3,146 bytes there changed (3,148 on the 8C2 and 2C3) |
| main thread | unmapped | 1 MiB, one `getsp`, a store every 4 KiB | runs normally: the `getsp` grows `[stack]` |
| main thread | a gap of about 3 MiB, then a 1 MiB mapping | one `getsp` to 768 KiB below the mapping's end, a store every 4 KiB | the `getsp` is accepted; the first probe below `[stack]`'s start gets `SEGV_MAPERR` in the gap; the mapping is untouched |
| the same | the same | page by page | a `getsp` is refused (SIGSEGV at the old bottom − 1) between 1 MiB and 1 MiB + 16 KiB above the mapping (4, 8 and 12 KiB over on the 4C, 8C2 and 2C3); the mapping is untouched |

So:

- **The probe interval must not exceed the guard** (the 8 KiB rows).
- **A `getsp` is no probe.** It touches no memory, and the kernel
  accepts it whenever its new bottom lies in a mapping (bottoms 35 KiB
  and 985 KiB below a guard were accepted; only the stores faulted).
- **Allocate page by page wherever a signal can come between the
  allocation and its probes.** The kernel writes each signal frame
  right below `USD` ("Signals"), so after one large `getsp` a signal
  lands below the guard (the timer row). Page by page, `USD` is never
  more than a page below a probed word.
- **In the main thread the gap below `[stack]` catches the probes.** A
  `getsp` into a lower mapping extends nothing (above), so the first
  probe below `[stack]` faults. Page by page, each `getsp` grows
  `[stack]` through `expand_downwards`, which keeps `stack_guard_gap`
  (256 pages, 1 MiB) free above the next mapping (`linux/mm/mmap.c:2091-2099,
  2164`); the kernel grows `[stack]` in 16 KiB steps from its start, so
  the refusal comes up to 16 KiB above that gap.

Not covered (inferred, not tested):

- **Calls probe nothing.** An E2K call stores nothing on the data stack
  (its state goes to the chain and procedure stacks), and the runs above
  cover one large frame whose top lies within a page of memory already
  touched. Frames smaller than the probe interval that never store to
  their own memory can add up past the guard; GCC's model counts calls
  as implicit probes on x86 (the pushed return address:
  `ix86_adjust_stack_and_probe`, `gcc/config/i386/i386.cc:8278-8283`)
  and AArch64 (the saved LR, with a 1 KiB caller guard:
  `STACK_CLASH_CALLER_GUARD`, `gcc/config/aarch64/aarch64.h:101`)
  [source: GCC master `ea32419e8c4`].
- **A signal frame is larger than a page**: 4,272 bytes (above), so with
  `USD` less than 176 bytes above a one-page guard part of the frame
  lies below the guard. Whether the kernel writes that part before it
  faults on the guard depends on the order of its copies (it writes the
  frame in many separate copies, `kernel/signal.c:383-414` and
  others).

Page-by-page allocation costs more only the first time the main
thread's stack grows, because the kernel steps in at each `getsp` that
leaves the part `USD` covers ("The data stack" above). Time of the first
frame in a fresh process, with an 8-byte-store fill of the frame, three
runs [hw: `callsstack_clash cost`; not measured on the 8C2]:

| Frame | 4C: one `getsp`, probes | 4C: page by page | 2C3: one `getsp`, probes | 2C3: page by page |
|---|---|---|---|---|
| 64 KiB | 0.26 ms | 0.25 ms | 0.08 ms | 0.08 ms |
| 1 MiB | 3.7–3.8 ms | 4.5–4.6 ms | 1.18–1.30 ms | 1.47–1.48 ms |
| 4 MiB | 10.9–11.1 ms | 18.5–19.1 ms | 3.5–3.6 ms | 6.1–6.2 ms |

A second frame of the same size costs about the same either way (4 MiB:
5.7–5.8 ms on the 4C, 2.1–2.2 ms on the 2C3).

### Overflow signals [hw: `accerr.c`; 4C, 8C2, 2C3]

What a SIGSEGV handler is told when a program runs off its data stack,
beside plain bad accesses. Each case ran in a child process with the
handler on an alternate stack, frames filled from the top down; how far
each stack grows first is in "Threads" and "User contexts" above.
`SEGV_MAPERR` is 1, `SEGV_ACCERR` 2, `SEGV_BNDERR` 3.

| Case | `si_code` | `si_addr` | Kernel path |
|---|---|---|---|
| A load or store to an unmapped page, or to address 0x40 | `SEGV_MAPERR` | the address | no mapping: `vma_lookup` fails (`mm/fault.c:3809-3814`) |
| A load or store to a `PROT_NONE` page; a store to a read-only page | `SEGV_ACCERR` | the address | `access_error` (`mm/fault.c:3210-3240, 3615-3617`) |
| A load or store 64 bytes below the main thread's `[stack]`, no `getsp` | `SEGV_MAPERR` | the address | as unmapped: the fault path only looks the address up (`vma_lookup`) and never extends a stack mapping; only a `getsp` grows one |
| A load or store in glibc's guard page, directly or from frames whose `getsp` the kernel accepted past it | `SEGV_ACCERR` | the first access in the guard | as `PROT_NONE` |
| A store into an unmapped hole that an accepted `getsp` spans (one unmapped page, then a mapping, below a `pthread_attr_setstack` stack or a made context) | `SEGV_MAPERR` | that store | as unmapped |
| A `getsp` the kernel refuses to grow the stack for: nothing mapped below a `pthread_attr_setstack` stack or a made context; a `PROT_NONE` page, then nothing; a `PROT_NONE` page, then a hole; the main thread at `RLIMIT_STACK`. A literal amount (a fixed array) and a register one (`alloca`) alike | **`SEGV_BNDERR`** on the 8C2 and 2C3, **`SEGV_ACCERR`** on the 4C | **the interrupted `USD`'s bottom − 1**, the first byte below the stack, even when that byte is in a `PROT_NONE` page. At `RLIMIT_STACK` the kernel first grows the stack to exactly the limit, so this is `[stack]`'s top − the limit − 1 | `expand_user_data_stack` fails (`mm/fault.c:1037-1172`), then `force_sigsegv_expand_stack` (`kernel/traps.c:1132-1141`) |
| A `getsp` whose amount the kernel cannot read (in `%g8`, 4 MiB: [stack-and-unwinding.md](stack-and-unwinding.md), "User stack") | `SEGV_BNDERR` | the `getsp` instruction | `GETSP_OP_FAIL`: `S_SIG` with the trap's `TIR.ip` (`kernel/traps.c:1178`, `include/asm/traps.h:24-38`) |
| The chain stack beyond `RLIMIT_PC_STACK` | SIGKILL; no handler runs | – | "Hardware stacks" above |

With `SEGV_BNDERR`, `si_lower` and `si_upper` are 0: the kernel sends
these with `force_sig_fault`, not `force_sig_bnderr`. The kernel log
records a refused growth of a thread's or a context's stack, rate
limited: `expand_user_data_stack(): user data stack overflow: stack
bottom …, top …, sp …, free size …` or `… jumped over a hole …-… or
inconsistent VM_GROWSDOWN flag` (`mm/fault.c:1104-1127`). It records
nothing for the main thread at `RLIMIT_STACK`, whose path has only a
debug print (`mm/fault.c:1075-1080`).

**The 4C's `SEGV_ACCERR` comes from its older kernel** [source; hw:
the `%g8` case]. In MCST's 6.1-1.9 tree (commit 6a2673970ea0) the same
function is named `force_sigsegv_array_bounds` and sends `SEGV_ACCERR`
(`arch/e2k/kernel/traps.c:1174-1183` there); 6.1-1.17-open (d639a5da9813)
renamed it and sends `SEGV_BNDERR`, with the same address (MCST's
#100842 in the comment: "the first byte below the stack"). The
unreadable amount gives `SEGV_BNDERR` in both trees (`:1224` in 1.9),
and the 4C reports `SEGV_BNDERR` for it, so the two kernels differ only
in that one constant. The growth checks of `expand_user_data_stack`,
the page-fault codes and every other case above are the same on all
three machines. The kernel configuration plays no part: the function has no
`#if`, and the three kernels' stack, guard and VMA options are the same
(`/proc/config.gz`). ALT ships MCST's tree unchanged: the
`kernel-image-mcst-e4c-6.1.180-alt1.17.1` source package that ALT's
e2k Sisyphus now carries ("updated to 6.1-1.17 mcst source tree") has
the same `arch/e2k`, `mm` and `kernel/signal.c` as d639a5da9813
[source: the package unpacked and compared]. So an updated 4C will
report `SEGV_BNDERR` too (inferred).

A SIGSEGV handler that wants to recognise a data stack the kernel
would not grow should therefore accept both codes, or better, compare
`si_addr` with the interrupted stack's bottom, `uc_mcontext.usd_lo`'s
pointer (bits 0–47) minus `usd_hi`'s size (bits 32–63) ("Signals",
the frame table; [stack-and-unwinding.md](stack-and-unwinding.md),
"Stack registers"): a refused growth reported exactly bottom − 1 in
every case, and no other case did [hw]. On 6.1-1.9 a refused growth
whose bottom − 1 lies in a guard page has the code and an address of a
store into the guard; only that comparison separates them (inferred).

## Address space [hw, `sysabi.c` sections 6 and `maps`]

| Item | 4C, 8C2 | 2C3 | Source |
|---|---|---|---|
| Layout | upper (`CONFIG_MMU_SEP_VIRT_SPACE` off) | 512 GiB lower (on: every v6+ kernel and every kernel not built for one CPU model) | kernel `Kconfig:584-586`, `include/asm/pv_info.h:21-37` |
| `TASK_SIZE` | 0xd000_0000_0000 | the same | `include/asm/pv_info.h:21-28` |
| `[cut]` (compilation unit table page) | 0xc2ff_ffff_e000 | 0xc27f_ffff_e000 | `include/asm/stacks.h:21-38` |
| Hardware stacks from (`[procedure stack]`, `[chain stack]`, `[signal stack]`) | 0xc2df_ffff_e000 | 0xc25f_ffff_e000 | `include/asm/stacks.h:118-124` |
| Main stack: top below | 0xc2de_ffff_e000, minus up to 8 MiB at random | 0xc25e_ffff_e000, the same | `include/asm/stacks.h:131`, `include/asm/uaccess.h:252`; `linux/mm/util.c:296` |
| `mmap`, shared libraries, `ld.so`, static PIE | from 0x4555_5560_0000 plus up to 1 TiB at random (seen 0x4569…–0x4652…) | the same | `include/asm/processor.h:57-60`, `mm/mmap.c:53-140`, `Kconfig:335-339` |
| PIE executables | 0x8aaa_aaaa_a000 plus the same random offset (seen 0x8ac0…–0x8ba9…) | the same | `include/asm/elf.h:245`; `linux/fs/binfmt_elf.c:1178-1225` |
| Static PIE's `brk` heap | from 0x8aaa_aaaa_a000 plus a little (seen 0x8aaa_aaaf…–0x8aaa_ac43…), while its image is in the `mmap` area | the same | `linux/fs/binfmt_elf.c:1186-1216` |
| Non-PIE executables (lcc's default), static or not | 0x10000 | the same | binutils `ld/emulparams/elf_e2k.sh:3` |
| Pages; ld `MAXPAGESIZE` | 4 KiB, huge 2 MiB and 1 GiB; 0x1000 | the same | `include/asm/page_size.h:14-43`; binutils `bfd/elf64-e2k.c:147` |
| Stack and `brk` heap permissions | `rw-p`, never executable by default. The stacks become executable only through a `PT_GNU_STACK` with `PF_X` (the executable's at `exec`, or a library's when ld.so loads it) or through `mprotect` ([elf.md](elf.md), "Executable stack"). `exec` never sets `READ_IMPLIES_EXEC` | the same | `include/asm/page.h:319-320`; `linux/fs/exec.c:810-820`, `linux/include/linux/elf.h:9-14`, `linux/mm/mmap.c:3137` [hw: `/proc/self/maps` of a program without `PT_GNU_STACK` (`tools/abi/probes/execstack.sh --remote`); saved on the 8C2, checked by hand on the 4C and the 2C3] |

MCST's sanitizers assume an older layout: a fixed maximum user address
0xc2ff_ffff_ffff, the stack below 0xc2df_ffff_f000, the heap from
0x4555_5555_6000, PIE images at 0x8aaa_aaaa_a000 (compiler-rt
`sanitizer_linux.cpp:1057-1059`, `msan/msan.h:219-262`); on the 2C3's
lower layout even the stack is outside their map. In practice only MSan
breaks, and only on the lower layout, where it refuses to start; on the
upper layout the 6.1 ranges fit its table, and ASan and LSan work on
both ("Sanitizers") [hw].

**User pointers use bit 47.** PIE images and the main stack lie above
0x8000_0000_0000; all user addresses are below 2⁴⁸. Schemes that assume
47-bit user pointers (x86-64-style tagging, 47-bit NaN-boxing) break; 48
bits work. MCST LSan's `p >> 47 == 0` (compiler-rt
`lsan_common.cpp:139-141`) loses nothing, since it only filters
candidate heap pointers and its heap lies below 2⁴⁷ ("Sanitizers").

## Time [hw, `sysabi.c` section 7]

`%clkr` (`rrd %clkr`, user mode) counts the core's cycles, and the
counters of different cores are not synchronised on the 4C (four
processors: CPU 1 and CPU 15 read about 1.7 × 10¹² and −1.4 × 10¹²
cycles from CPU 0) or on the 2C3 (CPU 1 reads −7.5 × 10¹³ from CPU 0).
The 8C2's eight cores (one processor) agree within 30 cycles. A thread
that migrates sees `%clkr` jump, so `%clkr` measures intervals only on a
thread pinned to one core; time across cores comes from
`clock_gettime` (costs above).

## Profiling (`-pg`) [hw: `pgprof.c`]

lcc 1.29.16 at `-O3 -pg` starts every function, leaves included, with
[lcc]:

```
{ setwd wsz = 0x8, nfx = 0x1, dbl = 0x0
  setbn rsz = 0x3, rbs = 0x4, rcur = 0x0
  disp  %ctpr1, _mcount; ipd 2
  getsp,0 _f32s,_lts1 0xfffffff0, %r2 }  ; a 16-byte frame
{ nop 3
  rrd,0 %cr0.hi, %b[0] }                  ; frompc, not masked to 48 bits
{ call %ctpr1, wbs = 0x4 }               ; R_E2K_DISP, also with -fPIC
```

glibc's `_mcount (u_long frompc)` is a `noinline` C function that takes
`selfpc` from its own `%cr0.hi`, the address after the call in the
profiled function (glibc `sysdeps/e2k/machine-gmon.h:28-34`). lcc links
`gcrt1.o` for `-pg` and `grcrt1.o` for `-pg -static-pie`; the sysroot
also has `Mcrt1.o`. lcc rejects `-finstrument-functions` [lcc]. The
kernel's ftrace finds and patches this call sequence in its own objects
([kernel-build.md](kernel-build.md), "ftrace"). On all
three machines a `-pg` program, dynamic and static PIE, writes
`gmon.out`, and the system's `gprof` prints the right call counts and
callers (500 calls of `leaf`, 400 from `twice`, 100 from `main`).

## Sanitizers [lcc: `sanitize.c`; hw: `abileft-san.c`]

lcc's valid `-fsanitize=` values are `address`, `leak`, `memory`, `all`
(`thread` is refused; `undefined` is accepted and adds nothing), and it
links `-lcompiler_rt.asan` and the like from its tree:

| | ASan | MSan |
|---|---|---|
| Shadow | `(a >> 3) + 0x7fff8000` (`shrd`, then `ldb …, 0x7fff8000`); compiler-rt `asan/asan_mapping.h:152-158, 234` | `(a & ~0xc00000000000) ^ 0x200000000000`; origin + 0x280000000000 (`msan/msan.h:263-264`) |
| Calls | `__asan_report_load4`, `__asan_report_store8`, …; `__asan_init`, `__asan_register_globals` from a `.ctors.65487` constructor; stack redzones poisoned inline | `__msan_init`, `__msan_warning_noreturn`, `__msan_param_tls`, `__msan_retval_tls`, `__msan_poison_stack` |

The runtime is MCST's compiler-rt 11.1.0 (Apache-2.0 with LLVM
exceptions, `LICENSE.TXT`). Its E2K changes: no fast unwinder (return
addresses are in the chain stack; `sanitizer_stacktrace.h:23-26`), the
instruction before a return address is `pc - 8` (`:88-92`), PC and SP
from `cr0_hi` and `usd_lo` as above, write faults from the trap cell. A
GCC port sharing it needs `TARGET_ASAN_SHADOW_OFFSET` 0x7fff8000.

**On hardware** [hw: `abileft-san.c`, each machine's lcc 1.29.16, with
and without `-fPIE -pie`, every case once per build; MSan also started
20 times on the 4C and the 8C2]:

| | ASan (`address`) | LSan (`leak`) | MSan (`memory`) |
|---|---|---|---|
| Starts | on all three | on all three | on the 4C and 8C2; **never on the 2C3** (exit 77, below) |
| Reports, with file and line | heap overflow (also in a thread), use after free, stack overflow, global overflow, a leak at exit; exit status 1 | a leak at exit; exit status 23 | a branch on an uninitialised heap or stack value (also in a thread); exit status 77 |
| A block held only in a register of a live frame | **reported as a leak** | **reported as a leak** | |

On the 2C3's lower layout MSan stops at startup with `FATAL: Memory
range 0x8baaaaaaa000 - 0xc2cfffffffff is not available` and
`MemorySanitizer can not mmap the shadow memory`. Its table calls that
range invalid and reserves it (`msan/msan.h:219-262`,
`msan_linux.cpp:137-153`), but on that layout it holds the main stack,
the hardware stacks, `[trampolines]` and `[cut]` ("Address space").
MSan's own allocator takes 0.5 TiB wherever `mmap` finds room
(`msan_allocator.cpp:64-78`): in the runs it landed in MSan's
"dsos-and-heap" range or in its "pie-code-and-data" range (at
0x8aae_aaac_0000, or above a PIE image), and every run worked. That range ends at 0x4655_5555_6000 while the
`mmap` area's random base goes up to 0x4655_5560_0000, so with the
largest offsets the libraries would lie in a range MSan reserves and it
would not start (inferred; not seen).

**LSan reports blocks held only in registers as leaks.** A 160-byte
block whose only pointer was in a window register (`%r2`) of a function
four calls up was reported by `__lsan_do_recoverable_leak_check`, and a
224-byte block held so by a thread still blocked when `main` returned
was reported at exit, on all three machines and in every build. Blocks
held by a global (also in a PIE) or by a data-stack slot (also the
blocked thread's) were found. LSan scans the data stacks, TLS, globals
and the registers that `PTRACE_GETREGS` returns (`lsan_common.cpp:225-319`,
`sanitizer_stoptheworld_linux_libcdep.cpp:511-515, 540-559`). On E2K
those are `%g0`–`%g31` and control registers, no window registers
(kernel `include/asm/user.h:26-204`), and it never reads the procedure
stack, which holds the callers' windows
([stack-and-unwinding.md](stack-and-unwinding.md), "Scanning for
roots"). So leak checks made during a run, and the exit check for
threads still alive, report such false leaks (inferred).

The 47-bit pointer test (`lsan_common.cpp:139-141`) loses nothing. The
ASan and LSan primary allocators are fixed at 0x6000_0000_0000
(`asan_allocator.h:150`, `lsan_allocator.h:80`; small blocks seen at
0x602…–0x603…) and large blocks are `mmap`ed below 2⁴⁷ (0x455…–0x465…).
PIE globals and the stacks above 2⁴⁷ are still scanned: the test only
filters the values found there.

## Static PIE [hw]

lcc links `-static-pie` with `rcrt1.o`, `crtbeginS.o`, `-static -pie
--no-dynamic-linker` and `-lgcc -lgcc_eh -llcc -lmvec -lc` [lcc]:
`ET_DYN`, no `PT_INTERP`, no `DT_RELACOUNT`; `.rela.dyn` holds
`R_E2K_64_RELATIVE`, some `R_E2K_NONE` (112) and some all-zero entries
(type 0 is `R_E2K_32_ABS`), which glibc skips because their offset is 0
(glibc `sysdeps/e2k/dl-machine.h:492-503`). Such programs run on all
three machines, loaded in the `mmap` area (above).

**`-pie` and `-static-pie` do not imply `-fPIE` in lcc** [lcc]: code
compiled without it uses absolute 64-bit literals, so `lcc -pie` links a
PIE with `DT_TEXTREL` (ld warns) and `lcc -static-pie` fails ("read-only
segment has dynamic relocations"). Pass `-fPIE` as well, as GCC's
drivers expect anyway. A static link with an ifunc crashes ld
([elf.md](elf.md)).

## Not checked yet

- `sigreturn` with an edited `uc_mcontext.cr0_hi` (resuming elsewhere).
- Where the 8C2's and 2C3's kernels set `%lsr` to 0xff0000000000 at
  `exec` (not found in 6.1-1.19's source), and where the 4C's
  0x6000000000 with `%ilcr` 9 comes from ("Process entry"; nothing a
  compiler relies on).
- `dlopen` of a library that needs an executable stack from a static
  program, whose `__libc_stack_end` is NULL ("Process entry").
- Stack-clash probing ("Threads", "Probing"): small frames that never
  store to their memory adding up past a guard (an E2K call probes
  nothing); a signal arriving while `USD` is less than 176 bytes above
  a one-page guard; the cost of page-by-page growth on the 8C2.
- Entries 2, 9, 13–15 and 19–31, which the trap table does not name
  ("Disabled entries").
- Why the 4C's kernel entries move `%g24`–`%g31` under a nonzero
  `%bgr.cur`, and whether ALT's newer 4C kernel still does ("Signals",
  "The rotating globals in the frame").
- Whether the 4C hands the 16-bit extensions of `%g16`–`%g31` from one
  process to the next: in `kernleft.c` part 2, the frames of later
  children held extensions (0x7e06, 0x7e09, 0x7e0e, 0x7e0f) that an
  earlier sibling had put there through its own frame, and values none
  of them wrote; on the 8C2 and 2C3 the frames' `gext` read 0 with tag 5.
