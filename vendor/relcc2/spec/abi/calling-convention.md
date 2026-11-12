# Calling convention

## Call sequence (guide 9.5.3–9.5.4; lcc, unipro)

```
	disp    %ctpr1, callee            ! prepare: also movtd %drN, %ctpr1 for indirect calls
	setwd   wsz = 8, nfx = 1, dbl = 0 ! caller's window, large enough for its outgoing area
	setbn   rbs = 4, rsz = 3, rcur = 0 ! %b[0..7] = %r8..%r15: the outgoing argument registers
	getsp   -48, %dr1                  ! reserve the stack argument area (see below)
	addd    ..., %db[0]                ! arguments go to %db[0], %db[1], ...
	call    %ctpr1, wbs = 4            ! callee's window starts at %r8: its %dr0 = our %db[0]
	...                                ! results are in %db[0], %db[1], ...

callee:
	setwd   wsz = 4, nfx = 1, dbl = 0  ! at least the 4 pairs of the parameter area
	return  %ctpr3                     ! prepare the return; may be done early
	...                                ! arguments in %dr0..%dr7, result to %dr0..
	ct      %ctpr3
```

- The call saves the return address, `WD`, `BR`, the predicate file, `USD`,
  `CUIR`, `TR` and `PSR` in the chain stack, and gives the callee a window
  whose initial size equals the caller's window size minus `wbs`.
- The first argument register must be even (`wbs` counts pairs). Both
  compilers point `%b[0]` at it with `setbn rbs = wbs` and write arguments
  as `%db[i]`.
- `wbs` lies between the pairs the caller was itself handed (4 for a
  C function) and its `wsz` − 1: a smaller `wbs`, a larger one, or one
  equal to `wsz` (no pair handed over) is SIGSEGV `SEGV_BNDERR`, at the
  `call` or at the callee's first instruction (guide 9.5.3;
  [registers.md](registers.md), window size limits [hw]).
- The C convention's parameter area is **4 pairs = 8 registers** (kernel
  `C_ABI_PSIZE_UNPROT`).
