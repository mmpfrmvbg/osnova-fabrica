# Operation timing and pipeline hazards

Latencies, control-transfer preparation delays and interlock behaviour,
measured on hardware by `tools/isa-timing/bench.py`. The data is in
[timing-e2s.yaml](timing-e2s.yaml) (generated; do not edit).

Status: **[hw]** on an Elbrus 4C (E2S, elbrus-v3, 750 MHz), an
Elbrus-8C2 (E8C2, elbrus-v5, 1.26–1.5 GHz; data in
[timing-e8c2.yaml](timing-e8c2.yaml), section "Elbrus-8C2 (v5)" below)
and an Elbrus-2C3 (E2C3, elbrus-v6, 2 GHz; data in
[timing-e2c3.yaml](timing-e2c3.yaml), section "Elbrus-2C3 (v6)").
Every latency, hazard and control-transfer delay measured on the 4C and
the 8C2 is the same, except that v5 made `pfdivd` and `pfsqrttd` 2
cycles slower, and an FP result 2 cycles later at the single or double
operand of an 80-bit operation. **v6 changes the timing**: an L1 load
takes 5 cycles instead of 3, an integer compare reaches a predicated
operation in 1 cycle instead of 2, `ldqp` goes through L1, and a few
conflicts are gone; everything else is as on v3 and v5. The sections
below describe v3 and v5; "Elbrus-2C3 (v6)" lists what differs.

## Method

- Cycles are read from `%clkr` (readable from user code, counts core
  cycles: 750.0 MHz against the wall clock).
- **Back-to-back cost**: a chain of dependent copies of one operation, one
  per wide instruction, so each waits for the previous result. Overhead
  is cancelled by the difference between chains of 64 and 32.
- **Scheduled latency**: the same chain with each operation followed by
  `nop`s so the next one issues `gap` cycles later; the latency is the
  smallest gap at which a step costs exactly `gap` cycles (no stall). This
  is the value a scheduler needs. The loop adds a few tenths of a cycle
  a step, taken as the smallest excess over `gap` among a chain's gaps
  (a stall adds at least 3); on the 4C it is sometimes 0.46–0.5 for a
  whole run.
- **Hazards**: a producer and a consumer `D` cycles apart (`D = 0`: same
  wide instruction), checking whether the consumer sees the new value.
  `.ignore strict_delay` keeps gas from inserting delays.
- **`rrd %clkr` waits for nothing** [hw: `tools/isa-probes/sregs.c`
  `clkr`, the three machines]. Two reads in consecutive instructions
  differ by 1. A divide or a cache-missing load between two reads adds
  only its own instruction, because the read does not wait for results
  in flight, unlike x86 `rdtscp`. The counter is also read before the
  interlock stalls of the two cycles in front of the read take effect:
  in `fdivd`, `addd` of its result, read, the 16-cycle stall of the
  `addd` is missing (3 cycles in all), and it shows only when the read
  comes 3 or more cycles after the `addd` (two more instructions: 21; a
  `nop 7` instruction counts its cycles: 27). Cycles count, not
  instructions: `{addd; nop 1}` right before the read still misses the
  stall (4), `{addd; nop 2}` (21) or the `addd` followed by an empty
  `nop 1` instruction (21) shows it [`sregs.c` `clkr`, `fdiv_use_n1`,
  `_n2`, `_e1`]. To time a single sequence, make an operation consume
  the last result and put the second read at least 3 cycles after it.
  The slope between two chain lengths, as used here, cancels this.

The guide's numbers (chapter 6.1) are in the second column for comparison.

## Latencies

| Producer → consumer | Guide | Scheduled latency | Back-to-back |
|---|---|---|---|
| integer add/sub, logic, shift, `sxt` (32 or 64-bit) | 1 | 1 | 1 |
| combined integer (`add_addd`, `shl_addd`; ALC1/4) | 2 | 2 (4 to the other cluster, Clusters) | 5 |
| integer multiply (`muls`, `muld`) | 4 | 4 | 5 |
| FP add, multiply (single and double) | 4 | 4 | 5 |
| FP multiply (`fmuld`, `fmuls`, `pfmuls`) with a denormal operand or a tiny result; adds and divides don't change (semantics.md, "Rounding modes, flush to zero and denormals are zero") | — | 5 | — |
| combined FP (`fmul_addd`), through any of its three operands (all are read at issue: the addend too, `pocchk2.c`, 4C, 8C2, 2C3) | 8 | 8 | 9 |
| FP min/max (`fmaxd`, `fmind`, packed `pfmaxd`) | — | **2** (also on the 8C2) | — |
| `fdivs` | 11 | 11 | 13 |
| `fdivd` | 14 | 14 | 17 |
| `fsqrts` | — | 12 | 13 |
| `fsqrtid` → `fsqrttd` or any FP op; `fsqrttd` → FP op (one double `sqrt`: 25) | — | 11; 14 (13; 16 to an integer op) | 13; 17 |
| `frcps`, `frsqrts` (12-bit estimates, semantics.md) | — | 6 (8 to an integer op) | 9 |
| `sdivs`, `sdivd`, `udivs`, `udivd` | — | **11 to 18, by the quotient's size** (below); 13 for small quotients to an integer op | 13 |
| `ldd`, L1 hit, any of ALC0/2/3/5 → next load's address | 3 | 3 | 5 |
| `ldd` → integer op | 3 | 3 | — |
| `ldb`, `ldh`, `ldw` → integer op | 3 | 3 | — |
| AAU load (`ldaad`, MAS 0 or 0x60, in ALC2 or ALC5, line in L1) → integer op | — | **9** (8C2 11, 2C3 13: each machine's L2 hit, with no cluster-crossing cost; apb.md, "AAU loads"; `memleft.c`) | — |
| integer op → load address | — | 1 | — |
| FP add → integer op | 4 + 2 | 6 | — |
| integer multiply (`muld`, `muls`) → integer op | 4 + 2 | 6 (7 with a write-back conflict, below) | — |
| integer op → FP add | 1 + 1 | 1 in the same cluster, 2 across (see Clusters) | — |
| FP add → FP multiply | 4 | 4 | — |
| compare → predicated ALU op | 2 | 2 | — |
| compare → `ct ? pred` | 3 | 3 | — |
| compare → `call ? pred`, not taken (a false call costs nothing else, also with the chain register file full: predicates.md, "Control transfers"; `callsstack_pcall.c`, 4C, 2C3) | — | 3 | — |
| `disp` → `ct` | 5 | 5 | — |
| `return` → `ct` | 6 | 6 | — |
| `movtd` → `ct` | 9 | 9 | — |
| taken `ibranch` (instant branch), taken prepared `ct` | — | +6, 0 (see [control-transfer.md](control-transfer.md)) | — |
| packed integer (`paddw`, `pandd`, `pcmpeqw`, `pmaxsh`, `psllw`, `pshufb`) | 4 (FP class) | 1 | — |
| packed multiply, `psadbw` (`pmullh`; ALC1/4) | 4 | 2 | — |
| packed integer → integer op | 4 + 2 | 4 | — |
| packed integer → FP add | 4 | 1 | — |
| FP add → packed integer (`pxord`); packed integer → FP add in the other cluster (`bench.py` `faddd_to_pxord`, `faddd_to_pxord_x`, `pxord_to_faddd_x`; 4C, 8C2) | — | 4 (6 to the other cluster); 4. So a `pxord` between two FP operations in one cluster takes them 5 cycles apart, an `xord` 7 (6 + 1); with a cluster crossing either takes at least 7 | — |
| packed integer (`paddh`) → `andd`; `andd` → packed integer, in its cluster and the other; `paddh` → `pandd` → `paddh` (`bench.py` `paddh_to_andd`, `andd_to_paddh`, `andd_to_paddh_x`, `paddh_to_pandd`, `pandd_to_paddh`; 4C) | — | 4; 1 (2 to the other cluster); 1 and 1. So a logic operation between two packed ones in one cluster takes them 2 cycles apart as `pandd`, 5 as `andd` | — |
| conversions (`fdtoid`, `idtofd`, `fstofd`, `fdtofs`, `fstoid`, `fstoidtr`, `fdtoidtr`, `fdtoistr`, `istofd`, `istofs`, `idtofs`) → an op reading the result in its format | — | 4 (5 or 6 in another format, see Formats) | — |
| `fdtoid` → integer op | — | 6 | — |
| integer op → `idtofd` | — | 1 | — |
| FP compare into a register (`fcmpeqd`) | — | 2; 4 to an integer op | — |
| `lzcnts`, `scls`, `getfs` | 1 | 1 | — |
| `sxt`, `merged`, `popcntd`, `lzcntd`, `bitrevd` | 1 | 1 | — |
| `umulhd` (high half of a 128-bit product) | 4 | 4 | — |
| `smulx`, `umulx` (32 × 32 → 64) | — | 4; 6 to an integer op | — |
| `insfs`, `insfd` (field insert) | — | 1; 2 across clusters | — |
| `sdivx`, `udivx`; `smodx`, `umodx` (64 ÷ 32, ALC5) | — | 11; 10 (13; 12 to an integer op) | — |
| `mpsadbh` | — | 2; 4 to an integer op | — |
| `fsubs`, `fsubd`; `fmaxs` | — | 4; 2 | — |
| round to integral `fdtoifd`, `fstoifs` | — | 4 | — |
| `fscaled`, `fscales` (v4+, Elbrus-8C2) | — | 4 | — |
| x86 flag forms (`adds_fw`, `subs_fw`, `ands_fw`, `incs_fw`, `shls_fw`, `addd_fd`, `subd_fd`, `incd_fd`, `shld_fd`, `sard_fd`, in ALC0 or ALC3) → an integer op, compare, `cctop`, `merges`, `smulx` or `fadds` in the producer's cluster; the same in the other cluster; store data (pocchk4.c) | — | 2; **4**; 1 (3 from the other cluster) | — |
| `smulx_fw`, `umulx_fw` → `smulx`; → an integer op, compare or `cctop` in either cluster; → store data (pocchk4.c) | — | 4; 6; 4 | — |
| `cctop{o,b,e,l}` → predicated ALU op or `merge` | — | 2 (as `cmpesb`; 1 on v6) | — |
| `cctop*` → `ct ? pred` (pocchk4.c) | — | 3 (as `cmpesb`) | — |
| `abgd`, `abgi` → a read of `%g24`–`%g31` under the new rotation (v3–v5) | — | the next instruction (`native.c`) | — |
| `rws %bgr` → a read under the new rotation (v3–v5) | — | 10, or the next instruction after `wait all_e` (`native.c`) | — |
| 80-bit `fxaddxx` / `fxmulxx` / `fxdivxx` | — | 5 / 4 / 16 | — |
| `fxaddxx` → integer op | — | 7 | — |
| `movfi` → `movif` (unpack and repack an 80-bit value) | — | 4 | — |
| `movif` → `movfi` (pmu.c) | — | 4 | — |
| `movif` → integer op, `movfi` → integer op (pmu.c) | — | 6 (a consumer 2 cycles after stalls 8, not 4) | — |
| `getsp` → integer op (pmu.c) | — | 2 | — |
| `fdtofx` → `fxtofd` | — | 5 | — |
| 80-bit with a single or double result (`fxadddd`, `fxmuldd`, `fxmulxd`); `fxdivdd` | — | 5; 18 | — |
| `fxtoid`, `idtofx`, `fstofx` | — | 5 | — |
| 80-bit square root steps `fxsqrtixx`, `fxsqrtuxx`, `fxsqrttxx` (ALC5); lcc's chain of the three | — | 11, 16–17, 16 | 53 a chain (double `fsqrtid` + `fsqrttd`: 30) |
| compare → `andp` (reading the `%pred`) | 1 | 1 | — |
| `andp` → `andp` | 0.5 | 0 inside one wide instruction (`@p4` → next CLP), 1 through a `%pred` | — |
| `andp` → predicated ALU op | 2 | 2 | — |
| `andp` → `ct ? pred` | 3 | 3 | — |
| FP compare (`fcmpltdb`; `fxcmp*b` in any format, `timeleft.c`) → predicated ALU op or `merge` | — | 4 (an early reader stalls in 2-cycle steps on v3 and v5: "Stalls cost more than the latency") | — |
| FP compare → `ct ? pred` | — | 5 | — |

**Integer divides take longer for larger quotients** (`pocchk.c`, the
smallest gap from a divide to its use that costs no stall; 4C, 8C2 and
2C3 alike, signed and unsigned alike): 11 cycles for quotients below
2^8, then about one more per 8–10 bits: 12 (2^10–2^17), 13 (2^20), 14
(2^27), 15 (2^37), 16 (2^47), 17 (2^57), 18 (2^63); `sdivs` 11–14 up to
2^31. `bench.py`'s 11 is the small-quotient case (its chain divides 1
by 1). A scheduler can't know the quotient; 13–15 covers quotients up
to 2^37. FP divides don't vary (`fdivd` 14 whatever the operands). The
quotient arrives on the FP side, like an FP result: an integer operation
waits 2 more, in either cluster (`sdivd` → `addd` 13 in ALC0 or ALC5),
an FP-side one doesn't (`sdivd` → `idtofd` 11; "Every v3 operation",
below).

Rows marked (pmu.c) come from `tools/isa-probes/pmu.c` (producer, D
cycles of `nop`, consumer, counted with the TICKS monitor;
[monitors.md](monitors.md)), not from `bench.py`, so they are not in
`timing-e2s.yaml`; nor is the AAU load row, from
`tools/isa-probes/memleft.c` `timing` (`t_use_ldaad*`: the load, D
empty cycles, an `addd` in ALC0; 4C, 8C2, 2C3).

Rows marked (pocchk4.c) come from `tools/isa-probes/pocchk4.c`, section
`lat`, not from `bench.py`. Each step is a producer with constant
inputs, G − 1 empty cycles and a consumer; 12 such steps after 4 run
between two `%clkr` reads, so only the producer → consumer edge can
stall. The 4C, the 8C2 and the 2C3 print the same. `bench.py` chains
each flag form into a consumer in its own channel (under `dbl = 1`),
which is why it found 2 everywhere.

The scheduled latencies of scalar integer, FP, control and predicate
operations match the guide. Differences:

- The guide's integer → FP "+1" appears only when the consumer is in the
  other cluster, and integer → integer pays it too: it is a cluster
  crossing, not a domain crossing (see Clusters).
- Packed integer operations are not 4-cycle FP-class operations on the
  4C: most take 1 cycle (multiply and `psadbw` 2) to another packed or FP
  operation. Their results reach integer operations at 4, like an FP
  compare into a register: the FP-side → integer penalty is +3 for the
  1-cycle ones and +2 otherwise.
- Conversions take 4 to a consumer that reads their result in the
  format they produce (and 6 to integer operations); the 5 (`fdtofs`
  6) recorded earlier came from chaining a conversion into itself,
  which reads its result in another format (Formats, below).
- FP compares into predicates are two cycles slower than integer
  compares (4 to a predicated operation, 5 to `ct`).
- Loads beyond L1 are not scheduled for (see Memory).

## Every v3 operation [hw]

`bench.py --only v3op` chains every v3 computational operation that had
no scheduled latency (811 chains, generated from `binutils-ops.yaml` as
the v5 ones are): the result feeds the same operation, or a conversion,
`merge` or `cctope` that reads it in the format it was produced in, and
each FP-side result also goes to an integer operation in its own
channel. Combined integer operations are chained through each operand,
and so are `fxdivt*`, whose single or double operand comes first.
The 4C, the 8C2 and the 2C3 agree on every chain except where noted
(v6: an integer compare or `cctop` reaches `merge` in 1, as above; v5
and v6: `pfdivd` and `pfsqrttd` 16; v5: `fxdivtss` and `fxdivtdd`
through their single or double src1 18, "Elbrus-8C2 (v5)"). The data
is in the three YAML files (`v3op_*`, `v3st_*`).

| Latency to its own kind | To an integer op | Operations |
|---|---|---|
| 1 | — | scalar logic, shifts and rotates (`scl`, `scr`), `getfd`, `merges`, `popcnts`, `bitrevs`, `sub` |
| 1 | 1 | the tag operations (`tools/isa-probes/tagx.c`, `lat` section; 4C, 8C2, 2C3 alike): `puttagd` through either operand (+1 to the other cluster, as any integer result), `puttags`, `gettags`, `gettagd` (to a 32-bit consumer; a 64-bit one waits 4, Formats) |
| 1 | 4 | every packed integer operation except the multiplies: add and subtract (also saturating), compares, min/max, averages, shifts (`psllqh` …), packs and unpacks, `pshufh`, `pshufw`, `pmerge`, `pinsh`, `pextrh`, `pmovmsk*`, `psign*`, horizontal add and subtract, logic |
| 2 | 2 | the x86 flag forms (`*_fb`, `_fh`, `_fw`, `_fd`); combined integer operations through any operand (`and_addd`, `add_xord`, `merge_addd` …) (both: 4 to the other cluster, below); an integer compare, `cmpand*` or `cctop*` → `merge` (v6: 1); the tag-keeping moves `movts`, `movtd`, `movtq` between registers (`tagx.c`; `movtd` → `ct` is 9, Latencies) |
| 2 | 4 | FP compares into a register (`fcmp*s`, `fcmp*d`, `pfcmp*`; `fcmpeqd` → `addd` 4 in either cluster, Clusters), FP min/max (`fmins`, `pfmax*`, `pfmin*`), packed multiplies (`pmulh*`, `pmadd*`, `pmulubhh`), `phminposuh` |
| 4 | 4 | the FP flags compares `fcmp{ud,od}{s,d}f` (to `cctop` as to any integer op; 4 to an integer op in either cluster, Clusters) |
| 4 | — | FP compares into a predicate (`fcmp*b`, `fxcmp*b`) → predicated op or `merge` |
| 4 | 6 | FP add, subtract, multiply, scalar and packed (`pfhadds`, `pfaddsubs` …); conversions, also packed (`pfdtois`, `pistofs` …) and round to integral, to a consumer of their format; `smulhd`, `umulhd`, `umulx`; the multiply flag forms (`smulx_fw` …); 80-bit `movx`, `movxa`, `movxc` and `fxmul*` with an 80-bit result |
| 5 | 7 | 80-bit add, subtract and `rsub`, `fxmul*` with a single or double result, conversions to and from 80-bit (`fxto*`, `*tofx`) |
| 6 | 6 | the 80-bit flags compares `fxcmp{ud,od}*f` (to `cctop` as to any integer op) |
| 6 | 8 | `frcps`, `frsqrts` |
| 8 | 10 | combined FP, scalar and packed, every first and second stage (`fsub_rsubs`, `pfhadd_addsubs` …) |
| 10 | 12 | `smodx`, `umodx` |
| 11 | 13 | integer divides with small quotients (`sdivs`, `sdivd`, `udivs`, `udivd`, `sdivx`, `udivx`; 11–18 by the quotient, above), `fsqrtid`, `pfdivs`; the 80-bit `fxsqrti*` (to an FP op only) |
| 12 | 14 | `fsqrts`, `pfsqrts` |
| 14 | 16 | `fdivd`, `fsqrttd`; `pfdivd` and `pfsqrttd` on v3 (16 and 18 on v5 and v6) |
| 16 | 18 | 80-bit divides `fxdiv*` and `fxdivt*`, `fxdivt*` through either operand (8C2: 18 into the single or double operand from an FP operation, "Elbrus-8C2 (v5)"; `tools/isa-probes/sregs.c` `latg` agrees); the square root steps `fxsqrtu*` (`fxsqrtuxx` 16–17, 18 on v6) and `fxsqrtt*` (to an FP op only) |

