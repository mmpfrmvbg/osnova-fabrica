# x86 translator support, and what native code can take from it

Elbrus has hardware for MCST's x86 binary translator (lcc's documentation
calls it Lintel; the kernel calls a task running it "binco" and the x86
address space it emulates the "secondary space"). This file lists those
facilities: what each is, how it is encoded, which ISA versions have it,
whether ordinary native code can use it. It then asks what a native
compiler (the GCC port) or a JIT can take from them. Most facilities
are already in other spec files; this one gathers them and adds what
the sweep of the kernel, binutils, both qemus, glibc, libgcc and lcc's
output found.

Marks: **[hw]** measured on the 4C, 8C2 and 2C3 (the file named);
**[source]** read in MCST Linux (`arch/e2k`), binutils, glibc, libgcc
or the qemus; **[lcc]** seen in lcc 1.29.16 / 1.31.05 output or its
shipped libraries; *inferred* where it is our reading. The guide says
nothing about binary translation.

## Becoming a translator task [source]

The kernel treats a task as binco when the **main executable's ELF
header** has `EF_E2K_X86APP` (`e_flags` bit 2), which MCST ld sets with
`--e2k-x86app` (elf.md names the flag). It is decided at `exec`,
inherited by `fork` and `clone`, and cannot be switched at run time or
by a shared library. A binco task:

- may call the translator's syscall `el_binary` (number 260; set a
  segment descriptor, register a recovery-point range, query the
  secondary-space offset, and services the translator uses to run x86
  programs); every command returns `-EPERM` for other tasks;
- gets its segment registers, `%rpr` and the TC state saved and
  restored at context switches, and the memory lock table (MLT) dumped
  into `sigcontext` at traps;
- has **different signal semantics**: a handler is entered with the
  interrupted `%g16`–`%g31` and `%bgr` (not cleared), and `sigreturn`
  does not restore `%g16`–`%g31`, which lcc-compiled code uses for
  temporaries ([registers.md](../abi/registers.md));
- on some CPUs (Elbrus-16C rev 2, Elbrus-8V7 rev 0) runs with the L2
  prefetcher off (erratum `GENERATIONS_L2_PREF`).

So the translator-only facilities below come at the price of a
different process model; they are not something a compiler can use in
ordinary programs.

## The facilities

