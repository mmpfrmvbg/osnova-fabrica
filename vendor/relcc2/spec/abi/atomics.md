# Atomic operations and memory ordering

How lcc compiles the GNU `__atomic_*`/`__sync_*` builtins (and so C11
`<stdatomic.h>` and C++ `<atomic>`), and the one rule that binds every
compiler: 16-byte atomics. Probe: `tools/abi/probes/atomics.c`
(assembly only).

On hardware (Elbrus 4C, by the proof-of-concept backend,
finding A2b): 8 threads, half running a function
built by lcc and half the same function built with these sequences by
another compiler, on shared objects: `fetch_add` on `long`, `int`,
`short`, `char`, strong and weak CAS loops on `long` and `int`, and an
exchange spinlock guarding a plain counter. All counts were exact in
three runs of 1.6 million increments each, while a plain-increment
control lost about half. So the lock protocol below is atomic in
hardware and code from different compilers interoperates. Ordering
and 16-byte atomics on v3 are checked by `tools/abi/probes/litmus.c`
(below).

Code from different compilers interoperates as long as each one's
read-modify-write is really atomic in hardware; the lock protocol below
is the only hardware way to do that for 1–8 bytes (and for 16 bytes on
v5+). The exception is a size that one compiler does in hardware and
another through a library lock (16 bytes, see below).

## Read-modify-write: locked load and unlocking store (lcc, qemu, binutils, hw)

Every exchange, fetch-op, compare-exchange and test-and-set is a retry
loop around a **locked load** and an **unlocking store**. lcc's
`__atomic_fetch_add(&g, v, __ATOMIC_SEQ_CST)` on a `long`:

```
1:  nop 1                                  ! own wide instruction: loop head
    { ldd,0 %g16, 0x0, %g19, mas = 0x7     ! locked load of the old value
      nop 4 }
    { addd,0 %g19, %g17, %g18 }            ! new value
    { std,2 %g16, 0x0, %g18, mas = 0x2     ! store only if the lock still holds
      rbranch 1b }                         ! = ibranch 1b ? %MLOCK
```

- The load has MAS `0x7` and must be in ALC0: "lock-wait" load (qemu
  `target/e2k/mas-format.h`, `e2k_parse_mas_lds1`: mod 7, not speculative,
  channel 0; mod 5 is the variant for channel 0 or for a 16-byte load in
  channel 2, v5+ only: "What breaks the lock" below). It reads the value
  and sets a lock on the address.
- The store has MAS `0x2`: "wait-unlock" store
  (`e2k_parse_mas_sts1`, mod 2). It writes only if the lock is still held,
  then releases it. lcc puts it in ALC2, except in relaxed and acquire
  exchanges, fetch-ops and test-and-sets for v5 and v6, at every size,
  where it uses ALC5; consume, release, acq_rel and seq_cst ones, every
  compare-exchange, and all of v3's and v4's use ALC2 [lcc 1.29.16 `-O3`:
  `e2k-v5.8c2`, `v6.2c3`, `v6.16c` against `v3`, `v4.8c`, `v4.1c+`, and
  1.31.05 `v5.8c2`: `tools/abi/probes/pocabi1_ord.c`; `pocabi1_atom16.c`
  for 16 bytes]. ALC5 is SIGILL on v3 ("What breaks the lock"); in the
  message-passing tests the channel made no measurable difference
  ("Memory ordering on hardware").
- `rbranch 1b` in the store's wide instruction is assembled as
  `ibranch 1b ? %MLOCK` (CT condition type 8, bundle.md): taken when the
  lock was lost and the store did not happen, so the loop retries.
- Between the two, lcc's templates contain only ALU operations
  (`addd`; for compare-exchange `cmpesb` and `merges`). Sizes: `ldb`/
  `ldh`/`ldw`/`ldd` with the matching store; 16 bytes `ldqp`/`stqp` (v5+).
- The memory order does not change the loop (except the unlock store's
  channel on v5 and v6, above): relaxed and seq_cst read-modify-writes
  have no `wait` around them, so the locked pair itself orders memory.
  An exchange with its unlock store in ALC2 after a plain store, read
  with lcc's acquire, never failed message passing on any machine
  ("Memory ordering on hardware").
- Compare-exchange stores in both outcomes: on a mismatch it writes the
  old value back (`merges` chooses the value to store), so the store
  always ends the lock. Test-and-set stores 1 and returns the old byte.
