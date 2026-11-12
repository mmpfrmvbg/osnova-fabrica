# Hardware errata and anomalies

What is known about E2K hardware bugs, from two kinds of source that
must not be confused:

- **[source]**: errata MCST names in its GPL code: the Linux kernel
  (`arch/e2k/include/asm/cpu_features.h`, `CPU_HWBUG_*` with MCST's bug
  numbers, the CPU models and revisions affected and the kernel's
  workaround; and comments elsewhere in `arch/e2k`), binutils (gas and
  ld workarounds), glibc and gdb (`sysdeps/e2k`, `e2k-tdep.c`). These are
  MCST's own statements and high confidence that the bug exists, but
  each is a comment line or a workaround: the exact trigger is rarely
  given, and we have reproduced none of them.
- **[hw?]**: things our probes saw on our machines that look wrong or
  undocumented. **Low confidence.** Each could be a bug in our probe, an
  interaction with the kernel, a misreading of what the operation is
  meant to do, or a fault of that one machine, rather than a CPU
  erratum; none is confirmed by MCST. Treat them as leads, not facts,
  and recheck before relying on any.

Our machines and their revisions (`/proc/cpuinfo`): the 4C is an
**E2S revision 2** (v3), the 8C2 an **E8C2 revision 3** (v5), the 2C3 an
**E2C3 revision 1** (v6). "Ours" below says which of them an erratum
covers.

## Errata that matter to a compiler [source]