| Facility | Encoding | ISA | Native user code | Where |
|---|---|---|---|---|
| x86 EFLAGS results of add, sub, logic, inc/dec, shifts, rotates, 32×32 multiply | `*_f{b,h,w}` (v1+), `*_fd` (v3+), ALC0/3 | v1+ | yes [hw]. 2 cycles to an integer op or the `cctop` of the producer's cluster (the one in its channel), 4 to the other cluster, 1 to store data. The multiplies take 6 to `cctop` or any integer op, 4 to `smulx`. A 32-bit result: the upper half is kept under `dbl = 0` and zeroed under `dbl = 1` [hw: `tools/isa-probes/pocchk4.c`] | semantics.md, "x86 flag operations"; timing.md |
| an x86 condition of a flags word into a predicate | `cctop{o,b,e,be,s,p,l,le}`, ALC0/3 | v1+ | yes [hw]. 2 cycles to a predicated op (1 on v6), 3 to `ct`, as a compare. Reads only the low 32 bits of its operand [hw: `pocchk4.c` `cc`, `lat`] | semantics.md, predicates.md |
| x87 80-bit arithmetic, `%fpcr`/`%fpsr` | `fx*`, `movif`/`movfi` | v1+ | yes [hw]. `%fpsr` holds the six flags and C1 (and on v6 x87's stack-fault bit, which nothing sets and which does not set ES). ES and B are computed from the flags and `%fpcr`'s masks. C0, C2, C3 and TOP don't exist (the stack is `%bgr`, whose faults are separate SIGFPE `FPE_FLTINV` traps, loops.md). C1 is written only by non-speculative divides and the square root, so an emulator computes it for `fadd`, `fmul`, `fst` and the compares. An unmasked exception traps at the operation itself, with no deferred trap at the next FP instruction (registers.md, "Traps") [hw: `tools/isa-probes/sregs.c`] | semantics.md, "80-bit operations"; registers.md, "Floating-point control and status" |
| the x87 register stack: rotating globals | `%bgr`, `abg` (v1–v5), `abgc`/`rbgc` (v6+), `vfbg`; v6 `mkfsw`, `modbgv`, `vfbgv` | v1+ | yes [hw]; v3–v5 rename `%g24`–`%g31` from the next instruction (10 cycles after `rws %bgr`); **v6 renames nothing**, only `cur` changes (`vfbg` and `%bgrpred` never run) | loops.md |
| x86 FP compare results into a register (`ucomisd` flags), MXCSR layout of `%pfpfr` | `fcmpud*f`, `fcmpod*f`, `fxcmpud*f` | v1+ | yes [hw]; lcc uses `fxcmpudxf` for `long double` `isless`/`isnan` [lcc] | semantics.md |
| x86-compatible FP compare mode, strict alignment | `%upsr` bit 8 `fsm`, bit 2 `ac` | v3+ (`fsm`) | writable [hw]; with `fsm` the predicate FP compares read unordered as x86 flags do (`lt`, `le`, `eq` true, `neq` false) [hw]; with `ac` every misaligned access of 2 bytes or more raises SIGBUS (`BUS_ADRALN`, `si_addr` the wide instruction's address, not the data's), and a store writes nothing: loads and stores of 2, 4 and 8 bytes; the AAU's `ldaad`, `staad` and `staaw`; `ldq`/`stq` that aren't 16-byte aligned (at +8 too, where they otherwise work; 8C2, 2C3); and on the 2C3 `ldqp`/`stqp` at any misalignment. A speculative load (`ldd,sm` with MAS 0 or mod 3, `ldw,sm`, and `ldqp,sm` on the 2C3) gives the diagnostic value (`4afafafa4afafafa`, tag 5) instead of trapping; bytes and aligned accesses are unaffected [hw: `tools/abi/probes/sysabi.c` section 8, `tools/isa-probes/memleft.c` `ac`; 4C, 8C2, 2C3], and glibc's own `printf` then faults on the 2C3 (v6 glibc makes misaligned accesses), not on the 8C2; `crtalign.o` (`-faligned-check`) sets `ac` [lcc]. Array prefetch ignores `ac`: movas from misaligned areas (doubleword, word and half areas at base + 1, 2 or 4; a byte area read 12 bytes a step; `ind` 4 in a byte area; on v5+ `movaqp` at + 4 and + 8) return exactly what they return without it, with `ac` set before `bap` or only after it, and never trap (the unaligned data or the diagnostic value, by machine and case, as in [apb.md](apb.md)); a misaligned `ldd` in the same function under the same `%upsr` is SIGBUS [hw: `tools/isa-probes/isaleft.c` `ac_*`, control `ac_ctl_ldd`; 4C, 8C2, 2C3]. `%upsr` reads 0x1 (bit 0 `fe`) on the 4C and 8C2 and 0 on the 2C3 (the kernel sets `fe`; v6 dropped the FP-disabled trap, kernel `traps.c:946`, so the bit is presumably not implemented there, inferred) | semantics.md, "Floating-point compares" |
| random predicates for sampling | `%rndpred1`–`15`, state `%rndpr` | v3+ | yes [hw] | predicates.md |
| issue without waiting for late operands | `%spred` | v1+ | yes [hw] | predicates.md |
| branch or call to a register | `ibranchd`, `icalld` | v6+ | yes [hw]; lcc 1.31.05 uses them only for v7 (jump tables, indirect tail calls and calls) [lcc] | control-transfer.md |
| recovery points, "generations mode" | `srp`, `crp`, `slrp` (SS), `%rpr` (0xa0, 0xa2) | v1+ (`slrp` v3+) | the operations run and cost nothing [hw]; the kernel's restart-on-trap service needs a binco task; `%rpr` is not preserved for other tasks [source] | speculation.md, "Recovery points" |
| segment registers | `%cs` … `%ss`, `.lo`/`.hi` (state registers 0x34–0x3f) | v1+ | set only through `el_binary` (binco); layout not in any open source | — |
| segment-relative loads and stores | `ld{c,d,e,f,g,s}s{b,h,w,d,q}`, `st…`; v5 `qp`/`mqp` forms; two 32-bit address operands | v1+ | they run but use whatever descriptor is loaded: they fault in an ordinary task [hw] | semantics.md |
| secondary-space address | a segment access lands at `0x4000_0000_0000` + the 32-bit x86 address on v3–v5, at the x86 address itself on v6+ (as the recorded fault addresses show) [hw, source] | v1+ | — | — |
| x86 `LOCK` support: memory lock table (MLT), lock-and-trap-on-store and lock-and-trap-on-access loads, store-and-unlock | MAS kinds on secondary-space accesses; `%mlt_inv` (MMU register) | v1+ | only through segment accesses (binco) | — |
| "TC" state (`%tcd`, `%tc`, `%tst`; `gettc`, `puttc`, `invtc`; `gettst`, `puttst`) and the SS "TS" field (`flushts`, `invts`, `puttsdc*`, `invtsc*`) | ALC0/3; SS type 1 bits 26, 28–29 | v1+ (`flushts` v3+) | binco context state; meaning not in any open source; `gettc`/`puttc` with ordinary operands are SIGILL [hw] | operations-v3.md |
| global-descriptor-relative loads and stores | `ldgd*`, `stgd*` | v1+ | lcc's 32-bit (`-mptr32`) code makes every memory access with them; in 64-bit processes they fault [lcc, hw] | operations-v3.md; [mode32.md](../abi/mode32.md) |
| a cache line flush that also drops the instruction cache | a store with MAS 0xf (`mod` 7, opc 1); MAS 0x17 is the I-cache-only line flush | v3+ | yes: libgcc's `__clear_cache` runs 0xf stores, and `ld.so` 0x17 stores, in user mode [source, lcc]; about 140 cycles for one line, 7 a line in bulk [hw] | below |
| what the trap left behind | `sigcontext`: `tir_*` (exception and channel), `trap_cell_*` (the trapped wide instruction's pending memory operations), `sbbp` (32-entry branch history); `UC_HANDLE_SIGRETURN_CELLAR` | — | these are filled for every task; `upsr`, `rpr_*` and `mlt` only for binco tasks, and `dam` stays zero unless the task is traced [source] | below |
| wait for a memory location to change (v6) | a load with MAS 0x11 ("watch for modification", ALC0; also `ldqp`, the `ldq` pair and MAS 0x31), then `wait mem_mod = 1, int = 1` | v6+ | **yes** [hw: 2C3]: returns when the 64-byte line changes or on any interrupt (every few ms), so a waiter loops; a ping-pong of two waiting threads has the round trip of two spinning ones (394 against 395 cycles) | below |
| x86 paging registers (`%cr3_rg`, MTRRs, `%pat`, …) | MMU registers | — | privileged | — |

## What native code can take

Ranked by how directly a compiler or a JIT can use them.

1. **Overflow and carry tests in two operations.** `adds_fw a, b` gives
   the flags of `a + b` in the same instruction as the `adds` that gives
   the sum, and `cctopo` (or `cctopb` for the carry) turns them into a
   predicate: `__builtin_add_overflow`, `__builtin_sub_overflow` and
   32-bit `__builtin_mul_overflow` (`smulx_fw`, `umulx_fw`) in two
   operations, where lcc emits ten (an add, three compares, four
   predicated moves and two extensions; for a multiply it divides the
   product by each operand, two `sdivs` or `sdivd` of 11-18 cycles
   each [lcc 1.29.16 `-O3`, v3-v6; 1.31.05, v6 and v7]; lcc never
   uses the flag operations except through its four
   `__builtin_e2k_*_f*` builtins). The `_fd` forms (v3+) do 64-bit add
   and subtract; there are no 64-bit multiply flags. Both run only in
   ALC0 and ALC3. An add's or a logic operation's flags reach the
   `cctop` in the same channel in 2 cycles and the other channel's in
   4, because a cluster crossing costs 2 here. A multiply's flags are
   an FP-side result: they reach either `cctop` in 6, and an integer
   operation issued in the multiply's channel 2 cycles after it delays
   them a cycle (timing.md, "Write-back conflicts"). With the `cctop`
   in the producer's channel, a predicated operation can use an add's
   overflow 4 cycles after the operands (3 on v6) and a `ct` 5, a
   little sooner than lcc's sequence; for a multiply, 8 (7 on v6) and
   a `ct` 9. Two `cctop`s (also beside two compares), two flag
   operations, or a `cctop` beside a flag operation issue in one
   instruction, one instruction a cycle [hw:
   `tools/isa-probes/pocchk4.c` `lat`, `wb`, `tp`; 4C, 8C2, 2C3]. The
   flags word is a 32-bit result, so under `dbl = 0` a 64-bit reader
   waits 4 for it (timing.md, "Formats"); test it with `cctop` or a
   32-bit operation. A flag-producing op and the plain op can share an
   instruction. With `,sm` both the flag operations and `cctop*`
   speculate: a diagnostic operand gives a diagnostic result or
   predicate, not a trap (speculation.md; `tools/isa-probes/pocchk5.c`
   `dg`). A JIT for a dynamic language gets cheap
   overflow-checked small integers the same way.
2. **Publishing JIT code.** After writing code: `wait st_c = 1`, a store
   with MAS 0xf to every 256-byte line of the code, `wait fl_c = 1`
   (libgcc's `__clear_cache`, which the GCC port's
   `__builtin___clear_cache` and trampolines can call; its comment
   says the step will not shrink on future CPUs). Then enter the new
   code through a control transfer, as the kernel does before v7
   (`disp` + `ct`). `mprotect` from writable to executable flushes
   nothing, so the flush is needed with W^X too. Neither qemu models
   instruction caches, so a missing flush shows only on hardware.
   Cost (`native.c`, all three alike): about 140 cycles for one
   256-byte line (the call and the two `wait`s), 250–390 for 4 KiB,
   then 7 cycles a line, about 1.8 KiB a cycle, from 64 KiB on.
3. **Implicit null checks and guard pages.** A SIGSEGV handler gets, in
   `sigcontext`, the trapped instruction's pending memory operations
   (address, value, tag, a condition word with the destination
   register, channel and kind) and the exception registers, without
   decoding the bundle. The kernel reads back the saved IP (`cr0_hi`)
   on `sigreturn`, which is the hook a runtime needs to resume at a
   slow path; `UC_HANDLE_SIGRETURN_CELLAR` asks it to complete the
   instruction's other memory operations. *Source only; to be
   verified on hardware before a design relies on it.*
4. **Cheap sampling.** `%rndpred` gives an operation that runs on a
   deterministic 2⁻ᴺ of executions with no counter (predicates.md):
   sampled profiling counters for a JIT's tier-up decisions, or
   sampled instrumentation. `sigcontext.sbbp` (the last 32 branches)
   could feed a branch-history sampler like Intel's LBR.
5. **Non-blocking loads.** `%spred` lets an instruction issue before a
   load's data arrives and tells afterwards whether it was late
   (predicates.md): a JIT can try a fast path and fall back without
   stalling on a miss.
6. **An operand-stack cache (v3–v5 only).** `%bgr` rotates
   `%g24`–`%g31` as an 8-entry stack (`abgd` push, `abgi` pop, traps on
   overflow), the new naming visible from the next instruction: the top
   of a stack machine's operand stack (an interpreter or a JIT for a
   stack VM) in registers without moves. Those registers are scratch in
   the ABI, so calls into C must save them. v6 dropped the renaming
   (`abgc` only moves `cur`), so code relying on it breaks there.
7. **Indirect dispatch.** On v7 `ibranchd`/`icalld` are lcc's choice
   for jump tables and indirect calls; on v6 a taken `ibranchd` costs
   12 cycles, so a hoisted `movtd` + `ct` stays better there.
8. **FP environment and x86 emulation.** `%pfpfr` has MXCSR's layout and
   `%fpcr`/`%fpsr` x87's (lcc maps `_mm_getcsr`, `_FPU_GETCW` straight
   to them), `UPSR.fsm` makes the predicate FP compares treat unordered
   as x86 flags do (semantics.md; an emulator only: compiled code never
   changes it, registers.md), and the flag
   operations, `fx*`, `%bgr` and `fcmpud*f` are what an open x86
   user-mode emulator on Elbrus (box64-style) would build on.