- **The empty cycles in the templates depend on the version** (lcc
  1.29.16 `-O3`, `long`; the proof-of-concept back end's A21, rechecked):

  | Sequence | v3 | v5 (8C2 build) | v6 (2C3 and 16C builds) |
  |---|---|---|---|
  | `nop 1` at the loop head | yes | **no** | yes |
  | fetch-op: load, `nop`, operation, store | 4 | 4 | 4 |
  | exchange: load, `nop`, store | 1 | 1 | 1 |
  | compare-exchange: load, `nop`, `cmpedb`, `nop`, `merge`, store | 2, 1 | 2, 1 | **7, 0** |

  The hardware interlocks, so the counts are a performance choice. An
  uncontended read-modify-write costs, by the empty cycles after the
  lock-wait load (`tools/isa-probes/pocchk2.c` `t_atom_*`: 16 on 16
  cache lines, `%clkr`), cycles each:

  | Sequence | 4C | 8C2 | 2C3 |
  |---|---|---|---|
  | fetch-add, 0 / 1 / 2 / 3 / 4 / 5 | 17.6 / 19.1 / 20.1 / 21.1 / 18.4 / 19.4 | the same | 21.4 / 19.1 / 20.1 / 21.1 / 22.1 / 19.4 |
  | exchange, 0 / 1 / 2 / 3 | 19.6 / 17.6 / 19.1 / 20.1 | the same | 19.6 / 21.4 / 19.1 / 20.1 |
  | compare-exchange 2,1 / 3,1 / 7,0 | 18.4 / 19.4 / 20.7 | the same | 22.4 / 19.6 / 22.4 |

  The cost repeats every 4 cycles of spacing (whole stall steps). On v3
  and v5 lcc's counts are at or next to the cheapest; on the 2C3 the
  lock-wait load's value arrives a cycle later, so the cheapest counts
  are v3's plus one (fetch-add 1 or 5, exchange 2, compare-exchange 3,
  1), and lcc's v6 build pays about 3 cycles over the best on each
  sequence, its new compare-exchange included.