| Erratum (MCST #) | CPUs | What (MCST's words, condensed) | MCST's workaround | Ours | For a compiler |
|---|---|---|---|---|---|
| `CODE_PLACEMENT` (146897, 140436, 77417) | E2S, E8C, E1C+, E8C2, E12C, E16C; E2C3 rev ≤ 1 | jumps to the end of a 4 KiB page, and the placement of asynchronous (APB) program code, can misbehave | keep jump targets and call return addresses out of bad page offsets (gas: 0xdc0–0xdff; the BPF JIT also 0xee0–0xfff; next section) | all three | MCST gas does it by default for v2–v6 (`ENABLE_FIX_LCC_BUG_142105`, apb.md); a port that emits its own code layout must keep gas's fix on. The rule for APB programs is not published |
| `INTERSECTING_L1_ACCESSES` (123567) | E8C2, E12C, E16C | a load after an intersecting store can read wrong data from L1 | at least one real wide instruction between them (not `nop N`) | 8C2 | **not reproduced**: `stldv.c` (a store and an overlapping load in the next instruction, 10 size/offset shapes × 6 channel pairs, 1,000,000 times each) read the right value every time on the 4C, the 8C2 and both 2C3 cores. Such a reload is slow anyway (timing.md, "Store to load"), but lcc keeps the workaround's real wide instruction between them only when asked or for some CPUs: `-ffix-lcc-bug123567` puts a separate empty wide instruction after every store (also before a return) in `e2k-v3` and `e2k-v5.8c2` code, and the `e2k-v6.16c` lcc and `-mtune=elbrus-12c`/`16c` do so by default (`-fno-fix-lcc-bug123567` turns it off). The default `e2k-v5.8c2` lcc does not: it puts a store and a load that may alias in one instruction (`stw,2` with `ldd,5`) and a load of part of a stored doubleword, surely overlapping, in the next instruction; `-mtune=elbrus-8c2` doesn't turn it on, and `e2k-v3.4c`, `v4.8c`, `v4.1c+` and `v6.2c3` ignore the option [lcc 1.29.16, 1.31.05: `tools/abi/probes/kernelbuild.py` `bug123567`]. MCST's kernel passes it for 8C2 and generic kernels ([kernel-build.md](../abi/kernel-build.md), "Erratum #123567") |
| `STORE_RELEASE`, `SOFT_WAIT`, `STORE_MAS` (130066, 134351, 133605, 159721) | E12C rev 0, E16C and E2C3 rev ≤ 2 (store-release, store MAS); E12C, E16C, E2C3 rev 0 (soft waits); E8C2 its own soft-wait variant | L1/L2 don't respect the `lal`/`las`/`sas`/`st_rel` barriers; a pair of stores with certain MAS doesn't work | don't use `las`/`sas`/store-release; `nop` before `lal`/`sal`; four instructions between such stores. The kernel's release store is `wait st_c, ld_c` + `st` on these, the MAS store-release (0x13) only where the bug is absent | 2C3 (store-release, store MAS), 8C2 (soft wait) | the v6 MAS release store that `mas6.c` timed (speculation.md, "v6 encodings") is **not to be used** on our 2C3 or any E2C3 up to rev 2; lcc doesn't, and its v6 atomics are `wait` + plain stores (atomics.md) |
| `BRANCH_ACTIVATES_CTPR` (rm 27719) | E2C3, E12C, E16C (all) | `ibranchd`/`rbranch` can corrupt an inactive `%ctpr` | don't use them while any `%ctpr` is inactive | 2C3 | `rbranch` ends every DAM check and lcc's atomic read-modify-write loops (atomics.md); on v6 keep all CTPRs valid (prepared) around them, or avoid them, until the meaning of "inactive" is known. The proof-of-concept back end's probe didn't show it (low confidence): after 1000 taken `rbranch`es, `%ctpr1` prepared before the loop still reached its target and `%ctpr2`, emptied by a call before it, still fell through under a false predicate, on the 2C3 (and the 4C, 8C2) |
| `L1I_RBRANCH_CALLS` (124206, 135900) | E2S, E8C, E1C+, E8C2; E12C, E16C, E2C3 rev 0 | "instruction buffer stops working" | prepare the CTPRs in the trap handler's (and `glaunch`'s) entry; no `rbranch` or `call` in trap entry and exit | 4C, 8C2 | kernel code only: MCST builds its trap entry and exit (`ttable.o`) with lcc's `-fno-dam` when `CONFIG_CPU_ISET_MIN` ≤ 6 (`CONFIG_MIGHT_HAVE_CPU_HWBUG_L1I_RBRANCH_CALLS`). lcc 1.31's `-fno-dam` leaves the DAM of pipelined loops (`-fno-swp-dam`, 1.29's `-fno-dam4swp`, removes it), and neither removes the `rbranch ? %dt_alN` of fully speculative loads; lcc's own `ttable.o` has no `rbranch` [lcc] ([kernel-build.md](../abi/kernel-build.md), "Array prefetch, %ctpr2, DAM"; kernel `asm/cpu_features.h:280-292`, `kernel/Makefile:57-63`). The trigger is not public and is privileged; not reproduced |
| `TAGGED_LDW` (142262) | E16C rev ≤ 2, E2C3 rev ≤ 1, E12C rev 0 | a tagged `ldw` doesn't work after a possibly aliasing `stw` | four bubbles between | 2C3 | the fill MAS is the tagged load, so lcc's spill code (`stw,sm` to a slot, `ldw … mas=0x4` back; speculation.md, "Spill and fill") is this case in ordinary 64-bit code; lcc's 2C3 build leaves one instruction between. **Not reproduced** on our E2C3 rev 1: `memx.c`'s `tldw_*`, `tldd_*` and `tm_*` (a `stw,sm` or `std,sm` and a fill at distances 1, 2, 3 and 5, store channel 2 or 5 against fill channel 0, 2, 3 or 5, an aliased address, a clean word over a tagged one; 17 shapes, 10,000 runs each) gave no wrong value or tag |
| `PREFETCH_EMPTY` (129870, 131465) | E12C, E16C, E2C3 rev 0 | prefetches into `%empty` don't work | give the prefetch the "L1 disabled" MAS (prefetch into L2) | none | lcc's `ldb,sm …, %empty, mas=0x20` prefetches (timing.md, "Memory") are no-ops there |
| `WC_DAM` (95860) | E2S rev ≤ 2, E8C rev ≤ 1, E8C2 rev 0 | write-combining memory conflicts with the DAM | `wait st_c` between WC writes and cacheable loads | 4C | only programs writing WC mappings (graphics memory) |
| `AAU_AALDV` (99302) | E2S, E8C, E1C+, E8C2 rev 0 | `%aaldv` is sometimes not restored properly | `wait ma_c` in the kernel's AAU restore | 4C | none in user code; the kernel covers APB across traps |
| `UNALIGNED_LOADS` (160330) | E8V7 rev 0 (v7) | fully speculative loads crossing a page boundary lose tags | no speculative mode for unaligned loads | none | v7 only: semi-speculative (`mas=0x0`) for loads that may cross a page (speculation.md) |
| `WRITE_MEMORY_BARRIER` (89495) | E8C rev ≤ 1 | the write barrier doesn't work, even for atomics | a special sequence after every read-acquire | none | v4 (E8C) only |
| `E4C` multi-node atomics (89527; kernel `e2k_api.h`, `CONFIG_CPU_E2S && CONFIG_NUMA`) | E2S with several nodes | "atomic operations have fully relaxed memory ordering" | `{wait st_c=1, ma_c=1}` before and after every kernel atomic | 4C (four nodes) | lcc's atomics carry no such `wait`. **Not reproduced**: `litmus_rmw.c` (message passing and store buffering with lcc's seq_cst exchange and fetch-add, 1,000,000 times each) saw no forbidden outcome on two chips (CPUs 1, 9) or one; the earlier `litmus.c` runs across chips agree (atomics.md) |
| Lock-wait loop head (163716, glibc `pthread_spin_lock.c`, `setjmp_tmpl.S`, for `__iset__ <= 6`) | v6 and older | the instruction before a lock-wait (`mas=0x7`) loop needs a `nop 1` | glibc adds `nop 1` there | all three | lcc's atomic loops start with a lone `nop 1` instruction at the `rbranch` target (atomics.md); copy it. glibc also notes "no memory accesses between lock and unlock" (33705) |
| `flushr` after a call (102582; kernel `e2k_api.h`) | not said | `flushr` must not be in the first instruction after a `call` | `{nop} {flushr}` | ? | only code that flushes the register stack itself (unwinders, context switches in user space) |
| Same CTPR prepared and used in one instruction (154538; gas) | v5 and older | a wide instruction may not prepare and transfer through the same `%ctpr` | gas refuses it ("not supported on elbrus-vN") | 4C, 8C2 | keep prepare and `ct` apart (control-transfer.md); on v6 gas allows it but the `ct` falls through (below) |
| `RWD_LSR` (165225) | listed, enabled for no CPU in this kernel | some instructions are not allowed after `rwd %lsr`/`%lsr1` | `{nop}` after the `rwd` | — | lcc already leaves 4 cycles between `rwd %lsr` and the loop (loops.md: a loop entered sooner counts the old `%lsr` in its first iterations, below) |
| `GENERATIONS_L2_PREF` (rm 35505) | E16C rev 2, E8V7 rev 0 | load/store "generations" conflict with the L2 prefetcher | the kernel disables the prefetcher while the binary compiler runs | none | binary translation only |

