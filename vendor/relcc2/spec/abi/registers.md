# Registers

## Register file (guide 9.3.1)

The register file holds 256 64-bit registers. Each also has an extended
part: 16 bits on v1–v4, making an 80-bit register for `long double`, and
64 bits on v5+, which also holds 128-bit packed values (lcc-doc). See
"Extended parts and `long double`" below.

| Part | Registers | Addressed as |
|---|---|---|
| Global | 32 | `%g0`–`%g31` (`%dg`, `%qg`), absolute |
| Stack (windows) | 224 | `%r0`–`%r63` relative to the current window base; `%b[0]`–`%b[127]` relative to the rotating base inside the window |

- `%rN` / `%drN` is the 64-bit register N of the window; `%qrN` (even N) is
  the pair N, N+1, low half first.
- A window can be larger than 64 registers, but `%r` addressing reaches only
  the first 64. `%b[]` reaches up to 128 registers from the rotating base.
- `%g24`–`%g31` can rotate (`abg`/`abgc`).

### Window and rotating-base units

The hardware counts these in **pairs of 64-bit registers** ("quad"
units). (kernel `e2k_wd_t`, `e2k_br_t`; unipro, lcc)

| Operation | Field | Meaning |
|---|---|---|
| `setwd wsz=N` | `wsz` | Window size: N pairs (2N 64-bit registers) |
| `setbn rbs=B, rsz=S, rcur=C` | `rbs` | Rotating area starts at pair B (`%b[0]` = `%r(2B)`) |
| | `rsz` | Rotating area size: S + 1 pairs |
| | `rcur` | Current rotation offset |
| `setbp psz=P` | `psz` | Rotating predicate area size |
| `call ..., wbs=W` | `wbs` | The callee's window starts at pair W of the caller's window |

A callee starts with its caller's `%br` (rotating base and predicate
rotation) until it sets its own with `setbn` or `setbp` (hw:
`tools/abi/probes/stackregs.c`; 4C, 8C2, 2C3; MCST's qemu zeroes it at
every call): [stack-and-unwinding.md](stack-and-unwinding.md), "Stack
registers".

Window size limits (Elbrus 4C; `tools/abi/probes/winsize.c`, and the
proof-of-concept backend's probe, finding A2):

- A callee's `setwd wsz` must be **at least the part of the caller's
  window it inherits**, `caller wsz − wbs` pairs; otherwise `setwd` raises
  SIGILL (caller `wsz = 8`: with `wbs = 4` the callee needs `wsz ≥ 4`, with
  `wbs = 6` it needs 2, with `wbs = 7` 1). lcc always hands over exactly 4
  pairs (the 8 argument registers, `wsz = 8`, `wbs = 4`, or `wsz = 0x10`,
  `wbs = 0xc`) and never uses `wsz` below 4, so the convention is: callers
  pass at most 4 pairs, callees use `wsz ≥ 4`.
- The largest window is **112 pairs** (224 registers, the whole stack part
  of the register file), also after spills; 113 traps. Registers above
  `%r63` are reachable only through `%b[]`.
- **A function may not call with a `wbs` smaller than what it
  inherited** (guide 9.5.3, "Переключение регистровых файлов": `wbs`
  may be neither larger than the current window nor smaller than its
  initial size, the parameter area). A function that inherited Q pairs
  must call with Q ≤ `wbs` < `wsz`. A smaller or larger `wbs` makes the
  `call` itself raise the window-bounds exception (TIR bit 9): SIGSEGV
  `SEGV_BNDERR` (`si_code` 3) with `si_addr` and the interrupted IP at
  the `call`, so nothing of the callee runs, and a system call fails
  exactly like an ordinary call. With `wbs` = `wsz` (no pair handed
  over) the same signal comes at the callee's first instruction [hw:
  `tools/abi/probes/pocabi2.c` `wbs` and `cross`: frames that inherited
  Q = 1–4 pairs call with `wbs` = W = 0–5 or 8, handing over P = 1–4
  pairs to `getpid` and `close` (entry 3), fast calls 6 and 2 (entry
  6) and ordinary functions; all 337 cases are SIGSEGV exactly when
  W < Q, whatever P; 4C, 8C2, 2C3. TIR bit 9 is kernel
  `include/asm/trap_def.h:36`; `kernel/traps.c:1097-1118` sends SIGKILL
  instead when the trap is at a kernel IP]. A C function
  inherited 4 pairs, so all its calls, system calls included, need
  `wbs ≥ 4`, and a function that makes a system call has a window of at
  least 4 + the pairs it hands over (8 for the usual 4). lcc never goes
  lower: its `%#` is 4 at `-O0` and 5 above
  ([source-compat.md](source-compat.md)), and the smallest `wbs` among
  the 51,808 `call`s in lcc 1.29.16's v3 `libc.so.6`, `libm.so.6` and
  `libstdc++.so.6` is 4 [lcc]. (The proof-of-concept back end's leaves
  called `getpid` with `wsz = 5`, `wbs = 1` and died: its A25.) In a
  recursion with one window size W and one `wbs` the callee inherits
  W − `wbs`, so `wbs ≥ W / 2` works and every smaller `wbs` gets the
  signal at the second nested call (W 16: `wbs` 8 works, 7 dies; W 32:
  16 works, 15 and 12 die; depth 1 always works; 4C, 8C2, 2C3,
  `tools/isa-probes/pocchk2.c` `rec*`; the proof-of-concept back end's
  I32). The convention (hand over 4 pairs, call with `wbs ≥ 4`) never
  breaks it.
