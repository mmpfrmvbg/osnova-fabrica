# Operations added in v7

What `elbrus-v7` (in development, not produced yet) adds to
[operations-v6.md](operations-v6.md). **Generated** by
`tools/isa-extract/gen_operations.py` from `operations-v7.yaml`.

Binutils knows these operations (names, channels, operand formats);
the community qemu implements only the four `qpack*` ones, and nobody
can run them yet. The columns are those of
[operations-v3.md](operations-v3.md).

## Packed

| Operations | ISA | ALC | Does | Lat | lcc v3 / v5 | Run on hardware |
|---|---|---|---|---|---|---|
| `qpackhbss`, `qpackhbus`, `qpackwhss`, `qpackwhus` | 7–8 | 0,1,3,4 | Narrowing packs; the community qemu implements them with the v5 `qpack*` helpers (a's lanes in the high 64 bits). |  |  | v7: no hardware |
| `qppermb_lt3`, `qpinss_lt3`, `qpinsd_lt3`, `qplog_0x00_lt3`, `qplog_0x01_lt3`, `qplog_0x02_lt3`, … (259 operations) | 7 | 0–5 | v7 encodings with the table or selector in a literal (binutils); not implemented in qemu. |  |  | v7; no open source |
| `qpcm2b`, `qpcm2h`, `qpcm2w`, `qpcm2d`, `qps2cmh`, `qps2cmw`, … (38 operations) | 7–8 | 0–5 | Operations no open source implements: dot products (`qpidot*`, `qpbfdots`), bfloat16 conversion (`qpfstobf`), AES (`qpaes*`) and Kuznyechik/Streebog (`qpkuz*`, `qpsbgltr*`, `qpmgme`) rounds, table lookups (`qptbl_*`), masks (`qpcm2*`, `qps2*`). Only names and operand formats (binutils) are known. |  |  | v7; no open source |

## Memory, protected mode and state

| Operations | ISA | ALC | Does | Lat | lcc v3 / v5 | Run on hardware |
|---|---|---|---|---|---|---|
| `ldosrrd`, `ldosrrqp`, `stosrrd`, `stosrrqp` | 7–8 | 0,2,3,5 | v7 accesses, no open implementation. |  |  | v7; no open source |
| `apincr`, `apincrc`, `cudincr`, `gdincr`, `getind`, `getmi`, `getptr`, `getptrc`, `getspd`, `subarr`, `subarrc`, `vfsid` | 7–8 | 0,1,3,4 | v7 pointer and array operations of protected mode; no open implementation. |  |  | v7; no open source |
| `rrshd`, `rwshd` | 7–8 | 0 | v7 state accesses (binutils); not implemented in qemu. |  |  | v7; no open source |

## Control

| Operations | ISA | ALC | Does | Lat | lcc v3 / v5 | Run on hardware |
|---|---|---|---|---|---|---|
| `ctp_call`, `dtbp` | 7 |  | Call through a prepared CTPR, and `dtbp` (binutils). |  |  | v7; source only |