## How binutils works around `CODE_PLACEMENT` [source]

MCSTBug #140436 (also #77417, #146897; `ENABLE_FIX_LCC_BUG_142105`
in gas, on by default for v2–v6 and off for v7, which MCST believes free
of it, #152233):

- **gas** moves every label that can be a jump target, and the return
  address after every `call`, out of page offsets **0xdc0–0xdff**, by
  inserting NOPs (up to 128 bytes) before it. Since it can only rely on
  the section's alignment, which it raises to 1 KiB by default
  (`--fix-lcc-bug142105=1024`; 2048 and 4096 give 2 and 4 KiB), it also
  avoids the same offset in every 1 or 2 KiB block: 0x1c0, 0x5c0 and
  0x9c0 with 1 KiB, 0x5c0 with 2 KiB. Labels inside a wide instruction,
  and labels marked `.non_target_label`, are left alone.
  `--fix-lcc-bug142105=0` or `.fix_lcc_bug149113` turn it off.
- **ld** fills the unsafe ranges of `.plt` with zero doublewords
  (8-byte NOPs that are never executed) and keeps PLT entries out of
  them; MCSTBug #144538 made objdump and ld skip such NOPs.
- **The kernel's BPF JIT** avoids two ranges per page, 0xdc0–0xdff and
  0xee0–0xfff, following "item 1 and 4.2 of comment 58 of bug 146897";
  the rest of that comment covers APB programs and is not public.