- These sequences are inline-asm templates in lcc's output (between
  `.accept strict_delay` and `.ignore strict_delay`, with `.ias_line`),
  and they carry their own `nop`s. The lone `nop 1` at the loop head is
  a hardware workaround: glibc puts one before its own lock-wait loops
  for `__iset__ <= 6`, citing MCSTBug #163716, and notes that no memory
  access may come between the lock and the unlock (#33705; hwbugs.md).
- MCST's kernel says that on the multi-node E4C (the 4C) atomics have
  fully relaxed memory ordering (#89527) and puts `wait st_c, ma_c`
  around its own; lcc doesn't, and `litmus_rmw.c` found no reordering
  across the 4C's chips (hwbugs.md).

### What breaks the lock [hw]

`tools/abi/probes/lockloss.c` (kernels from `gen_lockloss.py`) on the
4C, 8C2 and 2C3: each attempt of lcc's fetch-add tried once, with
something put between the lock-wait load and the wait-unlock store, and
`rbranch` counting failures instead of retrying (failures per million
attempts):

| Between the lock and the unlock | 4C | 8C2 | 2C3 |
|---|---|---|---|
| nothing (lcc's sequence) | 3 | 5 | 0 |
| ALU operations, a taken `ibranch`, a call and return of a function with no memory access, `rrd %clkr`, `wait` | 1–7 | 1–5 | 2–3 |
| **any load or store by the same thread, to any address** (another page, the locked word, +8 … +65536; any channel and size) | **all** | all | all |
| a system call (`sdisp` entry 3 or the fast entry 6), even with no memory access | all | all | all |
| about 512 / 4,096 / 32,768 empty cycles | 221 / 1,760 / 17,800 | 102 / 830 / 6,700 | 80 / 630 / 5,050 |
| a second lock-wait load | SIGBUS | SIGBUS | SIGBUS |

- Interrupts break the lock in proportion to the window (0.15–0.54 per
  million window cycles, about 300–430 a second: the timer tick); there
  is no timeout. So the retry loop is needed even in one thread.
- The wait-unlock store must have the locked address and size, else it
  fails and writes nothing; so does one with no lock taken. It goes in
  ALC2: in ALC5 it is SIGILL on the 4C, accepted on v5 and v6.
- `%MLOCK` is valid only in the store's own wide instruction: an
  `rbranch` one or two instructions later is never taken, even when the
  store failed.
- The first wait-unlock store ends the lock (a second one always fails).
  A lock not ended by a store is ended by the thread's next memory
  access; **if a lock-wait load comes first, it is SIGBUS**. So a
  compare-exchange must store on both outcomes, as lcc's does (GCC's
  usual expansion branches out without storing), or touch memory before
  the next lock-wait load. An abandoned lock does not block other cores.
- The access must be naturally aligned: a misaligned lock-wait load is
  SIGBUS `BUS_OBJERR` and writes nothing (8-byte, all three; a 16-byte
  `ldqp` one is `BUS_ADRALN` on v5, `BUS_OBJERR` on v6; `memx.c`).
  Under-aligned `__atomic` objects need libatomic's locks.
- **Other cores.** The lock covers a 64-byte block (another core's
  accesses at +64 and beyond never break it). Their loads and stores of
  the block are held off for 1,024 to 1,536 cycles, then break the lock
  (`./lockloss hold`). Against lcc's short window, remote loads rarely
  break it (5–200 per million), and remote stores rarely on the 4C
  (35–195) but about half the time on the 8C2 and a quarter on the 2C3,
  which still makes progress. Contended fetch-adds stayed atomic in
  every run (the word equalled both threads' successes).

  | Contended fetch-add, cycles per success | 4C, one chip | 4C, two chips | 8C2 | 2C3 |
  |---|---|---|---|---|
  | one word, or two words of one 64-byte block | 71 | 339 (the remote thread wins 5:1) | 126 | 87 |
  | separate blocks | 30–33 | 30–33 | 30–33 | 30–33 |
  | lcc's `__atomic_fetch_add` loop, one word | 54–122 | 543 (8.6:1) | 90 | 92 |

- A compare-exchange loop against another core's stream of fetch-adds
  on the same word nearly starves on one 4C chip (115–987 failed CASes
  per increment, 15,000–70,600 cycles each; across chips 11, the 8C2
  2–18, the 2C3 0.4–1). Against relaxed plain stores it needs under one
  retry per increment.
- MAS mod 5: SIGILL on v3; on v5 and v6 `ldd,0 … mas=0x5` behaves as
  mod 7, and an `ldq` register pair (ALC0+2) with mod 5 and an `stq,2`
  unlock works, as qemu's decoding has it. lcc's 16-byte loop
  (`ldqp,0 … mas=0x7`, `stqp,2 … mas=0x2`) follows the same rules.

For a compiler: emit the sequence as one unit after register allocation
(no spill, reload or stack access inside, nothing that may enter the
kernel), keep it a few cycles long (lcc's is 2–8), put `rbranch` in the
store's instruction, never leave a lock open, and prefer fetch-op
sequences to CAS loops where the operation exists. MCST's qemu keeps the
lock across memory accesses, so code that breaks these rules passes
there and livelocks on hardware.

**A type-9 branch in the loop** (`ibranch L ? %MLOCK || [~]%cmpN`,
[predicates.md](../isa/predicates.md), "Control transfers") is taken
when the store failed or the compare in the store's instruction holds
[hw: `tools/isa-probes/ctlleft.c`, 4C, 8C2, 2C3]. With the lock kept,
the store is done and the branch follows the compare (`t9_lock`). With
the lock broken by a load in between, the store is dropped and the
branch is taken whatever the compare (`t9_lockbrk`, `rb_lockbrk`). So a
test-and-set acquire can be one loop (ctlleft's `spin9_lock`):

```
1:  nop 1                                  ! loop head, as lcc's
    { ldw,0 %dr0, 0x0, %r5, mas = 0x7      ! locked load of the lock word
      nop 2 }
    { cmpesb,0 %r5, 0x0, %pred0            ! was it free?
      stw,2 %dr0, 0x0, %r6, mas = 0x2      ! store 1 (%r6) if the lock holds
      ibranch 1b ? %MLOCK || ~%cmp0 }      ! retry if the lock was lost or held
```

It stayed exact in 2 threads × 200,000 lock–unlock rounds on each
machine. Uncontended it costs what an exchange plus a separate test
costs with the same gap (`t_tas9` 18.1 cycles a round on the 4C and
8C2 and 22.1 on the 2C3, `t_tasc_n2` 18.0 and 22.0). Contended, the
result depends on the machine (ns a lock–unlock round, against lcc's
exchange, `rbranch` and a separate test, `spinc_lock`):

| Two threads on | type 9 | exchange and test |
|---|---|---|
| 4C, one chip (cores 0, 1) | 102–116 | 183 |
| 4C, two chips (cores 0, 4) | 139–163 | 273 |
| 8C2, cores 0, 1 | 122 | 96 |
| 8C2, cores 0, 4 | 55 | 58 |
| 8C2, unpinned | 59–60 | 68–69 |
| 2C3, pinned | 98 | 69–74 |
| 2C3, unpinned (one run) | 68 and 98 | 68–69 |

The two loops differed by one cycle in their load-to-store gap (type 9
2, the exchange 1), and fairness was not measured, so the contended
figures compare whole loops, not the branch alone. A compare-exchange
can't use it, since its store's data depends on the compare. lcc
doesn't use type 9. MCST's erratum #164666 (E2C3, E12C, E16C) only asks
that `ibranch(d) ? %MLOCK [|| %cmp] [|| %clp]` not come right before a
`wait int = 1`, which can trigger falsely (kernel
`asm/cpu_features.h:660-667`; hwbugs.md lists it as OS-only).

## Loads, stores and fences (lcc)

| Operation | lcc's code |
|---|---|
| relaxed load, store | plain `ld`/`st` |
| acquire load | `ld`, then `adds,sm %r, 0x0, %empty` in a later wide instruction: a dummy use that stalls until the value arrives, so nothing after it issues earlier (gas writes `,sm` as `,s`) |
| seq_cst load | `wait ld_c = 1, st_c = 1`, then the acquire load |
| release store | `wait ld_c = 1, st_c = 1` and the `st` (may share a wide instruction) |
| seq_cst store | release store, then `wait st_c = 1` |
| fence of any order, `__sync_synchronize` | `wait ld_c = 1, st_c = 1` |

lcc's code for the 8C2 (v5) adds `sal = 1, sas = 1` (the v5+ `wait`
bits, bundle.md) to the release and seq_cst stores' `wait`, and puts an
empty instruction (`{ nop }`) before that `wait`, as the E8C2 soft-wait
erratum asks (hwbugs.md); its code for the 2C3 (v6) is the v3 code
above, without them. Read-modify-writes
are the same on all three except for their empty cycles (above). v6 has MAS encodings for load-acquire and
store-release (kernel `asm/mas.h`: `MAS_LOAD_ACQUIRE_V6`,
`MAS_STORE_RELEASE_V6`, bit 4 set with `mod` 3), a "watch for
modification" load, and second encodings of the check-and-unlock load
and the wait-unlock store (0x33, 0x73: speculation.md, "v6
encodings"), but lcc 1.29.16 doesn't use them. On the 2C3 a
release store by MAS costs 3.5–4.8 cycles back to back against 15.8 for
lcc's `wait` + store (but MCST's kernel lists the MAS store-release as
broken on E2C3 up to revision 2, ours included, and the E12C/E16C,
and uses `wait` + store there: hwbugs.md), and an acquire load 10.4 cycles in a dependent
chain against 4.8 (speculation.md, "v6 encodings"); whether they order
exactly as their names say was not checked: litmus.c's setup shows only
store → load reordering, and the message-passing setups that do reorder
("Memory ordering on hardware") were not run with them.

`wait` waits for the completion of earlier loads (`ld_c`) and stores
(`st_c`). lcc 1.31 also has `__builtin_e2k_read_barrier`,
`_write_barrier`, `_mem_barrier` and `_barrier`, each a compiler barrier
plus a `wait` whose mask is the argument (the mask bits of `wait` for
the target ISA) (**lcc-doc**).

**What fences cost** [hw: `tools/isa-probes/memleft.c` `wait`,
`timing`; cycles for the fence alone / after a store / after a load,
4C / 8C2 / 2C3 where they differ; every field: timing.md, "Every v3
operation"]:

| Fence | Who uses it | Alone | After a store | After a load |
|---|---|---|---|---|
| `wait ld_c, st_c` | lcc's fences, every version | 7 | 15 / 15 / 16 | 8 / 8 / 11 |
| `wait all_c, fl_c` | glibc's `pthread_spin_lock`, `_unlock`, `_trylock` | 8 | 15 / 15 / 16 | 9 / 9 / 11 |
| `wait st_c, ma_c` | MCST's kernel around atomics on the NUMA 4C | 6 | 25 / 33 / 20 | 11 / 12 / 13 |
| all six fields | glibc's `dl-machine.h`, around its I-cache line flushes | 8 | 25 / 33 / 20 | 11 / 12 / 13 |
| `wait ld_c, st_c, sal, sas` (v5+) | lcc's v5 release store; the kernel's release store before v6 (`smp_store_release` adds `mt`, which v5 ignores) | 2 | 7 / 6 (8C2 / 2C3) | 7 / 3 (8C2 / 2C3) |
| `wait ld_c, st_c, sas, sal, las, lal, mt` (v6) | the kernel's v6 `smp_mb` | 2 | 6 | 6 |

So glibc's spinlock fence costs what lcc's does (a cycle more with
nothing outstanding), and `ma_c` is the expensive field. Release stores
back to back: lcc's v3 and v6 form (`wait ld_c, st_c` + `st` in one
wide instruction) costs 13.8 cycles a store on the 4C and 8C2 and 14.8
on the 2C3 (15.8 with the two in separate instructions, `mas6.c`, as
above). Its v5 form
costs 6.4 on the 8C2 (about half), 5.4 without the `nop`, and 4.7 on
the 2C3 (a third), where lcc doesn't use it. A seq_cst store (+ `wait
st_c`) costs 21, 21 and 22 cycles, 20 in the v5 form.

The store-buffering test (`x = 1`, the `wait`, `r = y` on both
threads; `memleft.c` `sb`) doesn't settle what the soft bits order. On
the 2C3, with the `wait` in the load's own wide instruction (1,000,000
tries each), `r1 = r2 = 0` came 260 times with no `wait`; `st_c, sas`
gave 212, `ld_c, sal` 199 and `mt` 85; `st_c, las`, `ld_c, lal`, `ld_c,
st_c, sal, sas`, the kernel's `smp_mb` and every hard `wait` gave 0.
Those zeros don't show store → load ordering: the kernel calls `lal`
the load-after-load modifier (`asm/e2k_api.h:5077-5080`), and the
`sal, sas` pair gives 0 although neither half does. Nor are they plain
delay: with a store before each, `st_c, sas` and `st_c, las` cost the
same 6 cycles, yet give 212 and 0. MCST's kernel takes the soft bits
to work on our 2C3: it drops them only on E2C3 revision 0, ours being
revision 1 (`CPU_NO_HWBUG_SOFT_WAIT` in `asm/cpu_features.h`, used by
`__E2K_WAIT` in `asm/e2k_api.h`; hwbugs.md) [source]. What the pattern
means is open, and MP and LB with the soft bits were not run (MP does
fail without fences when the reader holds the lines, "Memory ordering
on hardware"). On the 8C2 every `wait` gives 0
(320 without one in 1,000,000 tries), the soft ones included,
presumably because its reordering window is shorter than any `wait`
(inferred; below). v5 ignores `las`, `lal` and `mt`, so the kernel's
`rmb()` (`ld_c, lal`) is a full `ld_c` there, and the kernel keeps
`smp_mb()` at `ld_c, st_c` before v6 (`asm/barrier.h`).

## Memory ordering on hardware (v3) [hw]

`tools/abi/probes/litmus.c` with hand-written sides (`litmus.s`) runs
the classic two-thread tests on the 4C, two threads on one chip (CPUs
0, 1) and on different chips (1, 9), 2 million iterations per variant,
each access in its own wide instruction unless noted:

| Test | Forbidden under SC | Seen |
|---|---|---|
| SB: `x = 1; r1 = y` ‖ `y = 1; r2 = x` | `r1 = r2 = 0` | 23 and 41 times |
| SB, store and load in one wide instruction | same | 5,540 and 15 |
| SB with `wait ld_c = 1, st_c = 1` or `wait st_c = 1` between | same | never |
| MP: `x = 1; y = 1` ‖ `r1 = y; r2 = x`, both lines starting in the writer's cache | `r1 = 1, r2 = 0` | never (also with the loads in one instruction, `wait`, or lcc's release/acquire); but see below for a reader that holds the lines |
| MP, both stores in one wide instruction | same | 2 in 20 million (one per channel order) |
| LB: `r1 = x; y = 1` ‖ `r2 = y; x = 1` | `r1 = r2 = 1` | never (also in one instruction) |

In this setup (litmus.c's writer resets `x` and `y`, so both lines
start in its cache) the only reordering across wide instructions is a
later load passing an earlier store (a store buffer), which `wait st_c =
1` before the load prevents (on the 4C; pocabi1_mp.c's version of this
setup, W below, saw MP 0–2 times per million on the 8C2 and 0–1 on the
2C3). That is not TSO, though: when the reader already holds the lines,
MP fails on all three machines (below).
Within one wide instruction a load may see memory before the
instruction's store, and two stores may become visible in either
order (rare, since they need another core reading between them). The
counts are low because the two threads rarely overlap closely, so
"never" means not seen in 4 million tries per variant. The Elbrus-8C2
(v5, 300,000 tries per variant, built for v3 and for v5) gives the same
picture with far more SB outcomes (870 to 5,052, against 5 on the 4C),
none for MP or LB, and once more an MP outcome with both stores in one
instruction. The Elbrus-2C3 (v6, its two cores, 200,000 tries, built for
the 2C3) too: SB 326 and 263 (in one instruction), none with a `wait`,
none for MP (including release/acquire) or LB; its 16-byte atomics
(inline, lock-free) count exactly with no torn read.

The reordering needs the load close behind the store [hw:
`tools/isa-probes/memleft.c` `sb`]. On the 8C2, `r1 = r2 = 0` came 675
times in 2,000,000 tries with the load in the next instruction and 604
with one empty cycle between, but never with 2 or more empty cycles. On
the 2C3 it came 260, 83, 34 and 19 times in 1,000,000 tries with 0 to 3
empty cycles, and never with 4 or more (300,000 tries gave 59, 19, 7, 9
and 0). So on these two machines the hard `wait`s (6 cycles or more)
would show 0 even if they ordered nothing (inferred). It is no rule a
compiler can use, since a store that misses the cache may stay
buffered longer (inferred): seq_cst still needs the fence.

**Message passing when the reader holds the lines** [hw:
`tools/abi/probes/pocabi1_mp.c` with `pocabi1_mp.s`, lcc 1.29.16 builds
for each machine, 1,000,000 tries a variant, 1 to 5 runs; in the final
version the writer stores a new value each try, so a value left from an
earlier try would show, and none did]. The writer stores `x` then `y`
in consecutive wide instructions, the reader loads `y` then `x`. In setup R the reader
resets `x` and `y` before each try, so both lines start in its own
cache; in setup S the writer resets them and the reader then reads `x`,
so `x` starts shared and `y` in the writer's cache alone; W is
litmus.c's setup. `r1 = 1, r2 = 0` per million:

| Writer ‖ reader | 4C, one chip | 4C, two chips | 8C2 | 2C3 |
|---|---|---|---|---|
| R: plain stores (in any channels) or `y` by a lock-wait loop; plain loads | 0-9 (an earlier build: 216-567, the lock loop 0-2) | 29-98 | 28-886 | 0-48 |
| R: the loads in one wide instruction | 178-794 | 54-89 | 4-93 | 0-6 |
| S: plain stores and loads | 168,000-175,000 | 420,000-426,000 | 195,000-216,000 | 233,000-292,000 |
| S: reader `wait ld_c = 1` between the loads | 0-1 | 2-8 | 0 | 2,600-21,300 |
| S: reader's acquire, lcc's dummy use of `y` (`adds,sm r1, 0x0, %empty`) between the loads | 0-1 | 1-7 | 0-17 | 8,500-24,700 |
| S: writer `wait st_c = 1` between the stores | 0-1 | 15-18 | 0 | 0-1 |
| S: writer's release, lcc's `{ wait ld_c = 1, st_c = 1; std y }` | 2,400-2,600 | 428-443 | 0 | 0 |
| R and S: writer's `wait` or release ‖ reader's `wait` or acquire | 0 | 0 | 0 | 0 |
| R and S: `y` written by lcc's exchange loop (unlock store in ALC2) ‖ reader's acquire | 0 | 0 | 0 | 0 |
| W: any of these | 0 | 0 | 0-2 | 0-1 |

- The stores' channels (ALC2 or ALC5 for either store) made no
  difference, and `y` written by a lock-wait loop with its unlock store
  in ALC2 or ALC5 gave about the plain counts, except on one 4C chip in
  setup R (0-2). With lcc's acquire reading, the ALC5
  unlock store gave one outcome on the 2C3 in 2 million tries, the ALC2
  one none (not enough to tell them apart; lcc uses ALC5 only for
  relaxed and acquire read-modify-writes, which promise no release).
- The counts follow the run's timing: they repeat for one binary and
  seed and change with the build (the 8C2's plain R row was 29-45 in
  two builds, 494-740 in a third).
- So a load that hits a line its core holds can complete before an
  earlier load that misses (the plain S rows, cut to almost nothing by
  ordering the reader's loads on the 4C and 8C2), and on the 2C3 the
  writer's store to a line another core shares can reach the reader
  after its later store to a line it owns: a reader that waits for `y`
  still reads the old `x` in up to 2.5% of tries, and only a `wait`
  between the writer's stores prevents it (inferred from the rows;
  whether the writer reorders the stores or the reader applies the
  invalidation late can't be told apart here). Each side's fence alone
  left outcomes on some machine (the reader's up to 2.5% on the 2C3 and
  a few per million on the 4C and 8C2; the writer's, against plain
  loads, up to 2,600 per million on the 4C); both together left none
  anywhere.
- MCST's kernel writes its pre-v6 acquire load as the load plus a dummy
  use of the value ("Wait for the load to finish before issuing next
  memory loads/stores": `__smp_load_acquire`, `asm/barrier.h:140-148`;
  `E2K_RF_WAIT_LOAD`, `asm/e2k_api.h:5187-5198`) and its pre-v6 release
  store as a `wait ld_c, st_c, sal, sas` before the store
  (`smp_store_release_mt`, `asm/barrier.h:81-89`) [source]: lcc's forms.
- litmus.c's MP never saw this because its writer resets the lines.
  Found while rechecking the proof-of-concept back end's A29 (whether
  the ALC5 unlock store means anything for ordering).

For a compiler, on every version measured (v3, v5, v6), that means:

- seq_cst stores and fences need the `wait` (or a locked
  read-modify-write).
- A release store needs a `wait` before it, as lcc's `wait ld_c = 1,
  st_c = 1` (and never shares a wide instruction with an earlier store).
- An acquire load needs its value used before any later load issues, as
  lcc's dummy `adds,sm` does, or a `wait ld_c = 1` after it. Keeping the
  order in the instruction stream is not enough on either side.
- A read-modify-write orders as lcc's do without a `wait` (above).

16-byte atomics on v3 (same probe): two threads doing
`__atomic_fetch_add` and CAS loops on an `__int128` through libatomic
gave exact counts (4 million each), a third thread's `__atomic_load_n`
never saw the two halves differ, and `__atomic_is_lock_free(16)` is 0.
The same v3 binary on the Elbrus-8C2 also counts exactly but reports
lock-free 1, because that system's libatomic is built for the 8C2
(below).

## 16-byte atomics (lcc, lcc-doc)

| Target | Hardware 16-byte atomics | lcc's code | `__atomic_always_lock_free(16)` |
|---|---|---|---|
| v3, v4 | no (only loads and stores of protected-mode descriptors) | calls `__atomic_load_16`, `__atomic_compare_exchange_16`, ... in libatomic, which uses a lock, not lock-free | 0 |
| v5+ | yes | inline `ldqp`/`stqp` sequences (below) | 1 |

- Whether code that mixes the two on **one object** works depends on
  the system's libatomic. A libatomic built for v3/v4 (ALT Linux's on
  the 4C) uses a lock, which does not exclude the hardware loop, so
  mixing breaks. Elbrus Linux 9.5 on the 8C2 ships a libatomic built for
  `elbrus-8c2` whose `__atomic_*_16` are the same `ldqp`/`stqp` loops
  (147 quad operations in it), so there v3 code (calling libatomic) and
  v5 code (inline) agree: two threads adding to one `__int128`, one
  through each, counted exactly (4 million, three runs; hw). lcc's
  `-mno-quad-memory-atomic` makes v5+ code call libatomic too.
- v3 and v4 do not define `__GCC_HAVE_SYNC_COMPARE_AND_SWAP_16`; v5 does.
  Both define `__GCC_ATOMIC_*_LOCK_FREE` as 2 for every type up to
  `long long` and pointers.
- MCST's libatomic is GCC's generic one (`libatomic/config/posix`, lock
  tables) with only protected-mode changes (`internal-lcc-libs`,
  `lib/GNU/gcc-11/libatomic`).
- 32-bit mode (`-mptr32`) follows the same rules with `ldgdqp`/`stgdqp`,
  and each lcc tree's 32-bit libatomic is built for its CPU too; v3 and
  inline code mixed on one object there lose updates through lcc's
  lock-based libatomic and count exactly through Elbrus Linux's
  ([mode32.md](mode32.md), "16-byte atomics"; hw).

**lcc's v5 and v6 sequences** [lcc 1.29.16 and 1.31.05 `-O3`,
`e2k-v5.8c2` and `e2k-v6.2c3`: `tools/abi/probes/pocabi1_atom16.c`; the
two versions differ only in scheduling around the templates; found by
the proof-of-concept back end, finding A29]. The
value lives in one `qp` register: `qppackdl hi, lo` builds it (a
constant too: `qppackdl 0x0, 0x0`), and `qpswitchd` (which swaps the
halves) and `addd 0x0, q` take the high and low halves out. Every
function that touches one gets `setwd nfx = 0` (registers.md, "nfx").
The bracketed templates are lcc's inline-asm sequences, as for the
narrower sizes:

| Operation | v5 (8C2) | v6 (2C3) |
|---|---|---|
| relaxed load | two `ldd` (in one wide instruction through a pointer, in consecutive ones for a global) and `qppackdl`: **two accesses** | one `ldqp` |
| consume, acquire load | `{ ldqp; nop 2 } { adds,s v, 0x0, %empty }` (the dummy use of "Loads, stores and fences") | the same with `nop 4` |
| seq_cst load | `wait ld_c = 1, st_c = 1` in the `ldqp`'s instruction, then as acquire | the same |
| relaxed store | `qppackdl`, `stqp` | the same |
| release store | `{ nop } { wait ld_c = 1, sal = 1, st_c = 1, sas = 1; stqp }` | `{ wait ld_c = 1, st_c = 1; stqp }` |
| seq_cst store | the release store, then `{ wait st_c = 1 }` | the same |
| exchange | `1: { ldqp,0 a, old, mas = 0x7; nop 1 } { stqp a, new, mas = 0x2; rbranch 1b }`: a lock-wait loop of its own, with no compare | `1: nop 1`, then the same |
| compare-exchange | `*expected` read with two `ldd` and packed, the desired value packed, then `1: { ldqp,0 a, old, mas = 0x7; nop 2 } { qpcmpeqd,0 old, exp, m } { qpswitchd,0 m, m2 } { qpand,0 m, m2, m } { qpmerge,0 old, des, m, m; andd,1 m, 0x1, ok; nop 3 } { stqp,2 a, m, mas = 0x2; rbranch 1b }` (the `andd` reads the mask in `qpmerge`'s own instruction, before `qpmerge` replaces it); afterwards the old value is written to `*expected` with two `std`, whatever the outcome | `*expected` read with one `ldqp`; `1: nop 1 { ldqp,0 a, old, mas = 0x7; nop 7 } { qpcmpeqdap,0 old, exp, %pred } { qpmrgp,0 old, des, new, %pred; merges,1 0x0, 0x1, ok, %pred } { stqp,2 a, new, mas = 0x2; rbranch 1b }`; the old value written back with one `stqp` |
| fetch-op (add, sub, and, or, ...) | the old value read with two `ldd` (after the first failed round, with two `ldd,sm` issued right after the loop), the new one computed in halves (`cmpbdb` for the carry), then the compare-exchange loop above; on a mismatch, reload and repeat | the same around v6's compare-exchange |

As with the narrower sizes, the compare-exchange stores on both outcomes
(the old value when they differ), the `__sync_*` builtins are the
seq_cst forms, and the unlock store goes in ALC5 for relaxed and acquire
exchanges and fetch-ops, ALC2 otherwise ("Read-modify-write").
`__atomic_always_lock_free (16, 0)` and `__atomic_is_lock_free` are 1.

On hardware [`tools/abi/probes/pocabi1_a16run.c`, lcc `-O3`, two to
four runs each: the 8C2 with 8C2 code; the 2C3 with 2C3 code, and with lcc's 8C2
assembly assembled for the 2C3, since 8C2 programs don't run there
("Exec format error")]:

- Two threads each added 2^64 + 2^63 + 1 (a carry between the halves
  every second add) a million times: relaxed against seq_cst fetch-add,
  fetch-add against a weak compare-exchange loop, and add-fetch against
  fetch-sub. Every count came out exact, and concurrent exchanges kept
  every value (sum in = sum out).
- A compare-exchange that fails in either half returns 0, leaves the
  object and copies it to `*expected`.
- A concurrent `stqp` never tore lcc's relaxed load through a pointer
  (both `ldd` in one instruction: 16 million reads on the 8C2, 8 million
  with 8C2 code on the 2C3), but tore its global form (the `ldd` in
  consecutive instructions) once in 4 million reads on the 8C2. Two
  `ldd` further apart tear often (`tools/abi/probes/pocabi1_tear.s`,
  per million reads):

| Halves read | 8C2 | 2C3 |
|---|---|---|
| in one wide instruction | 0 | 0 |
| in consecutive instructions | 0-1 (1 in 10 million, lcc's global load included) | 0-1 |
| 8 cycles apart | 1-3 | about 332,000 |
| 32 cycles apart | 6-14 (cores 0, 4 and 2, 3), about 666,000 (cores 0, 1) | 894,000-999,000 |

- Uncontended, in cycles per loop iteration: a call of a function doing
  one operation plus the loop, whose empty iteration costs 25 on the 8C2
  and 28 on the 2C3 (best of 5 × 1,000,000; every run alike):

| Operation | 8C2 | 2C3 |
|---|---|---|
| load relaxed / acquire / seq_cst | 35 / 45 / 55 | 38 / 44 / 53 |
| store relaxed / release / seq_cst | 34 / 48 / 53 | 38 / 44 / 59 |
| exchange relaxed / seq_cst | 49 / 48 | 54 / 58 |
| fetch-add relaxed / seq_cst | 73 / 74 | 64 / 60 |
| compare-exchange that succeeds / fails | 68 / 58 | 58 / 56 |

For a GCC port: under the default `-march=elbrus-v3` it must call
libatomic for 16 bytes, as lcc does, and a v5+ mode should offer the same
switch as `-mno-quad-memory-atomic`. Mixing v3 and v5 code that shares
16-byte atomic objects is unsafe whichever compiler built it. A v5+ mode
can take lcc's sequences above with two changes. First, load with one
`ldqp` at every order, as lcc's v6 code does: two `ldd` are one access
only while they stay in one wide instruction, and even lcc's form in
consecutive instructions tore once on the 8C2; a scheduler working on
two `DImode` loads promises neither. Second, give exchange its own
pattern (lcc's two-instruction loop). Without one, GCC builds exchange
and every fetch-op as a compare-exchange loop (`expand_atomic_exchange`,
optabs.cc:7504-7521, falls back to
`maybe_emit_compare_and_swap_exchange_loop`, :7351-7364;
`expand_atomic_fetch_op`, :8214, to the same loop, :8332): lcc's shape
for fetch-ops, but not for exchange, whose loop is cheaper (48-49
against 68 cycles a call on the 8C2, above).

## Other differences from GCC (lcc-doc)

- A `__sync_*` builtin with no hardware support becomes a call into
  libatomic (the equivalent `__atomic_*`), not a call to a user-provided
  `__sync_*` function as in GCC; link with `-latomic`.
- Generic `__atomic_*` on a type of size 2, 4, 8 or 16 that is less
  aligned than its size are built as if aligned, as GCC does;
  `-mno-unaligned-type-atomic` makes lcc honour the alignment (all code
  touching the object must then agree).