- Tail calls: `ct` to a function without `call` keeps the current window, so
  arguments are placed in the caller's own `%dr0..` (unipro). lcc does
  the same at `-O2` and `-O3`: `return g (x + 1)` is `disp %ctpr1, g`,
  `addd %r0, 0x1, %r0` and `ct %ctpr1`, also from a function with a
  frame or with stack arguments [lcc 1.29.16 v3.4c, v5.8c2, v6.2c3 and
  1.31.05; `tools/abi/probes/pocplan.c` `tail1`, `tail_frame`,
  `tail10`]. It passes the stack slots in an area of its own frame, even
  where the incoming area would do (a `getsp` of 16 bytes for one
  argument in `tail1`, 0x50 for ten in `tail10`, slots 8 and 9 stored
  there; `tail_frame` reuses the outgoing area of its earlier call), and
  releases neither that area nor the rest of its frame before the `ct`.
  So the data stack grows at each tail call until the last callee
  returns (its return restores `USD` from the chain stack): against a
  direct call, the callee's locals sit 16 bytes lower after `tail1`, 48
  after `tail_frame` (its whole frame), 80 after `tail10`, and 16 bytes
  lower for each of 10 or 20 mutually recursive tail calls [hw:
  `tools/abi/probes/pocplan_tail.c`, 4C, 8C2, 2C3, and MCST's qemu].
  GCC's `gcc.dg/sibcall-3.c` and `sibcall-9.c`, which check that a
  local's address stays the same across sibling calls of a one-argument
  function, therefore abort with lcc's code; `sibcall-4.c` and `-10.c`
  (no arguments, no area) pass [hw: lcc 1.29.16 `e2k-v3` `-O2
  -fno-inline`, 4C, 8C2, 2C3]. A function may instead give its frame
  back before the jump, as GCC's sibling calls do, and that works
  ("Tail calls that release the frame", below).

### Tail calls that release the frame [hw: `tools/abi/probes/callsstack_tail.c` with `callsstack_tail.s`, and `callsstack_tailx.cc`; 4C, 8C2, 2C3 and MCST's qemu]

A function can give its frame back with a positive `getsp` of its size
(a VLA included, in one `getsp` of a register sum) and then jump to
another function with `ct`, in the same wide instruction or later. The
callee then runs exactly as if the original caller had called it
directly:

| Case | Result |
|---|---|
| a 64-byte frame released in the `ct`'s instruction, or 6 cycles before it | the callee's `getsp 0` in its first instruction reads what it reads after a direct call (without the release: 64 bytes lower) |
| a 32-byte frame and a VLA of 1, 16, 100, 4,096 or 70,000 bytes, released by one `getsp` of a register | the same |
| slots 8 and 9 read from the incoming area, then, after the release, rewritten in that area for the callee | the callee gets them; its local is at the direct call's address |
| a 96-byte result of the tail-called function | written through the original caller's area, right; the callee's local at the direct call's address |
| chains of 0 to 1,000,000 mutual tail calls with a 64-byte frame each, released 6 cycles before each `ct` or in its instruction (there under the `ct`'s predicate) | the final callee's local at the direct call's address; `USD` after the return the same as before the call |
| `alloca` of 64 KiB to 4 MiB in the final callee of 1,000 tail calls | the block at the direct call's address; `USD` restored |
| `backtrace` in the final callee of 10,000 tail calls | 6 frames: the final callee directly under `main` |
| a 20 µs SIGALRM timer during 200 chains of 100,000 calls (50 on the 8C2 and 2C3), the handler clearing 2 KiB of locals on the thread's stack | 2.6 million signals on the 4C and no wrong result; the deepest `backtrace` in the handler had 8 frames. The signals came at random points, not aimed at the instructions between a release and its `ct` |
| C++ exceptions with lcc 1.29.16's runtime (MCST's unwinder), `callsstack_tailx.cc` | thrown in the final callee of 0 to 10^6 tail calls (by the callee or a function it calls) and caught in `main`, the destructor run once and `USD` the same afterwards; caught by a landing pad in a function entered by `ct`; thrown by a callee whose stack arguments were rewritten after the release |

Give back exactly what was taken: `getsp` rounds the new stack pointer
down to 16 bytes, and nothing bounds a release by the function's frame
([stack-and-unwinding.md](stack-and-unwinding.md), "User stack"). After
the release nothing may read the released frame: it lies below `USD`,
where a signal frame can be written at any moment (no red zone:
[kernel-interface.md](kernel-interface.md), "Signals"). The
`ct`'s target is prepared with `disp` or an unconditional `movtd`: a
`movtd` into a CTPR under a predicate traps
([predicates.md](../isa/predicates.md), "RLP"). GCC's
`gcc.dg/sibcall-3.c` and `-9.c`, which compare a local's address at two
depths of a sibling recursion, would then pass, as `-4.c` and `-10.c`
already do (inferred from the chain cases; not run).

## Argument slots (guide 9.5.1; lcc, unipro, libffi)

Arguments form a list of 8-byte **slots**:

| Argument size | Placement | Slots |
|---|---|---|
| 0 (empty GNU C `struct {}`) | none: the next argument takes the slot (lcc) | 0 |
| 1–8 bytes | next free slot | 1 |
| 9–16 bytes | next **even** slot (an odd slot is skipped) | 2 |
| 17 bytes or more | next even slot | (size + 7) / 8 |

Placement depends on the size only, not on the type's alignment: a
9-byte `struct { char c[9]; }` also starts at an even slot (libffi
`calc_arg_alignment`, checked against lcc).

- **Slots 0–7 are passed in registers**: slot *i* in the callee's `%dr<i>`
  (the caller's `%db[i]`). Later slots are passed in memory only.
- An argument that would start in a register slot but not fit entirely in
  slots 0–7 goes entirely to memory. Example: seven `long`s and then a
  16-byte struct: the struct skips slot 7 and goes to slots 8–9 in memory.
- Slots are assigned in order and never backfilled: a later small argument
  does not go into a skipped slot (slot 7 above stays unused).
- Aggregates are passed by value in slots, packed as in memory: a 3-byte
  struct occupies the low bytes of one slot; `struct { float a, b; }` and
  `_Complex float` share one slot (`a` in the low half); a 72-byte struct
  occupies 9 slots in memory.
- `long double` occupies two slots (mantissa in the first, 16-bit sign and
  exponent in the second), aligned to an even slot. So do `__int128` and
  `__float128` (low half first). `_Complex double` occupies two slots
  (real first). For the exponent slot of a `long double`, lcc callers
  zero-extend the word from 32 bits (`sxt 0x6`) and lcc returns it
  zero-extended from 16 bits (`sxt 0x5`; `sxt` codes 4–6 are the unsigned
  forms); lcc callees use only bits 0–15 (hw: garbage above them is
  ignored).
- `float` is passed in the low 32 bits of its slot; `double` in the whole slot.
- GNU vector types (`__attribute__ ((vector_size (N)))`) are passed like
  an integer or aggregate of their size: an 8-byte vector takes one slot
  (`f (int, v4hi, double, v4hi)` gets `%r0`…`%r3`), a 16-byte one an
  even pair (`g (int, v4si)` passes it in `%r2`/`%r3`); results come
  back in `%r0` or `%r0`/`%r1`, and a struct holding a vector follows the
  aggregate rules [lcc: 1.29.16 `-O2`; the proof-of-concept back end
  agrees]. `va_arg` of a vector and v5's 16-byte vectors are not in the
  compat suite yet.

### Unused parts of a slot (lcc, qemu, compat, hw)

Bytes of a slot that hold no argument data are undefined, and the callee
must not depend on them. On E2K they may be worse than garbage. When an
aggregate larger than 8 bytes is passed in registers and its last slot
holds only 1–4 bytes (sizes 9–12, 17–20, …, 57–60), lcc writes that slot
with a 32-bit operation while `WD.dbl = 0`. That writes only the low half
of the register and leaves the upper half, including its tag, as it was.
Each 32-bit half of a register has a tag, and a half tagged 1 is
**diagnostic** when its bit 30 is set and **empty** when it is clear
([speculation.md](../isa/speculation.md), "Diagnostic values"). If the
upper half is diagnostic, a non-speculative operation that reads the
whole 64-bit register (for example `std` to spill it) raises
`exc_diag_operand`, which Linux delivers as `SIGILL`. An empty upper
half does not trap: a plain `std` stores the register, and 64-bit
operations read the half as a number [hw: `tools/abi/probes/tagempty.c`
variants g, h, l; 4C, 8C2, 2C3]. A callee should access such a slot only
at the width of the data in it, or with speculative operations: a
speculative store `std,sm` of such a register does not trap and stores
the low half intact (the upper half becomes an arbitrary diagnostic
pattern, `4afafafa` on the 4C, 8C2 and 2C3; hw,
`tools/abi/probes/tagtrap.c` variant d). MCST's libffi spills incoming
argument registers this way (`std,sm` throughout `src/e2k/call.S`).

The mechanism is confirmed on hardware by `tools/abi/probes/tagtrap.c`
(the 4C, 8C2 and 2C3 print the same): a speculative load from a bad
address leaves a diagnostic value; a 32-bit `adds` into that register
under `dbl = 0` keeps the old upper half, and a following `std` dies
with `SIGILL`. Under `dbl = 1` the same `adds` zero-extends and the
`std` succeeds.

Whether a real call hits it depends on what the upper half last held. A
register that a window gains, the part of a callee's window beyond the
pairs its caller hands over (the caller's `wsz` − `wbs`; lcc hands over
the 4-pair parameter area, [registers.md](registers.md), "Window and
rotating-base units") or what a later `setwd` adds, holds an **empty**
value on all three machines: 0 with tag 5 (tag 1 on both words) on the
8C2 and the 2C3, and on the 4C whatever an earlier frame left there with
bit 30 of each word cleared, also with tag 5 (`5555555555555555` comes
back as `1555555515555555`) [hw: `tagempty.c` variants n, o, p]. So when
lcc fills the last slot of such an aggregate with a 32-bit write into a
register the window has just gained, the upper half is empty, and a
callee that spills it with `std` works. That is why lcc `-O2` callers
and Unipro `-O0` callees, which spill incoming argument registers with
`std`, pass every `structs`, `floats` and `layout` test of the compat
suite on the 4C, the 8C2 and the 2C3 (`run.py --pairs lcc:unipro-O0
--remote`; its other failures are Unipro's known ones). A diagnostic
half needs a register that no window has gained since a failed
speculative operation filled it. A caller's `%b[N]` is one: what a
callee leaves in its `%dr2`–`%dr7` is still there when the same frame
calls again, and the next callee inherits it (on v5+ the high half of
such a register likewise: [registers.md](registers.md), "Extended parts
and `long double`"). So a callee that stores such a register without
having written it, as GCC's code does (below), traps on hardware too
[hw: `tools/abi/probes/foldi56_undef.c` s: `spoil_low` leaves diagnostic
values in its `%dr2`–`%dr7`, and `parse`'s plain `std` of the `%r2` it
never wrote is SIGILL; 4C, 8C2]. A register some window gained and
nothing has written since stores without a trap (`foldi56_undef.c` u,
where `main`'s `setwd` gained the `%r2` it hands to `parse`, and q; 4C,
8C2). The globals are another such register. They belong to no window,
so a function finds in `%g16`–`%g31` whatever its caller or an earlier
callee left there, a failed speculative load's `4afafafa4afafafa` (tag
5) included, and a plain `std`, `addd`, `muld` or `cmpedb` of such a
diagnostic one, which the function never wrote, is SIGILL `ILL_ILLOPN`
[hw:
`tools/abi/probes/foldp129_greg.c` a*, c*; 4C, 8C2]. A system call
through entry 3 leaves them empty (0, tag 5), and then nothing traps
(`foldp129_greg.c` y*; [kernel-interface.md](kernel-interface.md),
"System calls"). On the 4C a dynamic program's `_start` finds four
diagnostic ones left by ld.so ([kernel-interface.md](kernel-interface.md),
"Process entry").

MCST's qemu-e2k also fills every register that `setwd` adds with 0, tag
5 (`e2k_greg_make_empty`, `target/e2k/cpu.h:806-817`, written by
`helper_e2k_clear_rf_regs_on_setwd`,
`target/e2k/tcg/translate-misc.c:647-657, 1206-1212`), as the 8C2 and
the 2C3 do. It treats the cleaning as a feature that the
`CU_HW0.rf_clean_dsbl` bit turns off (MCST Linux declares that bit right
after a field marked "since iset v5", kernel
`include/asm/cpu_regs_types.h:886-887`), and `-e2k-opt no-rf-clean`
turns it off too. But qemu cannot store a register that has a tagged
half that is not diagnostic: the store's wide instruction runs again and
again, and no exception is raised [qemu: `tagempty.c` variants g–k and
`foldi56_undef.c` u and q never finish; `-d exec,nochain` shows the
block at the store repeating with TB flags 0x9, slow mode without
exception mode]. qemu translates code in a fast mode; when a run-time
check fails it leaves the block and translates the instruction again, in
a slow mode or an exception mode (TB flags bits 0 and 4,
`target/e2k/cpu.c:89-96`; the exits,
`target/e2k/tcg/translate.c:935-948`). A non-speculative store takes the
unchecked path in every mode but exception mode
(`target/e2k/tcg/translate-mem.c:1450` for `st*`, `:1747` for `staa`),
unless a lower channel of the instruction holds a store, or a
non-speculative load that qemu translates with checks (a fill-MAS
load; an ordinary one takes its own unchecked path and doesn't count,
`:1179-1185`) (`:1430-1448`; other operations don't count, since
`dc->maybe_have_exc` is cleared once the instruction's prechecks are
done, `translate-wi.c:488-499`). That path leaves for slow mode when the
data has a nonzero tag (`translate-mem.c:264-271`), or when the address
lies past the guest area qemu reserves, 1 GiB by default (`:296-304`;
`linux-user/main.c:124-127`). The exit goes to slow mode whatever mode
the block was translated in, so the slow-mode block takes the same path
and leaves again, for ever. The prechecks escalate instead: the operand
precheck goes from fast to slow mode and from slow to exception mode
(`target/e2k/tcg/translate-lookahead.c:1058-1064`), the predicate
precheck from either straight to exception mode (`:907-933`), as does a
fault of an unchecked access (`target/e2k/cpu.c:560-562`). That is why a
diagnostic value stops qemu with "exception handling is unimplemented"
rather than hanging it (`tagtrap.c` variants a, b, f; `foldi56_undef.c`
s) [source: `OpenE2K/qemu-e2k-mcst` 35b8c88ff78]. A store past the
reserved area hangs the same way, where hardware gives SIGSEGV
(`foldi56_undef.c` f).

Aggregates are not the only case. GCC-built code stores registers that
hold no value: a variable set on only some paths and then copied or kept
across a call. `foldi56_undef.c`'s `parse`, bison's copy of a `yylval`
the lexer did not set, keeps it in a `%r2` written on one path only and
stores it with a plain `std`. So under MCST's qemu ordinary GCC-built
programs hang at such stores, which the hardware performs unless an
earlier callee left a diagnostic value in the register (above). The
proof of concept's native `cc1` and glibc tests met it under qemu (its
I56); they were not run on the machines. In the compat suite, every such
aggregate passed from lcc `-O2` to Unipro `-O0` times out under qemu (54
`structs`, 2 `floats` and 2 `layout` tests on v3,
`tools/abi/compat/known.txt`); lcc `-O0` callers and Unipro `-O2`
callees are not affected. `-e2k-opt no-rf-clean` in `run.py --runner`
makes those tests pass, but it helps only code that never reads such a
register non-speculatively: the registers `setwd` adds then keep
whatever an earlier frame left there, diagnostic values included, which
the machines never leave there (`tagempty.c` n–p), and the first plain
read of a diagnostic one stops qemu [qemu: `foldi56_undef.c` u then
stores a stale value, and q stops at the `std` of a gained register that
an earlier callee left diagnostic, which the 4C and 8C2 store emptied].
A register given an empty half explicitly hangs either way (`tagempty.c`
g–i). qemu's `gettagd` of an emptied register returns 1, not the
hardware's 5 (`tagempty.c` variants n–p).

Which operations trap on such a register when its upper half is
diagnostic (a speculative `ldd` from a bad address leaves the whole
register diagnostic, then a 32-bit `adds` writes the low half under
`dbl = 0`), Elbrus 4C. The operation rows come from the
proof-of-concept backend's probe (finding A1), the
copy rows from `tagtrap.c` variants e and f (hw; the 8C2 and 2C3 give
the same):

| Operation reading the register | Result |
|---|---|
| any non-speculative 64-bit read: `addd`, `ord`, `shld`, `cmpedb`, `merged`, `faddd`, `std` | **SIGILL** |
| 32-bit reads: `adds`, `sxt 0x2`, `sxt 0x6`, `cmpesb`, `fadds`, `stw` | no trap, correct result (`adds 0, r` gives `0000000012345678`) |
| `movtd %r, %r` | no trap; the copy carries the tag (a later plain `std` of it traps) |
| `movtd %r, %ctprN` | no trap |
| speculative `addd,sm 0x0, %r, %r'` (lcc's form for 64-bit copies) | no trap, but the **whole result is a diagnostic value**: even the low half is lost (`std,sm` of it stores `4afafafa52345678`, not `…12345678`) |
| speculative `std,sm` of the register itself | no trap; the low half is stored intact (variant d) |

So a value written by 32-bit operations under `dbl = 0` must be read,
copied and spilled at 32 bits (`adds`, `sxt`, `stw`), as lcc does
(`adds 0x0, %r1, %b[1]` for 32-bit copies, `addd,sm` only for 64-bit
values): no 64-bit operation, speculative or not, gives a usable result.
For a GCC port this rules out paradoxical subregs of such values; the
proof-of-concept backend promotes narrow integers to 64 bits with `sxt`
and spills 32-bit values with `stw`.

### Integer promotion (guide 9.5.1, 9.5.2; lcc)

Integer arguments narrower than 64 bits are extended to 64 bits by the
caller: sign extension for signed types, zero extension for unsigned ones
(`_Bool`, `char`, `short`, `int`). lcc's callees nevertheless extend
arguments again before using them as 64-bit values, so they don't depend
on it; Unipro's callees depend on it for `_Bool`, `char` and `short` (not
for `int`). A new compiler should extend in both places: the compat
suite's `ext` unit passes garbage above the value and fails a callee that
trusts the caller. (compat: both compilers extend as callers.) The rule
covers memory slots too: lcc writes a narrow argument in slot 8 and up as
`sxt` and a full 64-bit `std`, not `stb`/`sth`/`stw`. Results take the
same rule, the other way round, and there MCST's assembly does depend on
it ("Results").

## Stack argument area (guide 9.4; lcc, unipro)

- The caller reserves an area at the top of its stack, using `getsp` with a
  negative size, before the call. Its size is `8 × slots` rounded up to 16
  bytes, **including the slots passed in registers** (the guide's
  "reserved area"). Both compilers reserve at least this much for every
  call that passes arguments. A call without arguments reserves nothing
  (lcc: no `getsp`).
- Slot *i* is at offset `8 × i` from the stack pointer (`USD`) at the time
  of the call, which is the callee's stack pointer on entry. The callee
  reads it with `getsp 0`.
- No other stack allocation may happen between filling the area and the
  call.
- lcc reserves one area, at entry, for the function's largest call
  (`getsp` −64 for 8 slots, −80 when another call in the function
  passes 10), and an `alloca` block goes right above it: at the stack
  pointer after the block's own `getsp` plus the area's size [lcc
  1.29.16 and 1.31.05, `-O0` and `-O3`]. GCC does the same under
  `ACCUMULATE_OUTGOING_ARGS` (`STACK_DYNAMIC_OFFSET`,
  `gcc/function.cc:1486-1507`) [source]. So an `alloca` block is an
  8-slot call's slot 8 only while no call in the function has more
  slots. MCST's LibreOffice UNO bridge passes a method's stack
  arguments that way (`callVirtualMethod`, built with `optimize (0)`;
  [source-compat.md](source-compat.md), "Inline assembly"): at `-O2`
  GCC deletes such a block and its `memcpy` as dead stores, which
  `optimize (0)` prevents, while lcc `-O3` keeps them [gcc; hw:
  `tools/abi/probes/folda53_regvar.c` `stack8` and `stack8+10`, lcc on
  the 4C and 8C2, the proof of concept on the 8C2].
- The area belongs to the callee for the duration of the call: it may
  store its register arguments into their slots (Unipro's variadic
  callees and libffi's closures do) and use the area as scratch. A caller
  must not expect its contents to survive the call.

## Variadic functions and calls without a prototype (guide 9.5.1; lcc, unipro, compat, hw)

- For a call to a **variadic** function, the caller stores the **last
  fixed argument and every variadic argument** to its memory slot, and
  also puts the arguments in registers as usual. Fixed arguments before the
  last one need only be in their registers: lcc stores exactly the last
  fixed argument onward; Unipro stores every argument.
- A variadic callee therefore takes fixed arguments other than the last
  from registers (or from the stack for slots 8 and above), and the last
  fixed argument and the variadic ones from memory, as lcc does. A callee
  that read the earlier fixed arguments from memory would read garbage
  when called from lcc. (Unipro's variadic callees store their incoming
  registers to the slots themselves, so they work either way.)
- **The last fixed argument is the last declared parameter.** A hidden
  result pointer (C++ classes that are not trivially copyable, below)
  takes slot 0 and moves every argument up a slot, but it is not a
  declared parameter. For `S f (long a, long b, ...)` lcc's caller stores
  slot 2 (`b`) and the variadic slots, but not slots 0 and 1, and its
  callee reads `b` from slot 2 of memory; for `S g (int n, ...)` the
  caller stores from slot 1. A member function's `this` follows the
  pointer, so `S X::m (int n, ...)` stores from slot 2. With no declared
  parameter (C++ `S h (...)`, `long k (...)`) the caller stores every
  slot, the hidden pointer's slot 0 included [lcc: l++ 1.29.16 and
  1.31.05 `-O3`, v3; compat-style run: `tools/abi/probes/pocabi1_va.cc`,
  every pair of lcc `-O3`, lcc `-O0` and Unipro callers and callees,
  under MCST's qemu and on the 4C: all right]. A caller that leaves the
  last fixed argument's slot unwritten makes lcc's callees (`-O3` and
  `-O0`) read whatever the slot held, while Unipro's callees read the
  register (`pocabi1_va.cc -DGARBAGE`, its control line). Found by the
  proof-of-concept back end, whose callers counted the declared
  parameters without the pointer (finding A24).
- `va_list` is `char *`, a plain pointer to the next slot (lcc's
  `__builtin_va_list`: `__builtin_types_compatible_p (va_list, char *)` is
  1, with `void *` or `signed char *` 0); `va_start(ap, last)` sets it to
  the slot after `last`. It can be passed to a function built by another
  compiler (compat: `valist` unit). In C++ the type is part of the mangled
  name: lcc's `long sum (int, va_list)` is `_Z3sumiPc`, `va_list *` is
  `PPc`, and `std::va_list` and `const va_list` are `Pc` too. Unipro's
  clang uses `void *` (`_Z3sumiPv`; in C `va_list` is compatible with
  `void *`), so a C++ function with a `va_list` parameter doesn't link
  between the two (`undefined reference to sum(int, char*)`) [lcc
  1.29.16 v3 and v6.2c3, 1.31.05 v3; Unipro 20.1.8 `-march=elbrus-v3`:
  `tools/abi/probes/pocabi1_valist.cc`, linked both ways and run under
  MCST's qemu; found by the proof-of-concept back end,
  finding A27].
- `va_arg` of any type larger than 8 bytes (`__int128`, `long double`,
  `__float128`, `_Complex double`, aggregates of any size; checked with a
  24-byte struct) first rounds the pointer up to a 16-byte **address**
  (lcc: `ap + (ap & 15)`). For a normal call the slot area is
  16-byte aligned, so this is the same as "start at an even slot", and
  callers place such values there. It differs for `static` variadic
  functions: at `-O1` and above lcc gives them a private calling sequence
  whose slot area is only 8-byte aligned, and puts a 16-byte value at the
  next 16-byte address, which may be an odd slot. A `va_list` from such a
  function that reaches code built by another compiler (for example
  `vprintf`) is read correctly only if `va_arg` aligns by address.
- Unipro's `va_arg(ap, __int128)` doesn't align at all, so it reads one
  slot early at odd slots, and for a `va_list` from an lcc `static`
  variadic function also at even slots; its callers place the value
  correctly (compat). `long double`, `__float128` and `_Complex double`
  are read correctly.
- A call **without a prototype** must place the arguments both in registers
  and in memory, so that it works whether the callee is variadic or not.
  lcc does this; **Unipro's clang does not** (registers only), so such calls
  from Unipro code into lcc-compiled variadic functions are broken.

## Results (guide 9.5.2; gdb, lcc, unipro, libffi)

- Results of **up to 64 bytes** are returned in the callee's `%dr0`…`%dr7`
  (the caller's `%db[0]`…), packed into slots as for arguments. Examples:
  `struct { long a[8]; }` uses `%dr0`–`%dr7`; a 3-byte struct, `struct
  { float a, b; }` and `_Complex float` use `%dr0`; `__int128`,
  `__float128` and `_Complex double` use `%dr0`/`%dr1`; `_Complex long
  double` (32 bytes) uses `%dr0`–`%dr3` (libffi, checked against lcc).
- `long double`: mantissa in `%dr0`, exponent in `%r1`.
- Results **larger than 64 bytes** are written by the callee to memory at its
  entry stack pointer, i.e. into the caller's argument area. The caller
  must reserve an area of at least the result size. There is no hidden
  pointer argument (except for the C++ classes below). The result area overlaps the arguments passed in
  memory, so the callee must finish reading them before it writes the
  result (libffi's closures build the result in a separate buffer and
  copy it last, `src/e2k/ffi.c`).
- Integer results narrower than 64 bits are extended to 64 bits by the
  callee (guide; compat: lcc and Unipro extend `_Bool`, `char`, `short`
  and `int` results). lcc's callers extend them again, from the type's
  own width, before using them as 64-bit values: `sxt 2` after a call
  returning `int`, `6` for `unsigned`, `1` for `short`, `4` for
  `unsigned char` [lcc 1.29.16 v3, v5.8c2 and v6.2c3, 1.31.05 v3; hw:
  `tools/abi/probes/folda44_retext.c` with `folda44_retext.s`, 4C,
  8C2]. MCST's assembly depends on it. glibc's `clone.S` (:84, :93),
  `clone2.S` (:91, :100) and `longjmp.S` (:63, `setjmp`'s second
  return) return their `int` with `adds 0x0, …, %r0` under `setwd wsz =
  0x8`, whose `dbl` is 0, so `%r0`'s upper half keeps what was there:
  for `clone`, the `fn` pointer [glibc; [registers.md](registers.md),
  `dbl`]. A caller that trusts the callee gets that half: `(long)
  child_pid` was 0x456500002130 for PID 0x2130 (the proof-of-concept
  back end's finding A44). So a new compiler's callers must extend
  narrow results again, as lcc's do, and its callees extend them too.
  Unipro's callers extend from 32 bits only (`sxt 2` for `short`, `6`
  for `unsigned char`), which is right for MCST's `int` returns but not
  for a `short` or `char` result with garbage above it [unipro; hw:
  `folda44_retext.c`].

## C++ classes that are not trivially copyable (lcc: l++ 1.29.16 `-O1`)

A class that is "non-trivial for the purposes of calls" in the Itanium
C++ ABI (a non-trivial copy or move constructor, or a non-trivial
destructor; GCC's `TREE_ADDRESSABLE`) can't be passed or returned in
registers, because it must stay at one address:

- **Result**: returned through a **hidden pointer in argument slot 0**,
  whatever its size (24 bytes and 128 bytes probed). The caller passes
  the address of the object to build in `%db[0]` and the real arguments
  move up one slot (`S mk3 (long, long)`: the callee gets the address in
  `%r0` and the arguments in `%r1`, `%r2`); the callee constructs the
  object there. The caller uses its own copy of the address afterwards,
  not `%dr0`. A class with only a non-trivial destructor counts too.
  In a member function the pointer comes first and `this` second: for
  `S X::m (long a)` the callee gets the address in `%r0`, `this` in `%r1`
  and `a` in `%r2` [lcc: l++ 1.29.16 `-O3`;
  `tools/abi/probes/pocabi1_va.cc` for the variadic form]. GCC orders
  them the same way: it puts `.result_ptr` before `this` in the parameter
  list (function.cc:2474-2496). In a variadic call the pointer counts as
  a slot but not as the last fixed argument ("Variadic functions",
  above).
- **Argument**: passed by invisible reference: the caller makes a
  temporary and passes its address in the argument's own slot
  (`take (long, S, long)`: `%r1` points to the copy). This part comes
  from GCC's C++ front end.

Trivially copyable classes follow the C rules above. The C rule applied
to these classes breaks objects that point into themselves
(`std::string`'s short-string buffer): the proof-of-concept backend's
`to_string` returned a string with a null `c_str ()` until it used the
hidden pointer (finding A9).

The compat suite's `cxxclass` unit checks both rules across compilers
(lcc and Unipro, under qemu and on the 4C): classes with a user copy
constructor (8–128 bytes), only a non-trivial destructor, a pointer into
themselves, move-only, polymorphic, and `std::string`, as results (also
with stack arguments and from member functions, the callee building the
object at the caller's address) and as arguments (in a register slot,
on the stack, two at once, each destroyed once by the caller), with
trivially copyable controls.

## C++ ABI beyond calls (lcc: l++ 1.29.16 and 1.31.05; gcc; hw)

l++ follows the Itanium C++ ABI in its generic form [lcc:
`tools/abi/probes/memorycxx_abi.cc` read with `-S` and `nm`, l++
1.29.16 and 1.31.05 for v3 giving the same names and code; across
compilers: `tools/abi/probes/memorycxx_abi_x.cc`, l++ and the
proof-of-concept GCC as either side, 0 failures under MCST's qemu and
on the 4C, 8C2 and 2C3]. The proof-of-concept GCC gives the same names
as l++ for every type l++ accepts, and the same layouts [gcc].

| Item | Rule |
|---|---|
| E2K's types in mangled names | `long double` `e`; **`__float80` is `long double`**, one type (`f (long double)` and `f (__float80)` is a redefinition, error #247; in C `__builtin_types_compatible_p (__float80, long double)` is 1); `__float128` `g`; `__int128` `n`, `unsigned __int128` `o`; `_Complex float`, `double`, `long double` `Cf`, `Cd`, `Ce`; GNU vectors `Dv<N>_<element>`, N the element count (`Dv2_d`, `Dv4_d` for 32 bytes, `Dv16_h`, `Dv8_c`, `Dv2_f`); `wchar_t` `w`, `char16_t` `Ds`, `char32_t` `Di`, `std::nullptr_t` `Dn`, `std::byte` `St4byte`; `size_t` `m`, `ptrdiff_t` `l`; `va_list` `Pc` ("Variadic functions", above) |
| Types lcc lacks | no `_FloatN` or `_FloatNx` types (lcc-doc: `builtin_gnu.html`; lcc: undeclared identifiers), so lcc fixes no names for them; x86 GCC mangles `_Float128` `DF128_` and `_Float64x` `DF64x` [source: GCC `ix86_mangle_type`, i386.cc:25821-25830]. `_Complex __float128` and `__complex__ __float80` are errors in l++ (#1043); GCC doesn't take them as types either: it reads `__float128` or `__float80` after `_Complex` as the declarator's name (a syntax error with a named parameter; an unnamed one becomes `_Complex double`) [gcc: host g++ 16.2 and the proof of concept] |
| Typeinfo | lcc's `libstdc++.so.6.0.29` (GCC 11's) exports `_ZTIe@@CXXABI_1.3`, `_ZTIg@@CXXABI_FLOAT128`, `_ZTIn` and `_ZTIo@@CXXABI_1.3.5` and their pointer forms (`P`, `PK`), and nothing for `_FloatN` (no `_ZTIDF*`); a compatible libstdc++ must export these versions. Vector typeinfo (`_ZTIDv4_i`) is emitted as COMDAT where it is used |
| Pointer to data member | 8 bytes: the member's offset; null is −1 |
| Pointer to member function | 16 bytes, aligned 8, `{ptr, adj}`: `ptr` is the function's address, or for a virtual function 1 + the byte offset of its vtable slot (`B::v1` at slot 0 is 1, `B::v2` 9); `adj` is the `this` adjustment in bytes, not doubled (`D::v1` through a second base at offset 16 is `{1, 16}`); null has `ptr` 0. A call tests `ptr & 1`, reads the vtable at `this + adj` and the function at vtable + `ptr` − 1. GCC's default keeps the virtual bit in `ptr` when functions are 2-byte aligned (`ptrmemfunc_vbit_in_pfn`) [source: GCC defaults.h:894-898] |
| Guard variables | 8 bytes; the inline test reads byte 0 (`ldb`) and uses it in a compare (the acquire of [atomics.md](atomics.md)) before calling `__cxa_guard_acquire`, then `__cxa_guard_release`, or `__cxa_guard_abort` from the landing pad when the initialiser throws. A `thread_local` with a dynamic initialiser has a 1-byte TLS flag, an init function `_ZTH<name>` and a weak wrapper `_ZTW<name>`; other files reference `_ZTH<name>` weakly |
| Array cookies | `new T[n]` for a `T` with a non-trivial destructor allocates a cookie of max (8, `alignof (T)`) bytes and stores the count in the 8 bytes right before the array (`alignas (64)`: the count at +0x38, the array at +0x40); none for a trivially destructible `T`. l++ calls `__cxa_vec_new (n, size, cookie, ctor, dtor)` and `__cxa_vec_delete3` with the sized `operator delete[] (void *, size_t)`; for an over-aligned `T` it calls `operator new[] (size_t, align_val_t)`, `__cxa_vec_ctor`, `__cxa_vec_dtor` and `operator delete[] (void *, size_t, align_val_t)`. GCC builds the same layout inline. `__STDCPP_DEFAULT_NEW_ALIGNMENT__` is 16 |
| Constructors, destructors, vtables | constructors and destructors return nothing (`this` is not returned, unlike ARM's ABI); l++ makes C2 an alias of C1 (`_ZN1KC2El = _ZN1KC1El`) and D2 of D1; the vtable pointer points 16 bytes into the vtable; non-virtual thunks are `_ZThn16_…`; the key-function rule holds (a class whose first non-inline virtual function is defined elsewhere only references its vtable) |
| Static initialisation | `__cxa_atexit` with `__dso_handle` for static destructors. l++ puts one `__sti__<file>` function per file in `.ctors`, which MCST's ld places into `.init_array` (binutils `ld/scripttempl/elf.sc:257-279`), so l++'s and GCC's static constructors run in link order whichever compiler built each file [qemu: five link orders] |
| Visibility of template instantiations | l++ gives an instantiation the template's own visibility, whatever its arguments': under `-fvisibility=hidden`, or with the arguments marked hidden, `holder<Hidden>::get ()` and `singleton<T, Policy>::instance ()` with a hidden `Policy` are `WEAK DEFAULT` when the templates are visible (the hidden classes' own members stay hidden) [lcc: l++ 1.29.16 and 1.31.05; `tools/abi/probes/folda57_tmplvis.cc`]. GCC limits an instantiation to its arguments' visibility: by type arguments since 4.2 (`constrain_visibility_for_template`, PR c++/26905), by template template and pointer-to-member arguments since 14 (GCC commit `7226f825db0`, PR c++/70413) [source; gcc: GCC 11.3.0 hides `holder<Hidden>::get ()` only, 16.2.1 and the proof of concept both]. So a library GCC builds with `-fvisibility=hidden` can export fewer instantiations than lcc's build of the same source, and a program that takes one from the library doesn't link against GCC's build (mapnik 3.1.0's `singleton<datasource_cache, CreateStatic>::instance ()`). It is GCC's front-end rule on every target, so a port keeps it; such a library gives the arguments default visibility |

**COMDAT groups of guard variables** [lcc: 1.29.16, 1.31.05; gcc; hw:
4C, 8C2, 2C3 and MCST's qemu]: l++ puts the guard of an inline
function's static, or of a template's static data member, in the
**variable's** COMDAT group (`_ZZ…`, `_ZN…`; the guard follows the
object in its section), as the Itanium C++ ABI suggests. GCC gives the
guard a group of its own (`copy_linkage`, `cp/decl2.cc:4052-4064`)
[source: GCC], which the ABI also allows, provided the guard is weak
[source: Itanium C++ ABI 5.2.2]. Both compilers make the guard
`STB_GNU_UNIQUE` instead, so linking an l++ object before a GCC object
that defines the same guarded static into one executable or library
fails ("multiple definition of `guard variable for …`"): the linker
keeps l++'s group, which holds both symbols, drops GCC's group of the
variable, and then meets GCC's guard again in its own group (inferred
from the groups). The reverse order links and runs. Both orders link
and run when the GCC side is built with `-fno-gnu-unique` (its guard
and variable are then weak). Unipro's clang also uses a separate group,
with a weak guard; its object links with l++'s in both orders and the
static is initialised once [unipro: assembly read, then assembled with
MCST gas, linked with an l++ object and run under MCST's qemu]. GCC has
no target hook for the guard's group (the `TARGET_CXX_*` hooks in
`target.def`) [source: GCC];
[gcc-port-plan.md](../../doc/gcc-port-plan.md), D10, has what a port
can do. The other grouping differences involve only weak symbols and
link in both orders: l++ puts D0 in a group of its own and D1 + D2 in
one where GCC uses one `D5` group, and l++ puts a thunk in its own
group where GCC puts it in the function's.
