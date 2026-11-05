# Control transfer

How E2K changes the flow of control: branches, calls, returns and system
calls. Encodings are in [bundle.md](bundle.md) (CS0, SS, `ctcond`); this
page is about what the operations do, what they cost and how a compiler
should use them.

Status markers, in addition to bundle.md's:

- **[hw]**: run on an Elbrus 4C (elbrus-v3): costs by
  `tools/isa-timing/bench.py` (data in [timing-e2s.yaml](timing-e2s.yaml)),
  behaviour by `tools/abi/probes/ctpr.c`
- **[guide]**: MCST programming guide, chapter 10.9–10.10 and 4.4
- **[lcc]**: observed in lcc 1.29.16 `-O2` output
- **[source]**: kernel (`arch/e2k/include/asm/cpu_regs_types.h`),
  MCST's qemu (`target/e2k/tcg/translate-ct.c`), gas (`tc-e2k.c`)

## Model [guide]

A transfer is either **instant** (one operation) or **prepared** (two):

1. A **prepare** (CTP) operation computes the target and the kind of
   transfer and stores them in one of three **control-transfer
   preparation registers**, `%ctpr1`–`%ctpr3`. The hardware starts
   fetching code at the target in the background.
2. A **transfer** (CT) operation, `ct`, `call` (or `scall`), takes a
   prepared register and transfers, optionally under a condition.