So a GCC port that emits assembly for MCST gas gets the label part for
free; one that emits its own code bytes (a JIT, or an integrated
assembler) must do the same. Related, not a bug: ld puts 4 `nop`s
instead of 2 in a v6+ PLT entry because "the delay between a load and
its consumer has been increased from 3 to 5 ticks starting from
elbrus-v6" (MCSTBug #112004).

## Errata for debuggers, profilers and the OS [source]

These don't change generated code but explain what tools see:

- `BREAKPOINT_INSTR` (90514; E2S, E8C, E8C2 — the 4C and the 8C2):
  the hardware hangs after code is modified for a breakpoint unless
  the patched instruction keeps its `HS.lng`; the kernel handles it.
- `SPURIOUS_EXC_DATA_DEBUG` (117649; up to v5, rev 0 of v6 CPUs) and
  `EXC_DEBUG` (143157, 141618; v6 and earlier): data breakpoints fire on
  the first 31 bytes of a 32-byte block falsely, and user debug
  exceptions can arrive in the kernel. gdb watchpoints on our machines
  can trigger spuriously.
- `KERNEL_DATA_MONITOR` (88644; E2S, E8C, E1C+ — the 4C): data-monitor
  events are lost when they overflow under masked interrupts; the kernel
  doesn't profile with the data monitors. `PIPELINE_FREEZE_MONITORS`
  (125405; E8C2, and E2C3/E12C/E16C rev > 0 — the 8C2 and the 2C3): the
  pipeline-freeze feature conflicts with performance monitoring, so the
  kernel turns pipeline freeze off while monitors run. Both bear on
  `profile.py` and `pmu.c` (monitors.md): cycle counts taken under
  monitoring are of a CPU with that feature off.
- Kernel comments outside `cpu_features.h`: the E8C write barrier needs
  a read of a special user-readable page after every acquire load
  (89242, 89495); the E2S needs a memory barrier after write-combining
  stores, so the kernel avoids WC stores there (`page.h`); a
  semi-speculative load from an invalid address took a page miss instead
  of returning a diagnostic value ("illegal page"), so the kernel
  reserves physical page 0 (`boot_init.c`); a `ct` returning to user
  mode can be interrupted with interrupts masked (59886); the trap entry
  needs a minimum `wsz` (68012); no branch may follow the restore of a
  `%ctpr` in the trap exit ("an old one that was not found", and
  `BRANCH_ACTIVATES_CTPR`).
- gdb keeps the patched instruction's `HS.lng` when it plants a
  breakpoint (86419 for `BREAKPOINT_INSTR`, 90514).
- `ITLB_LARGE_PAGES` (152622; up to v6): the ITLB for large pages is
  small, so the kernel maps less of itself with large pages.
- OS-only, listed for completeness: `CLW`, `CLW_STALE_L1_ENTRY`,
  `CLW_LOW_RESTORE`, `CLW_ASYNC*` (the stack-clearing hardware), `SS`,
  `FALSE_SS` (single step), `TRAP_CELLAR_S_F`, `TAGGED_STRQP`,
  `TLB_FLUSH_L1D`, `GIGANTIC_FLUSH`, `USD_ALIGNMENT`, `CR_*` (chain
  register writes), `C3*` (idle states), `WAIT_INT`, `SCLK*`, `LEVEL_EOI`,
  `IOMMU`, DMA, PCIe and memory-controller entries, `HWPOISON`, `LDRD_*`
  (privileged loads), `DIMCR1`, and the virtualization entries (`VIRT_*`,
  `GUEST_*`, `HRET_INTC_CU`, `HCALL_EXC_ILL_INSTR_ADDR`, `INTC_*`).

## What our probes saw [hw?, low confidence]

