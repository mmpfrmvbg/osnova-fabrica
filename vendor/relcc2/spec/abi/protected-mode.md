# Protected mode (`-mptr128`, e2k128)

**For completeness only: the GCC port targets 64-bit unprotected mode.**
Elbrus protected mode (MCST: *режим безопасных вычислений*, secure
computing mode) runs C and C++ with every pointer replaced by a 128-bit
hardware descriptor that carries the object's bounds and is marked by
memory and register tags. lcc builds it with `-mptr128`; the kernel runs
it as a separate kind of process with its own loader, system call
entries and C library (`/lib128`). What a 64-bit compiler needs from this
document is short: the descriptor operations below fault in a 64-bit
process ([semantics.md](../isa/semantics.md), "Memory, tag and
descriptor operations"), and protected and 64-bit objects cannot be
linked into one program ("lcc", `-mptr128-64`; guide 9.1.3). v7 changed
every format here and is out of scope; the layouts are those of v3–v6.
32-bit mode is in [mode32.md](mode32.md).

Marks as in [README.md](README.md). **kernel** paths are relative to
`OpenE2K/linux/arch/e2k/` (6.1-1.19), **glibc** paths to
`OpenE2K/glibc/` (2.35-29.023), **binutils** paths to
`OpenE2K/binutils-gdb/` (2.41-29.023); line numbers are those of the
submodules' current commits. **guide** is chapter 11 (the model), 9
(segments, calls) and 10 (operations) of MCST's programming guide.

Probes, in `tools/abi/probes/protected/` (`run.sh --remote HOST
[--ssh-port N] [--static TARGET]` builds and runs `pmasm`, `pmcxx` and
`pmrun`, then `pmrun`'s malloc cases under each `PM_*` setting and its
system call cases with the kernel's soft mode on and off; `run.sh …
--left` builds and runs `pmleft`, `pmomp`, `pmmin` and, where there is
a `/lib128`, the shared-library probes):

| Probe | What it shows |
|---|---|
| `pmcc.c` | read with `lcc -mptr128 -S`: the calling convention, how lcc makes and uses pointers, globals and function addresses, TLS, atomics, `intptr_t` |
| `pm6464.c` | read with `lcc -mptr128-64 -S`: what that option makes |
| `pmrun.c` | run, each case in its own child: data layout, pointer images, bounds, tags, integer casts, use after free, stack escapes, calls, varargs, system calls, signals, threads |
| `pmasm.c` | run: `%core_mode`, raw `getsap`, `aptoap`, `aptoapb`, `getva` results, `%usd`, stack pointers stored outside their frame, procedure labels |
| `pmcxx.cc` | run: C++ exceptions, virtual calls, containers, member pointers |
| `pmleft.c` | run: `usd` when `rrd %usd.lo` sees a `getsap` (under the machines' timing lock); `cud` `cudtoap`, `gdtoap`, `ldcud*`, `%cud`/`%gd` and the `rw` field of every kind of AP; `clean` the `clean_descriptors` system call; `mremap` a moving `mremap` with and without the dangling-pointer mode; `psl` recursion until `%usd.psl` overflows |
| `pmlib.c`, `pmdl.c`, `pmlibmain.c`; `pmlibxx.cc`, `pmlibxxmain.cc` | run: user shared libraries built with `-mptr128 -shared` (data, function pointers, callbacks, TLS, `%cud`/`%gd` in a library, `dlopen`/`dlclose`; C++ across the boundary) |
| `pmomp.c` | run: OpenMP |
| `pmmin.s` | run: a hand-written static protected program, linked as ELF64 and, through `objcopy`, as ELF32 |

**hw** here means the same result on the three machines:

| Machine | Kernel | Programs |
|---|---|---|
| 8C2 (v5) | 6.1.0-1.17 (Elbrus Linux 9.5.5) | built there by the machine's lcc 1.29.16 (`-O1`) against its `/lib128` (glibc 2.35-29.023) |
| 2C3 (v6) | 6.1.0-1.18 (Elbrus Linux 9.5.5) | the same |
| 4C (v3) | 6.1.158-mcst-e4c-alt1.9.1 (ALT Linux: no `/lib128`) | static, built on the host by lcc 1.29.16 `e2k-v3` against its sysroot's `usr/lib128/libc.a` (glibc 2.35-29.018) |

All three kernels are built with `CONFIG_PROTECTED_MODE` (and
`CONFIG_COMPAT`). Where the machines differ, the row says why: the CPU
(v5 or v6), the kernel or the C library.

## The model (guide 11)

- Pointers become **descriptors**: base address, object size and the
  offset in the object, 128 bits, 16-byte aligned, marked by hardware
  tags (guide 11.2, 11.3).
- A descriptor can only come from the kernel (memory from `mmap`, so
  `malloc`), from the current stack frame (`getsap`), by narrowing
  another descriptor (object to sub-object), or from the module's
  globals descriptor (guide 11.2). An integer cannot become a pointer.
- The hardware checks every access through a descriptor against its
  bounds, traps on the use of data read from uninitialised memory, and
  traps on dereferencing anything that is not a whole, correctly tagged
  descriptor (guide 11.4).
- Source code must not convert integers to pointers or assume
  `sizeof (void *)` equals `sizeof (long)` or `sizeof (double)`; a
  single object is limited to 2³² bytes, "temporarily" (guide 11.4;
  lib128's `malloc` stops at 2³¹: "The runtime (lib128)").
- The guide's example (`gp[-1] = 14` on a `malloc`'d array) dies with
  "Segmentation fault" only under `-mptr128` (guide 11.6); its code uses
  `getsap`, `stap*`, `movtq`, `aptoapb` and `ldgdq`/`stgdq` (guide 11.7).

## Tags (guide 11.3; kernel; hw)

Every 32-bit half of a register or of memory has a 2-bit tag (memory
keeps them in ECC bits, guide 11.3); a doubleword's tag is 4 bits, bits
0–1 the low half's ([semantics.md](../isa/semantics.md), "Tag
operations"). The values that occur:

| Doubleword tag | Meaning | Where |
|---|---|---|
| 0x0 | number | integers, floats, `NULL`, a pointer made from an integer |
| 0x5 | empty (both halves tag 1, bit 30 clear) | memory `malloc` hands out, filled with `0x0bad0bad0bad0bad` (glibc `sysdeps/unix/sysv/linux/e2k/e2k128/malloc-uclibc.h:1095-1127`) [hw: `pmrun` `f_uninit_heap_long`: "tag 5 raw bad0bad0bad0bad"] |
| 0xF, 0xC | low and high doubleword of an array pointer (quad tag 0xCF) | every data pointer (kernel `include/asm/tags.h:32-36,57`) [hw] |
| 0xA | procedure label on v1–v5 (one doubleword) | function pointers on the 4C and 8C2 (`tags.h:29,50`) [hw] |
| 0xF, 0xF | procedure label on v6 (quad tag 0xFF) | function pointers on the 2C3 (`tags.h:61`) [hw] |

**Loads keep tags, and empty values trap.** A protected load returns
memory's tags (an `ldapd` of `malloc`'d memory gives tag 5), and using
that value is SIGILL `ILL_ILLOPN` [hw: `pmrun` `f_uninit_heap`,
`f_uninit_heap_long`]. In a 64-bit process ordinary loads drop memory
tags and an empty value is read as a number
([speculation.md](../isa/speculation.md), "Diagnostic values"). lib128
writes its empty values with `stapd,sm`, because a plain store of one
"could result in exc_illegal_operand" (glibc `malloc-uclibc.h:1104-1106`).

A descriptor stays intact only when it is moved whole: in a register
pair (`movtq`) or as an aligned 16-byte memory access (guide 11.3). [hw:
`pmrun`]:

- A **doubleword load of either half of an array pointer returns the
  bits with tag 0** (every pointer dump: "ldapd: 0,0"). A v5 procedure
  label, one doubleword, keeps its tag 0xA; a v6 label's halves read as
  tag 0.
- A pointer rebuilt from its two halves read as integers
  (`f_halves_copy`), from the halves of two different pointers
  (`f_halves_mix`), after integer arithmetic on either half
  (`f_halves_arith`, `f_hi_arith`), or byte by byte (`f_bytecopy`) is
  untagged or partly tagged; using it is **SIGILL `ILL_ILLOPN`**.
- A pointer stored at an address that is 8 mod 16 does not fault but
  loses its tags; the value read back is SIGILL `ILL_ILLOPN` at use
  (`f_misaligned_ptr_store`). lib128's `memcpy` keeps tags when source
  and destination are 16-byte aligned (`f_memcpy`), not when both are 8
  mod 16 (`f_memcpy_misaligned`). Struct assignment keeps them
  (`f_memmove_struct`).
- `movtd` turns a tag-3 half into tag 0 (semantics.md), so lcc copies
  pointers with `movtq` [lcc].

## Descriptor formats (v3–v6)

### Array pointer (AP) (kernel `include/asm/e2k_ptypes.h:28-67`; hw)

| Doubleword | Bits | Field |
|---|---|---|
| low (tag 0xF) | 47–0 | base address |
| | 58–48 | 0 (bit 58: see "Stack pointers") |
| | 60–59 | `rw`: 1 read, 2 write (`R_ENABLE`, `W_ENABLE`) |
| | 63–61 | `itag`: 0 for an AP |
| high (tag 0xC) | 31–0 | `curptr`: the signed offset from base (lcc's pointer arithmetic) |
| | 63–32 | size in bytes |

[hw: `pmrun` "ptr"] `malloc (40)` gives low `0x1800000050a24060`, high
`0x0000002800000000` (`rw` 3, size 0x28, `curptr` 0); `p + 3` (`int`)
changes only `curptr`, to 0xc; `p - 1` has `curptr` `0xfffffffc`.

**Only `cudtoap` makes a read-only AP.** Every other pointer has `rw` =
3 [hw: `pmrun`; `pmleft cud` "rw" lines, all three]: pointers to
`const` objects and string literals, `malloc`, `alloca` (`getsap`),
`gdtoap`, and everything the kernel hands out (`argv`, `envp` and their
strings, `mmap` with `PROT_READ`, with `PROT_NONE` or of a file opened
`O_RDONLY`, a mapping after `mprotect (PROT_READ)`, a handler's
`siginfo` and `ucontext`). The kernel builds its APs with `RW_ENABLE`
(`MAKE_AP`, kernel `include/asm/uaccess.h:1581-1583`); its only
`R_ENABLE` ones (`kernel/binfmt_elfe2kp.c:232-245`) are compiled only
without `ARGS_AS_ONE_ARRAY`, which `include/asm/prot_loader.h:13`
defines. No lcc option or builtin sets `rw`, and `aptoapb` and
`__builtin_e2k_create_ap_subarray` keep it [hw: `c_cudap_narrow`,
`c_cudap_builtin`]. So a write through a `const` pointer is stopped by
the page, not by the descriptor (SIGSEGV `SEGV_ACCERR` at the data
address: `f_strlit_write`, `f_const_write`).

`cudtoap`'s AP covers the module's code with `rw` = 1, read only [hw:
`pmleft` `c_cudap_*`, all three]. A load through it works (`ldapd`
returns the code, tag 0); **a store through it is SIGSEGV `SEGV_ACCERR`
with `si_addr` the `stapd` itself**, before the page is reached: the
descriptor check `exc_access_rights`, exception 18 (kernel
`kernel/traps.c:179`, `:1309-1314`). System calls hardly look at `rw`:
`write` checks that its buffer is readable (`R_ENABLE`: kernel
`kernel/protected_syscalls.c:2012`, `include/asm/protected_syscalls.h:524-537`),
which every AP is, and nothing checks `W_ENABLE` on a buffer
(`check_buffer_is_writeable` has no caller). So `write (fd, cudap, 16)`
writes 16 bytes and `read` into it fails with `EFAULT` only because the
page is `r-x`. Otherwise only `mprotect` (a `prot` beyond the AP's
rights prints a warning, SIGABRT with `PROTECTED_MODE_SOFT=0`:
`protected_syscalls.c:5074-5080`, `include/asm/protected_syscalls.h:288-292`)
and `mremap` (the new AP keeps the old `rw`: `protected_syscalls.c:2705`)
read it (source only: an `mprotect` that would make code writable was
not tried).

An access of N bytes at `p + i` is allowed when `0 ≤ curptr + i` and
`curptr + i + N ≤ size`. Moving `curptr` out of range is allowed; using
the pointer then is not (`arith p+100`, `f_oob_*`).

### Stack pointers

The kernel also defines a *stack array pointer* (SAP: bits 31–0 an
offset in the stack's 4 GiB window, 47–32 `psl`, the procedure stack
level; `e2k_ptypes.h:37-40`), meant to stop pointers into a frame from
outliving it. **None of our machines makes one: the kernel turns stack
pointer checks off.** It sets `%core_mode.no_stack_prot` ("no check stack
pointers", kernel `include/asm/cpu_regs_types.h:1126-1129`) at boot on
every CPU before v7 (`kernel/e2k_syswork.c:1844-1855`, "bug 115090"),
and a protected process reads it as set [hw: `pmasm` "core_mode": 0x2 on
the 4C and 8C2, 0x26 on the 2C3; the same values as a 64-bit process,
[lcc-builtins.md](lcc-builtins.md)]. Only root can clear it, through the
sysctl `debug.no_stack_prot`, which rewrites `%core_mode` on every CPU
(`OpenE2K/linux/kernel/sysctl.c:2529-2546`, `:2597-2605`; kernel
`kernel/e2k_syswork.c:1825-1842`); it reads 1 on all three machines
[hw: `/proc/sys/debug/no_stack_prot`, owner root, mode 0644]. So
`getsap` returns an ordinary AP with the full 48-bit address [hw:
`pmasm` `getsap -32: lo=1800c2defffed9c0 hi=0000002000000000 tags=f,c`
on the 8C2], and a stack pointer stored
into a global, the heap or an older frame, returned from its function
or used after its frame is gone never faults (`pmrun` `f_stack_to_*`,
`f_return_local`; `pmasm` `c_sap_*`, also with raw `getsap` results); the
dead frame reads stale data.

**What the checks would do** is known only from the kernel source. A
SAP stored into global memory would (inferred, from the name) raise a
page fault whose type has the `global_sp` bit (kernel
`include/asm/mmu_types.h:429`, `:481`); 6.1-1.19 treats that as
impossible, warns once and sends SIGBUS `BUS_MCEERR_AO` at the data
address ("Hm? we refused to use sap in HW and SW", `mm/fault.c:2469-2475`).
The software that once tracked such stores (`do_global_sp`,
`lw_global_sp`, `mark_all_global_sp`, `delete_records` and a
`global_store_t` record, `include/asm/3p.h:16-67`) is declared but
defined nowhere (inferred: removed). The kernel still keeps `psl`
right across `longjmp` (`kernel/signal.c:1787-1805`) and `ptrace`
(`kernel/ptrace.c:358-367`).

**Bit 58.** On the 2C3 an AP made by `getsap` (so every pointer lcc
makes to a local, through `aptoap`/`aptoapb`) or by `cudtoap` has bit 58
set (`0x1c00c25e…`, `0x0c00…`); APs from `gdtoap`, `malloc`, `mmap` and
the kernel (`argv`, `envp`, `siginfo`, `ucontext`, though these lie on
the stack) don't, and on the 4C and 8C2 none does [hw: `pmleft cud`,
`pmasm`]. The registers these two operations start from have bit 58 set
in a protected process: `%usd.lo` (`p`: kernel
`include/asm/cpu_regs_types.h:280`, set by `new_pusd_v6`,
`include/asm/cpu_regs.h:715-722`) and `%cud.lo` (`c`:
`cpu_regs_types.h:84-87`, set for every module: `new_cud_v6`,
`cpu_regs.h:869-879`, called with `c` = 1 from `kernel/process.c:819`);
`%gd` has no such bit. So (inferred) v6 copies bit 58 of the source
register into the AP and v3–v5 clear it. Nothing in the kernel reads
bit 58 of an AP (its layout leaves bits 48–58 unused,
`e2k_ptypes.h:31-35`; the AAU's descriptor calls its bit 58 `ed`,
`include/asm/aau_regs_types.h:90`); what it means is not known.

`%usd` itself has the SAP layout in a protected process: bits 31–0 the
stack pointer, 47–32 `psl`, 58 `p`
([stack-and-unwinding.md](stack-and-unwinding.md), "Stack registers")
[hw: `pmasm`: `usd.lo` `0x1c000008fffed9e0` in a function,
`0x1c000009fffed960` in its callee: `psl` counts calls].

**`psl` overflows at 0xffe0.** In a new thread (which the kernel starts
at `psl` 1: `kernel/process.c:1789`) level n of a recursion has `psl` =
n + 2 [hw: `pmleft psl`, sampled from level 1 to 65,500, all three].
The call that would take `psl` past 0xffe0 is **SIGSEGV
`SEGV_BNDERR`** with `si_addr` the `call` instruction: 65,502 levels
below the thread's start function. It is the `psl` value, not a stack
size: a function with a 28-pair window and a 464-byte frame reaches the
same 65,502 levels, and a recursion in the main thread (`main` runs at
`psl` 8 in a dynamic program, 5 in a static one) stops when `psl`
reaches 0xffe0 too (65,494 levels on the 8C2 and 2C3, 65,497 static on the 4C)
[hw: `pmleft psl`, `c_psl_big`, `c_psl_main`, all three]. Up to v6 the
kernel raises `exc_user_stack_bounds` only on a `psl` over- or
underflow and sends this signal (`kernel/traps.c:1210-1217`); an
array-bounds fault would give the same signal (`:1178-1180`), so which of
the two the hardware raises is inferred. 64-bit programs have no such
limit ([kernel-interface.md](kernel-interface.md), "The data stack":
250,000 levels). Why the limit is 0xffe0 and not 0xffff is not known.

**A `rrd %usd.lo` issued one or two cycles after a `getsap` returns the
value from before it; from three cycles on, the new one** [hw: `pmleft
usd`: 2,000 samples per distance 1–8, 10, 12, 16, 24 in each of 12
or more passes on each machine, all alike; [timing.md](../isa/timing.md),
"Hazards"]. It is a fixed delay: a second `getsap` in the next
instruction sees the first (the two areas are 32 bytes apart; inferred:
it waits, as a `getsp` after a `getsp` does), and an `aptoapb` of the
result in between makes the read see it. The two cannot share an
instruction: gas places a `getsap` in ALC0 whichever channel is
written, and `rrd` runs only in ALC0 ("attempting to place several
instructions into ALC0"). lcc's prologues end with a `getsap`, so a
read of `%usd` two instructions into a function sees the frame without
it (`usd_pair`'s first read differs from a settled one in all but at
most one of 2,000 samples in the 8C2 and 2C3 builds where lcc put the
prologue's `getsap` two instructions before it, and never in the 4C
build, where it is 5 cycles before): this is (inferred) the 64-byte
step an earlier `pmasm` showed for a 32-byte `getsap`.

### Procedure label (PL) (kernel `e2k_ptypes.h:150-193`; hw)

| CPU | Value | Tags |
|---|---|---|
| v1–v5 | one doubleword: bits 47–0 the code address, 59 `pm` (privileged), `itag` 0; the pointer's high doubleword is 0 | 0xA, 0 |
| v6 | low: the code address, bit 59 `pm`, `itag` 1 (bits 63–61); high: bits 15–0 the module's CUT index (`cui`) | 0xF, 0xF |

[hw: `pmasm` `c_pl`] the PL of a static function is low
`0x0000000050203ea0`, high 0, tags `a,0` on the 8C2, and low
`0x2000000050187e58`, high `0x2` (`cui` 2), tags `f,f` on the 2C3.
`__builtin_e2k_get_ap_base` of a v6 PL returns the code address; the
value `__builtin_e2k_get_ap_curptr` returns for one traps where it is
used (SIGILL `ILL_ILLOPN` inside `printf`: `f_fnptr_dump`; (inferred:) it
keeps the high half's pointer tag).

## Operations

What lcc 1.29.16 uses them for [lcc: `pmcc.c` for `e2k-v3`, `v5.8c2`,
`v6.2c3`] and what they do in a protected process [hw: `pmasm` and
`pmleft`]. In a 64-bit process they fault
([semantics.md](../isa/semantics.md);
[operations-v3.md](../isa/operations-v3.md)).

| Operation | In protected mode |
|---|---|
| `getsap -N, dst` | allocates N bytes on the user stack (moves `%usd`) and returns an AP to them, size N [hw]. lcc: one for the outgoing argument area and one for each group of addressed locals, in the prologue; `alloca` |
| `aptoap src, off, dst` | the part of `src` from `curptr + off` to its end, `curptr` 0 [hw: `aptoap sap, 16` moves the base by 16 and the size from 32 to 16] |
| `aptoapb src, size, dst` | the first `size` bytes from `curptr` [hw: size 32 → 8]. Both are SIGSEGV `SEGV_BNDERR` if the result would leave `src` (`c_aptoap_over`, `c_aptoapb_over`): a descriptor cannot be widened. lcc narrows with `aptoap` + `aptoapb` (`__builtin_e2k_create_ap_subarray`) |
| `gdtoap [lit], dst` | an AP into the module's globals at a literal offset; lcc follows it with an `aptoapb` of the object's size (`g_addr`, `g_str`) |
| `cudtoap lit, dst` | an AP to the module's code from `CUD.base` + `lit` to its end, `curptr` 0, **`rw` = 1** (read only: "Array pointer") [hw: `cudtoap 0x100` of a 0xd000-byte `CUD` gives base + 0x100, size 0xcf00]. lcc never emits it (next row) |
| `ldcud{b,h,w,d,q} lit, off, dst` | a load at `CUD.base` + `lit` + `off`: it reads the module's code [hw: 64 bytes at offset 0 and at a function's offset are each found once in `/proc/self/exe`, exactly that offset apart]; past `CUD.size` SIGSEGV `SEGV_BNDERR` at the instruction. The guide reads text-segment constants with it in 32-bit mode (9.1.4.3), where lcc doesn't use it either ([mode32.md](mode32.md)). lcc never emits `ldcud*` or `cudtoap` in protected code: none in the 321 `lib128` files of each of lcc 1.29.16's `e2k-v3`, `v5.8c2` and `v6.2c3` sysroots or the 324 of 1.31.05's `e2k-v3`, nor for switch tables, constant arrays, literals, computed `goto` or `-fPIC` code at `-O0`…`-O3` [lcc]; gas notes that "data is not allocated in CUD (not supported yet)" (binutils `gas/config/tc-e2k.c:7813-7818`), but accepts both operations under `-mptr128` |
| `getpl [lit], dst` | a PL of a function at a `CUD` offset (guide 10.9.2 gives the form into `%ctprN`); lcc's function addresses (`p_fnaddr`; for v3–v5 lcc also zeroes the high doubleword) |
| `getva p, off, dst` | the low 48 bits of `p`'s base plus `off`, a 32-bit operand: `curptr` is not added (semantics.md's operands; [hw: `getva` of `getsap`'s result gives its base]). lcc converts a pointer to an integer, compares and subtracts pointers with `getva p, curptr` plus the sign-extended minus the zero-extended `curptr` (`p_to_long`, `p_lt`, `p_diff`), so (inferred) `getva` zero-extends `off` |
| `ldap{b,h,w,d,q} p, idx, dst`, `stap{b,h,w,d,q} p, idx, src` | access through an AP with an index, checked as above: every pointer access lcc makes |
| `ldgd{b,h,w,d,q}`, `stgd*` | access at a 32-bit offset from `%gd`, checked against the module's globals (guide 9.1.2): lcc's direct reads of globals (`g_load`) |
| `movtq` | copies 16 bytes with their tags: every pointer copy, argument and result |
| `adds` on the high doubleword | pointer arithmetic: a 32-bit add to `curptr`, which under `setwd dbl = 0` leaves the size half and its tag alone ([registers.md](registers.md), `dbl`; `p_add`). No protected function in `pmcc.c` uses `dbl = 1` |
| `movtd pl, %ctprN` + `call` | calls through a PL (`d_fp_call`, also on v6) |
| `puttagd` | lib128 clears the tag of `%qr0`'s high doubleword to read its argument area's size (glibc `sysdeps/unix/sysv/linux/e2k/e2k128/syscall.S:17-20`) and makes empty values (`malloc`) |
| `ldapq …, mas = 0x5` + `stapq …, mas = 0x2` + `rbranch` | pointer atomics on v5 and v6 (below) |

After the prologue's last `getsap`, lcc 1.29.16 stores one byte at
offset 0 of that area (`stapb %rN, 0x0, %rN`) for v3 and v4 targets
(`e2k-v3`, `v3.4c`, `v4.1c+`, `v4.8c`), not for v5 and v6 ones
(`v5.8c2`, `v6.16c`, `v6.2c3`); the guide's example has it too (11.7).
Why is not known [lcc].

## Compilation units: CUT, CUD, GD

- Each loaded module (executable, ld.so, each library) is a
  *compilation unit*: a code area described by **`CUD`** and a globals
  area described by **`GD`**, 128-bit registers (base and size). Calls
  and returns between modules switch them, with **`TSD`** (types) and
  **`CUIR`** (the unit's index) (guide 9.3.4; guide 10.9: the `CUT` row
  comes from the target page's PTE).
- The **CUT** (compilation unit table) is one 4 KiB page of 32-byte
  entries, a `CUD` and a `GD` each (kernel
  `include/asm/cpu_regs_types.h:78-145`, `include/asm/stacks.h:33-35`):
  `[cut]` in `/proc/self/maps`, at `c2ffffffe000` on the 8C2 and 4C and
  `c27fffffe000` on the 2C3 [hw]. That is 128 entries.
- The kernel gives each protected module the first free index from 1
  (0 is for unprotected code), fills its entry and marks its code pages
  with the index (`kernel/process.c:833-900`). On the 2C3 the main
  program's PLs carry `cui` 2 [hw].
- **Globals** [lcc]:
  - lcc reads them with `ldgd*` at a 32-bit offset from `%gd`
    (relocation `R_E2K_32_ABS`), and takes their addresses with `gdtoap`.
  - Position-independent code (`-fPIC`) keeps a GOT of 16-byte
    descriptors in `GD`, read with `ldgdq [sym@AP_GOT]` and
    `ldgdq [sym@PL_GOT]` (`R_E2K_AP_GOT`, `R_E2K_PL_GOT`). There is no
    `rrd %ip` GOT computation as in 64-bit code ([elf.md](elf.md)).
  - String literals and constants are in the same `GD` (the module's
    `r--p` segments) [hw: maps].
- **Functions**: direct calls use `disp` (`R_E2K_DISP`), function
  addresses `getpl`. Only a module's own code can make a PL to itself
  (`getpl` is `CUD`-relative), so ld.so takes other modules' PLs from
  their export table (`DT_EXPORT_PL`) or through the module's own
  `getpl` helper (glibc `sysdeps/unix/sysv/linux/e2k/e2k128/ldsodefs.h:380-410`).
- **`%cud` and `%gd` read with `rrd` in user mode** [hw: `pmleft`
  `c_cud_regs`, `pmlibmain` `c_regs`]: `%cud.lo` is `0x0c00…` + base on
  the 4C and 8C2 and `0x0e00…` + base on the 2C3, `%gd.lo` `0x1800…` +
  base, each `.hi` the size in bits 63–32. The kernel's `CUD` has `p`
  (bit 57, protected) and `c` (bit 58), its `GD` only base and size
  (kernel `include/asm/cpu_regs_types.h:77-135`); it sets `p` for
  protected modules (`include/asm/cpu_regs.h:869-879`), but bit 57
  reads 1 only on the 2C3. Bits 60–59 read as an AP's `rw`, 1 for
  `%cud` and 3 for `%gd`: what `cudtoap` and `gdtoap` give (inferred).
  `CUD` covers the module's `r-x` mappings and `GD` its `r--` and `rw-`
  ones, and a call into a library switches both (the library's own
  values inside it).

## What is checked (hw; signals: kernel `kernel/traps.c`)

`exc_array_bounds` becomes SIGSEGV `SEGV_BNDERR` (3),
`exc_access_rights` SIGSEGV `SEGV_ACCERR` (2) and `exc_illegal_operand`
SIGILL `ILL_ILLOPN` (2); for all three `si_addr` is **the faulting
instruction**, not the data (`S_SIG`, kernel
`include/asm/traps.h:24-38`; `traps.c:1280-1315`). Page faults give the
data address as usual. `si_addr` is an untagged `unsigned long` in
lib128 (glibc `sysdeps/unix/sysv/linux/bits/types/siginfo_t.h:91-95`);
the 4C's ALT kernel sets bits 59–60 in it (`0x18000000500e3648`), the
others don't.

| Case (`pmrun`) | Result |
|---|---|
| element `[10]` of `malloc (40)`, read or write; `[-1]`; `[100000]`; an 8-byte read of the last 4 bytes; past a global array; past a local array | SIGSEGV `SEGV_BNDERR` |
| `t.a[4]` where `struct { int a[4]; int b; } t` | **no fault**: reads `t.b`. lcc gives a member or element pointer the whole object's bounds (`&t.b`: base `t`, size 0x14, `curptr` 0x10); `t.a[5]` is `SEGV_BNDERR` |
| `&local`, a local array | bounds exactly the variable (size 4, 0x10) |
| `&tls_var`, `&errno` | the whole TLS block: size 0x2000 in the main thread (8C2, 2C3; 0x1110 static on the 4C), 0x400000 in a new thread ((inferred) the thread's stack mapping, where its TLS block lies) |
| a string literal through a pointer from a static initializer, past its end | **no fault**: the pointer covers the literal to the end of the module's `GD` (size 0x3470 on the 8C2): the initializer is an `R_E2K_AP` against the literal's local label, whose symbol size is 0, and ld.so gives a size-0 symbol the rest of `GD` (glibc `e2k128/ldsodefs.h:357-375`) [lcc: `.ptr .LC.1@AP`]. A literal's address taken in code has the literal's size (`aptoapb 0x8` for `"literal"`) |
| `argv`, `envp` | one area (`argv` `curptr` 0x20, `envp` 0x40); `argv[0]` exactly its string |
| `NULL` read or write | SIGILL `ILL_ILLOPN` (`NULL` is an untagged zero) |
| an integer cast to a pointer, read or write | SIGILL `ILL_ILLOPN`: lcc builds low = the integer, high = 0, no tags (`p_from_long`; dump of `(int *) (long) 0x1234`); `__builtin_e2k_is_ptr_nv` gives 1 |
| `malloc`'d memory read before it is written | SIGILL `ILL_ILLOPN` at the first use (tag 5) |
| a local read before it is written | `x + 1` gives 1: lcc zeroes it, as in 64-bit code ([source-compat.md](source-compat.md)) |
| a stack pointer stored outside its frame or used after it | **no fault** ("Stack pointers") |
| a call through a PL | works; `f == ret7` is 1 |
| a call through an integer holding a code address | SIGILL `ILL_ILLOPC` (1), `si_addr` the target |
| a call through a data pointer | SIGILL `ILL_ILLOPC` |
| a call through `NULL` | SIGSEGV `SEGV_MAPERR`, address 0 |
| reading the code a function pointer points to | SIGILL `ILL_ILLOPN` |
| `free (p + 1)` | SIGSEGV, `si_code` `SI_KERNEL` (8C2, 4C) or `SEGV_BNDERR` (2C3) |
| `free` of a stack array | lib128 prints "ERROR: protected memory structure looks corrupted", then SIGILL (8C2, 2C3); no fault with the static libc (4C) |
| `free` twice | no fault |
| `mmap (100)` and a read at offset 200 of the same page | SIGSEGV `SEGV_BNDERR`: `mmap` returns an AP of exactly the requested length (`f_sys_mmap_over`) |
| a store through `cudtoap`'s AP (`rw` = 1) | SIGSEGV `SEGV_ACCERR`, `si_addr` the store (`pmleft` `c_cudap_store`) |
| `ldcud` past `CUD.size` | SIGSEGV `SEGV_BNDERR`, `si_addr` the load (`c_ldcud_over`) |
| a call nesting past `psl` 0xffe0 | SIGSEGV `SEGV_BNDERR`, `si_addr` the call ("Stack pointers"; `pmleft psl`) |

### Freed memory

What happens after `free` depends on the C library, not the CPU: the
static program (glibc 2.35-29.018) behaves on the 8C2 as on the 4C, the
dynamic one (`/lib128`, 2.35-29.023) differently [hw].

| After `free (p)` | `/lib128/libc.so.6` (8C2, 2C3) | lcc 1.29.16's static `libc.a` (4C; also on the 8C2) |
|---|---|---|
| reading `p[2]` | 0, no fault | SIGILL `ILL_ILLOPN` (the block holds empty values) |
| writing `p[2]` | no fault | no fault |
| the next `malloc` of the same size | the same block: the old pointer sees the new data | another block |
| copies of `p` in a global, the heap, a register | keep their tags | keep their tags |
| `PM_MM_ZEROING_FREED_POINTERS=1` | as above | `p[2]` reads 0 |
| `PM_MM_CHECK_4_DANGLING_POINTERS=1` | **every `free` dies with SIGSEGV, `SI_KERNEL`** (also without `fork`: `pmrun free1`) | `free` is deferred until the 1,024th, which dies the same way (`pmleft` `c_clean_free_many`; `PM_CLEAN_DESCRIPTOL_LIST_SIZE=2000` makes it the 2,000th, `=10` changes nothing: the variable can only raise the threshold, `free-uclibc.c:186-191`) |
| `PM_MALLOC_MODE=0`, `2` | no change: new memory is always `0x0bad…` tag 5 | the same |

What the source does: lib128's `free` puts the pointer on a list
(glibc `e2k128/free-uclibc.c:561-597`). In the "emptying" mode it then
asks the kernel to fill the block with empty values
(`clean_descriptors (mem, size, SINGLE | NO_GARB_COLL)`, which writes
`0x0baddead0baddead` with tag 5: kernel
`kernel/protected_syscalls.c:770-829`, `:810`), in the "zeroing" mode it
`memset`s it (`free-uclibc.c:120-133` reads the mode from the kernel).
When the list reaches its threshold (1 in the source,
`malloc-uclibc.h:439-443`; 1,024 in the static `libc.a` [hw]; the
environment variable `PM_CLEAN_DESCRIPTOL_LIST_SIZE` can only raise it)
the blocks are freed, and in the dangling-pointer mode
`clean_descriptors` is first meant to walk all writable user memory,
the signal stacks and the procedure stack and rewrite every descriptor
that lies wholly inside a freed block as a number (kernel
`kernel/clean_aps.c:106-150`, `:330-360`). `malloc_1` fills new blocks
with empty values whatever the malloc mode (`malloc-uclibc.c:1307-1336`).
The mode sets `PM_MM_CHECK_4_DANGLING_POINTERS` (0x1000) and clears
emptying and zeroing (0x814018 → 0x811018 on the 8C2, 0x812018 →
0x811018 on the 2C3, 0x84018 → 0x81018 on the 4C; uapi
`include/uapi/asm/protected_mode.h:50-55`).

**The walk never starts from `free`.** lib128 passes its list of freed
pointers as descriptors (`free-uclibc.c:534-558`, `:575`), and the
kernel refuses any entry that is one: it logs "clean_descriptors: bad
descriptor extag 0xcf" and returns `-EFAULT` (kernel
`kernel/clean_aps.c:442-449`, the same in 6.1-1.9, 1.17 and 1.19), which
the system call turns into SIGSEGV with `SEND_SIG_PRIV`, hence
`SI_KERNEL` (`protected_syscalls.c:825-826`) [hw: that log line for
every such `free`, all three; the static libc's list has 1,024
entries].

**The walk works when reached another way** [hw: `pmleft clean`,
`mremap`, all three]:

| Call | Effect |
|---|---|
| `clean_descriptors (list, n, 0)`, each entry an AP's two doublewords as numbers (tag 0) | fills each area with `0x0baddead0baddead`, tag 5, then walks |
| `clean_descriptors (ap, size, 1)` (`CLEAN_DESCRIPTORS_SINGLE`) | the walk only |
| `clean_descriptors (ap, size, 3)` (also `NO_GARB_COLL`) | the fill only: lib128's "emptying" `free` |
| a moving `mremap` under `PM_MM_CHECK_4_DANGLING_POINTERS=1` | the walk for the old area (`protected_syscalls.c:2712-2728`) |

After a walk every copy of a pointer lying wholly inside the area, in a
global, the heap, a local array or the caller's registers (spilled to
the procedure stack), keeps its bits with tags 0, so using it is SIGILL
`ILL_ILLOPN`. A pointer to the next page, or to a larger area that
contains the cleaned one, keeps its tags. After a moving `mremap`
without the mode the old pointer keeps its tags and a read through it
is SIGSEGV `SEGV_MAPERR`.

## Data layout (hw: `pmrun` "layout", `pmcxx`)

| Type | Size / alignment |
|---|---|
| data pointer, function pointer | 16 / 16 |
| `long`, `size_t`, `ptrdiff_t` | 8 |
| `intptr_t` | 8 with lcc 1.29.16 (`__INTPTR_WIDTH__` 64); **16 with lcc 1.31.05** (`__intdescr_t`, "lcc") |
| `long double` | 16 / 16 |
| `max_align_t` | alignment 16 |
| `struct { char c; void *p; }` | 32, `p` at 16 |
| `struct { int i; void *p; int j; }` | 48, `p` at 16, `j` at 32 |
| `union { void *p; long l; }` | 16 |
| `va_list` | 16 (an AP) |
| `jmp_buf`, `sigjmp_buf` | 80 |
| `siginfo_t` | 128 |
| `ucontext_t` | 2,592 |
| `struct sigaction` | 176 |
| `pthread_t`, `pthread_mutex_t` | 16, 64 |
| C++: a class with only a vtable pointer; with an `int` added | 16; 32 |
| C++ pointer to member function | 32 |

Every aggregate holding a pointer is 16-byte aligned. Everything else
is as in [data-layout.md](data-layout.md).

## Calling convention (lcc: `pmcc.c`, lcc 1.29.16 for `e2k-v3`, `v5.8c2`, `v6.2c3`; the same with lcc 1.31.05)

- **Every call hands over 8 register pairs** (`wsz − wbs` = 8 in every
  call of `pmcc.c`: 43 for v3, 40 for v5 and v6, 44 with lcc 1.31.05;
  64-bit code hands over 4,
  [calling-convention.md](calling-convention.md)), and every function
  has `setwd wsz ≥ 8`. The guide's example has the same (11.7: `wsz =
  0x13`, `wbs = 0xb`).
- **`%qr0` (`%r0`, `%r1`) holds an AP to the argument area**, which the
  caller allocates with `getsap` in its prologue and narrows per call
  with `aptoapb` to 16 × (slots + 1) bytes; a call without arguments
  passes 16 bytes.
- **Arguments take 16-byte slots.** Slot k is at offset 16k of the
  area; slot 0 is `%qr0`'s own place and holds no argument. Slots 1–7
  travel in `%qr2`–`%qr14` (`%r2`–`%r15`) and only there; slots 8 and up
  only in the area (`d_many`: the eighth pointer is `ldapq %r0, 0x80`).
  The register image is laid out as the memory one: doubleword d of the
  area is `%rd`.
- **Scalars**: `int` and narrower are written with 32-bit operations and
  re-extended by the callee (`sxt`); `long` takes the low doubleword of
  its slot, a pointer the whole slot; `float` and `double` the low
  doubleword; `long double` its mantissa in the low doubleword and its
  16-bit exponent in the high one; `__int128` one slot.
- **Aggregates** take ceil(size/16) consecutive slots as their memory
  image; pointers in them stay quads (`struct { int *p; int x; }`:
  `%qr2` and `%r4`). An aggregate that does not fit wholly in the
  remaining register slots goes wholly to the area (a 136-byte struct;
  a 32-byte one from slot 7: `d_s136`, `d_sp_last`); the callee reaches
  it through an AP it makes from `%qr0`.
- **Variadic and unprototyped calls** write every argument, named ones
  included, both to the area and to registers (`c_va`, `c_unproto`); a
  variadic callee reads even its named arguments from the area (`d_va`).
- **Results of up to 128 bytes** come back in `%r0`–`%r15` as their
  memory image: a pointer in `%qr0`, four pointers in `%qr0`–`%qr6`, 80
  bytes in `%r0`–`%r9`, 128 bytes in `%r0`–`%r15`. **Larger results** are
  written through a hidden AP passed in slot 1 (`%qr2`), sized exactly to
  the result (0x90 for 144 bytes, 0x100 for 256), and the real arguments
  move up one slot (`r_s144`, `r_s256p`, `c_res`). 64-bit mode returns
  up to 64 bytes in registers and writes larger results to the caller's
  argument area ([calling-convention.md](calling-convention.md),
  "Results").
- **Varargs**: `va_start` makes the `va_list` (an AP) from `%qr0` with
  `curptr` at the first variadic slot; `va_arg` reads the slot through
  it and adds 16 to `curptr`, one slot per argument up to 16 bytes,
  `long double` included; `va_copy` copies the AP. A variadic callee
  can tell how many slots it got from `%qr0`'s size, as lib128's
  `syscall ()` does (`syscall.S:17-60`). [hw; lcc-doc for `-mprot-*`]:
  - Fetching one more argument than was passed is SIGSEGV
    `SEGV_BNDERR`, even if the value is never used (`f_va_missing`; the
    manual's `-mprot-va-arg-semi-spec` case).
  - Fetching a pointer where a `long` was passed is SIGILL `ILL_ILLOPN`
    (`f_va_int_as_ptr`; the manual's `-mprot-abi-promotion` case).
  - An `int` read as `long` gets, above the `int`, 4 bytes of the slot
    that the caller never wrote: what an earlier call left there,
    untagged (`f_va_int_as_long_stale`: `0x1800c2de00000005`, the 5 under
    the upper half of a stale pointer's low doubleword), or a trap at use
    if they hold an empty value.
- **Calls through the PLT** copy `%r0`–`%r15` to a new window and back
  ("ELF and linking").

## System calls

- **Entries** 8 (ordinary) and 7 (fast), for protected tasks only
  ([kernel-interface.md](kernel-interface.md), "System calls"; glibc
  `sysdeps/unix/sysv/linux/e2k/e2k128/sysdep.h:20-21`; kernel
  `kernel/trap_table.S:794-890`).
- **Sequence** (glibc `e2k128/sysdep.h`;
  `sysdeps/unix/sysv/linux/e2k/sysdep.h:101-106`): `setwd wsz = 0x10`,
  `setbn rbs = 8`, `sdisp %ctpr1, 8`, `call %ctpr1, wbs = 8`. The number
  goes in `%qb[0]` (`%db[0]` the number, `%db[1]` 0) and arguments 1–6 in
  `%qb[2]`–`%qb[12]`, each a quad (a pointer, or an integer in the low
  doubleword). The result is `%db[0]`; calls that return a pointer
  (`mmap`) give the error in `%db[0]` and the AP in `%qb[2]`
  (`e2k128/sysdep.h:146-147`). The entry checks with `vfrpsz` that 8
  pairs were handed over ([operations-v3.md](../isa/operations-v3.md),
  `vfrpsz`).
- **Argument checks.** The kernel keeps, per system call, the expected
  kind of each argument and which argument is the size of which buffer
  (`prot_syscall_arg_masks`, kernel `kernel/prot_syscall_synopsis.c:96`;
  applied by `ttable_entry8_C`, `kernel/ttable.c:1689`); most calls
  go through wrappers in `kernel/protected_syscalls.c`.
- **What the checks do** [hw: `pmrun` `sys`]:

| Call | Default mode | `PROTECTED_MODE_SOFT=0` |
|---|---|---|
| `write (pipe, char[8], 100)` | "[ePM#9] System call #4/write: count exceeds descriptor size (100 > 8) in arg #2. Count truncated down to the descriptor size (8)", **but it returns 100 and writes 100 bytes** | SIGABRT after "Execution of pmrun terminated. Error code: 22" |
| `read (/dev/zero, malloc (8), 100)` | the same message; **it returns 100 and overwrites the next heap block** | SIGABRT |
| `write (1, (char *) (long) buf, 4)` | "[ePM#5] … not a pointer is not allowed in arg #2", −1, `EFAULT` | SIGABRT |
| `open` of a `char[3]` without a NUL | "[ePM#8] … not a null-terminated string in arg #1", −1 | SIGABRT |

  The count is not truncated in the source either: the adjusted size
  only feeds the check of the buffer argument itself, and the system
  call gets the caller's count (kernel `kernel/ttable.c:1523-1580`,
  `:1843-1888`). The messages go to stderr. `malloc (2 GiB)` prints
  "malloc cannot allocate over 2**31 bytes (2Gb) in protected mode" and
  returns `NULL`, `ENOMEM` (glibc `malloc-uclibc.c:1312-1318`).
- **The process's mode** (`mm->context.pm_sc_debug_mode`; bits in uapi
  `include/uapi/asm/protected_mode.h:23-102`) is built at `exec` from
  the sysctls in `/proc/sys/kernel/e2k/SCM/` and from `PM_*` and
  `PROTECTED_MODE_SOFT` environment variables
  (`kernel/prot_sysctl_init.c:312-571`), and read or changed with
  `arch_prctl (PR_PM_DBG_MODE_GET = 8193, …)`. [hw: `f_sys_dbgmode`]:

| Machine | Default | Bits |
|---|---|---|
| 8C2 | `0x814018` | stderr messages `0x800000`, malloc mode 1 (bits 16–17), emptying freed memory `0x4000`, soft mode `0x10`, argument checks `0x8` |
| 2C3 | `0x812018` | the same with zeroing `0x2000` instead of emptying: the source's default (`PM_SC_DBG_MODE_DEFAULT`, `protected_mode.h:127-130`, plus malloc mode 1) |
| 4C | `0x84018` | bit `0x80000`, which the 1.19 source doesn't define, instead of `0x800000`; no malloc mode (`PM_MALLOC_MODE` changes nothing); messages say `[EPM#n]` |

  All sysctls read 0, except `prot_malloc_mode_control` = 4294967295 on
  the 2C3 (absent on the 4C).
- **Protected-only system calls** (uapi `include/uapi/asm/unistd.h:424-445`;
  kernel `kernel/systable.c:1524-1530`):

| Number | Call |
|---|---|
| 420 | `newuselib`: ld.so loads a library |
| 421 | `rt_sigaction_ex` |
| 424 | `clean_descriptors` |
| 425 | `unuselib` |
| 445 | `unsafe_uint64_to_ptr`: makes a descriptor from an integer; refused unless the sysctl or `PM_SC_UNSAFE_UINT64_TO_PTR_ENABLED` allows it |

## Signals, threads, TLS, C++, atomics

- **Signals** [hw: `f_signal`, `f_sigqueue`]: a handler gets `siginfo`
  and `ucontext` as APs of 0x80 and 0xa20 bytes, the second right after
  the first. The kernel takes the handler as a PL (`struct
  prot_sigaction`, kernel `include/asm/prot_signal.h:45-49`). The
  protected `mcontext` lacks the 64-bit trap-cellar fields (glibc
  `sysdeps/unix/sysv/linux/e2k/bits/sigcontext.h:52-79`). The kernel's
  frame is one union for all modes ([kernel-interface.md](kernel-interface.md),
  "Signals"). `raise`, `sigqueue`, `setjmp`/`longjmp` and `qsort` with
  a callback work.
- **Threads**: `pthread_create` and `pthread_join` work; thread stacks
  are mapped below 4 GiB [hw: `f_thread`].
- **OpenMP** (`-fopenmp`; `libomp` is in `/lib128` and in lcc's
  sysroot) [hw: `pmomp`, two threads, all three, static on the 4C]:
  parallel loops through a heap pointer, `reduction`, `critical`,
  `atomic`, `single`, `threadprivate`, `barrier`, pointers made in one
  thread and used in another, and tasks give the right results; a
  bounds error in a worker thread is SIGSEGV `SEGV_BNDERR` in that
  thread. On the 2C3 libomp printed "Setaffinity error -1" once, for a
  team of 2 without `OMP_NUM_THREADS`.
- **TLS**: the thread pointer is `%g12`, an AP to the thread's TLS block
  ([registers.md](registers.md)). lcc reads `ldapw %g12, [var@TLS_LE]`
  and takes an address as `%g12` with `curptr` moved, so a TLS pointer
  spans the whole block [lcc: `pmcc.c` `t_read`, `t_addr`; hw above].
- **C++**: an exception through 5 frames with a destructor,
  `std::vector<std::string>`, `vector::at` throwing `out_of_range`,
  virtual calls and member-function pointers work [hw: `pmcxx`].
- **Atomics on pointers** [lcc: `pmcc.c` `a_*`]: v3 calls libatomic's generic
  `__atomic_exchange`, `__atomic_compare_exchange` and `__atomic_load`
  with size 16; v5 and v6 inline them: exchange and compare-exchange as
  `ldapq …, mas = 0x5` / `stapq …, mas = 0x2` / `rbranch` loops (MAS
  mod 5 is a lock-wait load on v5 and v6: [atomics.md](atomics.md)), a
  load as a plain `ldapq`. `long` atomics stay `ldapd … mas = 0x7` on
  all. `__GCC_ATOMIC_POINTER_LOCK_FREE` is 1 for v3, 2 for v5 and v6.
  Since 1.26 the `__atomic` and `__sync` builtins accept descriptors,
  except the arithmetic ones [lcc-doc: changelog 1.26].

## The runtime (lib128)

- **Files**: `/lib128` and `/usr/lib128` hold a separate glibc 2.35
  build (`sysdeps/e2k/e2k128`, `sysdeps/unix/sysv/linux/e2k/e2k128`),
  interpreter `/lib128/ld-linux.so.2`. Elbrus Linux on the 8C2 and 2C3
  ships it, ALT Linux on the 4C doesn't; lcc's sysroot has it under
  `fs/lib128` and `fs/usr/lib128`, with static libraries, libstdc++,
  libatomic and libomp.
- **Address space** (kernel `include/asm/processor.h:57-59`,
  `include/asm/ptrace.h:32`; hw: maps): mappings start at
  `TASK32_SIZE / 3` = `0x5000_0000`, so ld.so, the program, libc, the
  heap and thread stacks all lie between `0x5000_0000` and 4 GiB. The
  main stack has its own 4 GiB-aligned window (`c2de…` on the 8C2 and
  4C, `c25e…` on the 2C3), since `%usd` and the SAP hold 32 bits of the
  address (`include/asm/cpu_regs_types.h:39-42`).
- **`malloc`** (an allocator derived from uClibc's,
  `e2k128/malloc-uclibc.c`) refuses more than `0x7fffffff` bytes,
  returns an AP of exactly the size asked (`malloc (1)`: size 1;
  `malloc (0)`: size 0) and fills the block with empty values first
  (`malloc-uclibc.c:1307-1336`) [hw]. It reports a corrupted heap with
  `printf` under its own lock, so a report before stdout has a buffer
  calls `malloc` again and hangs in `futex_wait` [hw: an earlier `pmrun`;
  `pmrun` now prints before its first case].
- **String functions** have protected versions
  (`sysdeps/e2k/e2k128/mem*.c`, `str*.c`).
- **Dynamic linking**: the kernel loads the executable and ld.so and
  makes their `CUT` entries (kernel `kernel/binfmt_elfe2kp.c`). ld.so
  loads each library with `newuselib`, which maps it and returns its
  `GD` descriptor and self-initialisation PL (glibc
  `elf/dl-map-segments.h:114`; kernel `protected_syscalls.c:2607`). ld.so
  makes every AP it writes from the module's `GD` with
  `__builtin_e2k_create_ap_subarray` (`e2k128/ldsodefs.h:350-376`) and
  applies `R_E2K_AP`, `R_E2K_PL`, `R_E2K_32_JMP_SLOT`, `R_E2K_32_COPY`
  and the 32-bit TLS relocations
  (`sysdeps/e2k/e2k128/dl-machine.h:353-394`).

## User shared libraries (hw: `pmlibmain`, `pmlibxxmain`; 8C2, 2C3)

Libraries built on the machine with `lcc -mptr128 -fPIC -shared` (its
`ld` makes the new PLT, "ELF and linking": `wbs = 8`, `%qr0`–`%qr14`
copied) work like the system ones. The 4C has no `/lib128` to run them.

| What | Result |
|---|---|
| Building | `-fPIC` is needed only when the library refers to another module's data: without it ld stops with "relocation `R_E2K_32_ABS' against undefined symbol `main_var' can not be used when making a shared object" [lcc 1.29.16, also the host's crossdev ld]. A library without such references links and runs without it (`pmdl.c` through `dlopen`): it then reaches its own globals `GD`-relative (`R_E2K_32_ABS`, no dynamic relocation) |
| Data the program uses | copy relocations (`R_E2K_32_COPY`) into the program's `GD`; the library reaches its own exported variables through its GOT (`R_E2K_AP`), so both use the program's copy (`&lib_var` is the same AP from both) |
| An array of unknown size (`extern const char lib_str[]`) | its pointer runs to the end of the program's `GD` (size 0xd80 for a 15-byte string): lcc takes the address with a `gdtoap` and no `aptoapb` [lcc: `-S`]; `extern int lib_arr[4]` gets exactly 16 bytes |
| Function pointers | a library function the program refers to has its canonical address in the program's PLT: the program's and the library's pointers are equal and on v6 carry the program's `cui` (2); one from `dlsym` carries its own module's (5 on the 2C3) |
| Callbacks, arguments | the program's function called from the library, and the program's arrays read in it, work; an out-of-bounds read in the library is SIGSEGV `SEGV_BNDERR` |
| TLS | the program uses IE (`R_E2K_TLS_IE` in the object, `R_E2K_TLS_TPOFF32` in the executable), the library GD (`R_E2K_TLS_32_DTPMOD`, `R_E2K_TLS_32_DTPREL`, `__tls_get_addr`); both get the same AP over the thread's TLS block, and each thread its own |
| `%cud`, `%gd` | switch to the library's own on a call into it ("Compilation units") |
| `dlopen`, `dlsym`, `dlclose` | work; after `dlclose` a call or a read through a pointer into the library is SIGSEGV `SEGV_MAPERR` at its address; a second `dlopen` maps it at the same place and `dlsym` gives the same PL as before (on v6 the same `cui`) |
| A 64-bit library | `dlopen ("/lib64/libm.so.6")`: "ELF file OS ABI invalid" |
| C++ (`l++`) | an exception thrown in the library is caught in the program; one thrown in the program passes through the library's frame and runs its destructor; virtual calls into the library work |

## lcc

Options [lcc-doc: `lcc_options.htm` of 1.31.05; lcc 1.29.16 where
marked]:

| Option | Effect |
|---|---|
| `-mptr128` (`-m128`) | protected mode |
| `-mptr128-64` | "compile in protected mode to an object that can then be linked under `-mptr64` (experimental)". [lcc 1.29.16: `pm6464.c`] The object has no `EF_E2K_PM` (`0x3000000` for `e2k-v3`, `0x5000010` for `v5.8c2`), so ld accepts it into a 64-bit program, but lcc predefines `__ptr128__` and the code is protected code with the protected convention (`ldapw`, `gdtoap`, `aptoapb`; the pointer argument in `%qr2`), whose operations fault in a 64-bit process (semantics.md). A file with an initialised pointer doesn't build: gas rejects `.ptr sym@AP` outside protected mode (`pmcc.c`). How such an object is meant to be used is not documented |
| `-mprot-va-arg-semi-spec`, `-mprot-abi-promotion`, `-mprot-all-sw-relax` (both) | tolerate fetching missing variadic arguments, and pass integers of 8 bytes or less promoted to pointers; ignored in the other modes (1.29) |
| `-fstack-arrays` | off by default in protected mode for every language: VLAs come from `__lcc_malloc`/`__lcc_free` [lcc: `l_vla`] |
| `-funsafe-struct-to-reg` | lets lcc keep structs in registers, without a guarantee if uninitialised data is written into a field |
| `-Wall-protected`; `-W{int32,int64,int128,intdescr}-to-pointer-cast-protected`, `-Wpointer-to-{int32,int64,int128,intdescr}-cast-protected` | cast warnings |
| `-mdmodel` | ignored in protected mode for v6 and older |
| `#pragma ivdep` | ignored in protected mode since 1.30.05 [lcc-doc: changelog 1.30, `pragma_mcst.html`] |

Predefined macros [lcc 1.29.16: `-mptr128 -dM -E` against the default;
lcc-doc `predefined_macro.html`]: added `__ptr128__`, `__PROTECTED__`
(a deprecated alias) and `__SIZEOF_POINTER__` 16; removed `__ptr64__`.
`__GCC_ATOMIC_POINTER_LOCK_FREE` becomes 1 for v3 (2 for v5, v6).
`__LP64__` and `_LP64` stay, and `__SIZEOF_LONG__` stays 8.
`__MCST_MACP__` is documented for protected v6+ code, but neither
1.29.16 nor 1.31.05 defines it for `e2k-v6.2c3` or `e2k-v6.16c`.

lcc 1.31.05 [lcc; lcc-doc]:

- `intptr_t` and `uintptr_t` are `__intdescr_t` and `__uintdescr_t` on
  every target (`__INTPTR_WIDTH__` 128, `__SIZEOF_INTDESCR__` 16,
  `__MCST_INTPTR_DYNAMIC__` 1, `__INTPTR_MAX__` still
  `0x7fffffffffffffff`): a cast from a pointer keeps the descriptor
  (`movtq`), and arithmetic calls the runtime's `__lcc_swde_add_rz`
  (`pmcc.c` `i_*`). The
  manual says `intptr_t` "has a 64-bit integer interpretation despite
  its 128-bit size" (`pointer_int_conversion.html`); the 1.28 changelog
  announced the 128-bit size for v7 only.
- `-mptr128` predefines `__PIC__` and `__PIE__` as 2.
- The calling convention is unchanged (`pmcc.c`: the same code but for
  scheduling).

History [lcc-doc changelogs]: 1.25 changed the `-mptr128` ABI (code is
incompatible with earlier versions) and brought the mode "to production
level"; 1.27.07 added OpenMP; 1.29 the `-mprot-*` options; 1.31 `apcse`,
CSE for protected address operations.

## ELF and linking (binutils, hw: readelf)

- **Header**: `EF_E2K_PM` (0x20) on every protected object;
  `EF_E2K_PACK_SEGMENTS` (0x40) added by the linker on executables and
  libraries (binutils `include/elf/e2k.h:103-104`): `pmcc.o` `0x3000020`,
  an executable `0x3000060`, "Protected Mode with packed CUD and GD".
  With packed segments the kernel sorts the program headers and places
  code and data itself (kernel `kernel/binfmt_elfe2kp.c:470-480`).
  Executables are `ET_EXEC`, linked at `0x10000`, with `DF_1_PIE`, and
  are loaded at `0x5000_0000` and up.
- **Relocations**:

| Relocation | Where |
|---|---|
| `R_E2K_AP` (100), `R_E2K_PL` (101) | initialised data and function pointers |
| `R_E2K_32_ABS` (0) | `GD` offsets in `ldgd*`, `stgd*`, `gdtoap` and `getpl` literals |
| `R_E2K_DISP` (110) | calls |
| `R_E2K_AP_GOT` (3), `R_E2K_PL_GOT` (4) | `-fPIC` code |
| `R_E2K_32_JMP_SLOT` (8) | PLT slots |

- **Dynamic tags** of executables and lib128's `libc.so.6`:
  `DT_E2K_LAZY_GOT`, `DT_PLTGOT` 0, `DT_REAL_PLTGOT`, `DT_PLTGOTSZ`,
  `DT_INIT_GOT` (the PL of the module's `__selfinit`) (values:
  binutils `include/elf/e2k.h:170-196`; [elf.md](elf.md)).
- **Static programs relocate themselves.** Descriptors can only be made
  at run time, so a static protected program keeps a `DYNAMIC` segment
  and `.rela.dyn` (749 `R_E2K_AP` and 248 `R_E2K_PL` in the static
  `pmrun`); `file` calls it "static-pie linked".
- **Two PLT layouts.** binutils builds the protected PLT header and
  entries one of two ways, chosen when binutils is configured
  (`--enable-new-pm-abi`, default off: `bfd/configure.ac:130-140`;
  `bfd/elfxx-e2k.c:2335-2550`):

| PLT | Copies to the new window | `call` |
|---|---|---|
| old | `%r0`–`%r7` | `wbs = 4` |
| new | `%r0`–`%r15` | `wbs = 8`: the convention above |

  The machines' `ld` (2.41.0-29.023), lcc 1.31.05's own linker
  (binutils 2.45-31.003) and lib128's own PLTs use the new one. A
  binutils built from the same sources without the option makes the old
  one: the crossdev build (2.41-29.018) that the `/opt/mcst/lcc-1.29.16`
  trees on the owner's workstation link with, and (by its configure
  line) `tools/setup/build-binutils.sh`'s. A hello world (`puts`) it
  links dies with SIGSEGV at the first library call, also with
  `LD_BIND_NOW=1`; the same object linked by a `--enable-new-pm-abi`
  build of the submodule, and the program built by lcc 1.31.05 or on the
  machine, print "hello" [hw: 8C2]. Static programs have no PLT.
- A 64-bit object and a protected one cannot be linked into one program
  (guide 9.1.3: one semantic model per program): ld stops with "PM input
  file `x.o' is incompatible with 64-bit output" [lcc 1.29.16's link of
  `pm6464.c` built with `-mptr128`]; `-mptr128-64` objects ("lcc") are
  accepted.
- **32-bit protected ELF files** (`ELFCLASS32` with `EF_E2K_PM`). lcc
  never makes one: of its pointer-mode options the last wins
  (`-mptr128 -mptr32` gives an ordinary 32-bit object, `e_flags`
  without `EF_E2K_PM`), gas with `-mptr128` always writes `elf64-e2k-pm`
  (binutils `gas/config/tc-e2k.c:745-751`), and every `lib128` file in
  lcc's sysroots is ELF64 [lcc]. binutils has the format and an ld
  emulation (`bfd/elf32-e2k-pm.c:20-26`, `ld/emulparams/elf32_e2k_pm.sh`),
  so `objcopy -O elf32-e2k-pm` of a protected object and `ld -m
  elf32_e2k_pm -static` make one (`e_flags` `0x3000060`, as the ELF64
  link). The kernel has a loader for it ("Kernel support"; it marks the
  task `E2K_FLAG_3P_ELF32`, "can be removed when only elf64 3P is
  supported": `include/asm/elf.h:248-265`,
  `include/asm/processor.h:193-194`). [hw: `pmmin.s`, all three] The
  same hand-written static program, which writes a string through a
  `gdtoap` AP with the protected system call entry and exits with 42,
  runs as ELF64 and as ELF32. Only such static programs can exist:
  there is no ELF32 `lib128`.

## Kernel support

- `CONFIG_PROTECTED_MODE` ("Security mode", default y; kernel
  `Kconfig:871-889`) builds the loader (`kernel/binfmt_elfe2kp.c`), the
  system call wrappers (`kernel/protected_syscalls.c`),
  `clean_descriptors`, `unsafe_uint64_to_ptr` and the sysctls.
  `CONFIG_CLW_ENABLE` (default y) enables the hardware's cleaning of
  released user stack windows, which the kernel turns off for
  unprotected processes (`trap_table.S:161-164`, `:930-934`).
  `CONFIG_SOFT_PM` (default n) is a "software corrector" for some
  protected-mode faults (`kernel/soft_pm.c`).
- The protected loader (`kernel/binfmt_elfe2kp.c`, built twice, by
  `binfmt_elf64_3P.c` and `binfmt_elf32_3P.c`: `kernel/Makefile:113-114`)
  accepts files of its own class with `EF_E2K_PM` (or the old
  `EM_E2K_FAKE` machine with a protected `EI_SEMANTIC`;
  `binfmt_elfe2kp.c:51-90`), so 32-bit protected files run too ("ELF
  and linking"), and lays `argv` and `envp` out as descriptors in one
  area (`:92-110`).

## Emulators (qemu)

Neither emulator runs protected code:

- MCST's qemu decodes but does not implement `gdtoap`, `cudtoap`,
  `getsap`, `getspd`, `aptoap`, `aptoapb` and `getva`
  (`target/e2k/operations.h.inc:1311-1318`): a static protected program
  stops at its first instruction with "qemu: unimplemented operation
  GETSAP at IP = 0x10400", a dynamic one at the first `getsap` in ld.so
  [run: v3, v5].
- The community qemu refuses any `EF_E2K_PM` executable: "Protected
  mode is unsupported" (`linux-user/e2k/cpu_loop.c:246-248`) [run].

## Not checked yet

- What the stack pointer checks do with `%core_mode.no_stack_prot`
  clear: only root can clear it (the sysctl in "Stack pointers"), and it
  is a setting for the whole machine. Why `psl` stops at 0xffe0, and
  whether the fault there is `exc_user_stack_bounds` (inferred) or
  `exc_array_bounds`: both give the same signal.
- What bit 58 of a v6 AP means, and whether v3–v5 keep bit 57 (`p`) of
  `CUD` (it reads 0 there).
- `mprotect` beyond a read-only AP's rights (source only: it would make
  code writable).
- Dynamic 32-bit protected programs (there is no ELF32 `lib128`).
- v4.
