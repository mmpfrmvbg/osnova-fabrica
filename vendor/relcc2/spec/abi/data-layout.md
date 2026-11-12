# Data layout

Little-endian. Checked by `tools/abi/probes/layout.c` (lcc, unipro).

## Scalar types

| Type | Size | Alignment | Register | Notes |
|---|---|---|---|---|
| `_Bool` | 1 | 1 | `%r` | |
| `char` | 1 | 1 | `%r` | **signed** |
| `short` | 2 | 2 | `%r` | |
| `int`, `enum` | 4 | 4 | `%r` | |
| `long`, `long long` | 8 | 8 | `%dr` | |
| `__int128` | 16 | 16 | `%qr` / two `%dr` | |
| pointers | 8 | 8 | `%dr` | |
| `float` | 4 | 4 | `%r` | IEEE single |
| `double` | 8 | 8 | `%dr` | IEEE double |
| `long double`, `__float80` | 16 | 16 | `%xr` | 80-bit x87 extended in the low 10 bytes (mantissa, then sign and exponent); stores write only those 10 bytes, so bytes 10–15 are undefined (hw); for MCST's gdb, debug information can describe one in registers only as a register pair given in pieces ([registers.md](registers.md), "How MCST's gdb reads them"); `__float80` is the same type as `long double` (lcc: C and C++) |
| `__float128` | 16 | 16 | `%qr` / two `%dr` | IEEE quad; arithmetic is in libgcc (`__multf3`, …) |
| `_Complex float` | 8 | 4 | | |
| `_Complex double` | 16 | 8 | | |
| `size_t` | 8 | 8 | | unsigned long |
| `wchar_t` | 4 | 4 | | signed int |
| `max_align_t` | 32 | 16 | | |
| GNU vectors, `__attribute__ ((vector_size (N)))` | N | N (any power-of-two N up to 2^31 bytes; `_Alignof` says N too) | | |
| C++ pointer to data member | 8 | 8 | | the offset; null is −1 |
| C++ pointer to member function | 16 | 8 | | Itanium's `{ptr, adj}` ([calling-convention.md](calling-convention.md), "C++ ABI beyond calls") |

Sources: guide 9.2 for sizes and register formats; gdb sets
`long double` to the i387 extended format in 128 bits and recognises
`__float128`/`_Float128` as IEEE quad. The vectors, the member pointers
and `__float80` [lcc: 1.29.16 for v3, v5.8c2 and v6.2c3, and 1.31.05;
`tools/abi/probes/memorycxx_abi.cc` for the member pointers].

`__attribute__ ((aligned))` without a value means 16, and lcc defines
no `__BIGGEST_ALIGNMENT__` [lcc: 1.29.16, 1.31.05]. A vector of N
bytes is aligned to N, also beyond 16 (`struct { char c; v32 v; }` puts
`v` at 32), and lcc's `_Alignof` and `alignof` say N. GCC with
`BIGGEST_ALIGNMENT` 128 lays such vectors out as lcc does but answers
16 to C11 `_Alignof` and C++ `alignof` for vectors of 32 bytes or more
and for a structure holding one, because `min_align_of_type` caps the
answer at `BIGGEST_ALIGNMENT` (`stor-layout.cc:2821-2837`) [source:
GCC; gcc]; its `__alignof__` says N. Unipro's clang answers N
[unipro]. lcc accepts any power-of-two number of elements, from a
1-byte `char` vector up to N = 2^31 bytes, and aligns every such vector
to N, as a member and as an object; 2^32 bytes is "vector size is too
large" [lcc: 1.29.16 and 1.31.05, v3 and v5.8c2;
`tools/abi/probes/folda35_vec.c`]. GCC aligns vectors to N only up to
ELF's `MAX_OFILE_ALIGNMENT`, 2^28 bytes (`default_vector_alignment`,
`targhooks.cc:1540-1549`), and refuses 2^31 − 1 components or more
(`c-attribs.cc:4375`), so the two lay such vectors out differently only
from 2^29 bytes [source: GCC; gcc].

## Aggregates (guide 9.2.4)

Standard rules: an aggregate is aligned to its most strictly aligned
member, members are placed at the lowest offset that satisfies their
alignment, and the size is padded to a multiple of the alignment.

## Bit-fields (guide 9.2.4.4)

- Allocated from the least significant bit of their container upwards.
- The container has the alignment of the declared type and may also hold
  other members.
- A field that doesn't fit in the remaining bits of its container starts a
  new container at the next suitably aligned offset.
- Unnamed bit-fields don't affect the aggregate's alignment. An unnamed
  zero-width bit-field aligns the next member to its declared type.

This matches the common System V rules (as on x86-64). It is layout
only: the type a field of 33–63 bits has in an expression differs
between lcc and GCC's C ([source-compat.md](source-compat.md),
"Bit-fields wider than `int`").

## Global and dynamic data (guide 9.1.4)

Recommended alignment of variables, for speed rather than correctness:

| Size | Alignment |
|---|---|
| 1 | 1 |
| 2 | 2 |
| 3–4 | 4 |
| 5–8 | 8 |
| 9 or more | 16 |

`malloc` results and stack allocations are 16-byte aligned.