9. **Wait on memory (v6).** The watch-for-modification load plus `wait
   mem_mod = 1, int = 1` runs in user mode: a MONITOR/MWAIT for spin
   loops in runtimes, garbage collectors and lock slow paths. It wakes
   as fast as spinning (the ping-pong above) but also on every
   interrupt, and v6's erratum `WAIT_INT` adds spurious wakeups, so it
   always sits in a loop that re-checks the word. It watches the 64-byte
   line of the loaded address, so keep unrelated data off it [hw: 2C3,
   `tools/isa-probes/memleft.c` `watch`]: a store by another core at
   +0, +8, +16, +32 or +48 ends the wait within about 0.6 µs, as fast as
   spinning notices it, and a store at +64 only at the next interrupt (a
   median of 2.7 ms later there). The quad watch loads (`ldqp,0` and
   the `ldq` pair with MAS 0x11) and `ldd … mas=0x31` behave exactly as
   `ldd … mas=0x11` (speculation.md, "v6 encodings"). Without a watch
   load, `wait mem_mod = 1, int = 1` returns at once (the waiting loop
   then spins).
10. **Only for a dedicated host process** (linked with
    `--e2k-x86app`): segment-relative accesses take a base and a limit
    from a descriptor and two 32-bit address parts, which fits a
    sandboxed 32-bit linear memory (WebAssembly-style) without
    explicit bounds checks; and the recovery-point service sends any
    trap inside a registered code range back to a chosen IP with the
    faulting page mapped, a restartable region. Against them: the
    descriptor layout is undocumented, the memory must live in the
    secondary space (offset by `0x4000_0000_0000` on v3–v5), memory is
    not rolled back, the signal semantics of `%g16`–`%g31` change, and
    nothing about them is measured. Guard pages and rseq-style
    restartable sequences are the simpler tools.

Not usable from native code: the x86 paging registers, reading the MLT,
and the TC/TS state, whose purpose the open sources don't explain.

## Open questions

- Whether other cores see new code after the MAS 0xf flush without
  more.
- Whether the IP redirect works for an ordinary task. (The trap cellar
  and exception registers are filled as the kernel source says, for a
  load fault and for `raise`: [kernel-interface.md](../abi/kernel-interface.md),
  "Signals".)
- The segment descriptor layout, and what a limit violation gives.

Measured with `tools/isa-probes/native.c` (and bench.py's distance
sweeps and `pocchk4.c` for the flag operations; `memleft.c` for
`UPSR.ac` and the watch load; `isaleft.c` for `UPSR.ac` and array
prefetch) on the 4C, 8C2 and 2C3.