- gas accepts `rbs` 0–63 only.
- Operations in the wide instruction with `setwd` may already use the new
  window: `{ setwd wsz = 8; addd %r0, 5, %r12 }` works (lcc puts `getsp
  ..., %r3` there), but `%b[]` in the instruction with `setbn` still uses
  the old rotating base. (MCST's qemu applies the new base there, so code
  that writes an argument register next to its `setbn` works under qemu
  and fails on hardware: a recursion written so dies with
  SIGSEGV at once on the 4C; `tools/abi/probes/sysabi.s`, `sa_down`.)
  lcc fills that instruction (lcc 1.29.16 `-O3`, Lua 5.4.7's 724
  functions, v3 and v6.2c3 alike within a few functions; the
  proof-of-concept back end's P73). Besides `setwd` it holds `setbn`
  (618 functions) or `setbp` (76), `getsp` (649; always ALC0, the only
  channel it has), a prepare (706: a `disp` to the first callee or
  `return %ctpr3`), loads through the argument registers (361: up to
  three beside `getsp`, which takes ALC0, four without it) and up to
  five integer operations, mostly constants for later: 2 to 10
  operations in all. Nothing there reads `getsp`'s result, which reaches
  an integer operation 2 cycles later
  ([timing.md](../isa/timing.md)) [lcc].

What windows cost (`pocchk2.c`, `%clkr`; 4C, 8C2 and 2C3 alike; the
proof-of-concept back end's I31):

| Case | Cycles |
|---|---|
| `disp` + `call` + `return`/`ct` of an empty leaf, caller window 16 pairs, callee 4, 8, 16, 32 or 64 pairs | 14.1 |
| the same, callee 112 pairs (caller and callee no longer fit the register file) | 32.4 |
| recursion, a level (call and return), handing over 4 pairs (`wbs` = W − 4), depth 8 / 32: W 8 | 17.6 / 18.1 |
| W 16, 32, 48, 64, 112 | 20.4 / 30.2, 47 / 55, 74 / 80, 101 / 104, 182 / 192–208 |
| W 48 or 40 with `wbs` 28 (keeping 28 pairs below the callee, as W 32) | 48.5–50 / 55.5 |
| `setwd` to the same size twice in a function | free |
| `setwd` 16 → 32 pairs and back | about 3 cycles for the pair |

Window size is free while the windows of the active calls fit the
register file; once they don't, a call and its return cost about
15 + 1.6 × `wbs` cycles, the part of the caller's window below the
callee being spilled and filled; the callee's own size doesn't matter.
So in deep call chains what costs is the pairs each frame keeps below
its callee; a function that calls should keep its window small at its
calls, but each grow and shrink costs about what the spills do (lcc
grows the window with a second `setwd` only around a pipelined loop).
In real programs the spills are small: the proof-of-concept back end
measured 0.54% of xz -6's cycles in `BUB_B_RF_SPILLFILL` on the 8C2
(windows of 48–55 pairs on its hot chain; lcc's 17–27 never spill) and
0.30% of 7-Zip's benchmark for lcc.

`setwd` also sets two window flags (qemu, kernel):

- **`nfx`**: the kernel's `WD.fx` is its inverse. With `nfx = 0` the
  hardware saves and restores the extended parts of the window's
  registers when spilling; with `nfx = 1` it does not, and a spilled
  window comes back with them 0, stale or, by chance, right (hw, qemu:
  `tools/abi/probes/ldouble.c`; hw: `pocabi2.c`). The extended parts
  are the 16-bit part of an 80-bit value (`movif` … `movfi`) and, on
  v5+, the high half of a 128-bit register. What became of a 16-bit
  part held in a window register of an `nfx = 1` function [hw:
  `tools/abi/probes/pocabi2.c` `ext`, several runs a machine, five
  values a case unless counted]:

  | While the value was held | 4C (v3) | 8C2 (v5) | 2C3 (v6) |
  |---|---|---|---|
  | a call 1,000 levels deep (the window spills) | lost: 0 or stale (`0x0005`, `0x004d`, `0x8690`, …) | lost: 0 | kept, except in a process's first deep call or two (0) |
  | a SIGSEGV whose handler fixes the page and returns | kept: 2 of 65 lost | lost: 0, 25 of 25 | lost: 0, 25 of 25 |
  | the same in a 96-pair window | 16 of 25 lost | 10 of 10 lost | 10 of 10 lost |
  | a SIGSEGV whose handler first recurses 1,000 levels | lost (0) | lost (0) | lost (0) |
  | SIGALRM every 100 µs, holds of about 100,000 cycles | 18 of 12,000 holds lost (21,576 signals) | 6,281 of 8,000 (6,264 signals) | 4,477 of 8,000 (4,490 signals) |
  | no signal, holds of 2 million cycles (timer interrupts; on the 8C2 also time-sliced with another process) | 1 of 2,000 lost | 4 of 4,000 | 0 of 3,000 |
  | a page fault without a signal; system calls `getpid`, `sched_yield`, `nanosleep (1 ms)` | kept | kept | kept |

  With `nfx = 0` none of these lost it on any machine, and values in
  `%g16` and `%g20` came through the SIGSEGV cases intact under either
  setting (the kernel restores `%g16`–`%g31` after a handler,
  [kernel-interface.md](kernel-interface.md), "Signals"). On the 4C a
  handler loses it when its frames push the interrupted window out of
  the register file (a handler that recurses, a big interrupted window;
  inferred), and about once in 1,200 signals otherwise; on the 8C2 and
  2C3 every handler that runs while it is held does. The 128-bit high
  half is lost too: with `nfx = 1` it read 0 after a signal handler had
  run while the function held it (3 of 3 runs on each machine); after
  a call 1,000 levels deep it read, on the 8C2, a copy of the
  register's own low half once and 0 twice, and on the 2C3 0 in the
  process's first deep call and the right value after, as its 16-bit
  part does (the table); with `nfx = 0` it survived both (hw:
  `tools/isa-probes/isaleft.c` `qspill`, 8C2 and 2C3, three runs each).
  In `foldi55.c`'s runs on the 8C2 every high half of an `nfx = 1`
  window, written as 128 bits, as 64 or not at all, read 0 with tags 0
  after a 1000-deep call or a SIGSEGV handler. The 80-bit part in the
  table was lost to timer interrupts in holds without a deep call (4 of
  4,000 on the 8C2, also time-sliced there); the 128-bit high half was
  lost to interrupts and context switches only after a deep call had
  returned (the frames below the function no longer in the register
  file; inferred): with a process pinned to the same CPU waking every
  50 µs in 2,983–2,999 of 3,000 holds of 0.4 ms, with timer interrupts
  alone in about 300 of 3,000, and across a blocking `nanosleep`. These
  left 0, tags 0, or now and then (0–39 holds of 3,000 a case; 2
  `nanosleep` runs of 3) a copy of the register's own low half with its
  tags, where the deep call or the handler alone left 0, tags 0 in these
  runs (qspill's one copy on the 8C2 aside). With the caller's frames
  still resident no hold lost it (about 10,500 switches), nor did
  `getpid` or `sched_yield`; with `nfx = 0` nothing was lost [hw:
  `tools/abi/probes/foldi55.c` `spill`, `sig`, `sys`, `ctx`; 8C2]. So
  any extended value in a window register needs `nfx = 0` in the
  function that owns the window, however briefly it is held (between a
  `movif` and its `movfi`) and whether or not the function calls: a
  signal, and now and then an interrupt, can come anywhere (the
  proof-of-concept back end's A26). lcc clears it in every function that
  computes with an 80-bit value (`movif`, `fdtofx`, `istofx`, `fx*`
  arithmetic, conversions and compares), leaves included and also when
  the value sits only in `%g16`/`%g17`. A function that only moves a
  `long double` as its two 64-bit parts (arguments returned, stored or
  passed on, call results returned, copies through memory) holds no
  extended value and gets `nfx = 1` on its own, but from `-O1` on it may
  inherit `nfx = 0` from the function before it in the file when that
  one had it [lcc 1.29.16 `-O3`, v3, v5.8c2, v6.2c3, and 1.31.05:
  `tools/abi/probes/pocabi2_nfx.c`]. Which functions inherit it isn't
  about `long double`: one that only returns a constant or one loaded
  value, stores an argument (`*p = x`) or passes a loaded value to a
  call inherits `nfx = 0`, whatever its types, and passes it on to the
  next, while one that computes (an `int` `x + 3`, the sum of two
  loads), copies through memory (`*a = *b`, a `long double` too at
  `-O3`; at `-O1` and `-O2` lcc copies one through `movif`/`movfi` and
  clears `nfx` for that) or stores a constant (`*p = 0`) gets `nfx = 1`
  and stops it [lcc 1.29.16 `-O1` to `-O3` and 1.31.05 `-O3`, v3,
  v5.8c2, v6.2c3: `tools/abi/probes/pocabi1_nfx.c`, `pocabi2_nfx.c`].
  The functions that stop it build a value in `%g16` first, the ones
  that inherit it use only their window registers (inferred from the
  listings). Unipro's clang clears it in exactly the functions that
  compute with an 80-bit value (unipro 20.1.8 `-O2 -march=elbrus-v3`,
  `pocabi2_nfx.c`). lcc's v5 and v6 code also clears it in every
  function that uses a 128-bit register, leaves included (16-byte
  atomics too: atomics.md, "16-byte atomics"), with the same carry-over
  into the functions after it, and across a call it keeps a 128-bit
  value in its stack frame, not in a register (lcc 1.29.16 `-O3`, small
  vector-type functions).
- **`dbl`** (v3+): with `dbl = 1`, 32-bit integer ALU operations
  zero-extend their result into the whole 64-bit register; with
  `dbl = 0`, they write only the low half and leave the upper half
  (including its tag) unchanged. The flag is saved and restored per frame
  (`cr1_hi.wdbl`). Unipro always uses `dbl = 1`. lcc chooses per
  function (lcc 1.29.16 and 1.31.05): `dbl = 0` without optimisation,
  and at `-O2` and above `dbl = 1` in functions whose unsigned 32-bit
  results must be zero-extended (an `unsigned` sum returned or used as an
  index, `unsigned` → `unsigned long`), which saves the extension;
  signed code keeps `dbl = 0` and uses `sxt`. In 400 of GCC's
  `gcc.c-torture/execute` tests at `-O2`, 387 of 2,102 functions had
  `dbl = 1` (386 with 1.31.05); at `-O0` none. Code must not rely
  on the upper half of a 32-bit result either way. Measured on the 4C
  (`tools/abi/probes/dbl.c`, hw; MCST's qemu agrees):

  | Operation | `dbl = 0` | `dbl = 1` |
  |---|---|---|
  | the whole 32-bit integer ALU group: `adds`, `ands`, `andns`, `shls`, `sars`, `scls`, `muls`, `sdivs`, `udivs`, `getfs`, `merges` (either predicate value), `popcnts`, `lzcnts`; also predicated (`? %pred`, when it writes) and speculative (`,sm`) | upper half kept | zero-extended |
  | the 32-bit combined integer operations (`add_adds`, `shr_ands`, `and_ors`, `xor_xors`, …) | upper half kept | zero-extended (`tools/isa-probes/pocchk.c`; 4C, 8C2, 2C3) |
  | the x86 flag forms' 32-bit flags word (`adds_fw`, `addd_fd`, `ands_fw`, and `smulx_fw`, although its result arrives on the FP side as `fadds`'s does, timing.md) [hw: `tools/isa-probes/pocchk4.c` `dbl`; 4C, 8C2, 2C3] | upper half kept | zero-extended |
  | `ldw` | zero-extended | zero-extended |
  | `sxt` | 64-bit result | 64-bit result |
  | FP-unit operations with a 32-bit result: `fadds`, `fstois`, `fdtois`, `fstoistr`, `movts` | upper half kept | upper half kept |
  | the tag operations with a 32-bit result, `gettags`, `gettagd`, `puttags` [hw: `tools/isa-probes/tagx.c` `gts_upper`, `gtd_upper`, `ps_upper`; 4C, 8C2, 2C3] | upper half kept | not checked |
  | `rrs` of a state register [hw: `tools/isa-probes/sregs.c` `width`; 4C, 8C2, 2C3] | low half written, upper half kept | 32-bit registers (`%pfpfr`, `%fpcr`, `%fpsr`, `%upsr`, `%core_mode`) and `%idr` (whose value fits in 32 bits): zero-extended. 64-bit ones (`%clkr`, `%ip`): the low half zero-extended on the 8C2 and 2C3, but **the whole 64-bit value on the 4C** (`rrs %ip` gives a PIE's full address there) |
  | `rrd` of a 32-bit state register | zero-extended | zero-extended |

  This holds for every register the operation writes, the globals
  `%g0`–`%g31` included (`adds`, `muls` into `%g20`). The table is from
  `tools/abi/probes/dbl.c` (generated by `gen_dbl.py`) on the 4C and the
  Elbrus-8C2, which agree (the proof-of-concept back end's findings I16,
  A18 rechecked), except the rows that name another probe.

  `rrs` and `rrd` of `%pfpfr`, `%fpcr`, `%fpsr`, `%upsr`, `%core_mode`,
  `%idr`, `%clkr` and `%ip` assemble and run in user mode on all three
  machines, and their results have no tags [hw:
  `tools/isa-probes/sregs.c` `width`, plus a PIE build for `%ip`]. To
  get a zero-extended FP control or status word, use `rrd` (any `dbl`)
  or `rrs` under `dbl = 1`. Under `dbl = 0`, `rrs` leaves the caller's
  upper half in place. MCST's qemu and the community qemu zero-extend
  under `dbl = 1` (as the 8C2 does).

  MCST's qemu limits `dbl` to the integer operation group plus `gettags`,
  `puttags` and `rrs` (`operations-descr.h`, `e2k_get_eff_dst_type`). The
  community qemu applies it to every 32-bit ALU result except `movt*s`
  (`translate.c`, `is_alop_affected_by_dbl`), which disagrees with the
  hardware for `fadds`.

## Conventions

| Register | Convention | Source |
|---|---|---|
| Window registers | Saved automatically by the call mechanism, except the parameter area, which a call may change | guide 9.3.1.2 |
| `%g13` | Thread pointer (TLS) | guide 9.3.1.4 |
| `%g12` | Reserved by the guide; used as the **static chain** by MCST's libffi (its closure trampolines load the closure address into `%g12` and jump; Go closures receive it there; its testsuite defines `STATIC_CHAIN_REG "%g12"`). In protected mode it is the thread pointer ([protected-mode.md](protected-mode.md)) | guide 9.3.1.4, libffi |
| `%g0`–`%g11`, `%g14`, `%g15` | Scratch across calls, but **not for temporaries**: a signal handler's writes to them reach the interrupted code (below) | kernel, hw |
| `%g16`–`%g31` | Scratch: not preserved across calls, and **emptied (0, tag 5) by system calls** through entry 3; fast calls may change `%g26`–`%g31` ([kernel-interface.md](kernel-interface.md), "System calls"). Saved and restored around signal handlers that interrupt code outside a system call, so usable for temporaries between calls (lcc's code uses these and never `%g0`–`%g15`). MCST's kernel keeps its own state in `%g16`–`%g25` while in the kernel and uses `%g26`–`%g31` as scratch ([kernel-build.md](kernel-build.md), "Global registers") | kernel, hw, lcc |
| Predicates `%pred0`–`%pred31` | Saved and restored automatically: the caller's come back whatever the callee writes. The callee starts with a copy of the caller's values and tags (hw: `tools/isa-probes/preds.c` `call_*`, `isaleft.c` `pt_seen`; the guide says only "a new predicate file"), so it must write a predicate before reading it: an inherited one may be diagnostic, and a plain use of that is SIGILL ([predicates.md](../isa/predicates.md)) | guide 9.3.2, 9.5.3, hw |
| `%ctpr1`–`%ctpr3` | Scratch: not preserved across calls. Returns go through `%ctpr3` | guide 9.3.3 |
| `%lsr`, `%ilcr` (loop status, counter) | Scratch | guide 9.3.4 |
| `%fpcr`, `%fpsr`, `%pfpfr`, `%upsr` | Special: a function that changes them must restore them. **`UPSR.fsm` (bit 8) is never changed**: processes start with it clear, and with it set the FP predicate compares give x86 results for NaN operands (semantics.md), so code may assume it is clear (owner's decision, 2026-10-11) | guide 9.3.4 |
| `WD`, `BR`, `USD`, `CUD`, `GD`, `CUIR`, `TSD`, `IP` | Saved and restored automatically | guide 9.3.4 |

The kernel saves all globals on context switch, but around a user signal
handler it saves and restores only `%g16`–`%g31`, which it calls "local"
(`arch/e2k/include/asm/glob_regs.h`, `kernel/signal.c`:
`sig_save_local_gregs`, `sig_restore_local_gregs`); `%g0`–`%g15` are
"global for user applications according to ABI" and keep whatever the
handler leaves in them. The guide (9.3.1.4) says all other globals are
saved around handlers, which is wrong for the 6.1 kernel: on the 4C,
the 8C2 and the 2C3 a handler that writes `%g1` and `%g16` changes the
interrupted code's `%g1` and not its `%g16` (`tools/isa-probes/pocchk.c`;
the proof-of-concept back end, which kept temporaries in `%g0`–`%g11`,
crashed under signals until it moved them). So compiler temporaries
belong in `%g16`–`%g31`, as lcc does, and `%g0`–`%g15` are for values
meant to be global (as `%g12`, `%g13`; the kernel also decodes a
`getsp` amount only from `%g16` on, elf.md). A signal delivered at the
end of a system call returns to code whose `%g16`–`%g31` the system call
has already emptied: `sigreturn` puts the frame's values back only for
code interrupted outside a system call [hw: `tools/abi/probes/ctxsig.c`
section 2; [kernel-interface.md](kernel-interface.md), "Signals"].

## Floating-point control and status (kernel, glibc)

Three 32-bit registers, read with `rrs` and written with `rws`
(kernel `cpu_regs_types.h`: `e2k_pfpfr_t`, `e2k_fpcr_t`, `e2k_fpsr_t`;
glibc `sysdeps/e2k/fpu`). Which bits each one keeps was found by
writing and reading them on the 4C, 8C2 and 2C3 [hw:
`tools/isa-probes/sregs.c` `write` (with `es2`) and `fp`]; MCST's qemu
keeps the same bits of `%pfpfr` and `%fpcr`, but stores `%fpsr`'s `es`
and `bf` and never computes them or C1 [source: qemu
`target/e2k/cpu-sregs.h`]. The exception bits are in the x87 order in
all three: invalid, denormal, divide by zero, overflow, underflow,
precision (inexact); glibc's `FE_*` values are those bits (`FE_INVALID`
0x01, `FE_DIVBYZERO` 0x04, `FE_OVERFLOW` 0x08, `FE_UNDERFLOW` 0x10,
`FE_INEXACT` 0x20; denormal 0x02 has no `FE_` name).

| Register | Used by | Bits |
|---|---|---|
| `%pfpfr` | `float`, `double`, packed | 0–5 flags (`ie de ze oe ue pe`); 6 `daz` (denormals are zero; the kernel's `e2k_pfpfr_t` calls it `zero1`, MCST's qemu `daz`) [hw]; 7–12 masks (`im dm zm om um pm`, 1 = masked, i.e. flag << 7); 13–14 rounding (0 nearest, 1 down, 2 up, 3 toward zero: `FE_DOWNWARD` 0x2000 ...); 15 `fz` (flush to zero) [hw]; 16–25 read 0; 26–31 `die dde dze doe due dpe` can be written, but nothing sets, clears or reads them ([speculation.md](../isa/speculation.md), "Speculative operations"). Bits 0–15 are x86 MXCSR's layout, and the operations follow SSE exactly ([semantics.md](../isa/semantics.md), "Rounding modes, flush to zero and denormals are zero") |
| `%fpcr` | 80-bit (x87 control word) | 0–5 masks (`im` ... `pm`); 6 always 1; 7 and 13–15 read 0; 8–9 precision control; 10–11 rounding (`FE_FPCR_DOWNWARD` 0x400 ...); 12 `ic` can be written but has no effect: infinities stay affine (with `ic` set `fxcmpudxf` still orders them: `inf` > 1, `-inf` < `inf`), as on x87 since the 387 |
| `%fpsr` | 80-bit (x87 status word) | 0–5 flags; 9 `c1` ([semantics.md](../isa/semantics.md), "80-bit operations"). 7 `es` (error summary) and 15 `bf` are **not stored**: both read 1 exactly when a flag in bits 0–5 is set whose mask in `%fpcr` is clear (checked with each mask cleared alone), and they follow `%fpcr` writes alone (`%fpsr` 0x3f reads 0x80bf under `%fpcr` 0x340 and 0x003f under 0x37f). x87's C0, C2, C3 and TOP (8, 10–14) do not exist and read 0. Bit 6 (x87's stack fault) is stored on the 2C3 only, does not set `es`, and no operation sets it |

glibc keeps the two sets in step: `fenv_t` is `{ __fpcr, __fpsr,
__pfpfr }`; `feholdexcept` saves all three, then sets every mask in
`%pfpfr` and `%fpcr` and clears the flags in `%pfpfr` and `%fpsr`;
`feenableexcept` clears mask bits in both `%pfpfr` (`excepts << 7`) and
`%fpcr`. A compiler that saves and restores the FP environment (GCC's
`TARGET_ATOMIC_ASSIGN_EXPAND_FENV`, for C11 atomic compound assignment
of floating types) must do the same for both pairs, since `long double`
uses `%fpcr`/`%fpsr`. Processes start with all six flags set
(`%pfpfr` 0x1fbf, `%fpsr` 0x3f; speculation.md), so code (and tests)
must not assume clear flags at startup. (Found by the proof-of-concept
backend, finding P7.)

**Traps** [hw: `tools/isa-probes/sregs.c` `fp`, the three machines;
kernel `arch/e2k/kernel/traps.c:1845-1885`]. `float`, `double` and
packed operations raise SIGFPE when the exception's mask in `%pfpfr` is
clear, whatever `%fpcr` says. 80-bit operations raise it when the mask
in `%fpcr` is clear, whatever `%pfpfr` says. Neither kind reads or sets
the other register's flags. The trap is precise: `si_addr` is the wide
instruction that holds the operation, and the handler finds the new
flag set. There is no x87-style deferred trap: an exact `fx*` operation
runs normally when an unmasked flag is already set in `%fpsr`. With an
underflow unmasked, an 80-bit operation traps on a tiny result even if
it is exact, as x87 does. The kernel's `do_fp` derives `si_code` from
every flag that is set, not from the one that trapped. If `%fpsr.es` is
set it decodes `%fpsr`; otherwise it decodes `%pfpfr`:

| Exception | `%pfpfr` trap, flags clear before | `%fpcr` trap, flags clear before | any trap, all six flags set before |
|---|---|---|---|
| invalid | `FPE_FLTINV` 7 | 7 | `FPE_FLTRES` 6 |
| divide by zero | `FPE_FLTDIV` 3 | 3 | 6 |
| overflow (the trap leaves inexact clear) | `FPE_FLTOVF` 4 | 4 | 6 |
| underflow | 6 (`fmuld` sets underflow and inexact) | `FPE_FLTUND` 5 | 6 |
| denormal | 5 | 5 | 6 |
| inexact | 6 | 6 | 6 |

A `%pfpfr` trap taken while `%fpsr` holds an unmasked flag gets
`%fpsr`'s code (`faddd` inexact with `%fpsr` = 0x01 and `%fpcr` 0x340
reports `FPE_FLTINV`). So `si_code` is reliable only when the flags
were clear before the operation. Processes start with all of them set,
so a handler that needs the cause should read the flags itself
(inferred).

**Flush to zero and denormals are zero** [hw: `tools/isa-probes/fenvlib.c`,
all three machines]. MCST's libgcc has a `crtfastmath.c` whose
constructor (a `.ctors` entry: `rrs %pfpfr`, `ors 0x8040`, `rws`) sets
`%pfpfr` bits 6 and 15 ("mcstbug #149583"; built by libgcc's
`config.host:591-593`). lcc's driver links `crtfastmath.o`, just before
`crtend.o`/`crtendS.o`, for `-ffast-math`, `-Ofast` and
`-funsafe-math-optimizations`, **also with `-shared`**, and with
`-static`. It doesn't for its own `-ffast`, nor for
`-ffinite-math-only`, `-fno-math-errno`, `-freciprocal-math`,
`-fassociative-math -fno-signed-zeros -fno-trapping-math` or `-O4`;
`-ffast-math -fno-fast-math` and `-nostartfiles` drop it, `-ffast-math
-fno-unsafe-math-optimizations` and `-ffast-math -fno-finite-math-only`
keep it [lcc 1.29.16 v3 `-v`; 1.31.05 the same for the options tried].
Such programs start with `%pfpfr` 0x9fff instead of 0x1fbf, and loading
such a library changes the process [hw: `tools/abi/probes/pocabi1_fm.c`,
lcc 1.29.16 v3 code on the 4C, 8C2 and 2C3, all alike]: after `dlopen`
of an lcc `-ffast-math -shared` library, the thread that loaded it reads
0x9fff and flushes `1e-310 * 1.0` and `1e-300 * 1e-10` to 0, threads it
creates afterwards inherit that, a thread already running keeps 0x1fbf,
and `dlclose` doesn't undo it; a program linked against such a library
starts `main` with 0x9fff. GCC's ports leave `crtfastmath.o` out of
shared objects for this reason (x86 since 2022, PR 55522;
`doc/gcc-port-plan.md`, 3.1). The proof-of-concept back end found the
`-shared` case (finding A28). glibc's `fesetround`,
`feclearexcept`, `feholdexcept`, `feupdateenv`, `feenableexcept`,
`fegetenv` and `fesetenv` of a saved environment keep both bits;
`fesetenv (FE_DFL_ENV)` and `fesetenv
(FE_NOMASK_ENV)` clear them.

### MCST glibc's FP bugs

MCST's glibc, which lcc's sysroot and the machines ship, has these
bugs. A port's programs and tests meet them through the C library,
whatever code the port generates.

**glibc's `fesetenv (FE_DFL_ENV)` is wrong** [hw, glibc
`sysdeps/e2k/fpu/fesetenv.c`]: it means to mask every exception
(`/* … все их маскируем */`) but writes `FE_ALL_EXCEPT << 7` to
`%pfpfr` (0x1e80) and `FE_ALL_EXCEPT` to `%fpcr` (0x3d, read back as
0x7d), and `FE_ALL_EXCEPT` lacks the denormal bit. Afterwards the
denormal exception is unmasked in both registers (`1.0 + 4.9e-324`
raises SIGFPE with si_code 5, `FPE_FLTUND`, or SIGILL in lcc `-O2` code,
whose speculative FP operations turn it into a diagnostic value), and
`%fpcr`'s precision control is 0, single: `long double` `1.0L / 3.0L`
gives `0xa.aaaabp-5` instead of `0xa.aaaaaaaaaaaaaabp-5` until the
environment is restored (processes start with `%fpcr` 0x37f). A test
suite that calls `fesetenv (FE_DFL_ENV)` sees both. A compiler's
`-ffast-math` startup should do what lcc's does (link MCST's
`crtfastmath.o`).

**MCST's `fmod`, `remainder` and `remquo` hang in `FE_DOWNWARD`** [hw:
`tools/abi/probes/libmchk.c` `fmod`, on the 4C (ALT's glibc 2.35), the
8C2 and the 2C3 (their libm is byte-identical to that of lcc 1.29.16's
v5.8c2 and v6.2c3 sysroots), and `libmchk.c` `remquo` on the 4C and the
8C2; the static `libm.a` and lcc 1.31.05's glibc 2.41 behave the same;
glibc `sysdeps/e2k/fpu/e_fmod.c:17-21,27,
61-64,69,78-81,84-96,114-117`, `e_remainder.c:19-23,29,39,76,91-101,122`,
`e_fmodf.c:26,64,99`, `e_fmodl.c:21,61-68,82`, `f2c.h:24,41`,
`sysdeps/ieee754/dbl-64/s_remquo.c:49-50,103-107`]. MCST's own `fmod`
and `remainder` (which halves x first) subtract multiples of y from x
in chunks. The loop runs while x's bit pattern, read as an
unsigned 64-bit number, exceeds y's by more than 26 exponents (31 in a
v6 build). When rounding down, an exact step `x − q·y` gives −0 (IEEE
754's sign for an exact zero difference in that mode). Its pattern,
0x8000000000000000, passes the bound, and further steps leave −0 as it
is, so the call never returns. This happens with `fmod (±0x1p52, 2.0)`,
`fmod (0x1p40, 2.0)`, `fmod (0x1p1023, 0.5)` (through the path that
first reduces by y·2¹⁰²²) and `remainder (0x1p52, 2.0)` on all three
machines, and with `fmod (0x1p30, 2.0)` on the 4C and 8C2 only (the
2C3's libm is a v6 build).

Where the call returns, an exact zero has the wrong sign. For a
positive x the step's −0 is the result; for a negative x the code puts
x's sign on by adding the sign bit to the result's pattern
(`absx.llong += ret.llong`), which turns that −0 into +0. So when
rounding down `fmod (8.0, 2.0)` is −0 and `fmod (-8.0, 2.0)` is +0,
where C wants the sign of x. `fmodf`, `fmodl`, `remainder`,
`remainderf` and `remainderl` do the same, but never hang: their
`float` and `long double` loops compare signed numbers (`LL`, or `LI`
loaded from a signed `short` exponent), which −0 makes negative. Every
exact zero we tried came out with the wrong sign except `fmod (0x1.8p40,
3.0)`, whose last step leaves y, which the code replaces with +0.
Nonzero results are right, and so is every result in the other three
rounding modes (checked against Python's `math.fmod` and
`math.remainder`).

`remquo` takes the same loop. MCST has no `remquo` of its own, and
glibc's generic one first reduces x with `__ieee754_fmod (x, 8 * y)`
(`remquo` in the 4C's and the 8C2's libm.so.6 calls `__fmod_finite`).
So when rounding down, `remquo (±0x1p52, 2.0)`, `(0x1p40, 2.0)`,
`(0x1p1023, 0.5)` and `(0x1p33, 2.0)` never return on the 4C and the
8C2 (`fmod (0x1p33, 16.0)` is the case of `fmod (0x1p30, 2.0)`), and
`remquo (0x1p30, 2.0)` returns; the 2C3 was not run. Unlike `fmod`'s,
its zero results have the right sign (it replaces a zero by +0 and then
puts x's sign on), and the quotient bits are right. `remquof` and
`remquol` go through `fmodf` and `fmodl` and return. A test that calls
`fmod`, `remainder` or `remquo` in `FE_DOWNWARD` can hang on E2K, for
example when it uses them as the reference for a rounding-mode test.

**MCST's libm needs the sticky FP flags set** [hw:
`tools/abi/probes/libmchk.c` `sqrt` and `err`, on the 4C, 8C2 and 2C3,
lcc 1.29.16 `-O3`, `-O0`, `-O3 -fno-spec-fp` and `-O3 -static`; lcc
1.31.05 `-O3 -static` and, on the 8C2, the shared glibc 2.41; libm.so.6
of lcc 1.29.16's v3 sysroot and the 8C2's, disassembled; glibc as
cited]. lcc builds glibc with its default `-fspec-fp` (MCST's Makefile
turns it off for a few files, `sysdeps/e2k/fpu/Makefile:1-20`). A
speculative FP operation that would set a flag that is clear gives a
diagnostic value instead ([speculation.md](../isa/speculation.md),
"Speculative operations"). Processes start with all six flags set, so
libm works. After `feclearexcept`, the shared libm dies with SIGILL
`ILL_ILLOPN`, either inside libm or at the caller's first use of the
diagnostic value it returns:

| Flags cleared | Calls that die | Calls that still work |
|---|---|---|
| `FE_INVALID` | `sqrt (-1.0)`, `sqrt (-INFINITY)`, `sqrtf (-1.0f)`, `sqrtl (-1.0L)`, `fmod (1.0, 0.0)`, `fmod (INFINITY, 1.0)`, `fmodf (1.0f, 0.0f)`, `fmodl (1.0L, 0.0L)`, `pow (-1.0, 0.5)`: inside libm | `acosh (0.5)`, `atanh (2.0)`, `remainder (1.0, 0.0)` (NaN, EDOM, invalid set); the domain errors of the next paragraph (no flag); valid operands |
| `FE_INEXACT` | `sqrt (2.0)` and `sqrtf (2.0f)` return a diagnostic value (the 2C3's `sqrtf` traps inside libm); `sqrtl (2.0L)` dies inside libm | exact roots; negative operands |
| `FE_ALL_EXCEPT` | all of the above, and `sin (1.0)`, `exp (1.0)`, `acos (0.5)`, `atan (1.0)`, `pow (2.0, 0.5)`, `hypot (1.0, 1.0)`, `fmod (5.5, 2.0)`, `remainder (5.5, 2.0)` | `log (2.0)`, `cbrt (2.0)` (inexact set); exact roots; `acosh (0.5)`, `atanh (2.0)`, `remainder (1.0, 0.0)` and the domain errors, as in the first row |

The square roots and the domain errors of `sqrt`, `fmod` and `pow`
fail because of how the shared library is built:

- libm's base version is GLIBC_2.2
  (`sysdeps/unix/sysv/linux/e2k/shlib-versions:1`), so
  `LIBM_SVID_COMPAT` holds (`math/math-svid-compat.h:76`) and `sqrt` is
  the SVID wrapper of `math/w_sqrt_compat.c:30-42`.
- Inside glibc, `__ieee754_sqrt` is an `asm_inline`
  (`sysdeps/e2k/fpu/bits/mathinline.h:45-51,290-293`), which lcc
  schedules like its own code. It if-converts the wrapper and makes the
  root `fsqrtid,sm` and `fsqrttd,sm` (libm.so.6 of lcc 1.29.16's v3
  sysroot, 0x190c0; `sqrtf`'s `fsqrts,sm` at 0x21098).
- The error path jumps to `__kernel_standard`. Its `zero/zero` for
  `sqrt`, `fmod` and `pow` sits under a test of the `_LIB_VERSION`
  variable (`sysdeps/ieee754/k_standard.c:38-42,568-571,603-606,
  622-625`). lcc computes it as `fdivd,sm 0x0, 0x0` and stores it into
  its `struct exception` with a plain `std`, and that store traps
  (libm+0x1c8f8 and +0x1cac0 on the 8C2). The 0/0 of `remainder`,
  `acosh` and `atanh` is unconditional (`k_standard.c:641,657,673`), a
  plain `fdivd` that raises invalid, so those work.
- `sqrtf` and `sqrtl` end up there too (`k_standardf.c:31`,
  `k_standardl.c:108`). MCST's Makefile builds `k_standardl.c` with
  `-fno-spec-fp` ("Bug #118896", `sysdeps/e2k/fpu/Makefile:12-13`) but
  not `k_standard.c`.

The static `libm.a` has neither problem. Without the compat symbols,
`_LIB_VERSION` is the constant `_POSIX_` (`math-svid-compat.h:83`),
`sqrt` is `math/w_sqrt_template.c:37-44` with the root on its only
path, and `__kernel_standard`'s 0/0 is a plain `fdivd`. Its `sin`,
`exp`, `acos`, `atan`, `pow`, `hypot`, `fmod` and `remainder` still die
with all flags cleared (they return a diagnostic value). lcc 1.31.05's
glibc 2.41 behaves the same, shared and static.

The caller's options change nothing (`-fno-spec-fp`, `-O0`), with one
exception. lcc `-O0` code spills a call's result with `std,sm` and
reloads it with a plain `ldd`, which reads the bits as an ordinary
number (the tag stays in memory; [speculation.md](../isa/speculation.md),
"Spill and fill"). So a diagnostic result comes back as a number with
bit 30 of each half set instead of trapping: `sqrt (2.0)` with
`FE_INEXACT` clear gives 0x7ff6a09e667f3bcd, a NaN, at `-O0`.

lcc's own inline expansion of `sqrt` (an inline root, and a libm call
for negative and NaN operands) has the same problems at `-O3`: its root
is `fsqrtid,sm` and `fsqrttd,sm`, a diagnostic for `sqrt (2.0)` with
`FE_INEXACT` clear, and its call path dies inside libm as above [lcc
1.29.16 `-O3`, v3.4c: `fsqrttd,5,sm … ? %pred0`, `call … ? ~%pred0`;
`libmchk.c` `dsqrt`]. At `-O0` or with `-fno-spec-fp` the root is
plain, but the call path still dies.

A root computed with plain `fsqrtid`/`fsqrttd`, followed by a `sqrt`
call made only for errno, works with any flags cleared. The root raises
invalid first, so `__kernel_standard`'s 0/0 is then an ordinary NaN. A
call made before the root traps (`libmchk.c` `rootfirst`, `rootlast`).
The plain root's results are libm's bit for bit
([semantics.md](../isa/semantics.md), "Square root and reciprocals";
`tools/isa-probes/pocchk5.c` `sqrt`). A speculative root (`,sm`, as
lcc `-O3` emits it) raises no flag that is clear, so it doesn't help
(inferred from [speculation.md](../isa/speculation.md), "Speculative
operations").

GCC's `gcc.dg/torture/pr68264.c` clears the flags and calls `acos` of a
NaN. Built by lcc, it dies with SIGILL in `acos` (`-O2` and `-O0`, on
the 8C2).

With every flag clear, `logbf (0.0f)` and `logb (0.0)` also return a
diagnostic value, and `logbl (0.0L)` dies inside libm. So do `tan`,
`tanf`, `tanl`, `sinl`, `cosl` and `sincosl` of ordinary arguments
(`tanl (0.5236L)`, `tan (π/4)`), and `fmaxf (NAN, 0.0f)`. `logb*` of
nonzero numbers, infinities and NaNs, `tanl (0.0L)`, `tanl (1.0L)`,
`fmaxf (0.0f, NAN)`, `fmax` and `fmaxl` work [hw:
`tools/abi/probes/foldp131_libm.c`, lcc 1.29.16 `-O3 -fno-spec-fp` and
`-O0`; the 4C (ALT's glibc 2.35-alt2.29.023) and the 8C2 (Elbrus Linux
9.5.5); not run on the 2C3]. gfortran clears every flag on entry to a
procedure that uses an IEEE module, so Fortran's IEEE tests meet these
(`gfortran.dg/ieee`'s `ieee_2`, `large_3`, `dec_math_1`, `minmax_3`
and `minmax_4`; the proof-of-concept back end's finding P131).

**MCST's libm raises no exception for most domain and range errors**
[hw: `libmchk.c` `err`, the three machines, shared and static alike;
glibc `sysdeps/e2k/fpu/e_acos.c:104-106`, `e_log.c:39-40`,
`e_exp.c:46-47`, `f2c.h:136`, `sysdeps/ieee754/k_standard.c:122-140,
410-428`]. `acos (2.0)`, `asin (2.0)`, `log (-1.0)`, `log10 (-1.0)` and
`logf (-1.0f)` return NaN, `log (0.0)` returns −∞, and `exp (1000.0)`
and `pow (0.0, -1.0)` return +∞. Each sets errno but raises no flag,
where C's Annex F wants invalid, divide-by-zero or overflow. MCST's
`e_*.c` pass these cases straight to `__kernel_standard`
(`SVID_libm_err`), which returns a constant (`NAN`, `HUGE_VAL`) for
most of them. `acosh (0.5)`, `atanh (2.0)` and `remainder (1.0, 0.0)`
compute 0/0 and do raise invalid. `acos (-1.0)` is π, as it should be.

**MCST's `floor`, `ceil` and `trunc` raise inexact, and `round` needs
the flags set** [hw: `tools/isa-probes/pocchk5.c` `round` and `libm`,
on the 4C (ALT's glibc), the 8C2 and the 2C3; libm.so.6 of lcc 1.29.16's
v3, v5.8c2 and v6.2c3 sysroots, disassembled]. `floor`, `ceil` and
`trunc` (and `floorf`, `ceilf`, `truncf`) are each a single
`fdtoifd`/`fstoifs` with immediate 1, 2 or 3
([semantics.md](../isa/semantics.md), "Other scalar operations"), so
they raise inexact for every non-integral argument: 368 of 368 in each
rounding mode on all three machines. C99 to C17 allow that; C23 (F.10.6) and
GCC's default from C23 on (`-fno-fp-int-builtin-inexact`) don't. `rint`
raises it, as it should, and `nearbyint` doesn't. Their values are right
in all four modes. `round`, `roundf` and `roundeven` are speculative lcc
code: with every flag clear, sweeps of `round` and `roundeven` over the
probe's values die with SIGILL. With `FE_INEXACT` clear, `round (0.7)`
returns a diagnostic value; with every flag clear so does `round (2.0)`,
an integral argument, and `roundf (0.7)` on the 4C and 2C3 (on the 8C2
it returns a number and raises inexact). With the flags set the values
are right, except that `round` returns a signalling NaN unchanged:
neither quieted nor raising invalid. So this libm is no reference for
the flags of rounding, and its `round` is one more function that needs
the sticky flags set (above).

**MCST's v3 `scalb` gives 0 for an exponent of 2^63 or more** [glibc
`sysdeps/e2k/fpu/e_scalb.c:40-80`, `e_scalbf.c:42-82`,
`e_scalbl.c:38-75`; hw: `tools/abi/probes/folda46_scalb.c`, ALT's libm
on the 4C and the v3 sysroot's static `libm.a` on the 4C and the 8C2;
lcc 1.31.05's v3 `libm.a` (glibc 2.41) the same; not run on the 2C3].
For `__iset__ <= 3`, MCST's `scalb`, `scalbf` and `scalbl` add `(long
long) fn` to x's exponent and test the sum for underflow before they
test `fn` against 5000 (500, 50000). For `fn` ≥ 2^63 the conversion
gives 0x8000000000000000, so the sum takes the underflow branch:
`scalb (1, 0x1p63)`, `scalb (1, DBL_MAX)`, `scalbf (1, FLT_MAX)` and
`scalbl (1, LDBL_MAX)` are +0 instead of +∞, and `scalb (-3, 0x1p64)`
is −0, where glibc's tests want ±∞ with overflow
(`math/libm-test-scalb.inc:129-144`). Negative exponents give the right
±0. lcc made the conversion speculative (`fdtoidtr,1,sm` in
`__scalb_finite`), so with `FE_INVALID` clear these calls die with
SIGILL inside libm; the proof-of-concept back end's GCC-built glibc
returns 0 with invalid (its finding A46). For `__iset__` 4 and up the
code clamps `fn` first and scales with `fscaled`, `fscales` or
`fxscalesx`, and the 8C2's libm and the v5.8c2 `libm.a` give every
value right. On both machines, with every flag clear, each `scalb`,
`scalbf` or `scalbl` call whose result is inexact, overflows or
underflows dies with SIGILL inside libm, as most of libm does (above).
`scalb` is obsolete (POSIX.1-2008 dropped it), so this is mostly noise
in glibc's `test-*-scalb`.

**MCST's `sqrtf128` returns its argument** [glibc
`sysdeps/e2k/fpu/e_sqrtf128.c:5-15`,
`sysdeps/ieee754/float128/float128_private.h:192, 371`; hw:
`tools/abi/probes/folda50_sqrtf128.c`, the 4C and the 8C2, shared and
static, lcc 1.31.05's glibc 2.41 the same; not run on the 2C3; gcc].
`__ieee754_sqrtf128` is a placeholder, `return a;`, which "just lets
one formally make sysdeps/ieee754/float128 for e2k" (x86's soft-fp version needs an
`sfp-machine.h` that E2K's glibc lacks). `sqrtf128 (2)` is 2 and
`sqrtf128 (-42)` is −42, bit for bit. The generic `_Float128` code takes
its roots from there (`sqrtl` and `__ieee754_sqrtl` are `sqrtf128` and
`__ieee754_sqrtf128` in the float128 build). So `f32sqrtf128 (2)`,
`f64sqrtf128 (2)` and `powf128 (2, 0.5)` are 2, `hypotf128 (3, 4)` is
13, and `asinf128` and `acosf128 (0.75)`, `acoshf128` and `asinhf128
(3)`, `tgammaf128 (30.5)` and `j0f128 (50)` are wrong from the second
or third digit. By the source, so are `cabsf128`, `csqrtf128` and the
complex functions built on them. `expf128`, `logf128` and `sinf128` are
right. C code that calls these gets the placeholder whatever compiler
built it. GCC's Fortran takes `REAL(16)` math from libm's `*f128`
functions when the target glibc is 2.26 or later
(`gcc/fortran/trans-types.cc:1010-1018`), and libgfortran's `configure`
does when libm has them (`libgfortran/configure.ac:681-697`). A port
must send both to libquadmath instead. The proof-of-concept back end
does (gcc-claude `752e5e1f420`); without that, `gfortran.dg`'s
`ieee/large_1`, `quad_2` and `dec_math` fail (its finding A50).

### `__float128` in MCST's libgcc and libquadmath

**MCST's soft-fp raises only invalid and divide by zero** [libgcc
`config/e2k/sfp-exceptions.c:5-34` in lcc's runtime tarball; lcc
1.29.16; hw: `tools/abi/probes/folda39_quadmath.c`, 4C and 8C2; not run
on the 2C3]. lcc compiles `__float128` arithmetic and conversions to
libgcc's soft-fp calls (`__addtf3`, `__divtf3`, `__trunctfdf2`, ...),
which raise their flags through `__sfp_handle_exceptions`. That
function computes `0/0`, `1/0`, `max + max`, `min * min` and `max - 1`
from `const double` locals under `optimize (0)`. lcc folds arithmetic
on initialized `const` objects even at `-O0`, whatever flag it would
raise, except a division by zero; with `-frounding-math` it doesn't. So
the `libgcc.a` of lcc 1.29.16 and 1.31.05, and the `libgcc_s.so.1` of
lcc 1.29.16's sysroots and of the 4C and the 8C2, store +∞, 0 and
`DBL_MAX` where the last three operations should be and keep only the
two `fdivd`. Every `__float128` result of lcc code is right, but
overflow, underflow and inexact are never raised: `1/3` raises nothing
(x86: inexact), and `1e4900Q * 1e4900Q` gives +∞ with no flag. GCC
compiles the same file into five run-time operations [gcc].

**lcc's libquadmath is no reference** [hw: `folda39_quadmath.c`: the
4C's `libquadmath.so.0` and lcc 1.29.16 v3's alike, the 8C2's the same
but for the trap offsets; libquadmath source in lcc's runtime tarball;
`tools/quadmath` sweeps every function]. The system's
`libquadmath.so.0` is lcc's build of GCC 11's libquadmath, with its own
copy of that soft-fp:

| Call | lcc's library | Why |
|---|---|---|
| any result that overflows, underflows or is inexact (`expq (1)`, `expq (±12000)`) | right value, no flag | the soft-fp above |
| `fmaq (3, 0x1.5555555555555555555555555556p-115, 1)` (x · y = 2^-113 + 2^-226) | 1; right: 1 + 2^-112 | `fmaq.c:218-225` rounds to odd by or-ing `fetestexcept (FE_INEXACT)` into the last bit after a soft-fp addition |
| `coshq (12000)` rounding down or toward zero | +∞; right: the largest finite | its overflow is `huge * huge` of a `static const` (`coshq.c:56, 107`), which lcc folds |
| `sqrtq (2)`, so `powq (2, 0.5)` and `hypotq (1, 1)` | one ulp high | GCC 11's `sqrtq` is a double seed and Newton steps (`sqrtq.c:23-31`); GCC 14 made it exact (PR 114623) |
| `strtoflt128 ("-nan")`, `("-nan(0x123)")` | +NaN | GCC 11 drops the sign; GCC 13 keeps it (PR 94756) |
| `expq (-12000)` rounding up | the smallest subnormal, which is right | x86 GCC folds `expq.c`'s `TINY * TINY` and gets 0 |
| after `feclearexcept`: `sqrtq` of an inexact root, `powq (x, 0.5)`, `hypotq (1, 1)`, `asinq` and `acosq (0.75)`, `tgammaq (30.5)` | SIGILL in `__extenddftf2` | `sqrtq` starts from libm's `sqrt`, whose diagnostic result ("MCST glibc's FP bugs") the conversion traps on |
| the same: `sinq (1e10)`, `j0q (50)` | SIGILL in `__quadmath_kernel_rem_pio2` | its argument reduction is lcc's speculative double code |

With small arguments (`sinq (1)`, `j0q (1)`, `asinq (0.5)`, `tgammaq
(0.5)`, `atanq (1)`) the functions return after `feclearexcept`.
Invalid and divide by zero (`logq (-1)`, `logq (0)`, `0/0`, `1/0`) are
raised as on x86. So a port's libquadmath must be checked against x86's
build of the same GCC source (`tools/quadmath`), not against the
system's. That reference has a gap of its own: from GCC 14, `sqrtq`
raises no inexact on any target, because `libquadmath/sfp-machine.h`
defines no `FP_EX_INEXACT` and `soft-fp.h:110-111` then makes it 0
[gcc: x86 GCC 16]. (The proof-of-concept back end's finding A39.)

## DWARF register numbers

| DWARF number | Register | Source |
|---|---|---|
| 0–63 | `%r0`–`%r63` (64-bit `%dr`) | gdb `e2k_dwarf_reg_to_regnum`, lcc, unipro |
| 64–127 | `%b[0]`–`%b[63]` | gdb, libgcc |

No other registers have DWARF numbers: lcc assigns none to `%b[64]`–`%b[127]`,
globals, predicates or control registers. Debug info from lcc and Unipro
uses `DW_OP_regN` with these numbers; arguments appear as `DW_OP_reg0`, … in
the callee.

MCST's gdb maps only these numbers (`e2k_dwarf_reg_to_regnum`,
`OpenE2K/gdb/gdb/e2k-tdep.c:396-408`) and fails on any other ("Unable to
access DWARF register number 128"), so debug info must not place a
variable in a global register or address it relative to one: the
experimental GCC numbered the globals from 128 and gdb rejected 44 of
the variables its guality tests checked (`tools/dejagnu/README.md`,
"Guality"; [source, hw] on the 8C2). Such a variable has to be described
some other way or left out as optimized out (a copy to a window register
made only under `-g` would make `-g` change code:
[gcc-port-plan.md](../../doc/gcc-port-plan.md), D13).

**Exception handling** uses DWARF 64 and 65 (`%b[0]`, `%b[1]`) as
`__builtin_eh_return_data_regno (0)` and `(1)` (libgcc). A compiler that
numbers them differently produces libraries that are incompatible with
lcc's libgcc and libstdc++ at run time; the libgcc source notes this
happened with an old `e2k-linux-gcc`.

### How MCST's gdb reads them (gdb source; hw)

MCST's gdb 15.2 maps DWARF N to an 8-byte view of the register without
its tags (`$__dwrN`, `$__dwbN`; `OpenE2K/gdb/gdb/e2k-tdep.c:396-408` at
818fc87ba33). It reads callers' windows from the procedure stack in the
layout of the CPU gdb runs on (v3: 32 bytes a pair; v5+: 16 bytes a
register; [stack-and-unwinding.md](stack-and-unwinding.md), "Scanning
for roots"), which it takes from the live target description, not from
the binary (`e2k-tdep.c:862-873`, `:3607-3680`;
`e2k-linux-nat.c:231-255`). [source; hw: `tools/abi/probes/debuginfo.sh`
with the hand-written DWARF of `debuginfo.s`, the same on the 4C (ALT's
gdb 15.2-alt1.2), the 8C2 and the 2C3 (OS Elbrus's gdb 15.2-29.023)]

| DWARF location | In the stopped function | In a caller's frame |
|---|---|---|
| `%rN` (0–63) | its value; `<unavailable>` beyond the window (`e2k-tdep.c:1833-1888`) | below 2 × `wbs` of the call it is in: its own value. From 2 × `wbs` to its window size: the callee's `%r0`, `%r1`, … as they are now, the pairs handed over (gdb rebuilds the caller's window as the callee's `psize` + `wbs`, `e2k-tdep.c:842-873`). Beyond its window: the error "Cannot access memory at address 0x0" (`e2k-tdep.c:1517-1526`), where gdb's own `$rN` says `<unavailable>` |
| `%b[k]` (64 + k) | through the live `%br`: `%r(2 rbs + (2 rcur + k) mod 2(rsz + 1))`; `<unavailable>` for k ≥ 2(rsz + 1) (`e2k-tdep.c:1919-1936`) | the same through the `%br` saved at the call (`cr1_hi.br`, `e2k-tdep.c:875-890`), whatever the callee set since; a k beyond the ring gives the error above |

What a compiler's locations must allow for:

- **A `%b[k]` location means `%b[k]` under the base in effect where gdb
  stops.** `setbn` and each `abn` rename every `%b[k]` from the next
  instruction on, while `%r` numbers don't move, so a location in `%b[]`
  has to end at each of them [hw: with `rbs` 4 and `rsz` 3, DWARF 64 read
  `%r10` after `setbn rcur = 1`, then `%r8` and `%r14` in the next two
  iterations of a loop that rotates with `abn`, and `%r12` after it;
  DWARF 72 (`%b[8]`) read `<unavailable>`].
- **A function without its own `setbn` runs on its caller's `%br`**
  ("Window and rotating-base units", above), and gdb reads its DWARF
  64 + k through that ring [hw: `%b[0]` was the callee's own `%r12`
  under its caller's `rbs` 4, `rcur` 2].
- **lcc's big-window layout** (`rbs` 0x20:
  [gcc-port-plan.md](../../doc/gcc-port-plan.md), "Registers above
  `%r63`") puts `%b[0..63]` at `%r64` and up, which only DWARF 64–127
  reach [hw: under `rbs` 0x20, DWARF 64–71 read `%r64`–`%r71`].
  `%b[64..127]` have no number. gdb's own names stop at `$r63` (`$r64`
  is void) and go up to `$b127`.
- **In a caller's frame, a register at or above 2 × the call's `wbs`
  shows the callee's register**, not the caller's value [hw: the
  caller's `%r24`, at 2 × `wbs` 0xc, read the callee's `%r0`]. The call
  clobbers these registers anyway, so no location may stay in them
  across it.
- **A caller's PC is its return address** (`cr0_hi.ip`, the wide
  instruction after the `call`; `e2k-tdep.c:745`), and gdb looks up the
  caller's blocks and location lists at PC − 1, inside the call's wide
  instruction (gdb `frame.c:2848`, `get_frame_address_in_block`). So a
  location that holds during the call must cover the call's wide
  instruction [hw: an entry covering only that instruction was used
  while the callee was stopped; one starting at the return address
  read `<optimized out>`]. gdb subtracts 1 only below an ordinary
  frame, so a frame interrupted by a signal may be looked up at its PC
  itself (not checked).
- **A call-site parameter names the callee's register.** To find the
  value behind a callee's `DW_OP_entry_value (DW_OP_regN)`, gdb finds
  the caller's `DW_TAG_call_site` by the caller's PC, the return
  address (`call_site_for_pc`), looks there for the parameter whose
  `DW_AT_location` is `DW_OP_regN` with the same N, and evaluates that
  parameter's `DW_AT_call_value` in the caller's frame (gdb
  `dwarf2/loc.c:1118-1135`, `:1190-1246`). So `DW_AT_call_return_pc`
  must be the address of the wide instruction after the call's. The
  window moves at the call, so an argument the caller puts in `%b[i]`
  (DWARF 64 + i) arrives as the callee's `%r<i>` (DWARF i): the
  call-site parameter must say DWARF i, or gdb finds no match ("Cannot
  find matching parameter at DW_TAG_call_site"). gdb also checks that
  the call site's callee is the function stopped in, from
  `DW_AT_call_origin` or a `DW_AT_call_target` evaluated in the
  caller's frame (`dwarf2/loc.c:655-700`, `:1194-1222`), so an
  indirect call whose target the caller can't describe gives no entry
  values [gdb source; hw: proof-of-concept GCC code with
  `DW_OP_reg0`/`DW_OP_reg1` call-site parameters showed `a=a@entry=…`,
  `n=n@entry=10` on the 4C].
- **No DWARF number reaches** gdb's `$sp` and `$fp`
  ([stack-and-unwinding.md](stack-and-unwinding.md), "Debug
  information"), an extended part or a v5+ high half, besides the
  registers listed above. gdb shows the last two as `$xrN` and `$qprN`,
  also in callers' frames [hw].

**Values wider than 8 bytes** [hw: `debuginfo.sh`, all three machines,
in the stopped function and in a caller's frame alike; source as
marked]:

| Location | What gdb shows |
|---|---|
| `DW_OP_regN` of a type that is not a float: a vector or `__int128` [hw], also `_Complex double` or a struct [source: `e2k_convert_register_p` takes only 16-byte `TYPE_CODE_FLT`] | DWARF N, then N + 1, of the right frame (gdb `findvar.c:553-592`). That is right for the pair layout of argument slots, with the low half in N |
| `DW_OP_regN` of a 16-byte float type (`long double`, `__float128`, any 16-byte `DW_ATE_float`) | N, then N + 1, through `e2k_register_to_value` (`e2k-tdep.c:3398-3431`), **but from the caller's frame**: gdb 15 made `get_frame_register_bytes` take the next frame (upstream 9fc79b42369; gdb `frame.c:1546`), and `e2k-tdep.c` still passes the frame itself, where `e2k-pm-tdep.c:39-51` was updated. A `long double` 1.5 in `%r4`/`%r5` printed as its caller's 2.5, a `__float128` 1 as 2, and lcc `-O0`'s own `__float128` parameter (`DW_OP_reg2`) as 9.99e-3083 (`debuginfo_misc.c`) |
| `DW_OP_regN DW_OP_piece 8 DW_OP_reg(N+1) DW_OP_piece 8`, or `DW_OP_regN DW_OP_piece 16`; the pieces need not be adjacent | read from the right frame for every type, 16-byte floats included (gdb `dwarf2/expr.c:205-260`, `rw_pieced_value`). GCC writes the first form for a value in two hard registers (gcc `dwarf2out.cc:14649-14652`, `:14686-14720`), so a port that keeps `long double` and `__float128` in register pairs is not affected |
| a `long double` in one register (lcc's `movif` form, "Extended parts" below) | no location describes it: read as N, N + 1, the low 16 bits of N + 1 become sign and exponent (1.5 in `%r6`, with `%r7` = 0x4000, read as 3) |
| a v5+ 128-bit value in one register (`%qprN`, the high half in the extended part) | no location describes it: `DW_OP_regN` shows N + 1's low half as the upper lane (`{0x6666, 0x7777}` for `%qpr14` = `{0x6666, 0x5555}`), and `DW_OP_regN DW_OP_piece 8 DW_OP_piece 8` the lower lane and `<optimized out>` [8C2, 2C3] |

The bug in the second row would go if `e2k_register_to_value` passed
`get_next_frame_sentinel_okay (frame)`, as `e2k-pm-tdep.c` does (not
tried: relcc2 doesn't patch MCST's gdb). It also breaks `next` over
`longjmp` ([stack-and-unwinding.md](stack-and-unwinding.md), "Debug
information").

gdb reads a 16-byte float type named `__float128`, `_Float128`,
`complex __float128`, `complex _Float128`, `real(kind=16)` or
`complex(kind=16)` as IEEE quad, and any other as x87 extended
(`e2k_floatformat_for_type`, `e2k-tdep.c:3566-3582`) [source]; lcc names
its types `long double` and `__float128` [lcc]. At `-O0` lcc keeps
`long double` and vector variables, parameters included, in memory
(`DW_OP_fbreg`), and `__int128` and `__float128` parameters and
`__int128` locals in an even register pair (a bare `DW_OP_regN`); a
`__float128` local without its address taken was in memory too [lcc
1.29.16 and 1.31.05, `e2k-v5.8c2`, `-O0 -g`].

Not checked: frames interrupted by a signal (gdb's signal-frame
unwinder), for `%b[]` and the PC − 1 lookup above.

## Extended parts and `long double` (lcc, hw, qemu)

Checked by `tools/abi/probes/ldouble.c` on the 4C (v3) and under MCST's
qemu as v3 and v5.

- lcc keeps a `long double` in one register: the 64-bit mantissa (with
  the explicit integer bit, as on x87) in the ordinary part and the
  sign and 15-bit exponent in the extended part. `movif mant, exp, dst`
  builds it from two registers; the mantissa is then read as the ordinary
  register and `movfi src, dst` reads the 16-bit part. Arithmetic uses the
  `fx*` operations (`fxaddxx`, `fxmulsx`, `fxdivxx`, `fxsqrtixx`, ...;
  the suffix letters give the operand formats: `x` 80-bit, `d` double, `s`
  single), conversions `fxtofd`, `fdtofx`, `idtofx`, `fxtoidtr`,
  compares `fxcmp*xb` into predicates. Loads and stores go through the
  two parts: `ldd`/`ldh`, then `movif`; `std` of the mantissa and `sth`
  of `movfi`'s result. lcc's v5 code is the same.
- **A `long double` held in a window register needs `nfx = 0`** in the
  function that owns the window, across a call or not. With `nfx = 1`
  its 16-bit part is lost when the window is spilled to the procedure
  stack: after a deep call it reads back as 0 on the Elbrus-8C2 and as
  0 or stale data (`0x1f98`, `0x0005`) on the 4C, while the 2C3 mostly
  keeps it; a call that does not spill keeps it (hw, qemu: `ldouble.c`).
  It is also lost when a signal handler runs while it is held: every
  handler on the 8C2 and 2C3, on the 4C a handler whose frames spill the
  window and about one signal in 1,200 otherwise. System calls and page
  faults keep it, timer interrupts nearly always (hw: `pocabi2.c`; the
  table under `nfx` above). The proof-of-concept back end, holding its
  values only between `movif` and `movfi`, got 104 and 143 wrong
  results of 8,192,000 on the 4C and 8C2 under a 50 µs profiling timer
  until it set `nfx = 0` (its A26; its counts not rechecked). Which
  functions lcc gives `nfx = 0`: under `nfx` above. Global registers are
  not spilled, and their extended parts survive signal handlers [hw:
  `pocabi2.c`, `%g16` and `%g20`, all three machines], but not system
  calls, which empty `%g16`–`%g31`
  ([kernel-interface.md](kernel-interface.md), "System calls"). An
  ordinary write of the register keeps the 16-bit part (`addd`, `adds`
  under `dbl = 0`, `ldd`), except that on the 4C a `faddd` result
  clears it to 0, where the 8C2 and 2C3 keep it [hw: `pocabi2.c`];
  nothing should rely on either.
- **The high half of a v5+ register after a narrower write.** A write
  of 64 bits or less (`addd`, `adds` under either `dbl`, `ldd`, `ldw`,
  `faddd`, `sxt`, a failed `ldd,sm`) leaves the high half and its tags
  as they were [hw: `tools/abi/probes/foldi55.c` `wr`; 8C2]. What they
  were depends on the register's history, so the high half of a value
  written with 64 bits or less is undefined and can be diagnostic:
  - a register the window gains (a `setwd` that grows it, a callee's
    pairs beyond those its caller hands over) reads empty in both halves
    (0 with tag 5, tag 1 on both words), and its high half stays empty
    after a 64-bit write [hw: `foldi55.c` `wr`, `gain`; 8C2];
  - a register in the pairs the caller hands over (the caller's `wsz` −
    `wbs`: lcc's 4-pair parameter area, or more in other code, "Window
    and rotating-base units") keeps both halves as the caller's window
    holds them, so its high half is what an earlier callee left in the
    same registers (`%r0`–`%r7` for lcc's four pairs): after a callee
    that left diagnostic high halves there, the next callee's
    64-bit-written registers kept them, and a plain `stqp` of one was
    SIGILL `ILL_ILLOPN`, while one the call gained stored [hw:
    `foldi55.c` `hand`; 8C2] (the low half likewise:
    [calling-convention.md](calling-convention.md), "Unused parts of a
    slot");
  - with `nfx = 1` a deep call or a signal handler that spills the
    window leaves 0, tags 0 (on the 8C2 once in qspill's three deep
    calls a copy of the low half; the 2C3 keeps it after the process's
    first deep call); an interrupt, a context switch or a
    `nanosleep` after a deep call has returned leaves 0, tags 0, or now
    and then a copy of the register's own low half with its tags (under
    `nfx` above): a failed speculative pointer in the low half
    (`4afafafa4afafaf8`, a failed `ldd,sm` masked by `andd,sm`) becomes
    a diagnostic high half and stays there when the real pointer is
    later written with 64 bits [hw: `foldi55.c` `ctx`, 2–3 of 750 holds
    a case; 8C2].

  A plain `stqp` of a register whose high half is diagnostic is SIGILL
  `ILL_ILLOPN` at the store, whatever the low half holds; a plain `std`
  of its low half stores, and `stqp,sm` stores both halves with their
  tags. So keep, save and spill a value at the width it was written:
  `std`/`ldd` for one written with 64 bits or less, `stqp` only for a
  value written whole as 128 bits (the proof of concept met it: its
  I55). Not measured on the 2C3.
- The arithmetic is x87 extended precision exactly: 64-bit mantissa,
  round to nearest even, denormals down to 2^-16445, overflow to
  infinity; `sqrtl(2)` is correctly rounded. Unnormals and pseudo-NaNs
  raise invalid and give the x87 "indefinite" NaN (`ffff c000…`); a
  pseudo-denormal is normalised (hw, and MCST's qemu agrees).
- 80-bit operations take their rounding mode and precision control from
  **`%fpcr`** (the x87 control word: RC bits 10–11, PC bits 8–9, default
  `0x037f`) and record exceptions in **`%fpsr`** (x87 status word), not
  in `%pfpfr`, which controls `float`/`double` and packed operations.
  With PC = double, `1.0L/3` is rounded to 53 bits, as on x87 (hw). glibc's
  `fesetround`, `feclearexcept` and `fetestexcept` update and read both
  registers, so C code sees one environment. **MCST's qemu gets this
  wrong**: it applies `%pfpfr` to 80-bit operations, ignores precision
  control and sets `%pfpfr` flags.