| Observation | Where | Why it may be a bug | Why it may not be |
|---|---|---|---|
| On the 2C3 a `mova` in a wide instruction without `loop_mode` is SIGILL `ILL_ILLOPC` (the illegal-opcode exception, at the `mova`) while `%lsr` has `vlc` = 1, `lcnt` = 0 and `ldmc` = 0, whatever `ecnt` and `over`: the state every counted loop leaves when it ends (`0xff6000000000` after glibc's and our loops), or a written `0xff2000000000` or `0xff2200000000`. With `vlc` 0 (`%lsr` = 0, or its value at process start, `0xff0000000000`), `lcnt` 1 or more, or `ldmc` 1 the `mova` reads. So a stand-alone program, or a branch loop not counted by `%lsr`, dies after any counted loop has ended (glibc's `strncmp` runs one; `strlen`, a `strstr` that matches at once and a leaf that takes a `ct` leave `%lsr` alone and change nothing), and a counted loop without `loop_mode` dies in its epilogue iterations (`lcnt` 0, `ecnt` > 0, `ldmc` 0), also as the first program of a process. A loop that writes `%lsr` before `bap` and has no epilogue iterations, with or without `loop_mode` (the proof of concept's), never meets it; in a `loop_mode` instruction the same `mova` is disabled instead, as on v3–v5 ([loops.md](loops.md)), which is how lcc's loops, with epilogue iterations or without, keep clear of it: every `mova` of theirs is in a `loop_mode` instruction | 2C3 (v6), both cores, v6.2c3 and v3 builds, the same in every run: `tools/isa-probes/pocchk6.c` `seq` (2026-10-13: 576 processes, each as the rule predicts, then 108 more; 20,000-round runs of the proof of concept's loops). The 4C and 8C2 run every sequence. The earlier description here (a program after another one and a call that takes a `ct`; `apb.c` `cold*`, `isaleft.c` `seq`, 2026-10-12) does not reproduce: the same `isaleft.c` sequences run on both cores on 2026-10-13, and a copy of it that reads `%lsr` before each program finds `0xff0000000000` or `0xff2000000001` there, states in which the rule lets a `mova` run. What its driver's glibc calls left in `%lsr` decided those results (inferred; pocchk6's first driver, which looked each step up with `strcmp`, showed the old pattern) | the trap is undocumented and earlier ISAs don't raise it: the 4C and 8C2 read such a `mova`, MCST's qemu disables a `mova` in this state only in `loop_mode` instructions (`translate-mova.c`), and the guide says nothing | it is deterministic and follows the very condition under which a `loop_mode` `mova` is disabled, so v6 may define it (we have one v6 CPU); no compiler we know issues a `mova` outside a `%lsr` loop, and lcc's loops with `ecnt` > 0, many of them with array prefetch, put every `mova` in a `loop_mode` instruction, where this state disables it instead ([loops.md](loops.md)) |
| An APB area whose increment carried a `mova` 32 GiB past its array (into unmapped memory) made the process spin in the kernel until killed, instead of giving a diagnostic value | 8C2, `apb.c` `incr64` (since changed) | a user program could tie up a core | might be the kernel's fault handling, not the CPU; seen once, not repeated on purpose (apb.md) |
| A compare one instruction before a taken return is not interlocked with a predicated operation or `merge` in the return's instruction: it reads the old predicate, with no stall (or, depending on timing, the new one: an `addd` reader after a compare did in 4 of 4 runs on the 4C and 1 of 4 on the 8C2 on 2026-10-10). An FP compare must be 4 cycles before: 1, 3 and, before a `merge`, 2 read the old value. On the 4C an FP compare 1 cycle before a reader in the instruction before a taken return gives the old value too; the 8C2 doesn't | 4C, 8C2 (`preds.c` `i17_*`, `foldi57_retpred.c`); fixed on the 2C3 for integer compares and logic (FP compares not run there) | every other predicate consumer waits; v6 behaves as one would expect | reproducible and maybe intended on v3–v5 (the guide doesn't say); lcc schedules exactly at the safe distance; timing.md lists it as a hazard to schedule around |
| A prepare (`disp`, `movtd`) and a `ct` through the same CTPR in one instruction: the `ct` doesn't transfer at all on v6 (on v3 and v5 `movtd` + `ct` goes to the old target, and so does a hand-encoded `disp` + `ct`, `foldp122_dispct.c`), although gas accepts the pair from v6 | 2C3 (`ctl6.c`, `bench.py` `movtd_ct`); 4C, 8C2 (`foldp122_dispct.c`, the v3/v5 `disp` case) | gas allowing it suggests it should work | the intended v6 semantics are unknown; perhaps related to `BRANCH_ACTIVATES_CTPR` |
| A loop entered 1–3 cycles after `rwd %lsr` (or `%lsr1`) counts down the old `%lsr` in the iterations issued before the write lands, so it runs a count that depends on what `%lsr` held (8, 7, 6 instead of 5 after a `%lsr` without `vlc`; 1 after a finished loop) | all three (`lsrw.c`; `loops.c` `early*`, which recorded "one too many" on v3/v5 and "one" on v6 before) | the write is not interlocked with the loop | the same on every machine and a fixed rule (4 cycles, loops.md); `rwd %lsr` → `rrd %lsr` is documented as not interlocked (timing.md); the kernel lists `RWD_LSR` for future CPUs; lcc leaves 4 cycles |
| The DAM keeps 32 doubleword entries exactly, but quad entries vary from run to run (33 sometimes kept on the 8C2, up to 44 on the 2C3) | 8C2, 2C3 (`spec.c` `q_cap*`) | the capacity isn't deterministic | replacement may legitimately depend on state we don't control; a lost entry only makes the check reload |
| `aaurrq` of an array descriptor: the high half reads 0 on the 4C, `0x89abcdef` on the 8C2 | `semc.c` | same operation, different results | reading AAU state from user mode may be unspecified |
| Some throughput patterns vary between runs: two stores agreeing in address bits 6–7 and a store plus a load in one 32-byte block (4C), `1 std + 2 ldd` and the store grid (2C3) | `bench.py` `tp` | non-deterministic cost | history-dependent banking is ordinary microarchitecture |
| A speculative `ldqp,sm` (mod 0 or 3) that starts 8 or 4 bytes before a `PROT_NONE` or unmapped page, so that its high half lies wholly in the bad page, returns the low half diagnostic and the high half a clean 0 with tag 0; starting 12 bytes before (the high half straddling), both halves are diagnostic, as every scalar crossing load is | 2C3 (`memx.c` `pcq_ldqpsm`, `pcq_ldqpspec`, every run) | code that uses the high half alone gets a silent 0 instead of a diagnostic value; it resembles the v7 erratum `UNALIGNED_LOADS` (above) | the probe's readout of 16-byte tags (`stqp,sm`, then fills) shows both halves tagged for `ldqp,sm` from NULL; packed code still sees the diagnostic low half, and lcc's v6 code reads past ends only with aligned accesses, which never cross a page |
| `fdivd` every 2 cycles with an FP operation in ALC5 in every gap costs 2.76 cycles a pair instead of 2 | 8C2 (`bench.py` `v5_div*`); gone on the 2C3 | a resource conflict lcc's changelog only hints at (1.26: "FP operations in channel 5 need special scheduling") | a documented scheduling constraint rather than an error |
| With `%bgr.cur` c ≠ 0, a timer signal's frame holds `%g24`–`%g31` shifted by c (`g[8 + j]` = what `cur` 0 names `%g(24 + ((j − c) & 7))`) and after `sigreturn` the code's `%g(24 + n)` holds its old `%g(24 + ((n − c) & 7))`; without a signal, 100 ms of spinning moved them by 1–3 places in 5 of 9 runs | 4C (`tools/abi/probes/kernleft.c` part 2: 26 of 27 signal runs over c = 1–3, 2026-10-13); the 8C2 keeps them in place, the 2C3 does not rename | user values change across kernel entries with no code touching them | the 4C runs MCST's old 6.1-1.9 kernel, which saves `%g16`–`%g31` before resetting `%bgr` (6.1-1.17 moved the save after it), so it may be the kernel's; a user-mode `std` of a rotated global stores the expected register; lcc never touches `%bgr` (kernel-interface.md, "The rotating globals in the frame") |

Not hardware, listed elsewhere: MCST ld's unlinkable `R_E2K_ISLOCAL`,
silent ifunc and static-ifunc failures (elf.md); objdump's `staa`/`ldaa`
decoding bug (bundle.md); the emulators' differences (AGENTS.md,
"Gotchas", and each page's "Emulators" section).