What this adds to the table above:

- **Every FP-side result reaches an integer operation 2 cycles later**,
  in any channel and either cluster, and that includes the divider's
  integer results (13, not 11) and the 80-bit unit's (7). Packed integer
  results and FP compares into a register are the exceptions with +3,
  as before.
- **A double square root is 25 cycles**: `fsqrtid` 11, `fsqrttd` 14
  (`fsqrttd` reads `fsqrtid`'s result as its second operand, which it
  needs: semantics.md). The 12, "about 17" and 8 for `fsqrtid`,
  `fsqrttd` and `frcps` recorded before came from `sqrt.c`'s
  back-to-back chains, which include the stall (13, 17, 9).
- **`pfdivd` and `pfsqrttd`** compute what `fdivd` and `fsqrttd` do
  (semantics.md) and take as long on v3, but 2 cycles more on v5 and
  v6.
- `fxdivt<a><r> src1, src2` divides a single or double src1 by an
  80-bit src2 (semantics.md, "80-bit operations"). Their chains divide
  1.0 by 1.0: through src1 (`v3op_fxdivtss`, `v3op_fxdivtdd`; an
  80-bit result converted back, `v3op_fxdivtsx_to_fxtofs`,
  `v3op_fxdivtdx_to_fxtofd`), through src2 (`_opb`; a single or
  double result converted to 80-bit) and to an integer op: 16 (18 to
  the integer op) on all three machines, except `v3op_fxdivtss` and
  `v3op_fxdivtdd` on the 8C2, 18 (an FP result into the narrow src1,
  "Elbrus-8C2 (v5)"). The chains before 2026-10-12 passed the 80-bit
  value as src1, which makes the result invalid, and timed that path
  (19; 20 to an integer op).
- `pextrh`'s own chain reads its 32-bit result as 64 bits; its 4 to
  `adds` is the cleaner figure. `puttags`, `gettags` and `gettagd`
  write 32-bit results too: `gettagd` → `gettagd` measures 4 because
  the second reads 64 bits of the first's result (Formats, "32-bit
  integer results read as 64 bits"). `pmovmsk*` were chained as packed
  integers (1), their result being an integer mask: 4 to an integer op.
- **2-cycle integer results cross clusters at +2**, not +1. An x86 flag
  form (`adds_fw`, `addd_fd`, `ands_fw`, `shls_fw`) reaches an integer
  operation, compare or `cctop` in its own cluster in 2 cycles and in
  the other cluster in 4, and a combined integer operation (`add_addd`
  in ALC1) reaches `adds` the same way. Both reach a store's data in 1,
  or 3 from the other cluster [hw: `tools/isa-probes/pocchk4.c` `lat`;
  4C, 8C2, 2C3]. So do the other combined integer operations measured,
  `and_addd` and `shl_addd` in ALC1 and `add_addd` and `add_xord` in
  ALC4: 2 to `adds` in their cluster, 4 in the other, store data 1 and
  3 [hw: `tools/isa-probes/timeleft.c` `lat`; 4C, 8C2, 2C3]. The chains
  above put each operation in one channel. `cctop` runs only in
  ALC0 and ALC3, so the `cctop` in a flag form's own channel gets the
  flags in 2 and the other one in 4 (found by the proof-of-concept back
  end, I50: overflow-checked loops with `cctopo` 3 cycles after
  `adds_fw` in the other channel ran at 2.3 cycles an iteration instead
  of 1). The multiply flag forms are FP-side results (the 4 | 6 row): 6
  to `cctop` or any integer operation in either cluster, 4 to `smulx`
  and to store data in their cluster, 6 to store data in the other
  (`timeleft.c` `lat`).

**The divider.** Every ALC5 operation that divides, takes a root or
estimates a reciprocal shares one unit with `fdivd` (`v3div_*` kernels):
alternating with `fdivd` it costs what `fdivd` alone does (5 an
instruction), and two a cycle apart take 13 cycles a pair, as two
`fdivd`. Cycles per operation when one issues every `g` cycles:

| Operations | `g` = 1 | 2 | 3 | 4 | 5 | 6+ |
|---|---|---|---|---|---|---|
| `fsqrtid`, `udivs`, `sdivx`, `udivx`, `pfdivs`, `frcps`, `frsqrts`, `fxsqrtixx` (as `fdivs`) | 5 | 2 | 3 | 4 | 5 | `g` |
| `udivd` (as `sdivd`) | 5 | 3.4 (v5, v6: 2) | 3 | 4 | 5 | `g` |
| `pfdivd` | 5 | 2 (v5: 2.5) | 3 | 4 | 5 | `g` |
| `fxdivxx`, `fxdivdd`, `fxdivss` | 5 | 3.4 | 3 | 4 | 5 | `g` |
| `fxsqrtuxx`, `fxsqrttxx` | 5 | 3.4 | 3 (v5, v6: 4.4) | 4 | 5 | `g` |
| `fsqrttd` | 5 | 4 (v6: 2) | 5 (v6: 3) | 4 | 5 | `g` |
| `pfsqrts` (as `fsqrts`) | 7 | 2.8 | 3 | 4 | 7 | `g` |
| `pfsqrttd` | 5 (v5: 6) | 4 (v5: 3.6, v6: 2) | 5 (v5: 3.9, v6: 3) | 4 | 5 (v5: 6) | `g` |
| `smodx`, `umodx` | 9 | 10 | 11 | 12 | 9 | 10, 11, 12, 9 … |

`smodx` and `umodx` hold the unit for 9 cycles: anything issued sooner
waits in 4-cycle steps (alternating with `fdivd`, 7 an instruction; two
a cycle apart, 21 a pair, or 17 with `fdivd` either way round).
isa-score models all of these as divider operations, and the 9 cycles.

**State registers** (`v3st_*`). `rrs` and `rws` of `%pfpfr`, `%fpcr`
and `%upsr`, and `rrd %ip`, issue one a cycle. A read of the FP state
(`%pfpfr`, `%fpcr`, `%fpsr`) delivers its value 11 cycles later; `%upsr`
and `%ip` 2. Writes need no distance: an operation in the next
instruction sees a new `%pfpfr` or `%fpcr`, and an `rrs` of the flags
issued in the instruction after an FP operation waits nothing (its
result is late anyway). Two patterns serialise: a write after a read of
`%pfpfr` waits for the read (`rws`, `rrs` alternating: 10 cycles a
pair), and a write of `%pfpfr` does not overlap a divide in flight
(`fdivd`, `rws` alternating: 22 a pair; with `faddd` 2). So `fesetenv`
and friends cost a dozen cycles, and FP code should not read the flags
on a hot path. `rrd %clkr` and `rrd %idr` deliver their value 2
cycles later, and `rrs %core_mode` 4 cycles later (an `addd` 1 cycle
after the read stalls 4 cycles; for `%clkr` and `%idr` the stall is
gone at 2 cycles, for `%core_mode` at 4). Back to back, `rrd %clkr`
and `rrd %idr` issue one a cycle. An `addd` 1 cycle after `rrs %pfpfr`
stalls 12 cycles, which agrees with the 11 above [hw:
`tools/isa-probes/sregs.c` `clkr`, the `rd_*` cases; 4C, 8C2 and 2C3
identical].

**`wait`** (`v3wait_*`) costs 6–7 cycles even with nothing outstanding
(`all_c`, `ld_c`, `ld_c`+`st_c` 7; `st_c`, `all_e` 6). After the
operation it waits for, a pair costs: `std` then `wait st_c` (or
`ld_c`+`st_c`, `all_c`) 15 (v6 16), so a store completes about 14
cycles after issue; `ldd` then `wait ld_c`+`st_c` 8 (v6 11); `faddd`
then `wait all_c` 10, `all_e` 10 (v6 16); `fdivd` then `wait all_c`
20. A C11 fence or seq_cst store (atomics.md) therefore costs about 15
cycles after a store.

The other fields [hw: `tools/isa-probes/memleft.c` `wait`; cycles a
repetition for the `wait` alone, a `std` then the `wait`, and an `ldd`
then the `wait`, as in the pairs above; 4C / 8C2 / 2C3 where they
differ; the field bits: bundle.md, "`wait` fields"]:

| `wait` | Alone | After `std` | After `ldd` |
|---|---|---|---|
| `ma_c` (also with `st_c`, with `fl_c`, and all six fields) | 6 (with `fl_c` or all six: 8) | **25 / 33 / 20** | 11 / 12 / 13 |
| `fl_c` | 8 | 10 | 9 |
| `all_c, fl_c` (glibc's spinlock fence) | 8 | 15 / 15 / 16 | 9 / 9 / 11 |
| `all_e` | 6 | 10 | 10 |
| `st_c, sas` (v5+) | 2 | 7 / 5.75 (8C2 / 2C3) | 3 |
| `ld_c, sal` (v5+) | 2 | 3 | 7 / 3 (8C2 / 2C3) |
| `ld_c, st_c, sal, sas` (lcc's v5 release) | 2 | 7 / 6 (8C2 / 2C3) | 7 / 3 (8C2 / 2C3) |
| `st_c, las` (v6) | 2 | 6 | 3 |
| `ld_c, lal` (v6) | 2 | 3 | 6 |
| `ld_c, st_c, sas, sal, las, lal, mt` (the kernel's v6 `smp_mb`) | 2 | 6 | 6 |
| `mt` (v6) | 2 | 3 | 3 (with `ld_c, st_c`: as without it) |

After a store, `ma_c` waits far longer than `st_c` (20–33 against 15–16
cycles). `fl_c` there costs one cycle more than the store and the
`wait` take apart (10 against 1 + 8), and `all_e` three more (10
against 1 + 6), both well short of `st_c`'s 15. A soft modifier (`sas`,
`sal`, `las`, `lal`) cuts the `wait` alone from 6–7 cycles to 2, and
after a store from 15–16 to 6–7. After a load the saving varies: `ld_c,
sal` costs 7 against `ld_c`'s 8 on the 8C2 but 3 against 9 on the 2C3,
and `ld_c, lal` 6 (2C3). Each modifier costs the same without its
`st_c`/`ld_c` bit (raw encodings, 2C3), and v5 ignores bits 9–11. What
these fences cost in atomics, and what the soft bits order: atomics.md.

**`wait trap = 1`** in user mode never returns [hw: all three;
`memleft.c` `trap`]: the thread stayed in it for 5 s until `alarm`
killed it, and stayed through five handled SIGALRMs, 20 ms apart,
without returning (that it is back on the `wait` after each interrupt
is inferred). It is the kernel's v3–v5 C1 idle state, which the kernel
leaves only by rewriting the return address in its interrupt handler
(`arch/e2k/kernel/cpu/iset_v3.c:465` `C1_wait_trap`,
`kernel/traps.c:1735` `handle_wtrap`); v6 idles with `wait int = 1,
mem_mod = 1` instead (`asm/e2k_api.h:7833`) [source]. A compiler never
emits it.

## Formats

An FP-side result read by an FP-side operation in another format than
the one it was produced in arrives later (`bench.py` chains
`<producer>_to_<consumer>`, the 4C and the Elbrus-8C2 alike):

| Result read as | Scheduled latency | Examples |
|---|---|---|
| its own format | 4 | `faddd` → `fdtoid`, `fdtoid` → `idtofd`, `fdtofs` → `fadds`, `fadds` → `fadds`, `qpfdtoid` → `qpidtofd` or `qpaddd` |
| a double or 64-bit integer read as a single (also packed singles) | 5 | `faddd` → `fadds`, `fstofd` → `fadds`, `fmuld` → `fmuls`, `fmuld` → `pfmuls` |
| a 64-bit integer read as a double | 5 | `fdtoid` → `faddd`, `fdtoid` → `fdtoid` |
| a single read as a double | 6 | `fadds` → `faddd`, `fadds` → `fdtoid`, `fdtofs` → `faddd`, `fdtofs` → `fdtofs` |

C code meets the slow cases rarely (a conversion reads its own input
format, and promotions are explicit `fstofd`), but self-chained
measurements do: the v5 conversions' 5 and 6 in the table of v5
latencies below are of this kind (with a consumer of their format,
`qpfdtoid` and `qpidtofd` take 4). The 64-bit → 128-bit penalty of v5
("Crossings with 128-bit values", below) may be the same effect.
`tools/isa-score` uses 4 for every conversion and does not model the
penalty.

**32-bit integer results read as 64 bits.** Under `setwd dbl = 0` a
32-bit integer operation writes only the low half of its destination
([registers.md](../abi/registers.md), `dbl`). An operation that reads
the whole 64-bit register gets the result 4 cycles after the producer
issues instead of 1. This holds in the same cluster or the other one
(the crossing adds nothing).

Measured producers: `adds`, `ands`, `xors`, `shls`, `merges`, `getfs`,
`gettagd` and the x86 flag forms (`adds_fw`, `addd_fd`, `ands_fw`,
`shls_fw`, whose flags word is a 32-bit result), from ALC0 or ALC3;
also `subs`, `ors`, `andns`, `shrs`, `sars`, `scls`, `scrs`,
`bitrevs`, `insfs` (ALC0), `lzcnts` and `popcnts` (ALC1), into `addd`
in ALC0 (4 under `dbl = 0`, 1 under `dbl = 1`, 1 into `adds`).
Measured consumers, in ALC0–5: `addd`, `andd`, `shld`, `getfd`,
`cmpedb`, `merged`, `movtd`, `gettagd` and `faddd`, a load or store
index (`ldd` in ALC0 or ALC3, `std`), and `std`'s data (ALC2 or ALC5).

A reader of the 32-bit operand gets it at its usual latency: 1 for
`adds` (2 from the other cluster), `cmpesb`, `sxt 2`, `getfs`, `merges`,
`fadds` and `stw`'s data. A producer slower than 4 is not delayed
further (`muls` → `addd` 6, as `muls` → `adds`; `smulx_fw` → `addd` 6).
Under `dbl = 1`, which zero-extends the result into the whole register,
the 64-bit readers also get it at the usual latency: 1, 2 from the
other cluster, and `std`'s data 1 from either (from a flag form: 2, 4
from the other cluster, store data 1) [hw: `tools/isa-probes/tagx.c`
`adds_addd`, `ands_andd`, `shls_shld`, `adds_addd1`, `adds_addd3`,
`adds3_addd4`, `adds_movtd`, `adds_gettagd`, `gettagd`, `adds_sxt`,
`muls_addd`, `*_dbl1`; `tools/isa-probes/pocchk4.c` `lat`, the `dbl 0`
and `dbl 1` rows; `tools/isa-probes/timeleft.c` `lat`, the second list
of producers; the 4C, the Elbrus-8C2 and the 2C3 alike].

So lcc's `adds` + `sxt` under `dbl = 0` costs nothing extra, while a
64-bit use of a 32-bit result without the `sxt` waits 4. Under
`dbl = 0`, read 32-bit values with 32-bit forms (`getfs`, `cmp*sb`,
`stw`) or extend them first. The proof-of-concept back end met this
too (I51): `getfd` of an `xors` result held a pipelined loop at 3
cycles an iteration, `getfs` at 1. `tools/isa-score` models it, per
function from its `setwd`.

## Clusters

The six ALU channels form two clusters, ALC0–2 and ALC3–5. A result
reaches the other cluster later (scheduled latency, producer in ALC0 or
ALC3, consumer in the channel shown):

| Producer | Consumer in the same cluster | Consumer in the other cluster |
|---|---|---|
| integer ALU op (`addd`) | 1 to an integer op, FP op or load address (ALC1, ALC2: 1) | 2 (ALC3, ALC4; ALC3 → ALC0 also 2) |
| x86 flag form (`adds_fw`); combined integer op (`add_addd` in ALC1, into `adds`) | 2 to an integer op, compare or `cctop` (ALC1, ALC2: 2) | 4 (ALC3–5; ALC3 → ALC0 also 4) |
| `ldd`, L1 hit | 3 (to `addd` or the next load's address) | 4 |
| FP add/multiply, integer `muld` | 4 to an FP op or `muld`; 6 to an integer op | 6 to any op |

So 1-cycle integer and load results cost one extra cycle across
clusters. The 2-cycle integer results measured (flag forms, `add_addd`)
and FP-class results cost two, which an FP → integer use pays anyway
[hw for the 2-cycle row: `tools/isa-probes/pocchk4.c` `lat`; 4C, 8C2,
2C3]. All of these
paths are interlocked (hazard tests `int_fp_use`, `fp_int_use` and their
`_x` cross-cluster forms see the new value at distance 1). For a
scheduler: give each result two latencies, own cluster and other cluster,
and prefer placing a consumer in the producer's cluster.

**FP compares into a register cross for free** [hw:
`tools/isa-probes/pocchk5.c` `lat`; 4C, 8C2 and 2C3 alike]. `fcmpuddf`,
`fcmpoddf` and `fcmpudsf` in ALC0 or ALC3 reach `cmpesb`, `cmpandesb`,
`cctope`, `xors`, `adds`, `getfs`, `getfd` and `addd` in 4 cycles, in
their own channel, their own cluster and the other cluster alike, and
`fcmpeqd` reaches `addd` in 4 in either cluster too (the control,
`faddd` → `addd`, takes 6 in both, as the table says). A consumer one
or two cycles early stalls 4. A 64-bit read of the 32-bit flags word
(`getfd`, `addd`) under `dbl = 0` gets it in 4 as well: the wait of
"Formats" adds nothing to a producer this slow. So an integer consumer
of these compares gets 4 in any channel, with no crossing cost; a
scheduler that adds the FP-side crossing to them pads 2 cycles after
every quiet compare (found by the proof-of-concept back end, P82;
`tools/isa-score` already gives them 4).

**A store's data** waits like an FP operand, not an integer one
(`tools/isa-probes/pocchk2.c`, `t_fpst_*` and `t_ist_*`; a chain of
steps, each a producer of the next value and a store of the last one in
one instruction; 4C, 8C2 and 2C3 alike; found by the proof-of-concept
back end, I44):

| Producer → store data | Same cluster | Other cluster |
|---|---|---|
| `addd` | 1 | 1 (no crossing cost) |
| `ldd`, L1 hit (`timeleft.c` `lat`) | 3 (2C3: 5) | 3 (2C3: 5): no crossing cost, where an `addd` in the other cluster waits 4 |
| x86 flag form (`adds_fw`), `add_addd` (`pocchk4.c` `lat`); `and_addd`, `shl_addd`, `add_xord` (`timeleft.c` `lat`) | 1 (not the 2 an integer op waits) | 3 |
| `faddd`, `fmuld`; `muld`, `smulx` (`timeleft.c` `lat`) | 4 (not the 6 an integer op waits) | 6 |
| `smulx_fw`, `umulx_fw` (`pocchk4.c`, `timeleft.c` `lat`) | 4 (not the 6 an integer op waits) | 6 |
| packed integer: `pandd` (4C, 8C2, 2C3), `plog`, `qplog`, `psrcd`, `qppackdl`, `qpswitchd` (8C2, 2C3) (`foldisa.c` `lat`) | 1 (not the 4 an integer op waits) | 3 (`pandd` on the 4C, `plog` on the 8C2 and 2C3) |
| `fdivd` (ALC5) | — | 16 (14 + 2) |

(`timeleft.c` `lat` rows: gap method, stores in ALC2 and ALC5,
producers in ALC0, 2, 3 or 5 for `ldd` and in ALC0 or 3 otherwise; 4C,
8C2, 2C3.)

`aaurw`/`aaurwd` (writing `%aaind`, `%aaincr` or `%aabf`, ALC2 or ALC5)
take their operand the same way: an `addd` result from either cluster
the next cycle, with no crossing cost, where an `addd` consumer in the
other cluster stalls (`tools/isa-probes/aaurwct.c`, 16 producer–consumer
pairs: 66 cycles with `aaurw(d)` or a store after `addd,3` or `addd,0`,
134 with `addd,2` after `addd,3`; 4C and 8C2 alike; isa-score models it).
Other producers reach `aaurwd` exactly as they reach a store's data:
`faddd`, `fmuld` and `muld` in 4 in their cluster and 6 in the other,
`ldd` in 3 from either cluster (2C3: 5), `add_addd` in 1 and 3, `addd`
in 1 from either [hw: `tools/isa-probes/timeleft.c` `lat`, `aaurwd`
into `%aaind1` and `%aaincr1` in ALC2 or ALC5; 4C, 8C2, 2C3].

A store's address operands pay the integer crossing (+1, as a load's
address does): two stores a cycle after the `addd`s that advance their
bases take 4.66 cycles an instruction when one base comes from the other
cluster (`t_st2_std_inc_*`). In a pipelined loop that crossing stalls
every iteration: a daxpy kernel at II 4 whose stores read a base that
an `addd` in the other cluster wrote one cycle before runs 8.00 cycles
an iteration instead of 4.00, one stall step an iteration counted in
`BUB_E2_ALUn_OPND` of the waiting store's channel, 2 or 5
(`tools/isa-probes/stbase.c` `age_p_m4`, `dr_*`; 4C, 8C2). Otherwise it
costs nothing which instance of its base register a store reads: in
that kernel the base read through `%b[]` 0 to 5 rotations (3 to 21
cycles) after its `addd`, the same value in a fixed `%dr`, a store
pointer of its own, offsets from −4,240 to +1,016 bytes, 2 or 4 stores
an iteration, `loop_mode`, and `,sm` on the other operations or not
all give 4.00 cycles an iteration without a write-back conflict and
6.00 with one ("Write-back conflicts"; 4C, 8C2). This settled the
proof-of-concept back end's finding I35, which had suspected the
stores' rebased base registers.

## Stalls cost more than the latency

The pipeline interlocks, but an early consumer is expensive. For a
4-cycle producer, a consumer placed `g` cycles later costs:

| g | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| cycles | 5 | 6 | 7 | 4 | 5 |

The rule behind every measured gap: an operand that is `e = L − g`
cycles early stalls the consumer's whole wide instruction for
`4 × ceil(e / 4)` cycles, so a step costs `g + 4 × ceil((L − g) / 4)`.
The pipeline retries in 4-cycle steps: one cycle early costs 4, five
cycles early 8. This fits all the chains in `timing-e2s.yaml` (`addd`,
`add_addd`, `muld`, `faddd`, `fmuld`, `fmul_addd`, `fdivs`, `fdivd`,
`fsqrts`, `sdivd`, `ldd`; checked by `tools/isa-score/selftest.py`),
including the dividers' apparent period of 4 and the combined integer
operations' 5 back-to-back (latency 2, one cycle early: 1 + 4). A
`mova` result used early stalls the same way (apb.md). Consequences for
a compiler: model latencies exactly, and fill a known gap with `nop N`
(or independent work) rather than relying on the interlock. This is why
lcc pads with `nop`s.

Each 4-cycle step is one repeat of the pipeline's E2 phase, which the
`BUB_E2` monitor counts ([monitors.md](monitors.md)). Also measured
there (`tools/isa-probes/pmu.c`): a stalled instruction's own `nop N`
cycles come after the stall, not during it; a load in a stalled
instruction delivers its result at its normal latency from the
instruction's real issue; two loads in one instruction, 0 to 256 bytes
apart, don't delay each other. Transfers wait exactly, not in steps
([control-transfer.md](control-transfer.md)).

**A predicate read too early stalls in 2-cycle steps on v3 and v5**,
not 4 [hw: `tools/isa-probes/timeleft.c` `lat`, the `cmpesb0p` …
`fxcmpeqsb0p` rows; `tools/isa-probes/timeleftv.c` `pr`, true and
false predicates and seven kinds of predicated consumer; 4C, 8C2,
2C3]. An operation under
`? %predN` or `? ~%predN` (`addd` in ALC0 or ALC3, `faddd`, `ldd`,
`std`) or a `merge` placed `e` cycles before its predicate is ready
stalls `2 × ceil(e / 2)` cycles: an integer compare one cycle early 2,
an FP compare (`fcmpltdb`, `fcmpledb`, `fxcmp*b` in any format, ALC0
or ALC3) 3, 2 and 1 cycles early 4, 2 and 2. The 2C3 keeps 4-cycle
steps here too (an FP compare 3, 2 or 1 cycles early: 4; its integer
compare is ready the next cycle). A `ct` under the predicate waits
exactly, on all three. Whether the predicate is true or false makes no
difference.

## Write-back conflicts

An FP-side result (FP add or multiply, integer multiply) on its way to
an integer operation arrives one cycle late when an integer-side
operation that writes a register is placed in the **same channel
exactly 2 cycles after** the producer, counted on the schedule as
written (stalls between them don't count: "The schedule as written
decides it", below). Such an operation is an integer ALU
operation (the x86 flag forms included, but not the multiply ones,
which are FP-side) or a load; a store is not, and neither is a compare
or `cctop` into a predicate. With the consumer
placed at the producer's latency, that is a stall step (4 cycles).
Measured (`bench.py`, `*_p*` kernels; the reported latency counts from
the second operation, so the producer → consumer distance is 2 more):

| Producer (ALC0) → `addd,1` | Operation 2 cycles later | Producer → consumer latency |
|---|---|---|
| `muld` | `addd,0` | 7 |
| `muld` | `ldd,0` | 7 |
| `muld` | `addd,1` (other channel) | 6 |
| `muld` | `faddd,0` (FP side) | 6 |
| `faddd` | `addd,0` | 7 |

The multiply flag forms are FP-side producers. `smulx_fw,0` → `adds,1`
or `cctopo` (either channel) takes 6 cycles. It takes 7 when an
`adds,0`, `adds_fw,0` or `ldw,0` issues 2 cycles after it, and stays 6
with a `cmpesb,0`, a `cctopo,0` or another `smulx_fw,0` there. `muld,0`
→ `adds,1` is likewise 7 or 6. `adds_fw` and the other flag forms are
integer-side and suffer no conflict [hw: `tools/isa-probes/pocchk4.c`
`wb`; 4C, 8C2, 2C3; found by the proof-of-concept back end, I50].

Packed integer results don't count as FP-side here, although an
integer operation gets them 4 cycles after the producer, as late as an
FP compare's. `pandd,0`, `plog_0x80,0` and `qplog_0x80,0` → `addd,1`
take 4 cycles with an `addd,0` or `ldd,0` 2 cycles after the producer,
as with nothing there; the control `muld,0` → `addd,1` takes 7 with
either and 6 without [hw: `tools/isa-probes/foldisa.c` `wb`; 8C2, 2C3;
`pandd` and `muld` also on the 4C; found by the proof-of-concept back
end, I54]. `tools/isa-score` gives packed results no conflict, and
`plog`/`qplog` the packed latencies.

The same conflict delays an FP-side result going to an **FP consumer in
the other cluster** (`fmuld,0` → `faddd,3`: 6 cycles, 7 with an
`addd,0` 2 cycles after the `fmuld`), but not one in the producer's
cluster (`fmuld,0` → `faddd,1`: 4 either way); 4C and Elbrus-8C2 alike
(`fmuld_to_faddd_*` kernels; the proof-of-concept back end's finding I19:
a pipelined daxpy kernel at 6.0 cycles an iteration instead of 4.6 from
this). Not affected: FP consumers in the producer's cluster, stores, and
operations in any other channel. lcc's `-O0` code hits it (`muls,0`
then `ldb,0` two cycles later in a hash loop: 17 cycles per iteration
instead of 13). A scheduler should keep the producer's channel free of
integer operations 2 cycles after an FP-side result it routes to the
integer side, or place the consumer a cycle later.

The conflict belongs to the producer's issue cycle, not to the
channel's latest FP-side operation. An FP-side operation (`muld`,
`fmuld`, `faddd` or `smulx_fw`) issued in the producer's channel one
cycle after it doesn't hide the conflict: an `addd` or `ldd` in that
channel two cycles after the producer still delays the producer's
result. And the second operation's own conflict doesn't touch the
producer: an `addd` two cycles after the second operation (three after
the producer) leaves the producer's chain alone. Cycles a step of a
chain, the producer in ALC0 and its consumer at the producer's latency
(16 steps timed with `%clkr`, best of 200 runs; 10.75 is 7 plus a
4-cycle stall step in 15 of the 16 steps, 16 is 12 plus one in each):

| Chain | Second op, ALC0, +1 | `addd,0` or `ldd,0` at +2 | `addd,2` at +2, or nothing | `addd,0` at +3 |
|---|---|---|---|---|
| `muld,0` → `addd,1` → `muld` | none, `muld`, `fmuld`, `faddd` or `smulx_fw` | 10.75 | 7 | 7 |
| `fmuld,0` → `faddd,3` → `fmuld` | the same | 16 | 12 | 12 |
| `smulx_fw,0` → `adds,1` → `smulx_fw` | the same | 10.75 | 7 | 7 |

[hw] `tools/isa-probes/damwb.c` `wb_*`, 4C, 8C2 and 2C3 alike (the
proof-of-concept back end's P81; the +3 column was run with `muld` and
`smulx_fw` as the second operation). So a scheduler must check each
integer operation or load it places against the FP-side operation
issued in the same channel two cycles earlier, not only against the
channel's latest one.