The prepare and the transfer may be any distance apart, as long as the
CTPR is not overwritten in between; one prepare can serve many transfers
(a loop's back edge). The only instant transfers available to user code
are `ibranch` (and `rbranch`, its `%MLOCK` form) and, from v6, `ibranchd`
/`icalld` with a register target.

After the wide instruction containing a transfer, the next one executed
is the target if the condition holds and the next in memory otherwise;
nothing from the other path changes the state. The other operations of
the wide instruction containing the transfer execute normally.

A wide instruction holds at most one prepare (in CS0) and one transfer
(in SS) [guide 4.4, bundle.md].

## Prepare operations

| Operation | CTPR | Target | Kind | Use |
|---|---|---|---|---|
| `disp %ctprN, label` | 1–3 | IP-relative, signed 28 bits × 8 bytes (±1 GiB) [bundle.md] | branch or call | direct jumps and calls (`R_E2K_DISP`, elf.md) |
| `movtd %drN, %ctprN` | 1–3 | 64-bit address in a register | branch or call | indirect calls, `switch` jump tables, PLT |
| `getpl %rN, %ctprN` | 1–3 | offset from the compilation-unit descriptor | branch or call | 32-bit mode only [guide]: lcc's indirect calls there, 9 cycles before the `call`; a `ct` or `call` waits 9 cycles after it, as after `movtd` [lcc; hw: `lat32`, 4C, 8C2, 2C3; [mode32.md](../abi/mode32.md), "Timing"] |
| `return %ctpr3` | 3 only | the caller's IP from the chain stack | return | function return |
| `sdisp %ctprN, n` | 1–3 | system call entry `n` (5 bits) | system call (`call` becomes `scall`) | glibc: `sdisp %ctpr1, __SYSCALL_TRAPNUM` then `call %ctpr1, wbs = N`; the `call` may hand over at most 4 pairs, 5 or more is SIGKILL ([kernel-interface.md](../abi/kernel-interface.md), "System calls") [hw] |
| `ldisp %ctpr2, label` | 2 only | an array-prefetch (APB) program | not transferable | APB setup; any later write to `%ctpr2`, a call or a return stops the program ([apb.md](apb.md)) |
| `pref %iprN, label [, ipd=1]` | `%ipr0–7` | code to prefetch | none | starts fetching `label` into the instruction cache, as an early `disp` would, without a CTPR ("Code not in the instruction cache", below); lcc does not emit it |

`disp`, `movtd`, `return` and `pref` take an optional `; ipd N` (the
SS's prefetch depth, 0–3; gas rejects larger values). lcc writes `ipd 2` on
every prepare for v3 targets (`e2k-v3`, `e2k-v3.4c`, or
`-march=elbrus-v3` with any lcc) and none for v4 and later (`v4.8c`,
`v5.8c2`, `v6.*`, or `-march`/`-mtune` for a later CPU); gas then
encodes no SS for a prepare alone (default depth) and `ipd 3` in an SS
it makes for a `ct`. With the code in the instruction cache it makes no
measurable difference (zlib on the 8C2, the PoC; finding
I25) [lcc, hw]. For code that is not in the instruction cache it does:
given enough lead, a prepare with `ipd 3` or with no SS fetches all of a
cold three-line (768-byte) target, lcc's v3 `ipd 2` loses 50 (4C) to
about 130 (8C2, 2C3) cycles there, and `ipd 0` fetches nothing ahead
([hw] `tools/isa-probes/ctlleft.c`; Instruction fetch, "Code not in the
instruction cache").
`gettsd`, `puttsd`, `done`, `iret`, `hret`, `glaunch` are for protected
mode or the kernel.

## Transfer operations

| Operation | Notes |
|---|---|
| `ct %ctprN [? cond]` | branch or return (whatever the CTPR was prepared for) |
| `call %ctprN, wbs = W [? cond]` | call: the callee's window starts at pair W of the caller's window; W from the pairs the caller was handed to its `wsz` − 1, else SIGSEGV `SEGV_BNDERR` (registers.md, window size limits [hw]); conditional calls exist |
| `ibranch label [? cond]` | instant branch, IP-relative like `disp`; no CTPR |
| `rbranch label` | `ibranch label ? %MLOCK` (the atomic retry loop, atomics.md) |
| `ibranchd`, `icalld` | v6+: instant branch or call to a register target |

Conditions (`ctcond`, bundle.md): a predicate or its negation, loop
conditions (`%LOOP_END`, `%NOT_LOOP_END`, used with loop mode, `alc`,
`abn`, `abp` in the same instruction), `%MLOCK`, and compare/CLP results
of the same instruction.

## The CTPR register [source]

64 bits on v1–v6 (v6 adds a second word with the compilation-unit index;
v7 widens the register to 128 bits and moves the fields):

| Bits | Field | Values |
|---|---|---|
| 0–47 | `ta_base` | target address |
| 54–56 | `ta_tag` | 0 empty, 1 diagnostic, 2 procedure label, 3 local label, 4 numeric label, 5 system label |
| 57–58 | `opc` | 0 `disp`, 1 `ldisp`, 3 `return` |
| 59–60 | `ipd` | the kernel names 0 no prefetch, 1 the target instruction, 2 the target and the next (`cpu_regs_types.h:733-735`). Measured, it is how much of the target the prepare fetches ahead: 0 nothing; 1 and 2 part of a cold three-line (768-byte) target (from L2, `ipd 2` is enough); 3 all of a 768-byte target but not of a 1.5 KiB one; a prepare in an instruction without SS behaves as 3 [hw: `ctlleft.c`, 4C, 8C2, 2C3]. The monitors count it: `ipd` N fetches N 256-byte lines starting at the target, and no SS 3 (`pmu2.c` `ib_depth_*`; [monitors.md](monitors.md), "Instruction fetch") |

`rrd %ctprN` reads a CTPR in user mode (ALC0, as every `rrd`). After
`sdisp` it holds `ta_tag` 5 for an entry the kernel enables and 0 for
one `%osem` disables, which then traps at the `call` like any empty CTPR
[hw: `tools/abi/probes/kernleft.c` part 1; 4C, 8C2, 2C3;
[kernel-interface.md](../abi/kernel-interface.md), "Disabled entries"].

## Lifetime and validity [hw, source]

Checked on the 4C by `tools/abi/probes/ctpr.c`:

| Situation | Result |
|---|---|
| A CTPR prepared before a `call`, used after the callee returns | **SIGILL** (`ILL_ILLOPC`): the CTPR is empty |
| A CTPR prepared by the caller, used by the callee | **SIGILL** (`ILL_ILLOPC`): `call` leaves the CTPRs empty too |
| `ct %ctprN ? cond` with a false condition on an empty CTPR | no trap |
| A CTPR used after a taken `ct` through another CTPR | still valid; a taken branch does not clear the CTPRs |
| `movtd` of a value with a diagnostic tag (failed speculative load) | no trap: the CTPR holds a diagnostic label |
| `ct` taken through that CTPR | **SIGILL** (`ILL_ILLADR`) |
| `ct ? false` through it | no trap |

So:

- **Every call and return empties all three CTPRs.** A function starts
  with no prepared transfer, and after each call it must prepare again
  everything it still needs, its own return included. MCST's qemu clears
  them on return (`translate-ct.c`); its `ct` on an empty CTPR is not
  implemented (it aborts), while the community qemu traps with SIGILL.
  A `call` under a false predicate is no call: it leaves all three
  (`%ctpr1` and a return prepared in `%ctpr3` before it still work after
  it, `tools/isa-probes/preds.c` `callf_*`, 4C, 8C2, 2C3), and lcc relies
  on this, sharing one return prepare across such calls (the
  proof-of-concept back end's P56).
- A `ct` traps only when taken, so a conditional transfer may name a CTPR
  that is not valid when the condition is false, and a prepare may be
  speculative: lcc issues `movtd,0,sm` for indirect calls and `switch`.
- `return` is valid only in `%ctpr3`; a CTPR prepared by `ldisp` cannot be
  transferred through (MCST's qemu raises an illegal-address exception for
  both).

## Restrictions [source: gas]

- One prepare and one transfer per wide instruction; `disp`, `ldisp`,
  `return`, `sdisp` all live in CS0, so only one of them.
- On v1–v5 a wide instruction may not prepare and transfer through the
  **same** CTPR (gas: "not supported on elbrus-vN", MCST bug 154538);
  v6+ allows it. Different CTPRs are fine: lcc puts `call %ctpr2` and
  `disp %ctpr1, loop_head` next to each other. [hw] On v3 and v5 a
  `movtd` and a `ct` through the same CTPR in one instruction (gas
  accepts `movtd`) transfer to the CTPR's old target, and so does a
  `disp` with a `ct` through its CTPR, which gas refuses there
  (hand-encoded from gas's v6 output: `tools/isa-probes/foldp122_dispct.c`,
  4C, 8C2); on v6 (the Elbrus-2C3) the `ct` doesn't transfer at all
  (`bench.py` hazard `movtd_ct`, distance 0; "v6"). None of these is
  useful: prepare ahead (5 cycles for `disp`, 9 for `movtd`).
- `movtd` and `getpl` into a CTPR go only in ALC0
  ([bundle.md](bundle.md), "Bundling restrictions").
- [hw] A `movtd` into a CTPR must not carry a predicate: gas accepts
  `movtd,0 %dr1, %ctpr1 ? %pred0`, but the hardware traps at it (SIGILL
  `ILL_ILLOPC`) whether the predicate is true or false
  ([predicates.md](predicates.md), "RLP"; 4C, 8C2, 2C3). MCST's qemu
  runs it conditionally.

## Costs [hw]

Delays between a prepare (or the condition) and the transfer, from
[timing.md](timing.md):

| From | To | Cycles |
|---|---|---|
| `disp` | `ct`, `call` | 5 |
| `return` | `ct` | 6 |
| `movtd`; `getpl` (32-bit mode, [mode32.md](../abi/mode32.md)) | `ct`, `call` | 9 |
| integer compare, `andp` | `ct ? pred` | 3 |
| integer compare | `call ? pred`, not taken | 3 |
| FP compare | `ct ? pred` | 5 |

A transfer placed earlier waits until the CTPR is ready, then proceeds:
with the prepare D cycles before the `ct`, the pair costs `max(D,
delay) + 1` cycles. Unlike an early data consumer (timing.md, "Stalls
cost more than the latency"), there is no extra penalty. The same holds
for the condition: a `ct ? pred` 1 or 2 cycles after its integer compare
waits 2 or 1 cycles, taken or not.

A `call ? pred` whose predicate is false waits for its condition the
same way, 2 or 1 cycles when the compare is 1 or 2 cycles before it, and
otherwise costs nothing, 1 call deep or 64 [hw:
`tools/isa-probes/callsstack_pcall.c` `loop`, 4C, 2C3]. Its spill of a
full chain register file costs nothing either
([predicates.md](predicates.md), "Control transfers"). So lcc's
predicated calls ("How lcc uses it", below) are free on the path that
skips them.

A conditional `ct` that is **not taken** waits for its CTPR only until
2 cycles after the `disp` (1 cycle early: 1 cycle lost; later: none),
not 5. Measured with the performance monitors (`tools/isa-probes/pmu.c`,
`ct_*_dK` and `cmpct_*_dK`; [monitors.md](monitors.md)):

| `disp` → `ct ? pred` distance | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| extra cycles, condition false | 1 | 0 | 0 | 0 | 0 |
| extra cycles, condition true | 4 | 3 | 2 | 1 | 0 |

So a compiler may put the `disp` of a rarely taken exit late, without
cost on the fall-through path.

The same holds after `return`: a not-taken `ct %ctpr3 ? pred` (lcc's
early exits) does not wait for the 6 cycles a taken return needs
(`tools/isa-probes/aaurwct.c`, `ct_return_dK` against `ct_disp_dK`:
median cycles of a call of a function whose body ends with the prepare
and, K cycles later, a `ct` whose condition is false; 4C and 8C2
identical):

| Distance K | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| after `return` | 41 | 45 | 42 | 43 | 44 | 49 | 46 |
| after `disp` | 41 | 41 | 46 | 43 | 48 | 45 | 46 |

Beyond the 1-cycle wait at distance 1 after `disp`, the totals grow by a
cycle per cycle of distance, except for repeatable 4-cycle bumps at some
distances (2 and 6 after `return`, 3 and 5 after `disp`) that we can't
explain; isa-score models both prepares like the `disp` row above.

Cost of the transfer itself (cycles per block in a loop of 16 identical
blocks, compared with a block of `nop`s of the same shape; the loop adds
about 0.4 per block):

| Block | Cycles | Cost of the transfer |
|---|---|---|
| `nop` | 1.38 | — |
| `ibranch` not taken | 1.38 | 0 |
| `ibranch` taken, with or without a true condition | 7.38 | **+6** |
| `ibranch L ? %MLOCK \|\| %cmpN` (or `%clpN`, ctcond type 9), its compare in the same instruction, not taken | — | 0, and no wait for the compare (a compare and `ibranch ? %pred` in the next instruction: 4 cycles for the two) |
| the same, taken | — | **+12** (a taken `ibranch`: +6; a compare and a taken `ibranch ? %pred`: 10 cycles for the two) |
| `disp`, `nop 5`, `nop` | 8.44 | — |
| `disp`, `nop 5`, `ct` taken / `ct ? true` / `ct ? false` | 8.38–8.44 | 0 |
| the same with `disp …; ipd 0` | 8.38 | 0 (the target is cached) |
| `disp`, `nop 5`, `call` to a leaf that prepares `return` on entry and returns 6 cycles later | 16.38 | 0 beyond the 8 + 8 cycles of the two instruction sequences |

So a prepared transfer issued at least its delay after the prepare costs
nothing, calls and returns included, while a taken `ibranch` always
costs 6 cycles, forward or backward (monitors: `ibranch_fwd` 1
instruction in 7 cycles, a forward and a backward one 2 in 14).

The type-9 rows come from another harness [hw: `ctlleft.c` `t_t9_*`,
`t_cmpib_*`, `t_ib_tk`, 4C, 8C2, 2C3 identical], in which a
one-instruction block costs 1 cycle, a taken `ibranch` block 7 and a
taken type-9 block 13, from ALC0 or ALC3 and for `%clpN` alike. So the
type-9 form ([predicates.md](predicates.md), "Control transfers") suits
rarely taken branches on a fresh compare. Not taken it is free (the
branch and the instruction after it take 2 cycles, `t_t9_skip_nt`).
Taken, it costs as much as `ibranchd` (+12, v6) and 3 cycles more than
a separate compare and `ibranch`.

A taken `ibranch` **hides an interlock stall in its own instruction**:
a load used one instruction later stalls 4 cycles (2 instructions, 6
cycles); with a taken `ibranch` in the consumer's instruction the pair
takes 8 cycles, not 12, while a prepared `ct` there adds nothing and the
stall is paid (monitors, `stall_*`). So padding with `nop` before an
`ibranch` back edge doesn't pay, as the proof-of-concept backend found
(finding I4); with a `ct` back edge it does. A compiler should prepare every likely-taken transfer
early (5 cycles before for `disp`, 9 for `movtd`) and keep `ibranch` for
rarely taken branches or when no CTPR is free.

### Instruction fetch [hw: monitors]

The `IB_NO_COMMAND` monitor counts cycles with no instruction ready to
issue ([monitors.md](monitors.md)). In loops that fit the instruction
buffer (`tools/isa-probes/pmu.c`, `fetch_*`, `cmpib_*`, `wide*`,
`ctipd_*`) only two things produce them:

- a **taken `ibranch`: 6 cycles**, forward or backward, wherever its
  condition comes from;
- a **taken `ct` whose CTPR is not ready yet**: the wait (5 cycles after
  `disp`, 9 after `movtd`, minus the distance) is counted here too.

Free: a not-taken `ibranch` (it only waits, exactly, for its condition:
compare → `ibranch` 3), a not-taken `ct`, any prepare of a cached target
(`disp` with `ipd` 0–3 or with no SS, `return`; for code not in the
instruction cache the depth matters, below), the `ipd` of the
transfer's own instruction, and straight-line code from the instruction
cache: wide instructions of up to 64 bytes issue one a cycle
(`tools/isa-probes/ctlleft.c` `s_*`, 4C, 8C2, 2C3), also right after a
taken transfer, with one exception (below).

Whole programs agree (the 4C, CoreMark, `tools/isa-score/profile.py`):
gcc-claude's code branches with conditional `ibranch`; 6 cycles per
taken `ibranch` (sampled: 377 M of them) predicts 2.14 G cycles, and
the monitor counts 2.07 G (11% of the run). Unipro's clang has no taken
`ibranch`; its 0.98 G bubble cycles (6%) are `switch` dispatches that
`ct` through a CTPR written by `movtd` one instruction earlier (8 cycles
early) and conditional `ct`s 2–3 cycles after their `disp`. lcc prepares
early and loses 1.3%. So: prepare every transfer that may be taken at
least its delay ahead, `movtd` 9 cycles ahead, and keep `ibranch` for
transfers that are rarely taken.

**Right after a taken transfer** [hw: `tools/isa-probes/timeleft.c`
`fetch`; hot code, 16 and 32 blocks 1 KiB apart, each ending in a
transfer to the next, cycles a block from the difference; 4C, 8C2, 2C3
identical; instruction sizes checked with objdump]. S is the size of the
block's big instructions in bytes (8 to 48: `addd`s and literals; 56
and 64: also predicated with `? %predN` and predicate logic, the only
way the probe filled them), d the `disp` (8 bytes), t the `ct` through
it, 8 an 8-byte instruction:

| Block | S = 8–48 | 56 | 64 |
|---|---|---|---|
| S, d, 4 × 8, t (only the target is big) | 7 | 7 | 7 |
| S, S, d, 4 × S, t | 8 | **9** | **9** |
| the same, t 6 or 7 cycles after d | | | 9, 10 |
| 8, 8, d, 4 × S, t | 8 (32, 48) | 8 | 8 |
| S, S, d, 4 × 8, t | 8 (32, 48) | 8 | 8 |
| 3 × S, d, 4 × 8, t | 9 (32, 48) | 9 | 9 |
| 4 × S, d, 4 × 8, t | 10 (32, 48) | 10 | **11** |
| S, S, d, 4 × S, 4 × 8, t (t 9 after d) | 12 (32, 48) | 12 | 12 |
| d, 6 × S, t (t 7 after d) | 8 (32, 48) | 8 | 8 |
| 7 × S, then a taken `ibranch` | 14 | 14 | 14 |
| 2 × 8, d, 4 or 5 × 8, t (t 5 or 6 after d) with a 256-byte line boundary before any of the first ten instructions | 8, 9 (S = 8) | | |

So a target instruction of up to 64 bytes is free after a prepared
transfer, and so is any code of instructions up to 48 bytes. In some
layouts of 56- and 64-byte instructions a `ct` exactly 5 cycles after
its `disp` loses a cycle, and 6 or more cycles never do (why is not
known). A taken `ibranch` costs its 6 cycles at any instruction size.

#### Code not in the instruction cache [hw]

`tools/isa-probes/ctlleft.c` (`fetch`, on the 4C, 8C2 and 2C3) times a
transfer to a target that is not in the 128 KiB instruction cache
(timing.md, "Cache geometry"), from the window's first instruction to
the target's first. In mode 1 the target was pushed out by 256 KiB of
other code (it is in L2). In mode 3 a 64 MiB data stream and 512 KiB of
code ran first, and the target is on a page of its own (in memory; its
page was presumably still in the ITLB, which holds 256 or more pages,
since a prepare whose target's page misses the ITLB fetches nothing:
"Prefetch depth", below; inferred). The 4C runs pinned to one node
(`numactl`); remote memory adds about 130 cycles. Targets on the
window's own page come out at L2 cost even in mode 3, because the
function's entry code fetched them (inferred), so only targets on
separate pages give memory figures. Cycles lost against the cached
case:

| Transfer | 4C | 8C2 | 2C3 |
|---|---|---|---|
| L2: `ibranch`, or `disp` 5 cycles ahead | 10 | 12 | 12 |
| L2: `disp` 10 / 20 ahead | 5 / 0 | 7 / 0 | 7 / 0 |
| L2: `movtd` 9 / 40 ahead | 10 / 0 | 12 / 0 | 12 / 0 |
| L2: `pref` 10 / 20 ahead (with `disp` 5 ahead) | 6 / 0 | 8 / 0 | 8 / 0 |
| memory: `ibranch` | 144–156 | 152–173 | 172–220 |
| memory: `disp` 5 / 40 ahead | 161 / 130 | 171 / 133 | 220 / 155 |
| memory: `disp` or `pref` about 155 ahead | 24–26 | 47–48 | 45–51 |
| memory: `disp` / `pref` 200 ahead | 0 / 0 | 0 / 0 | 25 / 0 |
| memory: `disp` or `pref` 255–340 ahead | 0 | 0 | 0 |

So a `disp` or `pref` starts fetching its target at once, and a `movtd`
when its CTPR is written (about 4 cycles later: `movtd` 9 ahead loses as
much as `disp` 5 ahead). The target's first instruction can issue about
16–17 cycles (4C) or 18–19 (8C2, 2C3) after the prepare when the code is
in L2. From memory it is about 155–170 (4C), 175–195 (8C2) or 195–225
(2C3) cycles. A transfer prepared that far ahead loses nothing; an
`ibranch` or a late prepare pays the whole miss. (The 8C2's L2 figures
move by tens of cycles with code layout: its 512 KiB L2 keeps the
256 KiB eviction run only partly.)

**Prefetch depth.** The `ipd` of the prepare's instruction (Prepare
operations, above) decides how much of a longer target comes with it. A
768-byte (three-line) target, cycles lost against the cached case:

| `ipd` | in L2, `disp` 40 ahead: 4C / 8C2 / 2C3 | in memory, `disp` 200 ahead | in memory, `disp` ~640 ahead |
|---|---|---|---|
| 0 | 19 / 23 / 23 | 241 / 373 / 376 | 219 / 324–345 / 353 |
| 1 | 6 / 8 / 8 | 82 / 165 / 216 | 58–59 / 141–144 / 163–191 |
| 2 | 0 / 0 / 0 | 73 / 177 / 179 | 50 / 129–132 / 123–124 |
| 3 | 0 / 0 / 0 | 0–48 / 172 / 147 | 0 / 0 / 0 |
| none (no SS) | 0 / 0 / 0 | 49 / 134 / 147 | 0 / 0 / 0 |
| an `ibranch` instead | 14 / 18–72 / 18 | 177 / 371 / 371 | 159–222 / 301–313 / 325–355 |

So, given enough lead, a prepare without `ipd` (gas's default when
nothing else needs an SS) or with `ipd 3` fetches all of a three-line
target on v3, v5 and v6, and lcc's v3 `ipd 2` loses 50 (4C) to about
130 (8C2, 2C3) cycles. With a 200-cycle lead nothing hides a three-line
target from memory on the 8C2 and 2C3, and `ipd 2` loses 24–43 cycles
more than the default. On a six-line (1.5 KiB) target `ipd 2`, `ipd 3`
and the default lose the same (152 / 300–303 / 301–304 cycles,
`f_fardiv48l6_*`). `ipd 0` makes the prepare fetch nothing ahead. The
instruction-fetch monitors confirm the depths: `ipd` N makes a prepare
request N 256-byte lines starting at its target, and a prepare without
SS 3 (bundle.md, "SS"): 0 / 1.2 / 2.5 / 3.7 / 3.6–3.7 requests to L2
per prepare for `ipd` 0 / 1 / 2 / 3 / no SS, and as many fewer misses
when the code reaches those lines (`pmu2.c` `ib_depth_*`, all three;
[monitors.md](monitors.md), "Instruction fetch").

**A prepare fetches nothing when its target's page is not in the
ITLB** (code that has not run recently: the ITLB holds 256 to 383 4 KiB
pages), whatever its lead: it counts an ITLB miss, starts no page walk
and makes no request, so a transfer to it would pay the whole miss
(inferred). The same targets after their pages ran get 0.9–1.5
requests per prepare (`pmu2.c` `ib_near_*`, all three; monitors.md).
The memory figures above are for targets whose pages had run. Whether
`pref` behaves the same is not checked.

**`pref`** needs the same lead as a prepare (about 20 cycles for code
in L2, 200–255 for code in memory) and then hides the miss completely,
also for an `ibranch`: `pref` 257 cycles ahead of a taken `ibranch` to a
cold page loses nothing, against 156 / 173 / 172 cycles without
(`f_fardiv20_prefib`, `f_fardiv20_ib`). Its prefetch survives a call. In
a window with a call to a cold leaf between the prefetch and the
transfer, the window (the leaf's own miss included) loses 236 / 334 /
384 cycles with no early prefetch (4C / 8C2 / 2C3), 93 / 169 / 214 with
a `pref` before the call, and 251 / 187 / 258 with a `disp` before it.
A CTPR's prefetch saved nothing across the call on the 4C, but most of
what `pref` saved on the 8C2 and 2C3 (not explained). `pref` fetches
about as deep as `disp … ; ipd 2`: a cold 768-byte target about 640
cycles ahead loses 48–49 / 146–153 / 123 cycles, against 50 / 129–132 /
123–124 for `ipd 2` and 0 for a prepare with no SS or `ipd 3`. Its own
`ipd=1` fetches a little less (+3 / +5 / +5 cycles on a three-line
target from L2). So `pref` is for cold code that a function reaches
through a call or an `ibranch`, issued a few hundred cycles ahead. It
needs a global symbol: gas gets the relocation wrong for a local label
([elf.md](../abi/elf.md), `R_E2K_PREF`).

**Straight-line code** that is not in the instruction cache is limited
by bytes, not by instructions (`ctlleft.c` `straight`, 1,024 wide
instructions of 8–64 bytes):

| Code in | 4C | 8C2 | 2C3 |
|---|---|---|---|
| instruction cache, 8–64 bytes | 1 instruction a cycle | 1 | 1 |
| L2: bytes per cycle | 25.6 (256 bytes per 10 cycles; 32-byte instructions 1.25 cycles, 64-byte 2.5) | 15–21 (varies with layout) | 23.3 (32-byte 1.38, 64-byte 2.75; 16- and 56-byte runs were slower, unexplained) |
| memory: bytes per cycle | 4.5–5.1 (node-local; about 2 from another node) | 2.7–3.2 | 2.7–3.0 |

So wide instructions of any length up to 64 bytes cost nothing extra in
hot code; in code that streams from L2, those longer than about 24
bytes cost a cycle per 23–26 bytes (4C, 2C3; the 8C2 is slower).

Not measured: v4 and v7; the 48C's different delays (lcc's
`-mset-prepare-ct-delays-e48c`, timing.md); why 56- and 64-byte
instructions with a `disp` exactly 5 cycles ahead lose a cycle.

## v6 [hw: Elbrus-2C3]

Every cost above is the same on the 2C3 (timing.md, "Elbrus-2C3 (v6)").
v6 adds transfers through a register without a CTPR, run by
`tools/isa-probes/ctl6.c` (`gen_ctl6.py` writes `ctl6.s`):

| Operation | What it does | Cost |
|---|---|---|
| `ibranchd,0 %drN, %empty [? cond]` | jump to the address in `%drN` (ALC0; the condition is a ctcond, as for `ct`, not an ALU predicate) | 13 cycles for a one-instruction block: 12 beyond the instruction, however early the address is ready (`ibranch` 6, a `ct` prepared 5 ahead 0); a loaded address adds the load-to-use stall |
| `icalld,0 wbs = N, %drN, %empty` | call the address in `%drN`, `wbs` as for `call`; the callee returns normally and the caller's registers below `wbs` survive | 23 cycles a call with a trivial leaf, against 14 for `disp` + `call` |
| `icall L, wbs = N` (binutils from v6, `opcodes/e2k-opc.c:487`; `tools/isa-probes/timeleft.c` `v6`) | call the label L without a CTPR (CS0 holds the displacement), `wbs` as for `call`: the callee got its argument and the caller's registers below `wbs` survived | 17 cycles a call of a 7-cycle leaf, against 14.3 for `disp`, 5 empty cycles and `call`, and 22.9 for `icalld`. With N cycles of caller work after the return a call takes 8 + N + max(6, 9 − N): 6 cycles more than a `call` through a CTPR prepared in time (`icalld` 12), plus up to 3 that work after the return hides |
| `disp %ctprN, L` and `ct %ctprN` in one instruction (gas allows it from v6) | **no transfer**: execution falls through; so does `movtd` + `ct` (timing.md) | 1 cycle |
| `fillr`, `fillc` | refill the register window or chain stack from memory (source); run in user mode and return normally | about 2 cycles with nothing flushed; right after a `flushr`, `fillr` adds about 63 cycles to a shallow call chain and saves 36 at 64 frames (`ctlleft.c` `fr_*`; operations-v6.md) |

MCST's kernel lists an erratum for every E2C3, E12C and E16C:
`ibranchd` and `rbranch` can corrupt an inactive CTPR (hwbugs.md,
`BRANCH_ACTIVATES_CTPR`).

So for indirect jumps and calls `movtd` 9 cycles ahead (or `disp` 5
ahead) plus `ct`/`call` stays the fast way; `ibranchd`/`icalld` only
save code where nothing else can fill the delay (MCST's binutils uses
`ibranchd` in v7 PLT entries). The direct `icall` saves the `disp` but
not its time: it costs what a `disp` 6 cycles ahead with nothing in
between does, and up to 3 cycles more when the caller has nothing to
do right after the return. Remember the window rule: a callee's
`setwd` must not be smaller than what `wbs` passes it (SIGILL
`ILL_ILLOPC` at the callee's first instruction).

## How lcc uses it [lcc]

From `-O2` code for an if/else with calls, a counted loop, a loop with a
call, a `switch`, an early exit and an indirect call:

- Every prepare carries `; ipd 2` in v3 code (none from v4 on, above).
- Functions prepare their return in the first wide instructions
  (`return %ctpr3`) and return with `ct %ctpr3`, often under a condition
  for early exits (`ct %ctpr3 ? %pred0`). `%ctpr3` is also used for other
  transfers when the return is not yet prepared (`disp %ctpr3, g` for a
  tail call in a `switch`).
- Calls: `disp %ctprN, f` well ahead, then `call %ctprN, wbs = 4`;
  conditional calls (`call %ctpr1, wbs = 4 ? %pred0`) next to the opposite
  `ct` for if/else. At `-O3` most calls are predicated: 12,999 of 20,519
  in lcc 1.29.16's SQLite for v5, and 2,592 of 5,921 in Lua 5.4.7 for v3.
  Each callee is prepared in its own CTPR before the condition is known,
  so two predicated calls in opposite arms run back to back: `if (f ==
  2) lng (l); else dbl (d)` is `disp %ctpr1, dbl` and `disp %ctpr2, lng`
  before the compare, then `call %ctpr2 ? %pred0` and, in the next
  instruction, `call %ctpr1 ? ~%pred0` (v3, v5.8c2 and v6.2c3 alike). A
  CTPR prepared before a predicated call is used after it only under a
  predicate that excludes the call's, since a taken call empties all
  three (above; a call under a false predicate leaves them). `sqrt` with
  `errno` is `fcmpledb 0, x` into `p`, an unconditional `fsqrtid,sm`,
  `call %ctpr2 ? ~p` to libm's `sqrt` (the `disp` in the function's first
  instruction) and `fsqrttd,sm ? p`. A prepare takes no predicate (CS0
  has no condition field, [bundle.md](bundle.md)), so lcc prepares
  unconditionally [lcc; the proof-of-concept back end's P67]. A prepare
  written in a conditional arm therefore runs on both paths. lcc keeps a
  noreturn arm (`if (bad) { f (...); abort (); }`) out of predication:
  it predicates the good way and lays the arm out after it as plain
  code that prepares its calls again [lcc 1.29.16 `-O3`, v3, v5.8c2;
  `tools/abi/probes/foldp113_ctprarm.c`].
- After every call it prepares again whatever the rest needs (the loop's
  back edge, the next call, the return), as the hardware requires.
- Counted loops use loop mode: `disp %ctpr1, head` before the loop and
  `ct %ctpr1 ? %NOT_LOOP_END` with `loop_mode`, `alc`, `abn`
  ([loops.md](loops.md)).
- `switch` (lcc 1.29.16 at `-O3` for v3, v5.8c2 and v6.2c3 alike, and
  at `-O2` for v3; lcc 1.31.05 `-O3` for v3; generated switches of N
  arms, K of them calling; the proof-of-concept back end's P65 and
  P72). lcc counts arms, not case values: a run of consecutive values
  with one target counts once, so 32 values in 8 ranges stay small. A
  switch of up to 17 arms becomes predicated code with no table. The
  selector is compared
  against each value into predicates (`cmpesb`, up to four an
  instruction), `landp` trees join the arms' conditions, the arms' loads
  and arithmetic run `,sm`, their stores are predicated, and each arm
  leaves through a conditional `ct %ctpr3 ? %predN`. Up to 13 arms
  without calls make one block; from 14 arms, or with calls, range
  compares (`cmplesb`, with a `ct` to the other part) split the values
  into a few such blocks first. SQLite's `sqlite3VdbeSerialGet` (12 case
  values in 9 arms and a `default`, v5.8c2) is two blocks split at 5, 34
  wide instructions in all. At `-O3` the arms' calls are predicated too
  (`call %ctprN ? %predK`, each callee prepared in its own CTPR
  beforehand); with all 17 arms calling, the switch stays predicated.
  lcc builds a jump table in two cases: from 18 arms, and from 6 arms
  when 6 or more of them end in a tail call (`return g (x)`, which
  becomes a `ct` to `g`; with 5 such arms, of 6 or of 17, the switch
  stays predicated). The table code is a bound compare (`cmpbedb`), an
  `ibranch` out of range, `shld`, an `ldd` of the target from a `.T.N`
  table, `movtd,0,sm` into `%ctpr1` and the `ct` 9 cycles after the
  `movtd`: about 14 cycles from the bound compare to the arm on v3 (3 for
  the load), 16 on v6 (5). Indirect calls use `movtd` the same way, 9
  cycles before the `call`. Labels as values (`goto *p`) go through such
  a table too ([source-compat.md](../abi/source-compat.md), "Labels as
  values").
- `ibranch` is rare: one in the sample against 20 `ct`s.