**The schedule as written decides it** [hw: `tools/isa-probes/stbase.c`
`wb_*`; 4C, 8C2 and 2C3 alike; found while settling the
proof-of-concept back end's I35]. What counts is the integer operation
being written 2 cycles after the producer (instructions and their
`nop`s). A stall step that holds an instruction between them, or the
integer operation's own instruction, doesn't remove the conflict, and a
consumer in the integer operation's own instruction gets the late
result too. Loops of a few instructions on fixed registers, the product
read by `faddd,3` in the other cluster (6 cycles), cycles an iteration:

| Loop | Cycles | Stall steps (`BUB_E2`) |
|---|---|---|
| `fmuld,1` in I1, `faddd,3` in I3 (2 cycles later: it waits one step) | 8 | 1 |
| the same and `addd,1` in I3 (written 2 after the `fmuld`, issued 6 after) | **12** | 2 |
| the same, the product read by `faddd,0` (the producer's cluster) instead | 8 | 1 |
| `fmuld,1` in I0, `addd,1` and `faddd,3` in I3 (written 3 after) | 8 | 1 |
| `fmuld,1` with `nop 1` in I1, `addd,1` and `faddd,3` in I2 (one instruction, 2 cycles after) | **12** | 2 |
| `fmuld,0` in I1, `ldd,0` and `faddd,3` in I3 (a load as the integer-side operation) | **12** | 2 |
| a load in I0 used too early in I2 (one step there), `fmuld,1` in I1, `faddd,3` in I3 (on time after the step) | 8 | 1 |
| the same and `addd,1` in I3 | **12** | 2 |
| the same and `addd,1` in I2 instead (written 1 after) | 8 | 1 |
| the same with `fmuld,0` and `ldd,0` in I3 (the early load and its use in ALC2) | **12** | 2 |

`CONF_ALUn_OUT` counts one conflict an iteration in each bold row
([monitors.md](monitors.md)). So a scheduler counts the 2 cycles on the
schedule it writes, and a model applies the delay as written, also to
consumers in the integer operation's instruction (`tools/isa-score`
does).

**In a software-pipelined loop** such a conflict can cost 2 cycles an
iteration on average rather than 4 [hw: `stbase.c`, pipelined daxpy
kernels `y += a x`, four elements an iteration at II 4; 4C and 8C2, and
the `l5_*` forms on the 2C3]. The proof-of-concept back end's kernel
(its finding I35) has `fmuld,1` in I1, whose product `faddd,3` reads in
the next iteration's I3, exactly 6 cycles later, and the x pointer's
`addd,1` in I3, written 2 cycles after the `fmuld`. It runs 6.00 cycles
an iteration (`BUB_E2` 0.50, all `BUB_E2_ALU3_OPND`; `CONF_ALU1_OUT`
1.00). Every iteration's product is a cycle late, but the stall step
one causes also holds back the next iteration's consumer, whose product
was issued before the stall and so arrives in time: only every other
iteration stalls (inferred from the counts; isa-score's simulation with
the rule above gives exactly this). Where nothing stalls between a
producer and its consumer, every iteration pays the step: an 8-instruction loop with the
product read 6 cycles later in the same iteration takes 12 cycles with
the conflicting `addd,1` and 8 without (`wb_far_*`), as the chains above
do. One change at a time on the kernel:

| Kernel | Cycles an iteration |
|---|---|
| as the proof of concept bundled it (`rebased`) | 6.00 |
| the x pointer's `addd,1` and I3's `faddd,4` swapping channels (`rebased_fix`) | 4.00 |
| the x pointer's `addd` one instruction earlier, in ALC4 | 4.00 |
| the late product read in ALC0, the producer's cluster | 4.00 |
| the late product read in ALC4, still the other cluster | 6.00 |
| `fmuld` 2 and 3 swapped (the late product read by `faddd,4`) | 6.00 |
| no stores at all | 6.00 |
| the other kernel of I35 (`plain`, 4.00) with its x pointer's `addd` moved to ALC1 in I3, 2 cycles after its `fmuld,1` | 6.00 |
| a separate store pointer advanced by `addd,4` 2 cycles after `fmuld,4` | 6.00 |

The stores of I35 (which pointer instance they read, their offsets)
change nothing ("Clusters"). In Linpack, whose matrix doesn't fit L1,
the proof of concept measured 4.78 and 6.13 cycles an iteration for the
two kernels; the fraction above 4 and 6 is presumably cache misses
(inferred). On the 2C3 loads take 5 cycles, so the kernels as bundled
for v3 wait for their x loads there (8.00 either way); with the
multiplies, adds and stores 4 cycles later in the same channels and
kernel positions (`l5_*`) it gives the 4C's and 8C2's 4.00 and 6.00.

## Throughput

Measured by `bench.py`'s `tp` kernels: 32 or 64 wide instructions, each
a group of independent operations with constant inputs and fresh
destinations, back to back; the cost per instruction is the difference
divided by 32 (`throughput` in the YAML). Every channel takes a new
operation every cycle, at full width:

| Group per instruction | Cycles |
|---|---|
| 6 `addd`; 4 `muld`; 4 `faddd`, `fadds`, `fmuld`, `fmul_addd` or `fdtoid`; 4 `faddd` + 2 `addd` | 1 |
| 2 `paddw` (ALC0, 3 only on v3); 2 `popcntd` (ALC1, 4) | 1 |
| 2 `add_addd` (ALC1, 4); 2 `add_addd` or `shl_addd` + 4 `addd`: **8 simple integer operations** (4C and 8C2) | 1 |
| 4 `ldd` or `ldw`; 4 `ldd` + 2 `addd` | 1 |
| 4 `ldb`, `ldh` or `ldw`, at fixed or moving addresses (4C, 8C2, 2C3: `timeleft.c` `tp`) | 1 |
| 1 `std` (ALC2 or 5); a store with loads in any allowed channels, far apart | 1 |
| 1 `stb` or `sth`; 2 `stb`, `sth`, `stw` or `std` in different banks (64 bytes apart) or at moving addresses; a byte, halfword or doubleword store in ALC2 with two loads of its size in ALC0 and ALC5, other blocks (4C, 8C2, 2C3: `timeleft.c` `tp`) | 1 |
| 4 of any pipelined 64-bit packed FP operation (`pfaddd`, `pfadds`, `pfsubd`, `pfmuld`, `pfmuls`, `pfmaxd`, `pfmins`, `pfcmpeqd`, `pfcmplts`, `pfcmpuodd`, `pfhadds`, `pfaddsubs`, `pfmul_addd`, `pfmul_adds`, `pfadd_hadds`, `pfdtoifd`, `pfstoifs` and the conversions `pfstois`, `pfstofd`, `pistofs`, `pfdtois`, `pfdtofs`); 1 or 2 `pfaddd`; 4 `pfaddd` + 2 `addd`; 2 `pfmuls` + 2 `fmuld`; 4 `pfmul_addd` + 2 `ldd` (4C, 8C2, 2C3: `pf_*`) | 1 |

The 64-bit packed FP operations (two singles or one double in a 64-bit
register) issue like scalar FP ones: one per allowed channel per cycle,
fully pipelined, with nothing in the other channels slowing them [hw:
`bench.py` `pf_*` and `v5_pf*`, 4C, 8C2, 2C3, 2026-10-12; the
`timing-*.yaml` files gain these kernels at their next full run]. Their
channels are binutils' (gas rejects the others: "`pfmuld' cannot be
encoded in ALC2"): ALC0, 1, 3 and 4 on v3, so 4 `pfmul_adds`, 16
single-precision operations, is v3's peak a cycle; v4+ add ALC2/5 for
some ("Elbrus-8C2 (v5)").

The exceptions are the divider and the memory banks.

**Divider.** `fdivs`, `fdivd`, `sdivs`, `sdivd` and `fsqrts` share one
unit in ALC5 (a `fdivd`/`sdivd` pair alternating behaves like either
alone), and so does every other ALC5 operation that divides, takes a
root or estimates a reciprocal ("Every v3 operation", above, which has
their patterns; `smodx` and `umodx` hold it 9 cycles). It is
pipelined, but some issue distances conflict and stall the later
instruction. Cycles per divide when one issues every `g` cycles:

| `g` | 1 | 2 | 3 | 4 | 5 | 6+ |
|---|---|---|---|---|---|---|
| `fdivs`, `fdivd`, `sdivs` | 5 | 2 | 3 | 4 | 5 | `g` |
| `sdivd` | 5 | 3.4 | 3 | 4 | 5 | `g` |
| `fsqrts` | 7 | 2.8 | 3 | 4 | **7** | `g` |

Fractions are averages of a pattern of stalled and unstalled issues.

**Pairs** [hw: `tools/isa-probes/timeleft.c` `div`, the `dp` and `dq`
lines: all 81 ordered pairs of `fdivd`, `fdivs`, `sdivd`, `fsqrts`,
`fsqrttd`, `pfdivd`, `fxdivxx`, `fxsqrtuxx` and `smodx` 1–6 cycles
apart, and some pairs to 16; `tools/isa-probes/timeleftv.c` `dp`:
ten of them against themselves, `fdivd` and `fsqrts` at 1–14 cycles
with the gap written both ways (below); 4C, 8C2, 2C3]. Two divider
operations one cycle apart stall 4 cycles, whatever the two; further
apart they don't,
with two exceptions. After `smodx` (and presumably `umodx`) anything
waits for its 9 cycles in 4-cycle steps: 8 at 1–4 cycles, 4 at 5–8.
And a single-precision square root (`fsqrts`, `pfsqrts`) stalls a
divider operation (any tried: `fsqrts`, `pfsqrts`, `fsqrtid`, `fdivd`,
`fdivs`, `sdivd`, `fsqrttd`, `fxdivxx`) by 4 at two more distances,
which depend on the root's operand and on how the gap is written,
as empty instructions of their own (`{ fsqrts }` `{ nop 8 }`) or as a
`nop N` in the root's instruction (`{ fsqrts; nop 7 }` `{ nop 1 }`):

| The root's operand | Separate empty instructions | `nop N` in the root's instruction |
|---|---|---|
| 1.0 (also as `pfsqrts`'s low single, the one it takes) | 9, 10 | 2, 10 |
| 0.0 (also as `pfsqrts`'s low single) | 3, 11, 12 (2C3: none) | 4 (stall 4 or 8), 12 (2C3: none) |

The other operations conflict only at distance 1, both ways.

**Runs** of one operation `G` cycles apart, then idle (stall of the
run; [hw: `timeleft.c` `div`, the `dr` lines, and `timeleftv.c` `dr`,
which writes each run both ways: only `fsqrts` differs; 4C, 8C2,
2C3]):

| Run (`G`) | ×3 | ×4 | ×5 | ×6 | ×8 | ×32: cycles an operation |
|---|---|---|---|---|---|---|
| `fdivd`, `pfdivd` (2) | 0 | 0 | 0 | 0 | 0 | 2 (8C2 `pfdivd`: 2.5, stalling only in runs longer than 8) |
| `sdivd` (2), 4C | 0 | 4 | 4 | 4 | 8 | 3.3 (8C2, 2C3: never stalls) |
| `fxdivxx`, `fxsqrtuxx` (2) | 0 | 4 | 4 | 4 | 8 | 3.3 |
| `fxsqrtuxx` (3), 8C2 and 2C3 | 0 | 4 | 4 | 4 | 8 | 4.3 (4C: never stalls) |
| `fsqrttd` (2), 4C and 8C2 | 0 | 0 | 0 | 0 | 12 | 3.9 (2C3: never stalls) |
| `fsqrttd` (3), 4C and 8C2 | 0 | 0 | 8 | 8 | 8 | 4.8 (2C3: never stalls) |
| `fsqrts` of 1.0 (2): separate / `nop N` | 4 / 4 | 4 / 4 | 4 / 4 | 12 / 12 | 16 / 8 | 4.6 / 2.9 |
| `fsqrts` of 1.0 (5): separate / `nop N` | 8 / 8 | 12 / 4 | 16 / 12 | 20 / 8 | 28 / 12 | 9.0 / 6.9 |

The ×32 rates with `nop N` are the table's above (`bench.py` writes its
gaps that way), and triples of the same operation 2 or more cycles
apart stall only for `fsqrts` (`dt` lines). The pair rules don't
predict the runs (with separate empty instructions a third `fsqrts` 5
cycles after the second lands 10 after the first and stalls, but so
does a fourth), so the divider's reservation model is not known. For a scheduler: keep divider
operations at least 2 cycles apart, take the spacing of long runs of
one operation from the table above ("Every v3 operation" for the
others), and keep divider operations off 2–4 and 9–12 cycles after a
single-precision square root, which avoids every pair conflict
measured.

**Two stores in one instruction** take 2 cycles when their addresses
agree in bits 6–7 (the same 64-byte bank of four: 0, 8, 16, 32, 48, 256
or 512 bytes apart), and 1 cycle otherwise (64, 80, 96, 128, 192, 320,
384, 448 apart). `stw`, `sth` and `stb` pairs behave the same way, and
two byte or halfword stores into one doubleword take 2 at fixed
addresses (two `stb` moving on 2 bytes an instruction, so that four
instructions in a row store into each doubleword: 1.28). The bank is
address bits 6–7 and nothing else: two `std` or `stb` 4, 8, 16 or 64
KiB apart take 2 cycles and 64 bytes more 1, with 4 KiB and with 2 MiB
pages (1 MiB too, tried with 4 KiB pages), and 96 random pairs of 4 KiB pages
of a 64 MiB region at one page offset all took 2, at 64 bytes more all
1 [hw: `tools/isa-probes/timeleft.c` `tp`, `bank`; 4C, 8C2, 2C3; loops
of 32 and 64 instructions storing to the same addresses]. Alternating stores to
one bank in successive instructions cost nothing. **This holds only
when instructions store to the same addresses again** (`bench.py`'s
kernels store to two fixed places every instruction): in a run of 32
instructions storing to the same two places 8 or 256 bytes apart, a
pair costs 1.41 cycles on the 4C and 8C2 and 1.53 on the 2C3 (64 apart:
1); when the addresses move on every instruction, as in a stream loop,
two stores cost 1 cycle at any distance (8, 64, 256; also
`tools/isa-probes/stbase.c`'s pipelined daxpy, whose two store
instructions each store two doublewords 8 bytes apart, one bank, runs
at its II, 4.00 cycles an iteration, on all three machines, the 2C3 in
its `l5_` form), and so do a store and a load. AAU stores (`staad`) behave exactly as `std` in all of these
(`pocchk2.c` `t_st2_*`, `t_stld_*`; the proof-of-concept back end's
finding I28).

**A store and a load in one instruction** to the same 8 bytes take
about 1.9 cycles. To other bytes of the same 32-byte block they take
either 2 cycles or 1, and which one is not a property of the code or
the address: identical kernels (same instructions, same data
addresses) differ within one run and between runs, also pinned to one
CPU, in contiguous stretches of the run, so some state left by earlier
code decides it. Different 32-byte blocks never conflict, nor do two
loads (0 to 512 bytes apart), nor a store followed by a load of the
same bytes in the next instruction. The addresses are compared modulo
4 KiB: a store and a load of the same doubleword offset 4, 8, 12, 16
or 64 KiB apart take 2 cycles in every run, with 4 KiB and 2 MiB pages
(1 MiB too, tried with 4 KiB pages) and the load in ALC0 or ALC5,
other doublewords of the block's
offset take 1 or 2 by run as above (8C2: 1.65–2), and other blocks 1
[hw: `tools/isa-probes/timeleft.c` `bank`, `alias`; 4C, 8C2, 2C3].

A compiler cannot see most addresses, but it can for one base register
(stack slots, structure fields): don't put two stores whose offsets
agree modulo 256 within 64 bytes, or a store and a load in the same 32
bytes, in one instruction.

**Combined operations widen the instruction.** A combined operation is
two ordinary ones chained in one channel (semantics.md) with the
latency of both, so it saves no time on a dependent path, but it takes
one channel slot: with two integer combined operations in ALC1/4 an
instruction does 8 simple integer operations a cycle instead of 6, and
4 `fmul_addd` give 8 FP operations a cycle on v3's four FP channels. It
also leaves the intermediate result unwritten. Where channels limit a
schedule (pipelined loops), combining is worth up to a third more
integer work per cycle, and twice the FP work.

## Memory

**Cache geometry** [source: kernel `arch/e2k/kernel/cpu/cacheinfo.c:26-85`,
the table behind `/sys/devices/system/cpu/cpu*/cache`; hw: sysfs on our
three machines and `pf.c`'s stride chase agree]:

| CPU | L1I | L1D | L2 | L3 |
|---|---|---|---|---|
| E2S (4C, v3) | 128 KiB, 4-way, 256-byte lines | 64 KiB, 4-way, 32-byte lines, write-through | 2 MiB per core, 4-way, 64-byte lines, write-back | none |
| E8C2 (8C2, v5) | the same | the same | 512 KiB per core, 4-way, 64 B | 16 MiB shared, 16-way, 64 B |
| E2C3 (2C3, v6) | the same | the same | 2 MiB per core, 4-way, 64 B | none |
| E8C (v4) | the same | the same | 512 KiB, 4-way | 16 MiB shared, 16-way |
| E1C+ (v4) | the same | the same | 2 MiB, 4-way | none |
| E12C (v6) | the same | the same | 1 MiB, 4-way | 24 MiB, 16-way (the table marks it private) |
| E16C (v6) | the same | the same | 1 MiB, 4-way | 32 MiB shared, 16-way |
| E8V7 (v7) | the same | the same | 1 MiB, 4-way | 48 MiB shared, 16-way |

- Every L1D is write-through ("Stores pass through L1$", kernel
  `asm/cache.h:44`), so stores reach L2, whose lines are 64 bytes. The
  kernel pads data that CPUs share to 64 bytes (`SMP_CACHE_BYTES`,
  `cache_line_size()`, `INTERNODE_CACHE_BYTES`; `asm/cache.h:14-62`;
  `L1_CACHE_SHIFT` 5, `L2_CACHE_SHIFT` 6, `E8C_L3_CACHE_SHIFT` 6 in
  `asm/e8c.h:30`), and an atomic's lock covers a 64-byte block
  ([atomics.md](../abi/atomics.md), "What breaks the lock").
- Measured line sizes [hw: `pf.c` part 5, a chase with stride S through
  64 MiB]: the cost per load doubles from stride 8 to 16 to 32 and again
  to 64, then stays (4C 14.9, 27.1, 50.4, 90.5, 89.1, 89.2 cycles): 32-byte
  L1 lines, 64-byte L2 (and 8C2 L3) lines, no adjacent-line fetch.
- Instruction cache: 256-byte lines. MCST's libgcc (`__e2k_clear_cache`)
  and the kernel's `flush_icache_range` flush one address per 256 bytes
  (`E2K_ICACHE_SET_SIZE`: libgcc `config/e2k/clear-cache.c:55-77`, kernel
  `asm/mmu_regs_types.h:303`, `mm/mmu.c:286-289`). What the flush costs:
  [x86-support.md](x86-support.md).
- **No hardware data prefetcher** on our three machines [source, hw]. The
  kernel's feature flags give a TLB and an L1 prefetcher only to v7
  (`CPU_FEAT_HW_PREFETCHER_TLB`, `_L1`) and an L2 prefetcher to
  everything except E2S, E8C, E1C+, E8C2, E2C3, E16C rev < 2 and E12C
  rev 0 (`CPU_FEAT_HW_PREFETCHER_L2`; `asm/cpu_features.h:793-815`); a
  stream without prefetches pays a full memory access for every 64-byte
  line on all three (below). Only software prefetches and APB fetch data
  ahead.
- **TLBs** [hw: `tools/isa-probes/pmu2.c` `tlb*`, `ib_pages_*`,
  [monitors.md](monitors.md), "The other events"; source: kernel
  `asm/tlb_regs_types.h:45-50`]: the DTLB holds 768 4 KiB pages (256
  lines of 4 entries, the fourth kept for large pages: [apb.md](apb.md),
  "Why"); a miss whose page-table entries are cached costs 15 / 17 /
  44–45 cycles (4C / 8C2 / 2C3), stores alike, and with 2 MiB pages a
  16 MiB stream makes none. The ITLB holds 256 to 383 4 KiB pages, and
  a prepare whose target's page misses it fetches nothing
  ([control-transfer.md](control-transfer.md), "Prefetch depth").

Compilers schedule loads for an L1 hit (3 cycles; 5 on v6), and so does
lcc outside pipelined loops. Inside them lcc issues the loads array
prefetch doesn't serve far ahead of their use: 40–90 cycles in 31 of the
155 v3 PolyBench kernels with such loads (mvt's column walk: 22
iterations at II 4), 40–76 on v5 and v6, 22–47 in CoreMark's
`matrix_test`, and NPB CG's gather `p[colidx[k]]` 52 cycles (13
iterations at II 4) on v5 and v6 and 32 (8 iterations) on v3, in rows
of 72.6 elements (class W) whose length it doesn't know (lcc 1.29.16
`-O3`; the proof-of-concept back end's P44 and P74; loops.md, "How lcc
builds loops").
Longer latencies cannot be scheduled for and are left to the interlock,
prefetching and APB, so `bench.py` measures them only with `--memory`
(pinned with `--numa CPU:MEM`). For reference, on the 4C (64 KiB L1D and
2 MiB L2 per core, no L3, four NUMA nodes), a random pointer chase gave:
L2 hit 9 cycles (the guide says 11; `pf.c`'s chase, loop included,
reads 11.2), memory on the local node about
105–110 (+15 with 4 KiB pages, from TLB misses), on another node about
190–235.
This 4C runs its DDR3 memory in two channels per processor instead of
the three the E2S has (owner): latency should hardly change, but any
bandwidth-bound result on it (memory-bound benchmarks, streaming loops)
understates a fully populated machine. The 8C2 has DDR4 in all four
of its memory channels, so 4C/8C2 bandwidth comparisons favour the
8C2 by more than the hardware does.

On the Elbrus-8C2 (64 KiB L1D and 512 KiB L2 per core, 16 MiB L3
shared, one node; `--memory` at 1,500 MHz): L2 hit 11 cycles (scheduled
latency, a 256 KiB chase; the same as `ldqp`, which L2 serves), L3
about 32 (1–8 MiB chases cost 32–33 cycles a load whatever the gap),
memory about 180 (120 ns; a 128 MiB chase) and about 20 more with
4 KiB pages. In nanoseconds the 8C2's L2 is faster than the 4C's (7 ns
against 12) and so is its memory (120 against 145), but in cycles both
are slower, which a schedule tuned for the 4C feels: Unipro's Linpack,
whose 320 KB matrix leaves L1 and which uses no array prefetch, runs
12% slower than isa-score's L1 model on the 8C2 and 6% faster on the
4C.


**Cache hints in the MAS** [source: kernel `asm/mas.h`; lcc]: for
ordinary accesses (MAS `mod` 0) bits 5–6 (`dc_ch`) choose the caches
the access may fill: 0 all, 1 not L1, 2 not L1 or L2, 3 none
(`CACHE_BYPASS_*`). lcc's builtins (`e2kintrin.h`) use them: `ld_*_t1`
is `mas=0x20`, `ld_*_t2` `mas=0x40`, `ld_*_nta` `mas=0x60` (v3 and v5);
`st_*_nt` is a plain store on v3 and `mas=0x40` on v5; the stores of a
loop under `#pragma vector nontemporal` ("no caching at any level, write
combining") get `mas=0x60` (`staad … mas=0x60` in a `loop_mode` loop:
apb.md, "AAU stores"), and lcc's software-pipelined streaming
loops at `-O3` load with `ldd,sm …, mas=0x20` (a second copy of the
loop with `0x40`), after `ldb,sm …, %empty, mas=0x20` prefetches.
Measured with `tools/isa-probes/mas_hint.c` (hand-written loops,
`mas_hint.s` from `gen_mas_hint.py`): 32 MiB from memory, one access a
64-byte line, then rereading a hot working set (ns per line; the 4C on
one node):

| Access | 4C stream | 4C hot set after it | 8C2 stream | 8C2 hot set after it | 2C3 stream | 2C3 hot set after it |
|---|---|---|---|---|---|---|
| `ldd` | 4.8 | evicted (256 KiB: 16 → 121) | 2.22 | evicted, from L1, L2 and L3 | 1.42 | evicted (48 KiB too) |
| `ldd mas=0x20` | 4.4 | evicted (48 KiB partly kept) | 2.25 | evicted | 1.41 | 48 KiB kept, larger evicted |
| `ldd mas=0x40` | 7.6 | **kept** | 2.15 | evicted | 1.40 | **kept** (to 1 MiB) |
| `ldd mas=0x60` | 7.6 | **kept** | **1.77** | **kept** (48 KiB to 4 MiB) | 1.40 | **kept** |
| `std` | 12.5 | evicted | 4.0 | evicted | 4.3 | evicted |
| `std mas=0x20` | 12.3 | evicted | 4.0 | evicted | 4.3 | evicted |
| `std mas=0x40` | 11.4 | **kept** | 3.8 | evicted | **3.4** | **kept** |
| `std mas=0x60` | 12.9 | **kept** | **3.0** | **kept** | **2.9** | **kept** |

So the hints behave as APB's `dcd` does (apb.md): on the 4C, bypassing
L2 (`0x40`) or everything (`0x60`) keeps other data cached at the price
of about 1.6× slower streamed loads (stores cost nothing extra); on the
8C2 only `0x60` keeps it, and makes the stream faster too (loads 1.77
against 2.22 ns a line, stores 3.0 against 4.0), while `0x20` and
`0x40` act as plain accesses. For data read or written once, `0x60` is
the hint to use on v5 and `0x40` on v3; lcc's automatic `0x20` changes
little on either. On the 2C3 (v6; 2 MiB L2, no L3) every hint streams
loads at the same speed (1.4 ns a line), `0x40` and `0x60` keep the hot
set for loads and stores alike, and they make streamed stores faster
(3.4 and 2.9 against 4.3 ns): there either is free.

AAU accesses take the hints exactly as ordinary ones do [hw:
`tools/isa-probes/memleft.c` `hint`]. The measurement is the same, with
two accesses a wide instruction (`h_*`), plus lcc's v5/v6 `#pragma
vector nontemporal` shape (`staad` in a `loop_mode` loop with the APB
program running, `k_staad_*`). A 256 KiB hot set, ns per line before →
after a 32 MiB stream (the 4C run was perhaps not pinned to one node;
each before/after pair comes from one run; **kept**: the same before
and after, `staad` / `ldaad`):

| MAS | 4C `staad` / `ldaad` | 8C2 `staad` / `ldaad` | 2C3 `staad` / `ldaad` |
|---|---|---|---|
| 0 | 9.1 → 72.1 / 9.1 → 63.5 | 5.2 → 60.8 / 5.8 → 59.1 | 3.8 → 53.0 / 3.8 → 45.7 |
| 0x20 | 9.1 → 72.9 / 9.1 → 62.9 | 4.6 → 59.8 / 4.6 → 59.1 | 3.8 → 53.0 / 3.8 → 45.7 |
| 0x40 | **kept** (9.1 / 9.1) | 4.6 → 57.9 / 4.6 → 57.8 | **kept** (3.8 / 3.8) |
| 0x60 | **kept** (9.1 / 9.1) | **kept** (4.6 / 4.6) | **kept** (3.8 / 3.8) |

These match `std` and `ldd` in the same runs, and `k_staad` matches
`h_staad`, so lcc's nontemporal `staad … mas=0x60` protects the cache
on all three machines. One difference from `ldd`: a stream of plain
`ldaad` doesn't disturb a 48 KiB set in L1 on the 4C (5.3 → 5.5) and
the 2C3 (1.9 → 2.1), where `ldd` evicts it (5.5 → 64.6, 1.9 → 44.5),
because AAU loads don't fill L1 (below). On the 8C2 both evict it.

**Software prefetch** [lcc: `tools/abi/probes/prefetch.py`; hw: `pf.c`,
`pf-lcc.c`]. A prefetch is a speculative byte load to `%empty`
(`ldb,sm addr, off, %empty, mas=M`). lcc lowers `__builtin_prefetch (p,
rw, locality)` and `__builtin_e2k_prefetch (p, hint)` (`<e2kintrin.h>`,
hint = locality) to one such load and ignores `rw`; locality 3 depends
on the CPUs the code may run on (`prefetch.py` over every lcc 1.29.16
target and lcc 1.31.05's `-march`/`-mtune`):

| locality | lcc 1.29.16 `e2k-v3`, `v6.16c`, `v6.2c3`; 1.31.05 `e2k-v3`, `v6.2c3`, `-march=elbrus-v3` … `v6`, `-mtune=elbrus-12c`, `16c`, `2c3` | lcc 1.29.16 `e2k-v3.4c`, `v4.1c+`, `v4.8c`, `v5.8c2`; 1.31.05 `e2k-v4.8c`, `v5.8c2`, `-mtune=elbrus-4c`, `8c`, `1c+`, `8c2`, `48c`, `8v7`, `-march=elbrus-v7` |
|---|---|---|
| 0 | `mas=0x60` | `mas=0x60` |
| 1 | `mas=0x40` | `mas=0x40` |
| 2 | `mas=0x20` | `mas=0x20` |
| 3 (also `__builtin_prefetch (p)`) | `mas=0x20` | **no MAS** (0), in ALC3 |

The split follows erratum `PREFETCH_EMPTY` (E12C, E16C and E2C3 rev 0:
prefetches to `%empty` do nothing; workaround, the L1-bypass MAS:
[hwbugs.md](hwbugs.md)): lcc uses MAS 0 only for code that cannot run
on those CPUs (inferred). At `-O0` the generic and 12C/16C/2C3
compilers give locality 1 `0x60`. `-fno-semi-spec-ld` adds the fully
speculative mod 3 (`0x63`, `0x43`, `0x23`; speculation.md). lcc's own
prefetches are `mas=0x20`: every load to `%empty` in the 31 shared
libraries of lcc 1.29.16's sysroots has MAS 0x20. Its options: `-fprefetch`
(loops that are not pipelined), `-fswp-prefetch` (pipelined loops),
`-flist-prefetch` (lists), `-fguess-prefetch=N`; `-fprefetch-loop-arrays`
is accepted.

What each MAS fills [hw: `pf.c` part 4: 128 lines prefetched, a
20,000-cycle wait, then each line loaded once; cycles per load]:

| | 4C | 8C2 | 2C3 |
|---|---|---|---|
| no prefetch (memory) | 88 | 162 | 174 |
| line in L1 / L2 / 8C2 L3 | 3.3 / 11.2 / — | 3.2 / 11.2 / 34.2 | 5.2 / 13.2 / — |
| prefetch MAS 0x00 | L1 | L1 | L1 |
| prefetch MAS 0x20 (lcc's) | **L2 only** | L2 only | L2 only |
| prefetch MAS 0x40 | nothing | **L3 only** | nothing |
| prefetch MAS 0x60 (lcc's locality 0) | **nothing** | nothing | nothing |

So MAS 0x20 (the "not L1" hint, `dc_ch` 1) leaves the line in L2, 0x40
in the 8C2's L3 and nowhere on the CPUs without one, and 0x60 keeps it
nowhere (as loads, these MAS values are the cache hints of "Cache hints
in the MAS" above). A 0x60 prefetch reads nothing at all: it makes one
L2 lookup that misses and is dropped, with no memory read
(`MAU_READS`, `MAU_LDB_LINE` and `L2_LINE` 0 against 1 per line for
MAS 0 and 0x20; `pmu2.c` `pf0x*`, all three; [monitors.md](monitors.md),
"MAU"), while a 0x60 load does read its line.

The same holds for real loads and stores [hw:
`tools/isa-probes/memleft.c` `fill`: 128 lines 64 bytes apart, evicted,
then streamed with each access and MAS, a 20,000-cycle wait, then a
dependent chase in ALC0 and, separately, in ALC3; cycles per load of
the chase]:

| MAS | 4C | 8C2 | 2C3 |
|---|---|---|---|
| 0 | L2 | L2 | L2 |
| 0x20 | L2 | L2 | L2 |
| 0x40 | nowhere (87 cycles a load, as cold) | **L3** (32.9) | nowhere |
| 0x60 | nowhere | nowhere | nowhere |

The table holds for `ldd`, `std`, `ldaad`, `staad` and lcc's
nontemporal `loop_mode` `staad` alike, except that a stream of plain
`ldd` (MAS 0) also leaves part of its lines in L1, on all three
machines (below). Stores and AAU loads leave **no** line in L1 with any MAS, in
either chase channel: after MAS 0 or 0x20 the chase costs 11.0 cycles
a load on the 4C and 8C2 and 14.9 on the 2C3, the L2 hit with this
chase (an L1 hit: 3.0, 3.0 and 7.0). So an AAU load doesn't fill L1
(and, its latency being the L2 hit, presumably doesn't read it either;
Latencies), and a store that misses L1 doesn't allocate a line there
(inferred cause: L1 is write-through).

**Not every load that misses fills L1** [hw: `memleft.c` `fill`; low
confidence: the mechanism is unknown, and the fractions are inferred
from where the chase's cost falls between the L1 and L2 levels]. A
dependent chase leaves every line it reads in L1 for a second chase in
the same cluster. A stream of independent `ldd` leaves fewer. With two
loads a wide instruction (`h_ldd_00`, a wide instruction a cycle;
`f_ldd_00`, one every 8 cycles) it leaves 20–30% on the 4C and 45–50%
on the 8C2 and 2C3, whether both loads sit in one cluster or one in
each; the 8C2's stream at a wide instruction a cycle, chased from ALC3,
left 15%. With four loads a wide instruction it leaves a quarter
(2C3). With one load every 8 cycles it leaves 38–46% (4C), 75–78% (8C2)
and 87–94% (2C3). On the 4C and 8C2 a chase in ALC3 after a chase in
ALC0 (or the reverse) finds only 54–78% of the lines in L1; on the 2C3
it finds all of them. The fractions move between runs: a C loop of one
load a line left 50% on the 4C in one run and 25–34% in another. So a
line just streamed by loads is not reliably in L1 for a second pass;
isa-score's L1 model holds for data the code reads repeatedly
(inferred).

| `pf.c`, cycles | 4C | 8C2 | 2C3 |
|---|---|---|---|
| random gather over 256 MiB, per element: none / MAS 0 / 0x20 / 0x40 (D ≥ 16 ahead) | 123 / 22 / 24 / 122 | 185 / 21 / 26 / 47 | 233 / 19 / 26.5 / 232 |
| pointer chase with a jump pointer D ≥ 32 ahead, per node: none / MAS 0 / 0x20 | 116 / 33–35 / 35 | 182 / 11.6 / 18.2 | 221 / 13.8 / 21.2 |
| stream, per 32-byte line: none / MAS 0 / 0x20, ≥ 512 bytes ahead | 52.6 / 8.7 / 14.3 | 87.9 / 8.5 / 17.3 | 96.7 / 10.5 / 18.3 |
| any of these with MAS 0x60 | no gain | no gain | no gain |

The 4C's chase levels off at about a third of a memory access, as if it
kept only 3–4 misses in flight (inferred). lcc's own `s += a[i]` at
`-O3` (`pf-lcc.c`, cycles per 32-byte line):

| | 4C | 8C2 | 2C3 |
|---|---|---|---|
| default | 8.8 (no APB; lcc's own `0x20` prefetches) | 2.4 (APB) | 1.5 (APB) |
| `-fno-loop-apb` | 8.8 | 12.7 | 11.4 |
| `-fno-loop-apb` + `__builtin_prefetch` locality 3, 2 KiB ahead | 7.4 | 7.5 | 9.7 |
| `-fno-loop-apb` + locality 0 (MAS 0x60) | **27.4** | **67.6** | **58.1** |

So: APB beats software prefetch 3–7× on v5 and v6; a prefetch whose
data is used soon is best with MAS 0 (L1), and lcc's `0x20` costs a
little (an L2 hit per line) for keeping L1 clean; a locality-0 prefetch
as lcc emits it (0x60) does nothing, and the loop lcc builds around it is
3–5× slower than its loop without a prefetch call. On the 4C the
locality-0 build reads as many lines from memory as the locality-3 one
(`MAU_READS` 12.6 M each, 13.2 M without prefetch calls) and runs at the
speed of the same assembly with the prefetches deleted (28.1 against
27.6 cycles a line, 708 M against 696 M cycles), while `-fno-loop-apb`
alone gives 8.8–9.3. What is slow is the loop lcc builds around a
prefetch call, 16 wide instructions for 16 elements instead of 6
(inferred) [hw: `pf-lcc.c`, `perf stat`, 4C, two runs]. Following lcc
(decision 7) means emitting 0x20; the measurements favour 0x00 for data
used soon and nothing for locality 0 (0x40 on the 8C2): the owner's
call.

**What GCC's parameters need** (GCC `params.opt:380-406`,
`doc/params.texi:932-942`; GCC's defaults in brackets):

| Parameter | 4C | 8C2 | 2C3 |
|---|---|---|---|
| `l1-cache-line-size` (bytes) [32] | 32 | 32 | 32 |
| `l1-cache-size` (KiB, L1 data) [64] | 64 | 64 | 64 |
| `l2-cache-size` (KiB) [512] | 2048 | 512 (plus a 16 MiB L3) | 2048 |
| `prefetch-latency` (cycles) [200] | about 90 (memory) | about 160 | about 175 |
| `simultaneous-prefetches` [3] | about 4 (inferred) | 12 or more (inferred) | 12 or more (inferred) |
| prefetch distance | gather: 8–16 elements; stream: 512 bytes, 2 KiB safe | the same | the same |

**C++17 interference sizes.** lcc does not provide them: lcc 1.29.16's
`l++ -std=c++17` rejects `std::hardware_destructive_interference_size` for
every target (`prefetch.py`), and neither
`__cpp_lib_hardware_interference_size` nor `__GCC_DESTRUCTIVE_SIZE` is
defined; lcc's libstdc++ is GCC 11's, whose `<new>` predates them. So
there is no existing value to match. GCC defines `__GCC_DESTRUCTIVE_SIZE`
and `__GCC_CONSTRUCTIVE_SIZE` from `--param destructive-interference-size`
and `constructive-interference-size` (`c-family/c-cppbuiltin.cc:762-774`);
a target that sets neither gets `l1-cache-line-size` for both
(`cp/decl.cc:5833-5868`), 32 here. The value is part of the C++ ABI of
any header that uses it (`-Winterference-size`). The facts for the choice
(the owner's): L1D lines are 32 bytes, but L1D is write-through, L2
lines are 64 bytes, the kernel separates shared data by 64 and an
atomic's lock covers 64 bytes; 64 for the destructive size follows.

**Misaligned loads and stores** (`pocchk.c`, cycles per wide
instruction over 32 instructions, fixed costs included; offsets 1, 4, 7
and 60 from a 64-byte boundary, where its four loads at +0, +8, +16 and
+24 always include one that crosses a 32-byte line, so every misaligned
offset costs the same there):

| | 4C (v3) | 8C2 (v5) | 2C3 (v6) |
|---|---|---|---|
| 4 `ldd` in one instruction, aligned / misaligned | 1.0 / 5.7 | 1.0 / 6.0–6.8 | 1.0 / 1.0 |
| 2 `std`, aligned / misaligned | 1.0 / 8.0 | 1.0 / 8.0 | 1.0 / 1.0 |
| load → address of the next load, aligned / misaligned / crossing a 64-byte line | 4.7 / 8.3 / 11.9 | 4.7 / 11.9 / 15.5 | 4.7 / 4.7 / 4.7 |

So on v3 and v5 a misaligned access costs several cycles (a load that
crosses a doubleword one or two 4-cycle stall steps more latency, one
that crosses a 32-byte line a step more: below), and peeling or
versioning for alignment pays; v6 handles misaligned accesses at full
speed. (lcc keeps `-mstrict-align` up to v4, source-compat.md; the
8C2's misaligned accesses work but are no faster than the 4C's.)
16-byte accesses (`memx.c`; semantics.md, "Memory, tag and descriptor
operations"): 32 `ldq` take 33 cycles aligned or at +8 and 133 at +4 or
+1 on the 8C2, 32 `stq` 41 and 297; misaligned `ldqp`/`stqp` are SIGBUS
there. On the 2C3 all four take the aligned time at any offset.

What costs is crossing a boundary [hw: `tools/isa-probes/apbleft.c`
`cost`, cases from `gen_apbleft.py`: one or two accesses a wide
instruction, 32 and 128 instructions timed and the difference taken, so
fixed costs drop out (the 8.0 above for two stores is this table's 9
less the stores still pending when the clock is read, inferred); best
of 300; several runs a machine, identical except the 4C's `staaq`
below; base offsets 0, 1, 2, 4, 7, 8, 28 and 60 from a 64-byte
boundary. AAU accesses (`ldaa*`, `staa*`) cost what `ld*` and `st*` do
except where shown]:

| Cycles a wide instruction, or a load-and-use pair | 4C | 8C2 | 2C3 |
|---|---|---|---|
| a load inside a 32-byte line, any offset | 1 | 1 | 1 |
| a load crossing a 32-byte line, the same address again | 5 | 6.3 | 1 |
| two `ldd` in one instruction, misaligned inside a 32-byte line, the same addresses again | 2 | 2 | 1 |
| a stream of doublewords from a base 1–7 bytes off: one load / two an instruction | 2 / 3 | 2 / 3.5 | 1 / 1 |
| a store inside an aligned doubleword (`sth` at +1, `stw` at +1 and +2) | 1 | 1 | 1 |
| a store crossing an aligned doubleword, one / two an instruction (also in a stream) | 5 / 9 | 5 / 9 | 1 / 1 |
| a misaligned stream of `ldaaq` / `staaq` | 3 / 9 | 3 / 9 | 1 / 1 |
| `ldd` and use: aligned / crossing a doubleword / crossing a 32-byte line | 6 / 10 / 14 | 6 / 14 / 18 | 6 / 6 / 6 (14, below) |
| `ldaad` and use: inside a 32-byte line, any offset / crossing one | 10 / 14 | 14 / 18 | 14 / 14 |

(A pair is the load and its consumer in the next instruction, here in
the other cluster: 2 + 4 × ⌈(latency − 1) / 4⌉ cycles by the stall
rule, so 6 means a latency of at most 5, 10 means 6–9, 14 means 10–13,
18 means 14–17. The gap method narrows two of these [hw:
`tools/isa-probes/timeleft.c` `aau`, `ldd,5` or `ldaad,5` from a base
+0, +4 or +1, a doubleword inside a 32-byte line, → `addd,0`]: `ldd`
crossing a doubleword has a latency of exactly 9 on the 4C and 11 on
the 8C2 (5 on the 2C3), and `ldaad` 9, 11 and 13 at any of these
offsets.)

- On v3 and v5 a load inside a 32-byte line issues at full rate however
  it is aligned. Crossing a doubleword adds one stall step to its
  latency (4C) or two (8C2); crossing a 32-byte line one more, and
  about 4 cycles of issue (8C2 4–5): in a stream of doublewords from a
  misaligned base one load in four crosses a line, which makes 2 cycles
  a load.
- A store costs 4 extra cycles whenever it crosses an aligned
  doubleword (two such stores in one instruction 8), in a stream too; a
  misaligned store inside a doubleword costs nothing.
- An AAU load's latency is the L2's (apb.md, "AAU loads") and grows only
  when the load crosses a 32-byte line.
- On the 2C3 none of this costs, with one exception: a load crossing a
  32-byte line had the L2's latency (pair 14) unless earlier aligned
  loads had brought both of its lines into L1 (the `t_use_ldd` case run
  alone, 300 calls in a row: 19 of 19 runs), and the L1's after them.
  So such a load doesn't fill L1 (inferred), as AAU loads and stores
  don't (above).
- With the same addresses again in every instruction (see "Two stores
  in one instruction" under Throughput): two AAU loads in one 64-byte
  line take 2 cycles on all three, aligned or not (1 in a stream;
  apb.md, "AAU loads"); on the 2C3 an `staaq` that is not 16-byte
  aligned, or an `ldaaq` that crosses a 32-byte line, takes 2; on the 4C
  an `staaq` to a 16-byte boundary takes 13–15 cycles (five runs; the
  cause is not known), against 2 for one 8 bytes past it or for two
  `std` 8 bytes apart, and 1 in a stream (the 8C2 and 2C3: 1).
- v5's `ldaaqp` and `staaqp` are SIGBUS on the 8C2 when not 16-byte
  aligned, as `ldqp` and `stqp` are, and cost nothing on the 2C3 at any
  offset.

**Store to load** [hw: `tools/isa-probes/stld.c`;
`tools/isa-probes/damlist.c` `t_*` cases: a store, a load 0 to 8
cycles later, its value used 3 to 15 cycles after the load, four such
steps an iteration 64 bytes apart, medians of 15 runs, two or three
repeats; 4C, 8C2, 2C3]: a load that a
store just before it keeps out of L1 is **served by L2** (one
`L1_LD_HIT` fewer, one `L2_QUERY` more; monitors.md), so its value
comes at the L2 hit latency whatever the channels: 9 cycles on the 4C,
11 on the 8C2, 13 on the 2C3, 6, 8 and 8 cycles late. The load itself
issues at once; only a use of its value waits (stall rule), by
`t_w*`: on the 8C2 a use 3–6 cycles after the load stalls two steps
more than from L1, 7–10 cycles after one, 11 or more none (after a
store 2 or 3 cycles before the load about half a cycle a step
remains); on the 4C two at 3–4, one at 5–8; on the 2C3 two at 3–8,
one at 9–12. In `stld.c`'s loop (the use right after the load) a
store, reload and use take 14.5 cycles a step instead of 6.9 on the 4C
and 8C2. Which loads pay, by the cycles from the store's issue to the
load's (another 32-byte line never does, the next one included,
except one 16 KiB × k away: "Loads 16 KiB away from a store", below; a
store under a false predicate makes nothing pay, `t_y_pf_*`):

| Cycles after the store | 4C (v3) | 8C2 (v5) | 2C3 (v6) |
|---|---|---|---|
| 0 (one instruction) | the stored bytes at the store's width: always (`std` +0 then `ldd` +0, "More store-to-load cases"); any other load of the line in some code only: identical loops paid +8 cycles a step in every run in one function (`t_u3_d0_o0`) and 0.1–2.7 in another (`t_w3_d0_o0`); a load 4 KiB away at the stored offset in 10–50% of the steps. Its issue cost is "A store and a load in one instruction" (Throughput) | the same for other loads of the line (the stored bytes at their width not measured apart) | the stored bytes at the store's width: always ("More store-to-load cases"); other loads of the line as on the 4C |
| 1 | every load reading a byte of the stored aligned doubleword: the same bytes, narrower, wider, or other bytes of it (`stw` +0 then `ldw` +4) | the same | the stored bytes, a narrower load inside them or a wider one holding them; other bytes of the doubleword and other doublewords of the line usually too, though some processes never pay (below, and "More store-to-load cases") |
| 2, 3 | none | **every load of the line that reads a byte the store did not write**: other bytes of the stored doubleword, a wider load holding the stored bytes, any other doubleword, the line's last byte; a load inside the stored bytes is served by L1 | a load that overlaps the stored bytes without being exactly them at the store's width: `std` then `ldw` at +0 or +4; `stw` then `ldd` (tried 2 and 4 cycles after); also 16-byte accesses and misaligned stores ("More store-to-load cases") |
| 4 | none | none | the same, and every other load of the stored doubleword except the stored bytes at the store's width (`stw` +0 then `ldw` +4; `stb` +0 then `ldb` +1) |
| 5 or more | none | none | none |

Channels don't matter (stores in ALC2 or ALC5, loads in ALC0, 2, 3 or
5), nor whether the addresses are the same in every iteration, and
speculative loads (`ld,sm`, the lock load `mas=0x4`) pay like the rest
(`damlist.c`'s list cases). The 2C3's "some runs" behaves like a
state: `stld.c`, at one address, paid nothing in eight processes and
in a ninth paid the whole penalty on every load from one run that took
an interrupt on (`w0_w4`: 6.9, then 14.7 cycles a step); `damlist.c`'s
loops, moving through 16 KiB, paid on 25% to 100% of such loads by run
and case, and its list walk with the store 1 cycle before the next
node's load (`v6_d1`) on none. The cause is not known; "The 2C3's line
penalty" below has what decides it as far as it was traced.
(A store's base or data register written by the instruction before
costs nothing: `pocchk2.c` `t_stbase_k*`, `t_stdata_k*`, all three
machines.)

For a compiler that sees both addresses (one base register: a spill
and its fill, stack arguments, structure fields): keep a load of a
just-stored doubleword at least 2 cycles after the store (v3), on v5
also keep any load of the store's 32-byte line out of 2 and 3 cycles
after it unless it reads only stored bytes (1 cycle is fine for another
doubleword, 4 for anything), and on v6 keep a load that reads a stored
byte or another byte of a doubleword the store wrote into 5 cycles
after the store unless it reads exactly the stored bytes at the store's
width (then 2), any other load of the stored 32-byte line 2 cycles
after it, and after a store that crosses a 32-byte line any load of its
second line 5 cycles after it (16-byte stores and loads and AAU stores
included; "More store-to-load cases" below). On v3 a load after a store
that crosses a doubleword or a line needs no distance beyond the
store's own 4 cycles. Loads through other pointers pay
when they hit the line, which no compiler can see: CoreMark's list
reversal (Elbrus-8C2, below). lcc's own v5 code pays too: in its
static libm's `__ieee754_acoshl` (lcc 1.29.16, the `v5.8c2` sysroot)
an `ldw` reads a `long double`'s exponent 2 cycles after the `sth` that
stored it, and `tools/isa-score/profile.py` on the 8C2 measured that
block at 27.4 cycles an execution against 25.0 modelled with this rule
and 17.0 without it [hw: 3,000,000 calls].

**More store-to-load cases** [hw: `tools/isa-probes/memorycxx_stld.c`,
kernels from `gen_memorycxx_stld.py`, 2026-10-16; 4C (two runs) and
2C3, the 8C2 not measured]. Each step is a store, a load D = 0–6
cycles later (ALC0) and a use of its value U = 3–24 cycles after the
load, which gives the next step's store its data; four steps 256 bytes
apart make an iteration, 64 iterations a call, best of 15 calls, and
every pair also runs with the store 128 bytes away as a baseline. A
latency is the smallest U that adds nothing; where only some steps pay,
the extra cycles a step show what share does (the stall rule). D counts
the cycles from the store's issue to the load's:

| Store, then load | 4C (v3) | 2C3 (v6) |
|---|---|---|
| `std` +0, `ldd` +0 (the table above) | D 0: 9; D 1: 9 with the steps spaced, 9 or 10 back to back (below); D ≥ 2: 3 | D 0–1: 13; D ≥ 2: 5 |
| another width inside the stored bytes (`std` +0 then `ldw` +4; `stw` +0 then `ldb` +3) | D 1: as `ldd` +0; D 0: `ldb` +3 in a quarter of the steps in one run of two | D 1–4: 13 |
| other bytes of the stored doubleword (`stw` +0, then `ldw` +4, `ldb` +5 or `ldh` +6) | D 1: as `ldd` +0 | D 4: 13; D 1: usually 13 (below) |
| another doubleword of the line (`std` +0, `ldd` +8) | nothing from D 1 on; D 0: half the steps in one run of two | D 1: usually 13 (below) |
| `staad` +0 (AAU), then `ldd` +0 / `ldd` +8 / `ldw` +4 | as `std` from D 1 on (D 1 / nothing / D 1); D 0: `ldd` +0 in a quarter of the steps | as `std` from D 1 on (13 at D 1 / nothing / 13 at D 1–4); D 0: nothing |
| a store crossing a doubleword (`std` +4), then `ldd` +4, +0 or +8 | the store's own 4 cycles ("Misaligned loads and stores"), then nothing at D ≥ 1 | `ldd` +4: D 1; `ldd` +0 and +8 (partly stored): D 1–4 |
| a store crossing a 32-byte line (`std` +28), then a load of either line | its 4 cycles, then nothing at D ≥ 1, whatever the load reads | `ldw` +32 (stored bytes, second line): D 0–4; `ldw` +28 (stored, first line) and `ldd` +40 (not stored, second line): D 1–4, and D 0 in a quarter of the steps; `ldd` +32 (half stored): D 1–4; `ldd` +16 (not stored, first line): D 1, and D 0 in a quarter of the steps; `ldd` +28 (crossing): 13 at every D, also with the store 128 bytes away |
| an aligned store, then a load crossing a line that reads 4 stored bytes (`std` +32 or +24, `ldd` +28) | nothing beyond the crossing load's own cost at D ≥ 1; 4 cycles more a step at D 0 | D 1–4: 13 in every step; without the store, and at D 0 and 6, 13 in half the steps and 5 in the rest |
| a store to a line not in L1 but in L2, then a load of that line or the next 32-byte one (`ldd` +0, +8 or +32) | 9 (the L2's) at every D, with or without the store; at D 1 10 in half the steps (back to back) | 13 (the L2's) at every D, with or without the store; `stqp` then `ldqp` or `ldd` the same |
| `stqp` +0, `ldqp` +0 | — | D 0–1: 13; D ≥ 2: 5 |
| `stqp` +0, then `ldd` +0, `ldd` +8 or `ldw` +12 | — | D 1–4: 13 |
| `std` +0 or `std` +8, then `ldqp` +0 | — | D 1–4: 13 |
| `std` +0 and `std` +8 in one instruction, then `ldqp` +0 | — | D 1: 14; D 2–4: 13; D 6: 5 |
| other bytes of the line: `stqp` +0, then `ldqp` or `ldd` +16; `std` +16, then `ldqp` +0 | — | D 1: usually 13 (below) |

Back to back means the next step's store issues right after the use.
On the 4C that makes D 1 dearer: 9 or 10 (half the steps each) when the
steps use four places, 10 or 11 when they use one. With 4 empty cycles
after each use every step gets 9, with one place or four (the
`t<L>l4*` trace kernels, and a sweep of U with that spacing), as the
table above says. Whether the extra cycle for lines not in L1 also goes
with spacing was not tried, nor whether it covers a whole 64-byte L2
line (+0, +8 and +32 paid; +64 was not tried).

So on v6 any load that overlaps the stored bytes without being exactly
them at the store's width gets its value from L2 up to 4 cycles after
the store: narrower, wider and partly overlapping loads, misaligned and
line-crossing stores, and 16-byte accesses alike; after a store that
crosses a line, so does any load of its second line. Exactly the stored
bytes at the store's width pay only in the store's own instruction and
1 cycle after it. On v3 a store that crosses a doubleword holds issue
for its 4 cycles, so no load after it falls in the 1-cycle window
(inferred). AAU stores follow the `std` rules from 1 cycle after the
store on both machines. A load in the store's own instruction reads the
old value ([bundle.md](bundle.md)) and still pays when it reads exactly
the stored bytes at the store's width (4C: `std`/`ldd`; 2C3: `std`/`ldd`
and `stqp`/`ldqp`), on the 2C3 also `ldw` +32 after `std` +28; other
pairs in one instruction paid in some steps (a quarter of them: on the
2C3 `ldw` +28, `ldd` +16 and `ldd` +40 after `std` +28, on the 4C
`staad`/`ldd`) or in some runs only (4C: `ldd` +8 after `std` +0 and
`ldb` +3 after `stw` +0 paid in one run of two).

**The 2C3's line penalty** [hw: `memorycxx_stld.c` `trace` and `pages`,
the load 1 cycle after the store, its use 5 after the load]: a load of
other bytes of the stored 32-byte line 1 cycle after the store (`std`
+0 then `ldd` +8; `stw` +0 then `ldw` +4, `ldb` +5 or `ldh` +6; `stqp`
+0 then `ldqp` or `ldd` +16; `std` +16 then `ldqp` +0) is usually served
by L2 (value at 13): the "some runs" of the table above are the usual
case. Seven such loops storing to four lines, each run in 6 fresh
processes, paid in 3 of the 4 steps in 38 of the 42 processes, in all 4
in 3 and in 2 in 1; the step that escaped was the first one after the
loop's back branch, whichever line it used. With the `pages` buffers
(64 4 KiB pages, then a 2 MiB page) `stw` +0 then `ldw` +4 paid in 3 of
4 steps on every 4 KiB page and in all 4 on the 2 MiB page, and `std` +0
then `ldd` +8 in all 4 on most pages of both. A loop whose steps all
use one line paid nothing, except in many calls with 31 or 87 cycles a
step; one with two lines paid in half its steps. Every page paid, and
neither the core nor a 3 ms sleep before every call changed this. Yet
in a process that had first run thousands of other kernels (the full
sweep) the same loops paid nothing, and in short sweeps whether they
paid depended on which pairs ran first: this is the state seen in
`stld.c` and `damlist.c`. Its cause is not known. For a compiler: on v6
keep any load of the stored 32-byte line at least 2 cycles after the
store.

**Loads 16 KiB away from a store pay the reload penalty too**, and
longer [hw: `tools/isa-probes/timeleft.c` `alias`, the `stld` lines,
and `tools/isa-probes/timeleftv.c` `sl` at more distances and gaps; a
store to `p`, `G` empty
cycles, a load from `p + D` and its use feeding the next store; 2 MiB
pages; 4C, 8C2, 2C3]. Cycles a step:

| Load at `p + D`, `G` empty cycles after the store | `G` = 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| no conflict | 7.1 | 8.1 | 9.1 | 10.1 | 11.1 |
| `D` = 0 (a true reload) | 15.1 | 8.1 | 9.1 | 10.1 | 11.1 |
| `D` = 16, 32, 48, 64, 96, 128 or 192 KiB, or 1 MiB | 15.1 | 4C 14.0; 8C2, 2C3 16.1 | 4C 13.1; 8C2, 2C3 17.1 | 4C, 8C2 10.1; 2C3 18.1 | 11.1 |
| `D` = 8, 16, 24 (another doubleword of the stored 32-byte block), 8C2 (the line rule above) | 7.1 | 16.1 | 17.1 | 10.1 | 11.1 |

`D` = 4, 8, 12, 20, 24, 28 or 40 KiB, 16 KiB plus 8, 32 or 64 bytes
and 64 KiB plus 8 to 256 bytes or minus 8 cost nothing. So a load of the same offset in
another 16 KiB pays the penalty with up to 2 empty cycles after the
store (3 on the 2C3), where a true reload pays only right after it. 16 KiB is
one way of the 64 KiB 4-way L1, so the check presumably compares the
set index and offset, address bits 3–13, and not the rest (inferred).
With 4 KiB pages the distances that pay change from run to run (64 KiB
paid in every run, 1 MiB in all but one, 32 KiB to 3 MiB and even
64 KiB + 8 in some), which fits bits 12–13 being taken from the
physical address (inferred; low confidence). For a compiler: keep a
load that may be 16 KiB × k from a store just made, such as a spill
reload or a strided access in a loop of stores, 3 empty cycles (v6: 4)
after the store, that is 4 cycles (v6: 5) from the store's issue to the
load's, where the schedule allows it.

**Loads whose value is never read** (`pocchk2.c` `t_dead_*`, the
proof-of-concept back end's finding I37): a step of four independent
`ldd` to lines that miss the caches, ten empty cycles, then the four
registers (A) overwritten, (B) left alone, or (D) read; (C) is the step
without the loads. Cycles a step, the best of three sweeps of 256 MiB:

| Case | 4C, each load on a new page | 4C, 576 bytes apart | 8C2, new pages | 8C2, 576 apart | 2C3, new pages | 2C3, 576 apart |
|---|---|---|---|---|---|---|
| A: loads, registers overwritten | 102 | 43 | 12 | 13 | 17 | 14 |
| B: loads, registers left | 98 | 43 | 11 | 12 | 17 | 14 |
| C: no loads | 11 | 11 | 11 | 11 | 11 | 11 |
| D: loads, values read | 202 | 136 | 40 | 172 | 219 | 184 |

So a write of a pending load's register doesn't wait for the load (A ≈
B), the 8C2 and 2C3 overlap independent misses (four dead misses cost
them 0–6 cycles), and the 4C doesn't: four misses nobody reads cost it
about 32 cycles, 87 with TLB misses. On v3 a speculative load that
misses is not free even when its value turns out dead.

## Array prefetch

Measured by `tools/isa-probes/apb.c`, not `bench.py`; details in
[apb.md](apb.md#timing-hw). A `mova` result is ready 5 cycles after
issue, in any channel and for a consumer in either cluster; a consumer
issued earlier stalls a fixed 4 cycles, as above. The first `mova` after
`bap` issues without a stall 22 cycles after it when the data is in the
caches.

**One area delivers 16 bytes a cycle** (32 on v6, Elbrus-2C3 below). lcc's `loop_mode` loops over
arrays in L1 (`-O3 -faligned`, timed with `%clkr`), on the 4C and the
8C2 alike: a sum of `long`s reading one area runs at 0.53–0.54 cycles
per element, also when lcc's v5 code reads 32 bytes an iteration from
that area with two `movaqp` (each iteration then takes 2 cycles, where
the v3 code's two `movad`, 16 bytes, take 1); two arrays (two areas)
keep 0.54 cycles per element, 16 bytes a cycle from each; three arrays
reach 23 (v3 code) to 30 bytes a cycle (v5 code). So reading more than
16 bytes from one area in one instruction costs a cycle per extra 16
bytes (isa-score models this).

Where the areas sit matters for column walks. With 4 KiB pages every
element of a long column walk is a table walk; the walker does one at
a time (11, 14 and 40 cycles on the 4C, 8C2 and 2C3, inferred from the
monitors), and each half of the buffer takes its areas' misses in
turn. So two areas in one half are 9–40% slower than one area in each
half, on all three machines and at any area size; with 2 MiB pages the
half matters only on the 2C3 (apb.md, "Which half an area is in";
`pocchk3.c` `col`, `apbleft.c` `col`).

On the 4C and the 2C3, an area streaming beside loads that go to L2
stalls the loop. A loop at II 4 that reads one array through an area
and another with `ldd` runs at 5.25 cycles an iteration from L2 on the
4C (2C3 4.5–5.25, 8C2 at most 4.2), whichever way either array runs.
The core counts the stall as the AAU's (`STALL_AAU`); it needs a
fetching area and loads that miss L1 (or AAU loads), whatever the area
fetches. With both arrays in areas the loop keeps 4 cycles from L1, L2
and memory (apb.md, "Plain loads beside an area"; `pocchk3.c` `bk`,
`apbleft.c` `bk`).

## Hazards (interlocking)

| Producer → consumer | Interlocked? | Detail |
|---|---|---|
| ALU, multiply, divide, load → register use | yes | values correct at any distance ≥ 1, also integer ↔ FP and across clusters |
| an operation **under a false predicate** → a reader of its destination | **no wait** | a reader one cycle after an `ldd` or `muld` whose predicate is false runs as if that operation wrote another register (2.0 cycles a step, against 5.9 and 9.8 when it executes; `pocchk.c`, 4C, 8C2, 2C3): the interlock follows the predicate, so the other arm of an if-converted if-else costs nothing |
| compare → predicated ALU op, `ct ? pred`, `ibranch ? pred` | yes | correct at distance ≥ 1 |
| compare or predicate logic → predicated op (a store too) or `merge` in the wide instruction of a **taken return** (`ct %ctpr3` after `return`, also under a true condition) | **no** | the op reads the predicate as it was before the producer, with no stall, when an integer compare or predicate logic (`pass`/`landp`/`pass`, also on an FP compare's result) is 1 cycle before it, or an FP compare (`fcmp*b`, `fxcmp*b`; `fcmplesb`, `fcmpledb` and `fxcmplesb` run) 1 or 3 cycles before it, or 2 before a `merge` (an RLP reader is right at 2). Integer compares and logic 2 cycles before, and FP compares 4, give the new value [hw: `tools/isa-probes/foldi57_retpred.c`; 4C, 8C2]. An `addd` reader 1 cycle after an integer compare got the new value in 4 of 4 runs on the 4C and 1 of 4 on the 8C2 on 2026-10-10 (`preds.c` `i17_*`), but the old one in every `foldi57_retpred` run (there one reading in 80 after logic got the new value, on the 8C2): the outcome depends on timing. A taken branch (`ct %ctpr1`, near or far), a `call`, a `ct` that is not taken and no transfer all wait (`tools/isa-probes/preds.c` `i17_*`, `foldi57_retpred.c`; the proof-of-concept back end's findings I17, where a `merge` in a return's instruction broke expat, and I38). A taken branch between the producer and the reader changes nothing: a reader at the target counts from the producer. On v6 (the 2C3) an integer compare or logic 1 cycle before reads the new value (`i17_*`, `i17l_*`); FP compares were not run there. |
| FP compare → predicated op or `merge` in the wide instruction **right before** a taken return | **no on v3** | on the 4C an FP compare 1 cycle before the reader, which is 1 cycle before a taken return (also a conditional one), gives the reader the old predicate: gcc.c-torture `pr39501.c` at `-O0`, one operation per wide instruction (the proof-of-concept back end's finding I57). 2 cycles between compare and reader, or 2 between reader and return, give the new value; integer compares and logic are right here, and so is the 8C2 [hw: `foldi57_retpred.c`; 4C, 8C2; not run on the 2C3] |
| compare → `andp`, `andp` → predicated ALU op | yes | correct at distance ≥ 1 |
| `andp` → `andp` in the same wide instruction (a CLP reading `@p4` written by an earlier CLP) | — | sees the new value: predicate logic chains inside one instruction |
| an operation in ALC K whose operand isn't ready, in an instruction with `pass %spredK` | **no wait, by design** | the instruction issues without waiting for ALC K: the operation sees a diagnostic operand (SIGILL without `,sm`, a diagnostic result with it) and `%spredK` is true; 1,000 iterations of a load and such a consumer one instruction later take 6,002 cycles against 10,001 without `%spred` (`preds.c` `spt_*`, 4C, 8C2, 2C3; [predicates.md](predicates.md)) |
| `disp`, `movtd` → `ct` | yes | correct at distance ≥ 1 |
| `rws %fpcr` → `rrs %fpcr` | yes | |
| `rws %pfpfr` (rounding mode) → FP operation | yes | |
| FP operation → `rrs %pfpfr` (exception flags) | yes | |
| **`rwd %lsr` → `rrd %lsr`**; v5+ also `rwd %lsr1` → `rrd %lsr1` or `rrd %lsr`, and `rwd %lsr` → `rrd %lsr1` | **no** | old value at distance 1–3, new from 4 (`loops.c`, `lsrw.c`; 4C, 8C2, 2C3) |
| `rwd %lsr`, `%lsr1` or `%ilcr` → `rrd %ilcr` or `%ilcr1` | **no** | old value at distance 1–4, new from 5 (`lsrw.c`) |
| **`rwd %lsr` or `%lsr1` → the loop's `alc`** | **no** | iterations issued 1–3 cycles after the write count down the old `%lsr`, the new count applies from 4 ([loops.md](loops.md), "Registers") |
| `getsap` → `rrd %usd.lo` (protected mode) | **no** | old value at distance 1–2, new from 3 (`tools/abi/probes/protected/pmleft.c` `usd`; 4C, 8C2, 2C3; [protected-mode.md](../abi/protected-mode.md), "Stack pointers"). `getsp` → `rrd %usd.lo` in 64-bit code was not measured |
| anything in the same wide instruction | — | every operation reads the state from before the wide instruction (distance 0 sees the old value) |

So on v3 and v5 keep an integer compare or predicate logic 2 cycles,
and an FP compare 4 cycles, before a predicate reader in a taken
return's instruction, and on v3 (v4 not measured) keep an FP compare
2 cycles before a reader in the instruction right before a taken
return. Scheduling at
the latencies meets both rules ([predicates.md](predicates.md),
"Timing") for the producers the scheduler sees; a reader at a jump's
target counts from a producer before the jump. lcc puts the `merged` of
a `long double` select in the return's instruction exactly 4 cycles
after its `fxcmpltxb` [lcc 1.29.16 `-O3`, v3, v5.8c2]. gas's
`strict_delay` padding (below) meets them for compares written outside
braces; it pads neither braced compares nor predicate logic, which is
always braced. Unscheduled output under `.ignore strict_delay` must add
the delay itself.

**Other stalls** the performance monitors found [hw:
`tools/isa-probes/pmu2.c`, 4C, 8C2, 2C3, two runs; the events in
[monitors.md](monitors.md), "Pipeline repeats and the rest"]:

| Case | Cost |
|---|---|
| **a call whose callee's `setwd` makes the window larger than the caller's, while a load is outstanding** | the callee waits for every outstanding load, whatever its destination register (`BUB_E2_SETWD`): a load from memory into the caller's own register, then a call, 68.5 / 104–112 / 112–113 cycles (4C / 8C2 / 2C3) against 27.0 when the callee's window fits in the caller's; a pending `sdivd` or `fdivd` costs nothing (25 cycles either way). So a load that may miss is better issued after such a call, or early enough to finish before it |
| `getsp` 1 or 2 cycles after another `getsp` (`getsp 0` too) | +2 (an E0 repeat, `BUB_E0_USD`); 3 cycles apart: free |
| FP compare, then an integer compare into a predicate in the same channel 2 cycles later (ALC0 tested) | +2 on v3 and v5 (an E0 repeat), +4 on v6 (an E2 step); other channels, 1 or 3 cycles apart, or the integer compare first: free |
| FP compare into a predicate in a call's instruction or the one before it, and a compare into a predicate in the callee's first instruction | +2 |
| combined FP operation, then `rws %pfpfr` in the next instruction | +4 (`BUB_E2_PFPFR_COMB`); `rws %pfpfr` before a combined operation, or after `faddd`: free |

isa-score doesn't model these (it treats two `getsp`s as a 2-cycle
dependence through the stack pointer, `tools/isa-score/model.py`).

gas, for operations written outside braces (its `strict_delay` mode,
`gas/config/tc-e2k.c`), inserts `nop 2` after integer compares and
`ccto*` and `nop 4` after FP compares, `nop 5` or `wait all_e=1` after
writes to the system registers flagged
in `include/opcode/e2k/state-regs.def` (`%psr`, `%cwd`, `%psp`, `%pcsp`,
`%usd`, segment registers and others), and `nop 4` after reading `%cud`
and `%gd`. On the 4C and 8C2 the compare padding is needed for
correctness only before predicate readers near a taken return (above);
elsewhere it saves the stall cost; the system-register cases are
privileged and not tested here.

Where the floating-point state lives (glibc `sysdeps/e2k/fpu`): the
rounding mode and exception flags of ordinary (scalar and packed)
operations are in `%pfpfr` (rounding in bits 13–14:
`FE_TONEAREST` 0, `FE_DOWNWARD` 0x2000, `FE_UPWARD` 0x4000,
`FE_TOWARDZERO` 0x6000; flags in bits 0–5, `FE_INEXACT` 0x20); `%fpcr` and
`%fpsr` are the x87-style control and status words that 80-bit operations
use instead (hw; MCST's qemu wrongly uses `%pfpfr` for them; see
`spec/abi/registers.md`, "Extended parts and `long double`").

## Elbrus-8C2 (v5) [hw]

`bench.py --target v5.8c2` on the 8C2 (kernels as on the 4C plus v5
ones, driver built by the 8C2-tuned lcc). The table was taken under the
`schedutil` governor; rerun under `performance` (1500 MHz fixed,
`%clkr` counting 1500 MHz against the wall clock, busy or idle) 368 of
370 latency and throughput kernels gave the same numbers, the other two
being store + load pairs in one 32-byte block (1.8–2 cycles either
way), so the governor doesn't affect cycle counts. All 80 scheduled latencies,
28 back-to-back costs, 21 hazards, 11 control-transfer delays and 10
branch costs equal the 4C's, and so do 164 of the 166 kernels of the
monitor probe (`pmu.c`, cycles from `TICKS`), and of the v3 sweep's 807
chains all but `pfdivd` and `pfsqrttd` ("Every v3 operation", above).
So v3 latencies hold for v5, as lcc's documentation says for v1–v5,
except into the single or double operand of an 80-bit operation
(below), which those chains don't reach.
What v5 adds or changes:

- **Six FP operations per cycle.** v4 added `faddd`, `fmuld`,
  `fmul_add*` (and the single forms) in ALC2 and ALC5, so 6 `faddd`,
  `fmuld` or `fmul_addd` issue in one instruction (v3: 4). In ALC2/5
  they have the usual latencies (4; `fmul_addd` 8) and crossing costs
  (ALC5 → ALC0 FP 6, ALC5 FP → integer 6). The 64-bit packed adds
  (`pfaddd`, `pfadds`, `pfsubd`, `pfsubs`, `pfhadds`, `pfhsubs`,
  `pfaddsubs`), `pfmuls` and the combined `pfmul_addd`, `pfmul_adds`
  and `pfadd_hadds` also gained ALC2/5 in v4 (binutils): six of one
  issue a cycle (`v5_pf*_6` for `pfaddd`, `pfadds`, `pfsubd`, `pfmuls`,
  `pfhadds`, `pfaddsubs`, `pfmul_addd`, `pfmul_adds` and
  `pfadd_hadds`; 8C2, 2C3). `pfmuld`, `pfmax*`/`pfmin*`, `pfcmp*` and
  the packed conversions stay in ALC0, 1, 3 and 4 on every version, so
  4 `pfmuld` + 2 `pfaddd` is the widest packed-double instruction (1
  cycle).
- **128-bit packed operations** (`qp*`, v5) work on whole registers
  (`%qprN` is register N at its full 128 bits): `qpfaddd`, `qpfmuld` 4
  cycles, `qpfmul_addd` 8, `qpaddd` and `qpand` 1; 6 `qpfaddd` or
  `qpfmuld` per instruction.
- **`ldqp` bypasses L1:** the single-register 128-bit load is served
  by L2. Its latency is **11** to any consumer (integer or `qp`; `ldd`
  stays 3), only one issues per cycle (2, 3 or 4 in one instruction
  take 2, 3, 3–4 cycles), and the monitors show why: 10 million `ldqp`
  of one cached address make almost no L1 requests and 10 million L2
  queries, all hits, where `ldd` hits L1 (the v5 event list says
  `L1_REQUEST` counts "synchronous requests except qpword";
  monitors.md). **`ldq`** (a register pair `%qrN`, two load channels:
  `ldq,0` takes ALC0 and ALC2, `ldq,3` ALC3 and ALC5) goes through L1:
  latency 3, two per instruction (32 bytes a cycle). lcc's v5 code
  never uses `ldqp` for data: a 128-bit vector is two `ldd` and a
  `qppackdl` (`ldqp`/`stqp` appear only in 16-byte atomics). Stores
  go through L1 and on to L2 alike (L1 is write-through: `std` and
  `stqp` make as many L2 store queries as L1 ones); two `stqp` in one
  instruction, 64 bytes apart, take 1 cycle.
- **Latencies of every v5 operation** (`bench.py`'s `v5op_*` chains,
  generated from `binutils-ops.yaml`: each result feeds the next
  copy's first source; 195 operations, `plog`/`qplog` represented by
  two tables each):

  | Latency | Operations |
  |---|---|
  | 1 | packed integer add/sub (also saturating), logic, shifts (`qpsll*`, `qpsrl*`, `qpsra*`, `qpsrc*`), compares (`qpcmp*`), min/max, averages, signs, horizontal adds (`qphadd*`, `qphsub*`), packs (`qpack*`), shuffles and permutes (`qpshufb`, `qppermb`, `qpmerge`, `qpswitch*`), `qpmsk2sgnb`, `qppackdl`, `plog`/`qplog`, `psrc*` (packed results: 4 to an integer consumer, below); the scalar `addcd`/`subcd` (with carry) and `getfz*` (integer: 1 to any consumer in their cluster, below); `puttagqp` (`tools/isa-probes/tagx.c`, 8C2 and 2C3: 1 to `qpand`, 4 to `addd` reading its low half, as `qpaddd`) |
  | 2 | packed integer multiplies (`qpmul*`, `qpmadd*`, `qpsadbw`, `qpmpsadbh`, `pmullw`), packed FP compares (`qpfcmp*`), `qpfmax*`/`qpfmin*` |
  | 4 | packed FP add, subtract, multiply, horizontal and add-subtract forms, round to integral (`qpfdtoifd`, `qpfstoifs`), `qphminposuh`, `qpsgn2mskb` (to an integer register and back) |
  | 5 | packed conversions (`qpfdtoid`, `qpfstoid`, `qpfstofd`, `qpfstois`, `qpidtofd`, `qpistofd`, `qpistofs`, and the `tr` forms), chained into themselves; 4 to a consumer of their result's format (Formats) |
  | 6 | `qpfdtofs`, `qpfdtois`, `qpfdtoistr`, `qpidtofs` (narrowing), chained into themselves, as scalar `fdtofs` |
  | 8 | combined packed FP (`qpfadd_*`, `qpfsub_*`, `qpfmul_*`, `qpfhadd_*`, `qpfhsub_*`, `qpfaddsub_*`) |

  So 128-bit operations take the latency of their 64-bit counterparts,
  and FP min/max is 2, not 4, on v3 too (table above).
- **Integer and packed results** [hw: `tools/isa-probes/foldisa.c`
  `lat`, the gap method of `pocchk4.c`; 8C2 and 2C3 alike, the `pandd`
  row also on the 4C (`foldisa-v3.s`); found by the proof-of-concept
  back end, I54]. The chains above feed each operation into itself, so
  their 1 doesn't say how soon other operations get the result
  (producers in ALC0, 1, 3 or 4, consumers in either cluster; "—" not
  measured):

  | Producer | Integer op (`addd`, `cmpedb`, `getfzd`): same cluster; other | Load address, same cluster | Store data: same cluster; other | FP op (`faddd`) or `plog`, same cluster |
  |---|---|---|---|---|
  | `getfzd`, `addcd` (as `getfd`, `addd`) | 1; 2 | 1 | 1; 1 | 1 |
  | `getfzs` | 1; 2 (a 64-bit reader under `dbl = 0`: 4, "Formats") | — | — | — |
  | `addcd_c`, `subcd` | 1; 2 | — | — | — |
  | `plog_*` | 4; 4 | 4 | 1; 3 | 1 (a `plog` in the other cluster: 4) |
  | `qplog_*` (`addd` reading its low half) | 4; 4 | — | 1; — | 1 (`plog`) |
  | `pandd` | 4; 4 | 4 (4C) | 1; 3 (4C) | 1 (`faddd` on the 4C, `plog` on the 8C2 and 2C3) |
  | `psrcd`, `qppackdl`, `qpswitchd` | 4; — | — | 1; — | — |

  So `getfz*` and `addcd`/`subcd` are integer operations, and `plog`,
  `qplog` and the other packed operations measured are packed ones,
  like v3's `pandd` ("Every v3 operation"). In integer code `plog`
  saves operations but not time: an `addd` gets `(a & b) | c` from
  `andd` + `ord` in 2 cycles and from one `plog_0xea` in 4. Packed
  results suffer no write-back conflict ("Write-back conflicts").
- **128-bit operations are fully pipelined** in every channel they are
  allowed (`v5tp_*` kernels: one per channel per cycle): packed integer
  add `qpaddd` in ALC0/3; `qpmullh`, `qpsadbw`, `addcd` in ALC1/4;
  logic, shifts, shuffles (`qpshufb`, `qppermb`, `qpmerge`), FP compares,
  `qpfmaxd`, conversions, `plog`/`qplog` in ALC0/1/3/4; combined FP
  (`qpfmul_addd`) in all six.
- **Crossings with 128-bit values**: a `qpfaddd` result costs 6 in the
  other cluster (as scalar FP) and 6 to `addd` (reading the low half), 4
  to `faddd`; `qpaddd` costs 4 in the other cluster and 4 to `addd`;
  `addd` → `qpaddd` 1. But a **64-bit FP-side result read by a 128-bit
  operation pays as if crossing, in the same channel**: `faddd` →
  `qpfaddd` 6, `fmuld` → `qpfmuld` 6, `faddd` → `qpaddd` 6, `paddw` →
  `qpaddd` 4 (instead of 4, 4, 4, 1). And packed integer results in the
  other cluster cost 4 on both machines (`paddw` → `paddw,3`, `qpaddd` →
  `qpaddd,3`), not latency + 2: an FP-side result in the other cluster
  costs at least what it costs an integer consumer.
- **An FP operation's result reaches an 80-bit operation's single or
  double operand 2 cycles later** [hw: `tools/isa-probes/sregs.c`
  `latg` and `lp`, gap method; `bench.py` `v3op_fxdivtss`,
  `v3op_fxdivtdd`; the 4C and 2C3 don't]: `faddd` →
  `fxadddd`'s second operand 6 (4C 4), `fxadddd` → `fxadddd` 7 (5),
  `fxtofd` → `fxadddx` 7 (5), `fxdivtss`/`fxdivtdd` → their own single
  or double src1 18 (16), `fxdivdd` → `fxdivdd` 18 (16). Other
  producers don't pay it. A load in the same cluster takes 4 instead of
  3 (`ldd,0` → `fxadddd,0`, while `ldd,0` → `faddd` stays 3). A load
  from the other cluster takes 4 as on the 4C (`ldd,3` → `fxadddd,0`,
  `ldd,0` → `fxdivtdx,5`'s src1), and an integer operation 1 as
  everywhere (`addd` → `fxadddd`). Edges into the 80-bit operand are
  unchanged (`fxdivtsx`, `fxdivtdx`, `fxdivxx` chains 16, as every
  `v3op_fxdivt*_opb*` chain; `fxadddx` → `fxtofd` 5), and so are
  results of 80-bit operations going to ordinary operations (`fxadddd`
  → `faddd` 5). Back to back, a chain through the narrow operand costs
  4 more per step (`fxadddd` 9 instead of 5, `fxdivdd` 21 instead of
  17), because stalls come in 4-cycle steps. The v3 sweep shows it only
  in `v3op_fxdivtss` and `v3op_fxdivtdd` (18): its other 80-bit chains
  run through the 80-bit operand or reach the narrow one from a
  conversion 12 cycles earlier. Conversions with a narrow input don't
  pay it, and the 80-bit compares do [hw: `tools/isa-probes/timeleft.c`
  `lat`, gap method; 4C, 8C2, 2C3]:

  | Edge | 4C, 2C3 | 8C2 |
  |---|---|---|
  | `faddd`, `fmuld` → `fdtofx`; `fadds` → `fstofx` | 4 | 4 |
  | `fxadddd` → `fdtofx` | 5 | 5 |
  | `ldd,0` → `fdtofx` | 3 (2C3: 5) | 3 |
  | `faddd`, `fmuld` → the double operand of `fxcmpltdb` or `fxcmpuddf`; `fadds` → `fxcmpltsb` | 4 | **6** |
  | `fxadddd` → `fxcmpltdb`, `fxcmpuddf` | 5 | **7** |
  | `ldd,0` → `fxcmpltdb`, `fxcmpuddf` | 3 (2C3: 5) | **4** |
  | `faddd,3` → the double operand of `fxdivdd,5` or `fxdivtdx,5` | 4 | **6** |
  | `ldd,3` → `fxdivdd,5`, `fxdivtdx,5` | 3 (2C3: 5) | **4** |
  | `ldd,5` → `fdivd,5`, `fxdivdd,5`, `fxdivtdx,5` | 3 (2C3: 5) | 3 |

  The cost never adds to a crossing: from the other cluster these
  edges take what any FP result or load does there, on all three
  machines (`faddd,3` → `fdtofx,0` or `fxcmpltdb,0` 6, `faddd,0` →
  `fxdivdd,5` 6, `fxadddd,0` → `fxdivdd,5` 7, `ldd,0` or `ldd,2` →
  the ALC5 operations 4, 2C3 5). So on the 8C2 an 80-bit operation's
  narrow operand takes FP results and loads as if they came from the
  other cluster, except a load in ALC5 feeding ALC5. (An 80-bit result
  read as a double, `fdtofx` → `fxadddd` or `fxcmpuddf`, takes 6 on all
  three: a format change, Formats.)
- **Divider:** `sdivd` and `udivd` every 2 cycles no longer conflict (2
  cycles; v3 3.4); `fxsqrtuxx` and `fxsqrttxx` every 3 cycles now do
  (4.4; v3 3), `pfdivd` every 2 cycles takes 2.5, and `pfsqrttd` has a
  pattern of its own (6, 3.6, 3.9, 4, 6 at `g` = 1–5); the other
  divider distances are as on v3 (`fsqrts` still conflicts at 5).
  `pfdivd` and `pfsqrttd` take 16 cycles to an FP op, 18 to an integer
  op (v3 14, 16; `fdivd`, `fsqrttd` stay 14). An ALC5 FP operation
  never conflicts with a divide in flight (distances 1–16 for `faddd`
  and `fmuld`), except in one pattern: `fdivd` every 2 cycles with an
  ALC5 FP operation in every gap costs 2.76 cycles per pair instead of
  2 (probably what lcc 1.26's "FP operations in channel 5 need special
  scheduling" is about).
- **A store and a load in one 32-byte block** in one instruction take
  1.8–2 cycles in every run (the 4C sometimes runs them at 1); two
  stores agreeing in address bits 6–7 take 2, as on the 4C.
- **A load 2 or 3 cycles after a store to its 32-byte L1 line** that
  reads any byte the store didn't write (another doubleword, other
  bytes of the stored one, a wider load) is served by L2: 11 cycles, 8
  late. The 4C serves it from L1, and so does the 2C3 unless the load
  overlaps the stored bytes or the store crossed into its line (Memory,
  "Store to load", "More store-to-load cases"; `damlist.c`). A
  pipelined list walk that stores to one node 2 cycles
  before it loads another pays two stall steps whenever the two nodes
  share a line. That is CoreMark's `core_list_reverse` as lcc 1.29.16
  `-O3` schedules it for v3 and v5, `{} {lock ALC3, check ALC5,
  rbranch} {store ALC5, ct}` with the store 2 cycles before the next
  lock, which reads the node 3 places on, and as the proof-of-concept
  back end did: CoreMark's own list orders (`core_bench_list`'s, 30
  nodes of 16 bytes, two of them to a line, interleaved), replayed
  through such a kernel on the 8C2, cost 8.0–8.4 stall steps a call,
  0.27–0.28 an element, against 0 with the store 1 cycle before the
  lock (lcc's kernel built from C: 8.0–8.5 above its constant 2) [hw;
  a replay harness not kept], the PoC's whole loss (speculation.md,
  "Data speculation (DAM)"). lcc's v6 kernel loses nothing: the 2C3
  has no such window, and the 5-cycle chase delays each lock to 5
  cycles after the store anyway.

## Elbrus-2C3 (v6) [hw]

`bench.py --target v6.2c3` on an Elbrus-2C3 (E2C3, 2 cores, 2000 MHz,
`performance` governor; the kernels of the 4C and the 8C2 plus v6 ones,
`add_v6`), and the probes in `tools/isa-probes` run on it and on the
8C2 side by side. These stay as on v3 and v5: every integer, multiply,
divide, FP, conversion, packed and 128-bit latency (the `v5op_*`
chains: all 195 equal; the v3 sweep's 807 chains: all equal the 8C2's
but the integer compares into `merge`, below), the format penalties,
the crossing costs between clusters and between the integer and FP sides, the stall rule
(an early consumer waits in 4-cycle steps), write-back conflicts,
branch costs (a taken `ibranch` 6, a prepared `ct` 0), CTPR delays (`disp` 5, `movtd` 9, `return` 6), the divider's own
conflicts, the store bank rule (two stores agreeing in address bits
6–7 take 2 cycles) and the store-to-load penalty. What v6 changes:

- **An L1 load takes 5 cycles** (3 before), in every load channel
  (ALC0, 2, 3, 5), for every size (`ldb` … `ldd`, `ldq`), to integer,
  FP and 128-bit consumers, and **in either cluster** (v3 and v5 add 1
  across). A consumer scheduled 3 cycles after a load, as for v3, stalls
  a whole 4-cycle step: the load–use pair takes 7 cycles, not 5. A
  dependent pointer chase costs 5 a step on all three machines (on v3
  and v5 it is 3 + a stall). Loads still issue four per cycle.
- **`ldqp` goes through L1**: latency 5, four per instruction (v5:
  served by L2, 11, one per cycle). lcc's v6 code uses it for data
  (with `movaqp` in APB loops).
- **Integer predicates are faster**: an integer compare (`cmp*`,
  `cctop*`) or predicate logic (`andp` …) reaches a predicated ALU
  operation or a `merge` in **1** cycle (2 before); to a `ct` it is still
  3, and FP compares are unchanged (4 to an operation, 5 to `ct`).
  The v6 packed compares into a predicate (`pcmp*op`, `pcmp*ap`,
  `qpcmp*op`, `qpcmp*ap`) behave like FP compares: 4 to a predicated
  operation or `merge`, 5 to `ct`.
- **Operations new in v6** (`bench.py`'s `v6op_*` chains and the
  kernels below):

  | Latency | Operations |
  |---|---|
  | 1 | `qpcext_*`, `qpsrad`, `pmrgp`, `qpmrgp` |
  | 2 | `mkfsw`, `modbgv`, `vfbgv` (the x87-stack helpers) |
  | 4 | `clmull`, `clmulh` (ALC0, 1, 3, 4; four per instruction) |
  | 4 | packed compares into a predicate, to a predicated op or `merge` (5 to `ct`) |
  | 5 | `fma*`, `fms*`, `fnma*`, `fnms*` (single and double) and every `qpfma*` form, through any source, the addend included; 7 to an integer consumer and to the other cluster (FP side, + 2); six per instruction |

  A fused multiply-add (5) is thus cheaper than `fmul_addd` (8) and
  rounds once (semantics.md).
- **A compare before a taken return**: the predicate written by an
  integer compare, or by predicate logic (`landp`), one instruction
  before a `ct %ctpr3` that returns now reaches a predicated operation
  or `merge` in the return's instruction (v3 and v5 read the old value;
  "Hazards", above). FP compares 1–3 cycles before (2 only for `merge`),
  which v3 and v5 read wrong, were not run on v6.
- **`movtd` and `ct` through the same CTPR in one instruction**: the
  `ct` does not transfer (falls through); v3 and v5 transfer to the old
  target (`bench.py` hazard `movtd_ct`, distance 0).
- **Conflicts that are gone**: an FP operation in ALC5 next to a divide
  (`fdivd` every 2 cycles with `faddd,5` between: 1 cycle each, v5
  1.38), and divider distances that conflicted: `fsqrttd` and
  `pfsqrttd` every 2 or 3 cycles take 2 and 3 (v3 4 and 5). The store
  bank rule stays. `qpcheckd` with equal operands issues two a cycle
  (ALC0 and ALC3) and delays no reader: a reader of its destination, or
  a chain through it, issues the next cycle (`ctlleft.c` `t6_qpcheck*`).
- **A store and a load in one 32-byte block** in one instruction still
  take 1 or 2 cycles, by run, as on the 4C: in four runs on 2026-10-12
  a pair in the cell's first block always took 2, one in the block at
  +0x100 took 2 in two runs and 1 in two (the 2026-10-06 run, 1 there,
  had looked like the conflict was gone).
- **`fxsqrtuxx`** takes 18 cycles (16–17; from a single or double,
  `fxsqrtusx` and `fxsqrtudx`, 16 as before).
- **`wait`** after a load or an FP operation costs more: `ldd` then
  `wait ld_c`+`st_c` 11 cycles a pair (v3, v5 8: the load's 5), `faddd`
  then `wait all_e` 16 (10); after a store 16 (15), but `ma_c` after a
  store 20 (25 and 33), and the soft modifiers save more after a load
  than on the 8C2 ("Every v3 operation").
- **Store to load** (Memory, "Store to load"; `stld.c`, `damlist.c`): a
  reload of the stored bytes in the next instruction still gets its
  value at the L2 latency (13 cycles, 8 late). Other bytes of the line
  usually pay at 1 cycle too: in 3 or all 4 of the steps of a loop that
  stores to four lines (in 3 the first step after the back branch
  escapes). A loop that reuses one line, as `stld.c`'s does, mostly
  doesn't, and neither do processes in some other state (Memory, "The
  2C3's line penalty"; `memorycxx_stld.c`). The 8C2's whole-line window
  2 and 3 cycles after a store is gone; instead any load that overlaps
  the stored bytes without being exactly them at the store's width
  (`std` then `ldw`, `stw` then `ldd`, and 16-byte `stqp`/`ldqp` with
  `ldd` or `std`) pays up to 4 cycles after the store, at 4 any load of
  the stored doubleword but the stored bytes at the store's width, and
  after a store crossing a 32-byte line any load of its second line
  (Memory, "More store-to-load cases").
- **Caches** (`--memory`, `/sys/devices/system/cpu`): 64 KiB L1D, 2 MiB
  L2, no L3; L2 hit 13 cycles (6.5 ns), memory about 220 cycles (110 ns).
- **Array prefetch** (apb.md): one area delivers **32 bytes a cycle**
  (16 on v3 and v5), so lcc's v6 loop reading two `movaqp` from one
  area runs an iteration per cycle (a sum of `long`s: 0.28 cycles per
  element, against 0.53 on the 4C and the 8C2); a `mova` result is
  ready after 5 cycles and an earlier consumer stalls 4; the first
  `mova` may issue 2 cycles sooner after `bap`; from L1 an area
  fetches a new 64-byte line every cycle (every 2 before), about one
  line a cycle per half of the buffer; from memory a line every 2.7
  cycles (3.2).

isa-score uses these numbers for v6 (and v7); `validate.py --target
v6.2c3 --cpu 0` puts every kernel within 1% of the 2C3 except two APB
loops (0.85 and 1.19), and `profile.py` CoreMark within 3% and Linpack
(size 200) within 1% (lcc `-O3` for the 2C3).

`pmu.c` on the 2C3 (monitors.md) agrees: of its 166 kernels, the 32
whose cycles differ from the 8C2's are the ones that use a load 3–4
cycles after it (+4 each), a `disp` and a false `ct` in one instruction
(2 cycles, 3 before) and 64-deep recursion (+20, chain-stack refill).

**What tuning for v6 is worth**: lcc's generic v3 code and its
2C3-tuned code (`-O3`), both run on the 2C3: CoreMark 4,411 against
5,266 iterations a second (1.19×), Linpack (size 200, 4,096 fixed
repetitions) 4.59 s against 3.39 s (1.35×). In the v3 CoreMark 30% of
the cycles are interlock stalls (`BUB_E2`), 2% in the tuned one: v3
code consumes loads 3 cycles out, and each such use stalls a 4-cycle
step on v6. isa-score with the v6 model predicts the v3 binary there
within 8% (measured / achieved 1.08). So a compiler that runs on v6
should schedule loads for 5 cycles even when it emits v3 code
(`-mtune`).

**v6 control transfers** (`ctl6.c`; control-transfer.md): a taken
`ibranchd` costs 12 cycles beyond its instruction however early its
target register is ready (13 a block, against 7 for `ibranch` and for a
`ct` prepared 5 cycles ahead); with the target loaded, a load-to-use
stall on top. `icalld` + return costs 23 cycles a call against 14 for
`disp` + `call`. `movtd` → `ct` still needs 9.

The 2C3's `CLOCK_MONOTONIC` (clock source `sclkr`) advances in steps
of about 330 ns between calls, so wall-clock timing of short loops
there reads 0; use `%clkr`, which counts the 2 GHz core clock.

## Differences between generations (lcc-doc)

lcc's changelogs name scheduling changes it made for later CPUs, which
`bench.py` should check when it runs there:

- v5: floating-point operations in channel 5 need special scheduling
  (lcc 1.26); measured above: one conflicting pattern with the divider.
- v6: the bypass from a store to a following load was removed (lcc 1.26),
  so a load that reads what a store just wrote waits longer. On the
  2C3 a reload of the stored bytes at the store's width pays only in the
  next instruction, as on v3 and v5, but a load of the stored
  doubleword at another width (a narrower one inside the stored bytes,
  a wider one holding them) pays up to 4 cycles after the store, where
  v3 and v5 serve a load inside the stored bytes from L1 from 2 cycles
  after it; that may be what the note means (inferred). A load 16 KiB
  away pays a cycle longer too (Memory, "Store to load", "Loads 16 KiB
  away from a store").
- Elbrus-48C (v7): prepare-to-transfer delays differ;
  `-mset-prepare-ct-delays-e48c` applies them and is on with
  `-mtune=elbrus-48c` (lcc 1.31).

## Not measured yet

- v4; v6 on the Elbrus-16C (the 2C3 is the v6 machine measured). v7
  is out of scope (not in silicon).
- FP compares before predicate readers near a taken return on the 2C3
  ("Hazards": `foldi57_retpred.c` was not run there).
- The divider's reservation model: why a single-precision square root
  conflicts at distances that depend on its operand and on whether the
  gap is a `nop N` in its instruction, and what decides runs of four
  or more ("Throughput", "Divider").
- Exactly which address bits the 16 KiB store-to-load alias compares
  with 4 KiB pages, where the result changes from run to run (Memory,
  "Loads 16 KiB away from a store").
- Store to load (Memory, "Store to load"): why the 8C2 sends a load of
  a line stored 2 or 3 cycles before to L2 (perhaps the write-through
  L1 updating the line then; not checked); what switches the 2C3's
  line penalty off in some processes and why the first step after a
  loop's back branch escapes it ("The 2C3's line penalty"); v4; on the
  8C2 every case of "More store-to-load cases" (16-byte, AAU and
  line-crossing accesses, stores that miss L1, other bytes of the
  stored doubleword; `memorycxx_stld.c` built with `-DSTLD_V5`, not run
  because the machine was busy), with steps spaced as well as back to
  back; on the 4C whether the extra cycle at 1 cycle after a store to
  a line not in L1 stays with spaced steps and covers a 64-byte line.
- Why a stream of loads that miss leaves only part of its lines in L1
  (Memory, "Not every load that misses fills L1"), and why a chase
  in the other cluster finds fewer of a chase's lines on the 4C and
  8C2. A separate L1 per cluster doesn't explain the streams (two loads
  in one cluster leave what one in each does); one L1 fill per wide
  instruction is only a guess.
- Why the schedule as written, not the issue cycles, decides a
  write-back conflict ("Write-back conflicts"; no mechanism found), and
  why `STALL_DTLB` counts 1.00 an iteration in `stbase.c`'s `age_p_m4`
  (a store's base crossing clusters, read through `%b[]`) but 0 in
  `dr_plain` (the same stall through `%dr`) on all three machines.
