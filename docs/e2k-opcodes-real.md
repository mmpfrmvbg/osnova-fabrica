<!-- doc-status: active; source: src/e2k/encoding.ts -->
# Реальные опкоды e2k: извлечение из открытых источников

**Дата:** 2026-09-15
**Статус:** извлечение подмножества DSP (`docs/e2k-subset-dsp.md`) из таблицы опкодов МЦСТ.
**Источник сырых данных:** `docs/e2k-sources-raw.md`; копии — в `.tmp/e2k-sources/` (не коммитятся).
**Чем проверяется:** `src/scripts/e2kOpcodesReal.audit.test.ts` — заново разбирает
`opcodes/e2k-opc.h` и сверяет **каждую** строку приложения А (имя, строку, код операции, формат).

**Правило:** каждая строка либо называет мнемонику с источником вида `файл:строка`, либо
помечена «НЕТ В ИСТОЧНИКЕ». Мнемоники скопированы из источника посимвольно — в том регистре,
в котором они записаны в таблице МЦСТ (в руководстве МЦСТ они записаны в верхнем).

**Чего здесь нет:** кодировки, которой нет в источнике. Ни одна мнемоника не «достроена» по
смыслу: если семейство в руководстве названо со звёздочкой, в таблице перечислены **варианты,
которые есть в источнике**, а не те, которые могли бы быть.

## 0. Что найдено и чего нет — коротко

**Найдено в таблице опкодов МЦСТ (`opcodes/e2k-opc.h`):** все семейства целочисленного ядра
(`adds`/`addd`, `subs`/`subd`, `ands`, `ors`, `xors`, `andns`, `orns`, `xorns`, `merges`,
`incs*`/`decs*`, `muls`/`muld`, `umulx`, `smulx`, `umulhd`, `smulhd`, `sxt`, `movts`/`movtd`/
`movtq`, `lzcnt*`, `popcnt*`, `bitrev*`), упакованные целочисленные (`padd*`, `psub*`, `pmin*`,
`pmax*`, `pavg*`, `pcmp*`, `pand*`, `por*`, `pxor*`, `psign*`, `psr*`, `psl*`, `pshuf*`,
`punpck*`, `pack*`, `pmov*`, `pextrh`, `pinsh`, `pmerge`, `phadd*`, `phsub*`, `pmulhh`, `pmullh`,
`pmulubhh`, `pmaddh`, `pmaddubsh`, `pmulhrsh`, `psadbw`, `mpsadbh`, `phminposuh`), упакованная
вещественная (`pfadds`…`pfaddsub_addsubs`, `pfcmp*`, `pfmin*`, `pfmax*`), сдвиги
(`shls`/`shld`, `shrs`/`shrd`, `sars`/`sard`, `scls`/`scld`, `scrs`/`scrd`), память
(`ldb`/`ldh`/`ldw`/`ldd`, `stb`/`sth`/`stw`/`std`), сравнения (`cmp*s`, `cmpand*`, `fcmp*`),
`staa*`.

**Найдено ВНЕ таблицы опкодов** (не «нет в источнике» — есть, но в другом слоге):

| что | где | источник |
|---|---|---|
| `MOVAB`…`MOVAQ` | слог AAS | `gas/config/tc-e2k.c:4635`, `:4657` |
| `ct`, `ct(cond)` | SS-слог (SF1) | `elbrus-docs README.md:225-227`, `:249-278` |
| `call`, `return` | управляющий слог CS | `opcodes/e2k-dis.c:1895` |
| `abn` | биты `abnf`/`abnt` SS-слога | `elbrus-docs README.md:214-215` |
| `%lsr` | регистр, не инструкция | руководство МЦСТ, стр. 162 |

**НЕТ В ИСТОЧНИКЕ:** ничего из подмножества DSP не осталось без источника — каждая форма либо
в таблице опкодов, либо в другом слоге, и это записано в §2 и §3. Это результат извлечения, а
не ожидание: проверялись четыре источника (`docs/e2k-sources-raw.md`).

**Чего извлечение не доказывает:** что наши байты примет MCST-objdump или QEMU — компилятора C
в окружении нет (`docs/e2k-qemu-build.md` §2). Совпадение **четырёх независимых описаний**
считается свидетельством, но не замером.

## 1. Легенда форматов (Alopf)

| формат | раскладка полей | пример из источника |
|---|---|---|
| ALF (слог ALS) | спекулятивный бит 31, код операции 30:24 | `qemu/target/e2k/syllab-format.h:32-34`; `opcodes/e2k-dis.c:828`; `E2KInstrFormats.td:475`; `elbrus-docs README.md:284-285` |
| ALOPF1 | ALF1: src1[23:16], src2[15:8], dst[7:0] | `adds` — `opcodes/e2k-opc.h:19` |
| ALOPF2 | ALF2: opce[23:16], src2[15:8], dst[7:0] | `fxsqrtisx` — `opcodes/e2k-opc.h:624` |
| ALOPF3 | ALF3: src1[23:16], src2[15:8], src3[7:0] | `stcsb` — `opcodes/e2k-opc.h:849` |
| ALOPF7 | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `cmposb` — `opcodes/e2k-opc.h:989` |
| ALOPF8 | ALF8: opce[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `cctopo` — `opcodes/e2k-opc.h:1309` |
| ALOPF10 | ALF10: src3[7:0], opce1[23:8] | `staab` — `opcodes/e2k-opc.h:1349` |
| ALOPF11 | ALS + ALEF2: opce[7:0], opc2[15:8] | `muls` — `opcodes/e2k-opc.h:1434` |
| ALOPF11_MERGE | ALS + ALEF2 (merge) | `pmrgp` — `opcodes/e2k-opc.h:4599` |
| ALOPF11_LIT8 | ALS + ALEF2 + lit8 в opce | `pextrh` — `opcodes/e2k-opc.h:1759` |
| ALOPF12 | ALF12: src2[15:8], dst[7:0] | `frcps` — `opcodes/e2k-opc.h:2449` |
| ALOPF12_PSHUFH | ALF12 + lit8 в ALES.opce | `pshufh` — `opcodes/e2k-opc.h:2509` |
| ALOPF13 | ALF13: src1[23:16], src2[15:8], src3[7:0] | `stcsq` — `opcodes/e2k-opc.h:2514` |
| ALOPF15 | ALF15: opce[23:16], src2[15:8], dst[7:0] (регистр состояния) | `rws` — `opcodes/e2k-opc.h:2679` |
| ALOPF16 | ALF16: opce[23:16], src2[15:8], dst[7:0] (из регистра состояния) | `rrs` — `opcodes/e2k-opc.h:2694` |
| ALOPF17 | ALF17: src1[23:16], src2[15:8], dst[7:0] (упакованные предикаты) | `pcmpeqbop` — `opcodes/e2k-opc.h:4419` |
| ALOPF19 | ALF19: src1[23:16], src2[15:8], dst[7:0] (предикаты) | `ldaab` — `opcodes/e2k-opc.h:1394` |
| ALOPF21 | ALS + ALEF1: src3[7:0], opc2[15:8] | `incs_fb` — `opcodes/e2k-opc.h:2709` |
| MERGE | короткая форма ALOPF1 (e2k-dis.c:846-849) | `merges` — `opcodes/e2k-opc.h:204` |

**ALES (полуслог)**: `opc2[15:8]`, `opce[7:0]` — `qemu/target/e2k/syllab-format.h:85-91`;
значения: `EXT = 0x1` (`include/opcode/e2k.h:68`), `NONE = 0xc0` (`include/opcode/e2k.h:93`),
`E2K_ALEF_OPC2_EXT = 0x01` (`qemu/target/e2k/opcode-tables.h:15`), `E2K_ALF_OPCE_NONE = 0xc0`
(`qemu/target/e2k/opcode-tables.h:41`).

**Соответствие «Alopf → раскладка» взято из кода сопоставления в дизассемблере**
(`opcodes/e2k-dis.c:846-1010`: ALOPF2 сверяет биты 23:16, ALOPF7 — биты 7:5, ALOPF11 —
полуслог ALES) и из `qemu/target/e2k/syllab-format.h` (имена полей ALF1…ALF10, ALEF1/ALEF2).

## 2. Соответствие «подмножество DSP ↔ источник»

Формат строки: **форма из спецификации** · **мнемоники в источнике с форматом, кодом операции
и строкой** · **примечание**.

**Сокращение:** во всех таблицах §2 источник — `opcodes/e2k-opc.h`, поэтому он не повторяется;
`:NNN` означает строку этого файла. Исключение — примечания «вне таблицы опкодов»: там файл
назван целиком.

### §2.1 Целочисленное ядро

| форма | мнемоники в источнике | примечание |
|---|---|---|
| ADDs/d | `addd` (ALOPF1, `0x11`, :24); `adds` (ALOPF1, `0x10`, :19) |  |
| ADD (комбинированная форма) | `add_addd` (ALOPF21, `0x11`, :6634); `add_adds` (ALOPF21, `0x10`, :6629); `and_addd` (ALOPF21, `0x1`, :6564); `and_adds` (ALOPF21, `0x0`, :6559); `merge_addd` (ALOPF21_MERGE, `0xf`, :6624); `merge_adds` (ALOPF21_MERGE, `0xe`, :6619); … всего 22 |  |
| SUBs/d, SUB | `subd` (ALOPF1, `0x13`, :34); `subs` (ALOPF1, `0x12`, :29) |  |
| AND, OR, XOR | `andd` (ALOPF1, `0x1`, :84); `ands` (ALOPF1, `0x0`, :79); `ord` (ALOPF1, `0x5`, :104); `ors` (ALOPF1, `0x4`, :99); `xord` (ALOPF1, `0x9`, :124); `xors` (ALOPF1, `0x8`, :119) |  |
| ANDN, ORN, XORN | `andnd` (ALOPF1, `0x3`, :94); `andns` (ALOPF1, `0x2`, :89); `ornd` (ALOPF1, `0x7`, :114); `orns` (ALOPF1, `0x6`, :109); `xornd` (ALOPF1, `0xb`, :134); `xorns` (ALOPF1, `0xa`, :129) |  |
| MERGE | `merged` (MERGE, `0xf`, :209); `merges` (MERGE, `0xe`, :204) |  |
| INC* | `incd_fd` (ALOPF21, `0x31`, :3374); `incs_fb` (ALOPF21, `0x30`, :2709); `incs_fh` (ALOPF21, `0x30`, :2714); `incs_fw` (ALOPF21, `0x30`, :2719) |  |
| DEC* | `decd_fd` (ALOPF21, `0x33`, :3379); `decs_fb` (ALOPF21, `0x32`, :2724); `decs_fh` (ALOPF21, `0x32`, :2729); `decs_fw` (ALOPF21, `0x32`, :2734) |  |
| MULs/d | `muld` (ALOPF11, `0x21`, :1439); `muls` (ALOPF11, `0x20`, :1434) |  |
| UMULX | `umulx` (ALOPF11, `0x22`, :1444); `umulx_fb` (ALOPF11, `0x22`, :2329); `umulx_fh` (ALOPF11, `0x22`, :2334); `umulx_fw` (ALOPF11, `0x22`, :2339) |  |
| SMULX | `smulx` (ALOPF11, `0x23`, :1449); `smulx_fb` (ALOPF11, `0x23`, :2344); `smulx_fh` (ALOPF11, `0x23`, :2349); `smulx_fw` (ALOPF11, `0x23`, :2354) |  |
| UMULHd | `umulhd` (ALOPF11, `0x70`, :3169) |  |
| SMULHd | `smulhd` (ALOPF11, `0x71`, :3174) |  |
| SXT | `sxt` (ALOPF1, `0xc`, :199) |  |
| MOVTs/d/q | `movtd` (ALOPF2, `0x61`, :664); `movtq` (ALOPF22, `0x57`, :2814); `movts` (ALOPF2, `0x60`, :644) |  |
| LZCNTs/d | `lzcntd` (ALOPF2, `0x65`, :2864); `lzcnts` (ALOPF2, `0x64`, :2859) |  |
| POPCNTs/d | `popcntd` (ALOPF2, `0x67`, :2874); `popcnts` (ALOPF2, `0x66`, :2869) |  |
| BITREVs/d | `bitrevd` (ALOPF2, `0x27`, :2854); `bitrevs` (ALOPF2, `0x26`, :2849) |  |

### §2.2 Упакованные целочисленные

| форма | мнемоники в источнике | примечание |
|---|---|---|
| PADD* | `paddb` (ALOPF11, `0x8`, :1479); `paddd` (ALOPF11, `0xf`, :1494); `paddh` (ALOPF11, `0x9`, :1484); `paddsb` (ALOPF11, `0xa`, :1499); `paddsh` (ALOPF11, `0xb`, :1504); `paddusb` (ALOPF11, `0xc`, :1509); … всего 8 |  |
| PSUB* | `psubb` (ALOPF11, `0x10`, :1519); `psubd` (ALOPF11, `0x17`, :1534); `psubh` (ALOPF11, `0x11`, :1524); `psubsb` (ALOPF11, `0x12`, :1539); `psubsh` (ALOPF11, `0x13`, :1544); `psubusb` (ALOPF11, `0x14`, :1549); … всего 8 |  |
| PMIN* | `pminsb` (ALOPF11, `0x4`, :3234); `pminsh` (ALOPF11, `0x1`, :1569); `pminsw` (ALOPF11, `0x21`, :3184); `pminub` (ALOPF11, `0x0`, :1574); `pminuh` (ALOPF11, `0x5`, :3239); `pminuw` (ALOPF11, `0x20`, :3179) |  |
| PMAX* | `pmaxsb` (ALOPF11, `0x6`, :3244); `pmaxsh` (ALOPF11, `0x3`, :1559); `pmaxsw` (ALOPF11, `0x23`, :3194); `pmaxub` (ALOPF11, `0x2`, :1564); `pmaxuh` (ALOPF11, `0x7`, :3249); `pmaxuw` (ALOPF11, `0x22`, :3189) |  |
| PAVG* | `pavgusb` (ALOPF11, `0x1e`, :1714); `pavgush` (ALOPF11, `0x1f`, :1719) |  |
| PCMP* | `pcmpeqb` (ALOPF11, `0x18`, :2024); `pcmpeqbap` (ALOPF17, `0x28`, :4459); `pcmpeqbop` (ALOPF17, `0x28`, :4419); `pcmpeqd` (ALOPF11, `0x4d`, :3209); `pcmpeqdap` (ALOPF17, `0x28`, :4474); `pcmpeqdop` (ALOPF17, `0x28`, :4434); … всего 24 |  |
| PAND*, POR*, PXOR* | `pandd` (ALOPF11, `0x48`, :1679); `pandnd` (ALOPF11, `0x49`, :1684); `pord` (ALOPF11, `0x4a`, :1689); `pxord` (ALOPF11, `0x4b`, :1694) |  |
| PSIGN* | `psignb` (ALOPF11, `0x30`, :3294); `psignh` (ALOPF11, `0x31`, :3299); `psignw` (ALOPF11, `0x32`, :3304) |  |
| PSR*, PSL* | `pslld` (ALOPF11, `0x4e`, :1604); `psllh` (ALOPF11, `0x15`, :1614); `psllqh` (ALOPF11_LIT8, `0xe`, :1769); `psllql` (ALOPF11_LIT8, `0xf`, :1774); `psllw` (ALOPF11, `0x14`, :1609); `psrah` (ALOPF11, `0x13`, :1639); … всего 14 |  |
| PSHUF* | `pshufb` (ALOPF21, `0x4d`, :8019); `pshufh` (ALOPF12_PSHUFH, `0x17`, :2509); `pshufw` (ALOPF11_LIT8, `0x16`, :2079) |  |
| PUNPCK*, PACK* | `packsshb` (ALOPF11, `0x8`, :2069); `packsswh` (ALOPF11, `0xa`, :2084); `packushb` (ALOPF11, `0x9`, :2074); `packuswh` (ALOPF11, `0x6b`, :3204); `punpckhbh` (ALOPF11, `0x0`, :2089); `punpckhhw` (ALOPF11, `0x2`, :2094); … всего 10 |  |
| PMOV* | `pmovmskb` (ALOPF11, `0xb`, :2054); `pmovmskpd` (ALOPF11, `0x7`, :2064); `pmovmskps` (ALOPF11, `0x6`, :2059) |  |
| PEXTRH | `pextrh` (ALOPF11_LIT8, `0x1e`, :1759) |  |
| PINSH | `pinsh` (ALOPF11_LIT8, `0x1f`, :1764) |  |
| PMERGE | `pmerge` (ALOPF21, `0x6d`, :8024) |  |
| PHADD* | `phaddh` (ALOPF11, `0x29`, :3264); `phaddsh` (ALOPF11, `0x2b`, :3274); `phaddw` (ALOPF11, `0x2a`, :3269) |  |
| PHSUB* | `phsubh` (ALOPF11, `0x2d`, :3279); `phsubsh` (ALOPF11, `0x2f`, :3289); `phsubw` (ALOPF11, `0x2e`, :3284) |  |
| PMULHH, PMULLH, PMULUBHH | `pmulhh` (ALOPF11, `0x18`, :1589); `pmullh` (ALOPF11, `0x19`, :1594); `pmulubhh` (ALOPF11, `0x1d`, :2929) |  |
| PMADDH, PMADDUBSH | `pmaddh` (ALOPF11, `0x1a`, :1599); `pmaddubsh` (ALOPF11, `0x68`, :3309) |  |
| PMULHRSH | `pmulhrsh` (ALOPF11, `0x69`, :3314) |  |
| PSADBW, MPSADBH | `mpsadbh` (ALOPF11, `0x58`, :3199); `psadbw` (ALOPF11, `0x1c`, :1579) |  |
| PHMINPOSUH | `phminposuh` (ALOPF11, `0x6a`, :3319) |  |

### §2.3 Упакованная вещественная

| форма | мнемоники в источнике | примечание |
|---|---|---|
| PFADDs/d, PFSUBs/d, PFMULs/d | `pfaddd` (ALOPF11, `0x31`, :1649); `pfadds` (ALOPF11, `0x30`, :1644); `pfmuld` (ALOPF11, `0x39`, :1474); `pfmuls` (ALOPF11, `0x38`, :1469); `pfsubd` (ALOPF11, `0x33`, :1659); `pfsubs` (ALOPF11, `0x32`, :1654) |  |
| PFMUL_(ADD/SUB/RSUB)(s/d) | `pfmul_addd` (ALOPF21, `0x9`, :7674); `pfmul_adds` (ALOPF21, `0x8`, :7669); `pfmul_rsubd` (ALOPF21, `0x29`, :7994); `pfmul_rsubs` (ALOPF21, `0x28`, :7989); `pfmul_subd` (ALOPF21, `0x29`, :7684); `pfmul_subs` (ALOPF21, `0x28`, :7679) |  |
| PFHADDs, PFHSUBs, PFADDSUBs | `pfaddsubs` (ALOPF11, `0x77`, :3229); `pfhadds` (ALOPF11, `0x72`, :3219); `pfhsubs` (ALOPF11, `0x73`, :3224) |  |
| PFMUL_(HADD/HSUB/ADDSUB)s | `pfmul_addsubs` (ALOPF21, `0x68`, :8064); `pfmul_hadds` (ALOPF21, `0x48`, :7779); `pfmul_hsubs` (ALOPF21, `0x68`, :7809) |  |
| PF(ADD/SUB)_(ADD/SUB/RSUB)(s/d) | `pfadd_addd` (ALOPF21, `0x1`, :7694); `pfadd_adds` (ALOPF21, `0x0`, :7689); `pfadd_rsubd` (ALOPF21, `0x21`, :8004); `pfadd_rsubs` (ALOPF21, `0x20`, :7999); `pfadd_subd` (ALOPF21, `0x21`, :7714); `pfadd_subs` (ALOPF21, `0x20`, :7709); … всего 12 |  |
| PF(HADD/HSUB/ADDSUB)_(HADD/HSUB/ADDSUB)s | `pfaddsub_addsubs` (ALOPF21, `0x6e`, :8069); `pfaddsub_hadds` (ALOPF21, `0x4e`, :7784); `pfaddsub_hsubs` (ALOPF21, `0x6e`, :7814); `pfhadd_addsubs` (ALOPF21, `0x64`, :8054); `pfhadd_hadds` (ALOPF21, `0x44`, :7769); `pfhadd_hsubs` (ALOPF21, `0x64`, :7799); … всего 9 |  |
| PFCMP(s/d) | `pfcmpeqd` (ALOPF11, `0x3b`, :1934); `pfcmpeqs` (ALOPF11, `0x3a`, :1894); `pfcmpled` (ALOPF11, `0x3b`, :1944); `pfcmples` (ALOPF11, `0x3a`, :1904); `pfcmpltd` (ALOPF11, `0x3b`, :1939); `pfcmplts` (ALOPF11, `0x3a`, :1899); … всего 16 |  |
| PFMIN(s/d) | `pfmind` (ALOPF11, `0x35`, :1739); `pfmins` (ALOPF11, `0x34`, :1734) |  |
| PFMAX(s/d) | `pfmaxd` (ALOPF11, `0x37`, :1749); `pfmaxs` (ALOPF11, `0x36`, :1744) |  |

### §2.4 Сдвиги и масштабирование

| форма | мнемоники в источнике | примечание |
|---|---|---|
| SHLs/d, SHL | `shld` (ALOPF1, `0x19`, :144); `shls` (ALOPF1, `0x18`, :139) |  |
| SHRs/d, SHR | `shrd` (ALOPF1, `0x1b`, :154); `shrs` (ALOPF1, `0x1a`, :149) |  |
| SARs/d, SAR | `sard` (ALOPF1, `0x1d`, :184); `sars` (ALOPF1, `0x1c`, :179) |  |
| SCLs/d, SCR | `scld` (ALOPF1, `0x15`, :164); `scls` (ALOPF1, `0x14`, :159); `scrd` (ALOPF1, `0x17`, :174); `scrs` (ALOPF1, `0x16`, :169) |  |
| SHL*, SHR*, SAR*, SCL* (с флагами) | `sard_fd` (ALOPF21, `0x1d`, :3404); `sars_fb` (ALOPF21, `0x1c`, :2799); `sars_fh` (ALOPF21, `0x1c`, :2804); `sars_fw` (ALOPF21, `0x1c`, :2809); `scld_fd` (ALOPF21, `0x15`, :3394); `scls_fb` (ALOPF21, `0x14`, :2769); … всего 16 |  |

### §2.5 Память и адресация

| форма | мнемоники в источнике | примечание |
|---|---|---|
| LDB, LDH, LDW, LDD | `ldb` (ALOPF1, `0x64`, :604); `ldd` (ALOPF1, `0x67`, :619); `ldh` (ALOPF1, `0x65`, :609); `ldw` (ALOPF1, `0x66`, :614) | **реализованы** (07.2026): адрес — **сумма двух регистров** `src1 + src2` (`qemu/target/e2k/tcg/translate-al-c11.c:26-34`); каналы `{1,0,1,1,0,1}` — 0, 2, 3, 5. Измерено: `ldd,0 %b[1], %b[2], %db[3]` → `01 00 00 04 03 02 01 67` |
| STB, STH, STW, STD | `stb` (ALOPF3, `0x24`, :969); `std` (ALOPF3, `0x27`, :984); `sth` (ALOPF3, `0x25`, :974); `stw` (ALOPF3, `0x26`, :979) | **реализованы** (07.2026): раскладка ALF3 — `src3[7:0]`, `src2[15:8]`, `src1[23:16]` (`qemu/target/e2k/syllab-format.h:47-49`), адрес — `src1 + src2`, записывается `src3`; каналы `{0,0,1,0,0,1}` — только 2 и 5. Текст ассемблера идёт **(значение, база, смещение)**, а дизассемблер печатает `(src1, src2, src3)` = (база, смещение, значение) — обе последовательности **измерены** |
| MOVAB, MOVAH, MOVAW, MOVAD, MOVAQ | — | **вне таблицы опкодов**: AAS-слог — `gas/config/tc-e2k.c:4635` (`parse_mova_args`), `:4657` (MOVAQ — пара AAS-слогов) |

### §2.6 Управление и циклы

| форма | мнемоники в источнике | примечание |
|---|---|---|
| CT (передача управления) | — | **вне таблицы опкодов**: SS-слог (SF1), поля `ctop[11:10]`, `ctcond[8:0]` — `elbrus-docs README.md:225-227` |
| ct(cond) | — | **вне таблицы опкодов**: коды условий SS-слога — `elbrus-docs README.md:249-278` |
| call | — | **вне таблицы опкодов**: управляющий слог CS — `opcodes/e2k-dis.c:1895` |
| return | — | **вне таблицы опкодов**: управляющий слог CS — `opcodes/e2k-dis.c:1895` |
| abn (начало массива) | — | **вне таблицы опкодов**: биты `abnf`/`abnt` SS-слога SF1 — `elbrus-docs README.md:214-215` |
| CMPs/d | `cmpbdb` (ALOPF7, `0x21`, :1034); `cmpbedb` (ALOPF7, `0x21`, :1044); `cmpbesb` (ALOPF7, `0x20`, :1004); `cmpbsb` (ALOPF7, `0x20`, :994); `cmpedb` (ALOPF7, `0x21`, :1039); `cmpesb` (ALOPF7, `0x20`, :999); … всего 16 |  |
| CMPANDs/d | `cmpandedb` (ALOPF7, `0x23`, :1089); `cmpandesb` (ALOPF7, `0x22`, :1069); `cmpandledb` (ALOPF7, `0x23`, :1104); `cmpandlesb` (ALOPF7, `0x22`, :1084); `cmpandpdb` (ALOPF7, `0x23`, :1099); `cmpandpsb` (ALOPF7, `0x22`, :1079); … всего 8 |  |
| FCMPs/d | `fcmpeqd` (ALOPF11, `0x2d`, :1854); `fcmpeqs` (ALOPF11, `0x2c`, :1814); `fcmpled` (ALOPF11, `0x2d`, :1864); `fcmples` (ALOPF11, `0x2c`, :1824); `fcmpltd` (ALOPF11, `0x2d`, :1859); `fcmplts` (ALOPF11, `0x2c`, :1819); … всего 16 |  |
| staa incr | `staab` (ALOPF10, `0x1c`, :1349); `staad` (ALOPF10, `0x1f`, :1364); `staah` (ALOPF10, `0x1d`, :1354); `staaq` (ALOPF10, `0x3f`, :1369); `staaqp` (ALOPF10, `0x20`, :3519); `staaw` (ALOPF10, `0x1e`, :1359) |  |

## 3. Найдено вне таблицы опкодов

| объект | где кодируется | источник |
|---|---|---|
| `MOVAB`, `MOVAH`, `MOVAW`, `MOVAD`, `MOVAQ` | слог AAS (Array Access Syllable), не ALS | `gas/config/tc-e2k.c:4635`, `:4657` |
| `ct`, `ct(cond)` | SS-слог (SF1): `ctop[11:10]`, `ctcond[8:0]` | `elbrus-docs README.md:225-227`, `:249-278` |
| `call`, `return` | управляющий слог CS | `opcodes/e2k-dis.c:1895` |
| `abn` | биты `abnf`/`abnt` SS-слога SF1 | `elbrus-docs README.md:214-215` |
| `%lsr` | регистр, не инструкция; в кодировке команд его нет | руководство МЦСТ, стр. 162 (вне кодировки) |

## 4. Приложение А. Все найденные мнемоники

Одна строка — одна мнемоника источника. Именно эти строки сверяет оракул.

| мнемоника | форма спецификации | формат | код | поля | источник |
|---|---|---|---|---|---|
| `add_addd` | ADD (комбинированная форма) | ALOPF21 | `0x11` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:6634` |
| `add_adds` | ADD (комбинированная форма) | ALOPF21 | `0x10` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:6629` |
| `addd` | ADDs/d | ALOPF1 | `0x11` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:24` |
| `adds` | ADDs/d | ALOPF1 | `0x10` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:19` |
| `and_addd` | ADD (комбинированная форма) | ALOPF21 | `0x1` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:6564` |
| `and_adds` | ADD (комбинированная форма) | ALOPF21 | `0x0` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:6559` |
| `andd` | AND, OR, XOR | ALOPF1 | `0x1` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:84` |
| `andnd` | ANDN, ORN, XORN | ALOPF1 | `0x3` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:94` |
| `andns` | ANDN, ORN, XORN | ALOPF1 | `0x2` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:89` |
| `ands` | AND, OR, XOR | ALOPF1 | `0x0` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:79` |
| `bitrevd` | BITREVs/d | ALOPF2 | `0x27` | ALF2: opce[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:2854` |
| `bitrevs` | BITREVs/d | ALOPF2 | `0x26` | ALF2: opce[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:2849` |
| `cmpandedb` | CMPANDs/d | ALOPF7 | `0x23` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:1089` |
| `cmpandesb` | CMPANDs/d | ALOPF7 | `0x22` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:1069` |
| `cmpandledb` | CMPANDs/d | ALOPF7 | `0x23` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:1104` |
| `cmpandlesb` | CMPANDs/d | ALOPF7 | `0x22` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:1084` |
| `cmpandpdb` | CMPANDs/d | ALOPF7 | `0x23` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:1099` |
| `cmpandpsb` | CMPANDs/d | ALOPF7 | `0x22` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:1079` |
| `cmpandsdb` | CMPANDs/d | ALOPF7 | `0x23` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:1094` |
| `cmpandssb` | CMPANDs/d | ALOPF7 | `0x22` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:1074` |
| `cmpbdb` | CMPs/d | ALOPF7 | `0x21` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:1034` |
| `cmpbedb` | CMPs/d | ALOPF7 | `0x21` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:1044` |
| `cmpbesb` | CMPs/d | ALOPF7 | `0x20` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:1004` |
| `cmpbsb` | CMPs/d | ALOPF7 | `0x20` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:994` |
| `cmpedb` | CMPs/d | ALOPF7 | `0x21` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:1039` |
| `cmpesb` | CMPs/d | ALOPF7 | `0x20` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:999` |
| `cmpldb` | CMPs/d | ALOPF7 | `0x21` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:1059` |
| `cmpledb` | CMPs/d | ALOPF7 | `0x21` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:1064` |
| `cmplesb` | CMPs/d | ALOPF7 | `0x20` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:1024` |
| `cmplsb` | CMPs/d | ALOPF7 | `0x20` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:1019` |
| `cmpodb` | CMPs/d | ALOPF7 | `0x21` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:1029` |
| `cmposb` | CMPs/d | ALOPF7 | `0x20` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:989` |
| `cmppdb` | CMPs/d | ALOPF7 | `0x21` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:1054` |
| `cmppsb` | CMPs/d | ALOPF7 | `0x20` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:1014` |
| `cmpsdb` | CMPs/d | ALOPF7 | `0x21` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:1049` |
| `cmpssb` | CMPs/d | ALOPF7 | `0x20` | ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0] | `opcodes/e2k-opc.h:1009` |
| `decd_fd` | DEC* | ALOPF21 | `0x33` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3379` |
| `decs_fb` | DEC* | ALOPF21 | `0x32` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2724` |
| `decs_fh` | DEC* | ALOPF21 | `0x32` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2729` |
| `decs_fw` | DEC* | ALOPF21 | `0x32` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2734` |
| `fcmpeqd` | FCMPs/d | ALOPF11 | `0x2d` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1854` |
| `fcmpeqs` | FCMPs/d | ALOPF11 | `0x2c` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1814` |
| `fcmpled` | FCMPs/d | ALOPF11 | `0x2d` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1864` |
| `fcmples` | FCMPs/d | ALOPF11 | `0x2c` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1824` |
| `fcmpltd` | FCMPs/d | ALOPF11 | `0x2d` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1859` |
| `fcmplts` | FCMPs/d | ALOPF11 | `0x2c` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1819` |
| `fcmpneqd` | FCMPs/d | ALOPF11 | `0x2d` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1874` |
| `fcmpneqs` | FCMPs/d | ALOPF11 | `0x2c` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1834` |
| `fcmpnled` | FCMPs/d | ALOPF11 | `0x2d` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1884` |
| `fcmpnles` | FCMPs/d | ALOPF11 | `0x2c` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1844` |
| `fcmpnltd` | FCMPs/d | ALOPF11 | `0x2d` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1879` |
| `fcmpnlts` | FCMPs/d | ALOPF11 | `0x2c` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1839` |
| `fcmpodd` | FCMPs/d | ALOPF11 | `0x2d` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1889` |
| `fcmpods` | FCMPs/d | ALOPF11 | `0x2c` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1849` |
| `fcmpuodd` | FCMPs/d | ALOPF11 | `0x2d` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1869` |
| `fcmpuods` | FCMPs/d | ALOPF11 | `0x2c` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1829` |
| `incd_fd` | INC* | ALOPF21 | `0x31` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3374` |
| `incs_fb` | INC* | ALOPF21 | `0x30` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2709` |
| `incs_fh` | INC* | ALOPF21 | `0x30` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2714` |
| `incs_fw` | INC* | ALOPF21 | `0x30` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2719` |
| `ldb` | LDB, LDH, LDW, LDD | ALOPF1 | `0x64` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:604` |
| `ldd` | LDB, LDH, LDW, LDD | ALOPF1 | `0x67` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:619` |
| `ldh` | LDB, LDH, LDW, LDD | ALOPF1 | `0x65` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:609` |
| `ldw` | LDB, LDH, LDW, LDD | ALOPF1 | `0x66` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:614` |
| `lzcntd` | LZCNTs/d | ALOPF2 | `0x65` | ALF2: opce[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:2864` |
| `lzcnts` | LZCNTs/d | ALOPF2 | `0x64` | ALF2: opce[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:2859` |
| `merge_addd` | ADD (комбинированная форма) | ALOPF21_MERGE | `0xf` | — (раскладка в источнике не разобрана) | `opcodes/e2k-opc.h:6624` |
| `merge_adds` | ADD (комбинированная форма) | ALOPF21_MERGE | `0xe` | — (раскладка в источнике не разобрана) | `opcodes/e2k-opc.h:6619` |
| `merged` | MERGE | MERGE | `0xf` | короткая форма ALOPF1 (e2k-dis.c:846-849) | `opcodes/e2k-opc.h:209` |
| `merges` | MERGE | MERGE | `0xe` | короткая форма ALOPF1 (e2k-dis.c:846-849) | `opcodes/e2k-opc.h:204` |
| `movtd` | MOVTs/d/q | ALOPF2 | `0x61` | ALF2: opce[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:664` |
| `movtq` | MOVTs/d/q | ALOPF22 | `0x57` | — (раскладка в источнике не разобрана) | `opcodes/e2k-opc.h:2814` |
| `movts` | MOVTs/d/q | ALOPF2 | `0x60` | ALF2: opce[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:644` |
| `mpsadbh` | PSADBW, MPSADBH | ALOPF11 | `0x58` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3199` |
| `muld` | MULs/d | ALOPF11 | `0x21` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1439` |
| `muls` | MULs/d | ALOPF11 | `0x20` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1434` |
| `or_addd` | ADD (комбинированная форма) | ALOPF21 | `0x5` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:6584` |
| `or_adds` | ADD (комбинированная форма) | ALOPF21 | `0x4` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:6579` |
| `ord` | AND, OR, XOR | ALOPF1 | `0x5` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:104` |
| `ornd` | ANDN, ORN, XORN | ALOPF1 | `0x7` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:114` |
| `orns` | ANDN, ORN, XORN | ALOPF1 | `0x6` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:109` |
| `ors` | AND, OR, XOR | ALOPF1 | `0x4` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:99` |
| `packsshb` | PUNPCK*, PACK* | ALOPF11 | `0x8` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2069` |
| `packsswh` | PUNPCK*, PACK* | ALOPF11 | `0xa` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2084` |
| `packushb` | PUNPCK*, PACK* | ALOPF11 | `0x9` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2074` |
| `packuswh` | PUNPCK*, PACK* | ALOPF11 | `0x6b` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3204` |
| `paddb` | PADD* | ALOPF11 | `0x8` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1479` |
| `paddd` | PADD* | ALOPF11 | `0xf` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1494` |
| `paddh` | PADD* | ALOPF11 | `0x9` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1484` |
| `paddsb` | PADD* | ALOPF11 | `0xa` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1499` |
| `paddsh` | PADD* | ALOPF11 | `0xb` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1504` |
| `paddusb` | PADD* | ALOPF11 | `0xc` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1509` |
| `paddush` | PADD* | ALOPF11 | `0xd` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1514` |
| `paddw` | PADD* | ALOPF11 | `0xe` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1489` |
| `pandd` | PAND*, POR*, PXOR* | ALOPF11 | `0x48` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1679` |
| `pandnd` | PAND*, POR*, PXOR* | ALOPF11 | `0x49` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1684` |
| `pavgusb` | PAVG* | ALOPF11 | `0x1e` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1714` |
| `pavgush` | PAVG* | ALOPF11 | `0x1f` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1719` |
| `pcmpeqb` | PCMP* | ALOPF11 | `0x18` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2024` |
| `pcmpeqbap` | PCMP* | ALOPF17 | `0x28` | ALF17: src1[23:16], src2[15:8], dst[7:0] (упакованные предикаты) | `opcodes/e2k-opc.h:4459` |
| `pcmpeqbop` | PCMP* | ALOPF17 | `0x28` | ALF17: src1[23:16], src2[15:8], dst[7:0] (упакованные предикаты) | `opcodes/e2k-opc.h:4419` |
| `pcmpeqd` | PCMP* | ALOPF11 | `0x4d` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3209` |
| `pcmpeqdap` | PCMP* | ALOPF17 | `0x28` | ALF17: src1[23:16], src2[15:8], dst[7:0] (упакованные предикаты) | `opcodes/e2k-opc.h:4474` |
| `pcmpeqdop` | PCMP* | ALOPF17 | `0x28` | ALF17: src1[23:16], src2[15:8], dst[7:0] (упакованные предикаты) | `opcodes/e2k-opc.h:4434` |
| `pcmpeqh` | PCMP* | ALOPF11 | `0x19` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2029` |
| `pcmpeqhap` | PCMP* | ALOPF17 | `0x28` | ALF17: src1[23:16], src2[15:8], dst[7:0] (упакованные предикаты) | `opcodes/e2k-opc.h:4464` |
| `pcmpeqhop` | PCMP* | ALOPF17 | `0x28` | ALF17: src1[23:16], src2[15:8], dst[7:0] (упакованные предикаты) | `opcodes/e2k-opc.h:4424` |
| `pcmpeqw` | PCMP* | ALOPF11 | `0x1a` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2034` |
| `pcmpeqwap` | PCMP* | ALOPF17 | `0x28` | ALF17: src1[23:16], src2[15:8], dst[7:0] (упакованные предикаты) | `opcodes/e2k-opc.h:4469` |
| `pcmpeqwop` | PCMP* | ALOPF17 | `0x28` | ALF17: src1[23:16], src2[15:8], dst[7:0] (упакованные предикаты) | `opcodes/e2k-opc.h:4429` |
| `pcmpgtb` | PCMP* | ALOPF11 | `0x1b` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2039` |
| `pcmpgtbap` | PCMP* | ALOPF17 | `0x28` | ALF17: src1[23:16], src2[15:8], dst[7:0] (упакованные предикаты) | `opcodes/e2k-opc.h:4479` |
| `pcmpgtbop` | PCMP* | ALOPF17 | `0x28` | ALF17: src1[23:16], src2[15:8], dst[7:0] (упакованные предикаты) | `opcodes/e2k-opc.h:4439` |
| `pcmpgtd` | PCMP* | ALOPF11 | `0x4f` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3214` |
| `pcmpgtdap` | PCMP* | ALOPF17 | `0x28` | ALF17: src1[23:16], src2[15:8], dst[7:0] (упакованные предикаты) | `opcodes/e2k-opc.h:4494` |
| `pcmpgtdop` | PCMP* | ALOPF17 | `0x28` | ALF17: src1[23:16], src2[15:8], dst[7:0] (упакованные предикаты) | `opcodes/e2k-opc.h:4454` |
| `pcmpgth` | PCMP* | ALOPF11 | `0x1c` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2044` |
| `pcmpgthap` | PCMP* | ALOPF17 | `0x28` | ALF17: src1[23:16], src2[15:8], dst[7:0] (упакованные предикаты) | `opcodes/e2k-opc.h:4484` |
| `pcmpgthop` | PCMP* | ALOPF17 | `0x28` | ALF17: src1[23:16], src2[15:8], dst[7:0] (упакованные предикаты) | `opcodes/e2k-opc.h:4444` |
| `pcmpgtw` | PCMP* | ALOPF11 | `0x1d` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2049` |
| `pcmpgtwap` | PCMP* | ALOPF17 | `0x28` | ALF17: src1[23:16], src2[15:8], dst[7:0] (упакованные предикаты) | `opcodes/e2k-opc.h:4489` |
| `pcmpgtwop` | PCMP* | ALOPF17 | `0x28` | ALF17: src1[23:16], src2[15:8], dst[7:0] (упакованные предикаты) | `opcodes/e2k-opc.h:4449` |
| `pextrh` | PEXTRH | ALOPF11_LIT8 | `0x1e` | ALS + ALEF2 + lit8 в opce | `opcodes/e2k-opc.h:1759` |
| `pfadd_addd` | PF(ADD/SUB)_(ADD/SUB/RSUB)(s/d) | ALOPF21 | `0x1` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:7694` |
| `pfadd_adds` | PF(ADD/SUB)_(ADD/SUB/RSUB)(s/d) | ALOPF21 | `0x0` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:7689` |
| `pfadd_rsubd` | PF(ADD/SUB)_(ADD/SUB/RSUB)(s/d) | ALOPF21 | `0x21` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:8004` |
| `pfadd_rsubs` | PF(ADD/SUB)_(ADD/SUB/RSUB)(s/d) | ALOPF21 | `0x20` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:7999` |
| `pfadd_subd` | PF(ADD/SUB)_(ADD/SUB/RSUB)(s/d) | ALOPF21 | `0x21` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:7714` |
| `pfadd_subs` | PF(ADD/SUB)_(ADD/SUB/RSUB)(s/d) | ALOPF21 | `0x20` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:7709` |
| `pfaddd` | PFADDs/d, PFSUBs/d, PFMULs/d | ALOPF11 | `0x31` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1649` |
| `pfadds` | PFADDs/d, PFSUBs/d, PFMULs/d | ALOPF11 | `0x30` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1644` |
| `pfaddsub_addsubs` | PF(HADD/HSUB/ADDSUB)_(HADD/HSUB/ADDSUB)s | ALOPF21 | `0x6e` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:8069` |
| `pfaddsub_hadds` | PF(HADD/HSUB/ADDSUB)_(HADD/HSUB/ADDSUB)s | ALOPF21 | `0x4e` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:7784` |
| `pfaddsub_hsubs` | PF(HADD/HSUB/ADDSUB)_(HADD/HSUB/ADDSUB)s | ALOPF21 | `0x6e` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:7814` |
| `pfaddsubs` | PFHADDs, PFHSUBs, PFADDSUBs | ALOPF11 | `0x77` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3229` |
| `pfcmpeqd` | PFCMP(s/d) | ALOPF11 | `0x3b` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1934` |
| `pfcmpeqs` | PFCMP(s/d) | ALOPF11 | `0x3a` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1894` |
| `pfcmpled` | PFCMP(s/d) | ALOPF11 | `0x3b` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1944` |
| `pfcmples` | PFCMP(s/d) | ALOPF11 | `0x3a` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1904` |
| `pfcmpltd` | PFCMP(s/d) | ALOPF11 | `0x3b` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1939` |
| `pfcmplts` | PFCMP(s/d) | ALOPF11 | `0x3a` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1899` |
| `pfcmpneqd` | PFCMP(s/d) | ALOPF11 | `0x3b` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1954` |
| `pfcmpneqs` | PFCMP(s/d) | ALOPF11 | `0x3a` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1914` |
| `pfcmpnled` | PFCMP(s/d) | ALOPF11 | `0x3b` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1964` |
| `pfcmpnles` | PFCMP(s/d) | ALOPF11 | `0x3a` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1924` |
| `pfcmpnltd` | PFCMP(s/d) | ALOPF11 | `0x3b` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1959` |
| `pfcmpnlts` | PFCMP(s/d) | ALOPF11 | `0x3a` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1919` |
| `pfcmpodd` | PFCMP(s/d) | ALOPF11 | `0x3b` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1969` |
| `pfcmpods` | PFCMP(s/d) | ALOPF11 | `0x3a` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1929` |
| `pfcmpuodd` | PFCMP(s/d) | ALOPF11 | `0x3b` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1949` |
| `pfcmpuods` | PFCMP(s/d) | ALOPF11 | `0x3a` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1909` |
| `pfhadd_addsubs` | PF(HADD/HSUB/ADDSUB)_(HADD/HSUB/ADDSUB)s | ALOPF21 | `0x64` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:8054` |
| `pfhadd_hadds` | PF(HADD/HSUB/ADDSUB)_(HADD/HSUB/ADDSUB)s | ALOPF21 | `0x44` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:7769` |
| `pfhadd_hsubs` | PF(HADD/HSUB/ADDSUB)_(HADD/HSUB/ADDSUB)s | ALOPF21 | `0x64` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:7799` |
| `pfhadds` | PFHADDs, PFHSUBs, PFADDSUBs | ALOPF11 | `0x72` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3219` |
| `pfhsub_addsubs` | PF(HADD/HSUB/ADDSUB)_(HADD/HSUB/ADDSUB)s | ALOPF21 | `0x66` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:8059` |
| `pfhsub_hadds` | PF(HADD/HSUB/ADDSUB)_(HADD/HSUB/ADDSUB)s | ALOPF21 | `0x46` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:7774` |
| `pfhsub_hsubs` | PF(HADD/HSUB/ADDSUB)_(HADD/HSUB/ADDSUB)s | ALOPF21 | `0x66` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:7804` |
| `pfhsubs` | PFHADDs, PFHSUBs, PFADDSUBs | ALOPF11 | `0x73` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3224` |
| `pfmaxd` | PFMAX(s/d) | ALOPF11 | `0x37` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1749` |
| `pfmaxs` | PFMAX(s/d) | ALOPF11 | `0x36` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1744` |
| `pfmind` | PFMIN(s/d) | ALOPF11 | `0x35` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1739` |
| `pfmins` | PFMIN(s/d) | ALOPF11 | `0x34` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1734` |
| `pfmul_addd` | PFMUL_(ADD/SUB/RSUB)(s/d) | ALOPF21 | `0x9` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:7674` |
| `pfmul_adds` | PFMUL_(ADD/SUB/RSUB)(s/d) | ALOPF21 | `0x8` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:7669` |
| `pfmul_addsubs` | PFMUL_(HADD/HSUB/ADDSUB)s | ALOPF21 | `0x68` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:8064` |
| `pfmul_hadds` | PFMUL_(HADD/HSUB/ADDSUB)s | ALOPF21 | `0x48` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:7779` |
| `pfmul_hsubs` | PFMUL_(HADD/HSUB/ADDSUB)s | ALOPF21 | `0x68` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:7809` |
| `pfmul_rsubd` | PFMUL_(ADD/SUB/RSUB)(s/d) | ALOPF21 | `0x29` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:7994` |
| `pfmul_rsubs` | PFMUL_(ADD/SUB/RSUB)(s/d) | ALOPF21 | `0x28` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:7989` |
| `pfmul_subd` | PFMUL_(ADD/SUB/RSUB)(s/d) | ALOPF21 | `0x29` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:7684` |
| `pfmul_subs` | PFMUL_(ADD/SUB/RSUB)(s/d) | ALOPF21 | `0x28` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:7679` |
| `pfmuld` | PFADDs/d, PFSUBs/d, PFMULs/d | ALOPF11 | `0x39` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1474` |
| `pfmuls` | PFADDs/d, PFSUBs/d, PFMULs/d | ALOPF11 | `0x38` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1469` |
| `pfsub_addd` | PF(ADD/SUB)_(ADD/SUB/RSUB)(s/d) | ALOPF21 | `0x3` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:7704` |
| `pfsub_adds` | PF(ADD/SUB)_(ADD/SUB/RSUB)(s/d) | ALOPF21 | `0x2` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:7699` |
| `pfsub_rsubd` | PF(ADD/SUB)_(ADD/SUB/RSUB)(s/d) | ALOPF21 | `0x23` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:8014` |
| `pfsub_rsubs` | PF(ADD/SUB)_(ADD/SUB/RSUB)(s/d) | ALOPF21 | `0x22` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:8009` |
| `pfsub_subd` | PF(ADD/SUB)_(ADD/SUB/RSUB)(s/d) | ALOPF21 | `0x23` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:7724` |
| `pfsub_subs` | PF(ADD/SUB)_(ADD/SUB/RSUB)(s/d) | ALOPF21 | `0x22` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:7719` |
| `pfsubd` | PFADDs/d, PFSUBs/d, PFMULs/d | ALOPF11 | `0x33` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1659` |
| `pfsubs` | PFADDs/d, PFSUBs/d, PFMULs/d | ALOPF11 | `0x32` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1654` |
| `phaddh` | PHADD* | ALOPF11 | `0x29` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3264` |
| `phaddsh` | PHADD* | ALOPF11 | `0x2b` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3274` |
| `phaddw` | PHADD* | ALOPF11 | `0x2a` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3269` |
| `phminposuh` | PHMINPOSUH | ALOPF11 | `0x6a` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3319` |
| `phsubh` | PHSUB* | ALOPF11 | `0x2d` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3279` |
| `phsubsh` | PHSUB* | ALOPF11 | `0x2f` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3289` |
| `phsubw` | PHSUB* | ALOPF11 | `0x2e` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3284` |
| `pinsh` | PINSH | ALOPF11_LIT8 | `0x1f` | ALS + ALEF2 + lit8 в opce | `opcodes/e2k-opc.h:1764` |
| `pmaddh` | PMADDH, PMADDUBSH | ALOPF11 | `0x1a` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1599` |
| `pmaddubsh` | PMADDH, PMADDUBSH | ALOPF11 | `0x68` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3309` |
| `pmaxsb` | PMAX* | ALOPF11 | `0x6` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3244` |
| `pmaxsh` | PMAX* | ALOPF11 | `0x3` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1559` |
| `pmaxsw` | PMAX* | ALOPF11 | `0x23` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3194` |
| `pmaxub` | PMAX* | ALOPF11 | `0x2` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1564` |
| `pmaxuh` | PMAX* | ALOPF11 | `0x7` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3249` |
| `pmaxuw` | PMAX* | ALOPF11 | `0x22` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3189` |
| `pmerge` | PMERGE | ALOPF21 | `0x6d` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:8024` |
| `pminsb` | PMIN* | ALOPF11 | `0x4` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3234` |
| `pminsh` | PMIN* | ALOPF11 | `0x1` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1569` |
| `pminsw` | PMIN* | ALOPF11 | `0x21` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3184` |
| `pminub` | PMIN* | ALOPF11 | `0x0` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1574` |
| `pminuh` | PMIN* | ALOPF11 | `0x5` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3239` |
| `pminuw` | PMIN* | ALOPF11 | `0x20` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3179` |
| `pmovmskb` | PMOV* | ALOPF11 | `0xb` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2054` |
| `pmovmskpd` | PMOV* | ALOPF11 | `0x7` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2064` |
| `pmovmskps` | PMOV* | ALOPF11 | `0x6` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2059` |
| `pmulhh` | PMULHH, PMULLH, PMULUBHH | ALOPF11 | `0x18` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1589` |
| `pmulhrsh` | PMULHRSH | ALOPF11 | `0x69` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3314` |
| `pmullh` | PMULHH, PMULLH, PMULUBHH | ALOPF11 | `0x19` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1594` |
| `pmulubhh` | PMULHH, PMULLH, PMULUBHH | ALOPF11 | `0x1d` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2929` |
| `popcntd` | POPCNTs/d | ALOPF2 | `0x67` | ALF2: opce[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:2874` |
| `popcnts` | POPCNTs/d | ALOPF2 | `0x66` | ALF2: opce[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:2869` |
| `pord` | PAND*, POR*, PXOR* | ALOPF11 | `0x4a` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1689` |
| `psadbw` | PSADBW, MPSADBH | ALOPF11 | `0x1c` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1579` |
| `pshufb` | PSHUF* | ALOPF21 | `0x4d` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:8019` |
| `pshufh` | PSHUF* | ALOPF12_PSHUFH | `0x17` | ALF12 + lit8 в ALES.opce | `opcodes/e2k-opc.h:2509` |
| `pshufw` | PSHUF* | ALOPF11_LIT8 | `0x16` | ALS + ALEF2 + lit8 в opce | `opcodes/e2k-opc.h:2079` |
| `psignb` | PSIGN* | ALOPF11 | `0x30` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3294` |
| `psignh` | PSIGN* | ALOPF11 | `0x31` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3299` |
| `psignw` | PSIGN* | ALOPF11 | `0x32` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3304` |
| `pslld` | PSR*, PSL* | ALOPF11 | `0x4e` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1604` |
| `psllh` | PSR*, PSL* | ALOPF11 | `0x15` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1614` |
| `psllqh` | PSR*, PSL* | ALOPF11_LIT8 | `0xe` | ALS + ALEF2 + lit8 в opce | `opcodes/e2k-opc.h:1769` |
| `psllql` | PSR*, PSL* | ALOPF11_LIT8 | `0xf` | ALS + ALEF2 + lit8 в opce | `opcodes/e2k-opc.h:1774` |
| `psllw` | PSR*, PSL* | ALOPF11 | `0x14` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1609` |
| `psrah` | PSR*, PSL* | ALOPF11 | `0x13` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1639` |
| `psraw` | PSR*, PSL* | ALOPF11 | `0x12` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1634` |
| `psrcd` | PSR*, PSL* | ALOPF11 | `0x17` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:4009` |
| `psrcw` | PSR*, PSL* | ALOPF11 | `0x16` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:4014` |
| `psrld` | PSR*, PSL* | ALOPF11 | `0x4c` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1619` |
| `psrlh` | PSR*, PSL* | ALOPF11 | `0x11` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1629` |
| `psrlqh` | PSR*, PSL* | ALOPF11_LIT8 | `0xc` | ALS + ALEF2 + lit8 в opce | `opcodes/e2k-opc.h:1779` |
| `psrlql` | PSR*, PSL* | ALOPF11_LIT8 | `0xd` | ALS + ALEF2 + lit8 в opce | `opcodes/e2k-opc.h:1784` |
| `psrlw` | PSR*, PSL* | ALOPF11 | `0x10` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1624` |
| `psubb` | PSUB* | ALOPF11 | `0x10` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1519` |
| `psubd` | PSUB* | ALOPF11 | `0x17` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1534` |
| `psubh` | PSUB* | ALOPF11 | `0x11` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1524` |
| `psubsb` | PSUB* | ALOPF11 | `0x12` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1539` |
| `psubsh` | PSUB* | ALOPF11 | `0x13` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1544` |
| `psubusb` | PSUB* | ALOPF11 | `0x14` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1549` |
| `psubush` | PSUB* | ALOPF11 | `0x15` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1554` |
| `psubw` | PSUB* | ALOPF11 | `0x16` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1529` |
| `punpckhbh` | PUNPCK*, PACK* | ALOPF11 | `0x0` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2089` |
| `punpckhhw` | PUNPCK*, PACK* | ALOPF11 | `0x2` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2094` |
| `punpckhwd` | PUNPCK*, PACK* | ALOPF11 | `0x4` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2099` |
| `punpcklbh` | PUNPCK*, PACK* | ALOPF11 | `0x1` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2104` |
| `punpcklhw` | PUNPCK*, PACK* | ALOPF11 | `0x3` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2109` |
| `punpcklwd` | PUNPCK*, PACK* | ALOPF11 | `0x5` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2114` |
| `pxord` | PAND*, POR*, PXOR* | ALOPF11 | `0x4b` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1694` |
| `sar_addd` | ADD (комбинированная форма) | ALOPF21 | `0x1d` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:6694` |
| `sar_adds` | ADD (комбинированная форма) | ALOPF21 | `0x1c` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:6689` |
| `sard` | SARs/d, SAR | ALOPF1 | `0x1d` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:184` |
| `sard_fd` | SHL*, SHR*, SAR*, SCL* (с флагами) | ALOPF21 | `0x1d` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3404` |
| `sars` | SARs/d, SAR | ALOPF1 | `0x1c` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:179` |
| `sars_fb` | SHL*, SHR*, SAR*, SCL* (с флагами) | ALOPF21 | `0x1c` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2799` |
| `sars_fh` | SHL*, SHR*, SAR*, SCL* (с флагами) | ALOPF21 | `0x1c` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2804` |
| `sars_fw` | SHL*, SHR*, SAR*, SCL* (с флагами) | ALOPF21 | `0x1c` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2809` |
| `scl_addd` | ADD (комбинированная форма) | ALOPF21 | `0x15` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:6654` |
| `scl_adds` | ADD (комбинированная форма) | ALOPF21 | `0x14` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:6649` |
| `scld` | SCLs/d, SCR | ALOPF1 | `0x15` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:164` |
| `scld_fd` | SHL*, SHR*, SAR*, SCL* (с флагами) | ALOPF21 | `0x15` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3394` |
| `scls` | SCLs/d, SCR | ALOPF1 | `0x14` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:159` |
| `scls_fb` | SHL*, SHR*, SAR*, SCL* (с флагами) | ALOPF21 | `0x14` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2769` |
| `scls_fh` | SHL*, SHR*, SAR*, SCL* (с флагами) | ALOPF21 | `0x14` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2774` |
| `scls_fw` | SHL*, SHR*, SAR*, SCL* (с флагами) | ALOPF21 | `0x14` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2779` |
| `scr_addd` | ADD (комбинированная форма) | ALOPF21 | `0x17` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:6664` |
| `scr_adds` | ADD (комбинированная форма) | ALOPF21 | `0x16` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:6659` |
| `scrd` | SCLs/d, SCR | ALOPF1 | `0x17` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:174` |
| `scrs` | SCLs/d, SCR | ALOPF1 | `0x16` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:169` |
| `shl_addd` | ADD (комбинированная форма) | ALOPF21 | `0x19` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:6674` |
| `shl_adds` | ADD (комбинированная форма) | ALOPF21 | `0x18` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:6669` |
| `shld` | SHLs/d, SHL | ALOPF1 | `0x19` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:144` |
| `shld_fd` | SHL*, SHR*, SAR*, SCL* (с флагами) | ALOPF21 | `0x19` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3384` |
| `shls` | SHLs/d, SHL | ALOPF1 | `0x18` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:139` |
| `shls_fb` | SHL*, SHR*, SAR*, SCL* (с флагами) | ALOPF21 | `0x18` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2739` |
| `shls_fh` | SHL*, SHR*, SAR*, SCL* (с флагами) | ALOPF21 | `0x18` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2744` |
| `shls_fw` | SHL*, SHR*, SAR*, SCL* (с флагами) | ALOPF21 | `0x18` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2749` |
| `shr_addd` | ADD (комбинированная форма) | ALOPF21 | `0x1b` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:6684` |
| `shr_adds` | ADD (комбинированная форма) | ALOPF21 | `0x1a` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:6679` |
| `shrd` | SHRs/d, SHR | ALOPF1 | `0x1b` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:154` |
| `shrd_fd` | SHL*, SHR*, SAR*, SCL* (с флагами) | ALOPF21 | `0x1b` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3389` |
| `shrs` | SHRs/d, SHR | ALOPF1 | `0x1a` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:149` |
| `shrs_fb` | SHL*, SHR*, SAR*, SCL* (с флагами) | ALOPF21 | `0x1a` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2754` |
| `shrs_fh` | SHL*, SHR*, SAR*, SCL* (с флагами) | ALOPF21 | `0x1a` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2759` |
| `shrs_fw` | SHL*, SHR*, SAR*, SCL* (с флагами) | ALOPF21 | `0x1a` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2764` |
| `smulhd` | SMULHd | ALOPF11 | `0x71` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3174` |
| `smulx` | SMULX | ALOPF11 | `0x23` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1449` |
| `smulx_fb` | SMULX | ALOPF11 | `0x23` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2344` |
| `smulx_fh` | SMULX | ALOPF11 | `0x23` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2349` |
| `smulx_fw` | SMULX | ALOPF11 | `0x23` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2354` |
| `staab` | staa incr | ALOPF10 | `0x1c` | ALF10: src3[7:0], opce1[23:8] | `opcodes/e2k-opc.h:1349` |
| `staad` | staa incr | ALOPF10 | `0x1f` | ALF10: src3[7:0], opce1[23:8] | `opcodes/e2k-opc.h:1364` |
| `staah` | staa incr | ALOPF10 | `0x1d` | ALF10: src3[7:0], opce1[23:8] | `opcodes/e2k-opc.h:1354` |
| `staaq` | staa incr | ALOPF10 | `0x3f` | ALF10: src3[7:0], opce1[23:8] | `opcodes/e2k-opc.h:1369` |
| `staaqp` | staa incr | ALOPF10 | `0x20` | ALF10: src3[7:0], opce1[23:8] | `opcodes/e2k-opc.h:3519` |
| `staaw` | staa incr | ALOPF10 | `0x1e` | ALF10: src3[7:0], opce1[23:8] | `opcodes/e2k-opc.h:1359` |
| `stb` | STB, STH, STW, STD | ALOPF3 | `0x24` | ALF3: src1[23:16], src2[15:8], src3[7:0] | `opcodes/e2k-opc.h:969` |
| `std` | STB, STH, STW, STD | ALOPF3 | `0x27` | ALF3: src1[23:16], src2[15:8], src3[7:0] | `opcodes/e2k-opc.h:984` |
| `sth` | STB, STH, STW, STD | ALOPF3 | `0x25` | ALF3: src1[23:16], src2[15:8], src3[7:0] | `opcodes/e2k-opc.h:974` |
| `stw` | STB, STH, STW, STD | ALOPF3 | `0x26` | ALF3: src1[23:16], src2[15:8], src3[7:0] | `opcodes/e2k-opc.h:979` |
| `sub_addd` | ADD (комбинированная форма) | ALOPF21 | `0x13` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:6644` |
| `sub_adds` | ADD (комбинированная форма) | ALOPF21 | `0x12` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:6639` |
| `subd` | SUBs/d, SUB | ALOPF1 | `0x13` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:34` |
| `subs` | SUBs/d, SUB | ALOPF1 | `0x12` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:29` |
| `sxt` | SXT | ALOPF1 | `0xc` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:199` |
| `umulhd` | UMULHd | ALOPF11 | `0x70` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:3169` |
| `umulx` | UMULX | ALOPF11 | `0x22` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:1444` |
| `umulx_fb` | UMULX | ALOPF11 | `0x22` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2329` |
| `umulx_fh` | UMULX | ALOPF11 | `0x22` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2334` |
| `umulx_fw` | UMULX | ALOPF11 | `0x22` | ALS + ALEF2: opce[7:0], opc2[15:8] | `opcodes/e2k-opc.h:2339` |
| `xor_addd` | ADD (комбинированная форма) | ALOPF21 | `0x9` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:6604` |
| `xor_adds` | ADD (комбинированная форма) | ALOPF21 | `0x8` | ALS + ALEF1: src3[7:0], opc2[15:8] | `opcodes/e2k-opc.h:6599` |
| `xord` | AND, OR, XOR | ALOPF1 | `0x9` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:124` |
| `xornd` | ANDN, ORN, XORN | ALOPF1 | `0xb` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:134` |
| `xorns` | ANDN, ORN, XORN | ALOPF1 | `0xa` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:129` |
| `xors` | AND, OR, XOR | ALOPF1 | `0x8` | ALF1: src1[23:16], src2[15:8], dst[7:0] | `opcodes/e2k-opc.h:119` |

## 5. Форма ALF7: измеренные байты (добавлено 2026-09-19)

Форма ALF7 — та, которой кодируются **сравнения**: приёмник у них не регистр, а **предикат**
(`pdst[4:0]`), а условие сравнения лежит в `cmpopce[7:5]`.

| текст МЦСТ | байты | что читается в байтах |
|---|---|---|
| `cmplsb,0 %b[1], %b[2], %pred0` | `01 01 00 04 c0 02 01 20` | `opc=0x20`, `src1=1`, `src2=2`, `cmpopce=6` («меньше»), `pdst=0` |
| `cmplsb,0 %b[1], %b[2], %pred3` | `01 01 00 04 c3 02 01 20` | `pdst=3` |
| `cmplesb,0 %b[1], %b[2], %pred0` | `01 01 00 04 e0 02 01 20` | `cmpopce=7` («меньше или равно») |
| `cmpesb,0 %b[1], %b[2], %pred0` | `01 01 00 04 40 02 01 20` | `cmpopce=2` («равно») |
| `cmplsb,0 %r1, %r2, %pred0` | `01 01 00 04 c0 82 81 20` | оконный файл регистров (`0x80 \| N`) |

Раскладка полей — `qemu/target/e2k/syllab-format.h:59-63` (`src1[23:16]`, `src2[15:8]`,
`cmpopce[7:5]`, `pdst[4:0]`); коды условий — последнее числовое поле записи
`e2k_alf7_opcode_templ` в `opcodes/e2k-opc.h:989-1064`; форма различается по битам 7:5 слова ALF
(`opcodes/e2k-dis.c:846-1010`).

**Обязательное поле `nop = 2`.** У сравнения заголовочный слог не `01 00 00 04`, как у `adds`, а
`01 01 00 04`: поле `nop` (биты 9:7) равно 2. Число берётся ассемблером из шаблона записи —
`gas/config/tc-e2k.c:5923` (`((e2k_alf7_opcode_templ *) alf)->implicit_nops`); дизассемблер МЦСТ
печатает его открытым текстом (`nop 2`). Смысл поля — два оставленных слота выдачи — назван
**допущением**: готовность предиката не измерена (`src/e2k/e2kPredicates.test.ts`).

**Условий «больше» и «больше или равно» в наборе нет.** Таблица знает `o,b,e,be,s,p,l,le`; `ge`
выражается как «не меньше» (`cmplsb`), `gt` — как «не не больше» (`cmplesb`), `ne` — как «не
равно» (`cmpesb`), а полярность при передаче управления задаёт `ct` (`? %predN` / `? ~%predN`).

## 6. Сводка

| показатель | значение |
|---|---|
| строк спецификации разобрано | 66 |
| мнемоник найдено в таблице опкодов МЦСТ | 318 |
| строк спецификации без находки в таблице | 6 |
| записей в таблице опкодов всего | 4271 (уникальных имён 3096) |
| строк источника разобрано | 21372 |

---

## 7. Массивы в IR и память e2k (07.2026)

### 7.1. Как массивы выражены в регистровом IR

Массивов как типа в IR **нет**: всё, что делает программа с массивом, уходит в **хост-вызов**
(`RegInstructionInvoke`), а эмиттер оболочки превращает его в носитель `IR.invoke`. Для ядра FIR
(111 инструкций) это:

| хост-вызов | сколько раз | смысл |
|---|---|---|
| `система.массив.добавить` | 13 | дописать элемент |
| `система.массив.создать` | 3 | создать массив |
| `система.массив.длина` | 3 | длина массива |
| `система.массив.получить` | 3 | прочитать элемент |

Носитель `IR.invoke` несёт операнды в порядке **`[flags, arg0, arg1, payload, dst]`**
(`src/e2k/emitterShell.ts:259-269`): `flags = (есть приёмник ? 1 : 0) | (argc << 1)`, `payload` —
**индекс имени** в таблице `invokeNames`, `dst` — приёмник. Семантику несёт **имя**, а не код
операции: в таблице опкодов МЦСТ такой операции нет, поэтому понижение и отказывает
(`src/e2k/e2kRealRun.ts`, `REFUSALS["IR.invoke"]`).

### 7.2. Чем это заменяется: форма памяти (реализована)

`ld*`/`st*` реализованы в `src/e2k/e2k-real.ts` (таблица `REAL_OPCODES`), форма ALF3 добавлена как
полноценная (слот `src3`). Измерено и сверено с ассемблером побайтово:

| текст | байты |
|---|---|
| `ldd,0 %b[1], %b[2], %db[3]` | `01 00 00 04 03 02 01 67` |
| `std,2 %b[3], %b[1], %b[2]` | `01 00 00 10 03 02 01 27` |
| `std,0 …` | **отказ ассемблера**: `` `std' cannot be encoded in ALC0 `` |

### 7.3. Исполнение памяти в модели — проверено

`src/e2k/e2kMemoryQemu.test.ts` (шлюз `npm run gate:qemu`): различающий опыт (записали 42 →
прочитали 42; записали 43 → прочитали 43), негативный контроль (чтение по другому адресу не даёт
записанного значения).

**Найдено при этом (и это неочевидно):** `std` в **страницу кода** кончается
`QEMU internal SIGSEGV {code=ACCERR, addr=…}` — QEMU защищает страницу переведённого кода.
Измерено: данные в той же странице, что код → ACCERR; те же данные на отдельной странице → код
возврата равен записанному. Поэтому у `buildElfFromCode` (`src/e2k/elfMinimal.ts`) есть параметры
`writable` (флаг сегмента `R|W|X`) и `extraMemory` (дописать `p_memsz`: хвост сегмента отображается
нулями и не является страницей кода).

### 7.4. Рантайм массивов: `IR.invoke` заменён настоящими обращениями (07.2026)

`src/e2k/arrayRuntime.ts` + ветвь `IR.invoke` в `src/e2k/e2kRealRun.ts` (`lowerCarrier`). Семантику
несёт **имя** вызова: `payload` — индекс в `invokeNames` образа оболочки
(`src/e2k/emitterShell.ts:255-269`), поэтому понижение получает таблицу имён через контекст.

Соглашение рантайма (наше решение): массив — указатель на блок `[длина:8][элемент0:8]…`, куча
растёт вверх; `получить` = `ldd` по адресу `массив + 8 + индекс*8`, `длина` = одно `ldd`,
`добавить` = обновление длины + `std`, `создать` = взять указатель кучи, обнулить длину, сдвинуть
кучу. Умножение на 8 — **удвоением** (`adds`), а не `shls`: `adds` проверен прогоном, `shls` — нет.

**Найдено при этом (и это важнее самого рантайма):**

| утверждение | источник/замер |
|---|---|
| базовый регистр существует **только внутри текущего окна**: индекс → `(wd_base_d + idx) % MAXSR_D`, выход за `size_d` — исключение `exc_window_bounds` | `qemu/target/e2k/reg-index.h:55-81` |
| при `setbn rsz = 5` доступны `%b[0..11]`, при `6` — `%b[0..13]`, при `7` — `%b[0..15]`; `rsz ≥ 8` не работает вовсе | **измерено** (`.tmp/rsz-sweep.ts`) |
| причина потолка — начальные `psize_q = 4`, `size_q = 8` квадрослов, то есть 16 единиц | `qemu/linux-user/e2k/cpu_loop.c:302-303` |
| наш кодировщик допускал базовые регистры до 63 — **шире окна**; теперь отказывает с причиной | `src/e2k/e2k-real.ts` (`BASE_REGISTER_COUNT = 32`; `E2K_RF_GLOB_IDX_MAX` — `qemu/target/e2k/cpu.h:90`) |

**Следствие для ядра FIR — сначала ошибочное, потом измеренное.** Отсюда было выведено «процедуре
`фильтр` нужно 17 vreg'ов, а окно даёт 16 регистров, значит окна не хватает». Вывод **неверен**:
число vreg'ов процедуры — это не то же самое, что число **одновременно** живых значений. Измерено
(§7.8): 17 vreg'ов `фильтр` раскладывались в **10** свободных регистров `%b[0..9]` (занято 7). Окно
расширять для этого не нужно.

**Поправка 2026-09-24.** Это измерение снималось против **незвуковых** правил (`peakLive` считался без
слияния отрезков, переносящих значение через дугу цикла). После правки
(`docs/e2k-regalloc-debt.md` §1–§3) `фильтр` в десять регистров **НЕ раскладывается**: в тесный момент
живы **13** отрезков при 10 свободных, а в окне вызываемой — **11** при 8. Поэтому вывод «окно
расширять не нужно» относится только к числу vreg'ов; раскладка упирается не в окно, а в точность
модели живости (шаг 4 §5 того же документа). См. §7.8 выше.

**Проверено прогоном:** `src/e2k/e2kArraysQemu.test.ts` (шлюз `gate:qemu`) — программа на Основе с
`создать`/`добавить`/`получить` компилируется, `IR.invoke` заменяется настоящими `ldd`/`std`, и
модель возвращает **7** для пары (5, 7) и **5** для пары (7, 5): значения действительно лежат в
памяти, а не в литералах.

### 7.6. Окно регистров: `setwd` управляет им из user space (07.2026)

Базовый регистр `%b[N]` существует **только внутри текущего окна** (`qemu/target/e2k/reg-index.h:55-81`),
а окно по умолчанию мало: измерено, что при `setbn rsz = 5` доступны `%b[0..11]`, при `6` — `%b[0..13]`,
при `7` — `%b[0..15]`, а `rsz ≥ 8` не работает вовсе (причина — начальные `psize_q = 4`, `size_q = 8`
квадрослов: `qemu/linux-user/e2k/cpu_loop.c:302-303`). Процедуре `фильтр` ядра FIR нужно **17 vreg'ов**,
то есть окна не хватает.

**Окно управляемо.** `setwd` — это слог CS1 с кодом операции `SETR0` **и литералом**, в котором лежит
размер: `wsz[11:5]` и `dbl` (бит 3) — `qemu/target/e2k/tcg/translate-lookahead.c:645-652`, `:683-691`;
`qemu/target/e2k/tcg/translate-misc.c:592-606`; `qemu/target/e2k/syllab-format.h:150-160`. Имена
параметров ассемблера — `wsz=`, `nfx=`, `dbl=` (`gas/config/tc-e2k.c:6257-6301`).

`setwd` **реализован** в `src/e2k/e2k-real.ts` (форма `CS1_SETWD`), байты сверены с ассемблером
(`src/e2k/e2kWindow.test.ts`, живой `as`): `setwd wsz=16, nfx=0, dbl=0` →
`11 80 00 00 00 00 00 00 00 00 00 00 00 02 00 00`.

**Измерено прогоном** (`.tmp/setwd-verify.ts`; ожидание — обмен `7 + 7 = 14`, `искл` — исключение модели):

| `setwd wsz` | `setbn rsz` | `%b[15]` | `%b[20]` | `%b[31]` |
|---|---|---|---|---|
| — | 7 | 14 | искл | искл |
| 16 | 7 | 14 | искл | искл |
| **16** | **15** | **14** | **14** | **14** |
| 16 | 31 | искл | искл | искл |
| 32 | 31 | 14 | 14 | 14 |
| 112 | 31 | 14 | 14 | 14 |

Правило видно из таблицы: **размер вращаемой области не может быть больше окна** (`rsz + 1 ≤ wsz`),
поэтому порядок обязателен — сначала `setwd`, потом `setbn`. Итог: `setwd wsz=16` + `setbn rsz=15`
даёт **32 регистра** (`%b[0..31]`), чего хватает и на 17 vreg'ов FIR, и на регистры рантайма.

**Отрицательный результат, из-за которого окно пока не расширяется.** Программа с расширенным окном
И обращением к памяти в модели **зависает**: оракул массивов с `setwd wsz=16` + `setbn rsz=15` не
дождался QEMU — два прогона по **123 с** и «QEMU не запустился», воспроизводимо и в одиночку; при окне
по умолчанию та же программа проходит и даёт 7. Поэтому `src/e2k/arrayRuntime.ts` работает в окне по
умолчанию (`rsz = 7`, регистры рантайма `%b[10..15]`), а расширение окна ждёт разбора этой связки
(`setwd` + память/вызов). Это не «не получилось»: кодировка проверена, доступность регистров
измерена, а препятствие названо и воспроизводится.
### 7.7. Чего ещё нет

Границы массива не проверяются (в модели `получить` вне границ даёт `null` —
`src/runtime/vm/interpreter.ts:70`); `установить`, `удалить`, `срез`, строки и математика — отказ с
причиной; `call`/`ret` нет, поэтому проверена одна процедура (`главная`). `IR.invoke` **размещается и
понижается** там, где раскладка удалась (см. §7.9), а ядро FIR целиком по-прежнему не собирается
ровно из-за `ret` (6 носителей) и `call` (2).

### 7.8. Раскладка регистров внутри окна: 17 vreg'ов `фильтр` в 8 свободных (07.2026)

> **Перемер 2026-09-24.** Числа этого раздела снимались против **незвукового** устранения копий и
> линейных отрезков без слияния переносимых через цикл. После двух правок
> (`docs/e2k-regalloc-debt.md` §1–§3) они другие: носителей **54 → 47** (снято **7** копий), отрезков
> **37**, точная граница (`peakLive`) **11** (было 9), в окне вызываемой **11** живых отрезков при 8
> свободных, а в десяти регистрах — **13** при 10. Вывод раздела «заняты все восемь, влезает впритык»
> **больше не верен**: раскладка `фильтр` **отказывает** — и это записано целью шага 4 (§5 того же
> документа: точная живость по CFG либо вытеснение). Прежние числа оставлены ниже как история замера
> 07.2026.

**Задача.** Окно не расширяем (§7.6 — `setwd` отложен), регистры рантайма массивов `%b[10..15]`
неприкосновенны. У процедуры `фильтр` (ядро FIR) **17** vreg'ов. Раскладывает `src/e2k/regAlloc.ts`
(линейное сканирование), живость считает `src/e2k/liveness.ts`. Раскладка стоит **в** конвейере
понижения: копии снимаются до двухпроходной раскладки адресов, и адреса, смещения переходов и пары
«сравнение → переход» считаются уже по укороченному потоку.

**Три величины пика, и они не равны друг другу** — перепутать их значит получить неверный вывод о
том, влезает ли программа (что и случилось в §7.5):

| величина | что это | у `фильтр` (после снятия копий) |
|---|---|---|
| интервал vreg'а | от первого определения до последнего чтения, **объединение** всех живых участков | 17 интервалов |
| пик модели раскладки (`peak`) | сколько нужно раскладке, держащей регистр за vreg'ом **весь** объединённый интервал | **11** (было 13) |
| точная нижняя граница (`peakLive`) | максимум живых на выходе инструкции, **обратный** анализ с рёбрами переходов | **9** (было 11) |
| отрезки жизни (`liveSegmentsOf`) | непрерывные участки: между смертью значения и новым определением регистр свободен | **37** |
| входящие vreg'и | читаются, но не определяются: параметры, их регистры **закреплены** | **v0, v1** |

**Входящие закрепляются, и это не тонкость.** `v0`/`v1` приходят в своих регистрах — раскладка,
перенёсшая параметр, положила бы значение не туда, куда смотрит вызывающий. Поэтому у `фильтр`
свободны только `%b[2..9]` — **восемь** регистров, и заняты все восемь: самый тесный момент требует
восьми отрезков одновременно. Закрепление снимается только моделью вызова и окна (следующий шаг),
до неё это единственное звуковое поведение.

**Устранение копий** (`src/e2k/copyElim.ts`) — не украшение: каждая пересылка `IR.move d, a` держит
**два** живых значения вместо одного, а в `фильтр` таких пересылок **29 из 54** носителей (замер
`.tmp/move-count.ts`). Измерено: носителей 54 → **46** (снято 8 копий), точная граница 11 → **9**.
Правило звуковое: пересылку можно выбросить и переименовать чтения, только если `d` не
переопределяется, пока живы переименованные чтения, **и** `a` не переопределяется между пересылкой и
последним чтением `d`, **и** между ними нет границы базового блока (цели перехода или пути «мимо»
условного перехода), **и** сама пересылка не является целью перехода. Третье и четвёртое условия —
из замеров: правила линейные, а линейный порядок совпадает с исполнением только внутри блока;
измерено, что из **179** кандидатов на снятие в пяти ядрах **7** снимались бы через цель перехода
(`docs/verification-debt.md`, случай 17). Четвёртое условие стоит ещё и потому, что после укорочения
потока цель перехода обязана остаться **существующей** командой: иначе её пришлось бы молча сдвигать
на соседнюю. Ограничение «пик не вырос» — тоже из замеров: без него пик у `свёртки` и `бпф4` **рос**
(11 → 13 и 9 → 11), а без проверки источника живых становилось подозрительно мало (пик 2 у `бпф4`
при 15 vreg'ах — признак неверного преобразования, а не находки).

**Порядок обязателен, и это измерено.** Без устранения копий `фильтр` в десять регистров не влезает
**даже по отрезкам**; с устранением — влезает (`.tmp/fit-without-copyelim.ts`). Поэтому шаг «применить
раскладку к потоку понижения» — это устранение копий **плюс** раскладка по отрезкам, а не одно из двух.

**Замер по всем пяти ядрам** — из отчёта самого конвейера (`.tmp/alloc-report-table.ts`, тот же путь,
что в проде; «объединение» — `peak`, «точная граница» — `peakLive`, «занято» — выданные регистры):

| ядро | процедура | vreg'ов | носителей | снято копий | объединение | точная граница | отрезков | входящие | занято | раскладка |
|---|---|---|---|---|---|---|---|---|---|---|
| fir | `фильтр` | 17 | 54 → 46 | 8 | 11 | **9** | 37 | 0,1 | **8** | **удаётся** (`%b[2..9]`) |
| fir | `сумма` | 10 | 23 → 17 | 6 | 7 | 5 | 14 | 0 | 5 | удаётся (`%b[1..5]`) |
| fir | `главная` | 11 | 34 → 31 | 3 | 10 | 9 | 15 | — | 9 | удаётся (`%b[0..8]`) |
| iir | `фильтр` | 14 | 40 → 29 | 11 | 8 | 6 | 21 | 0 | 6 | удаётся |
| iir | `целое_деление` | 7 | 11 → 6 | 5 | 4 | 3 | 4 | 0,1 | 2 | удаётся |
| convolution | `свёртка` | 18 | 65 → 60 | 5 | 14 | **11** | 49 | 0,1 | 0 | **отказ**: живы 11 отрезков при восьми свободных |
| correlation | `корреляция` | 18 | 55 → 47 | 8 | 11 | **9** | 39 | 0,1 | 8 | удаётся (`%b[2..9]`) |
| fft | `бпф4` | 15 | 67 → 38 | 29 | 8 | **7** | 27 | 0 | 8 | удаётся (`%b[1..8]`) |

**Поправка 2026-09-24 (минимальное вытеснение в память).** Таблица выше снята против **незвуковых**
правил раскладки (без слияния отрезков, переносящих значение через дугу цикла) и потому как
состояние недействительна. После правок (`docs/e2k-regalloc-debt.md` §1–§3, §13, §14) картина такая:
`fir/фильтр` раскладывается с **одним** вытеснением в слот (занято 8 регистров, 3 обращения к
памяти), `correlation/корреляция` — с **двумя** (6 обращений), `convolution/свёртка` отказывает:
ей нужно больше двух вытеснений. Свежие числа — §7.10 ниже и `.tmp/spill-measure.ts`.

Оракулы: `src/e2k/regAlloc.test.ts` (18 проверок) и `src/e2k/e2kRealRun.test.ts` (§«сквозной прогон:
раскладка регистров по процедурам») — включая независимую проверку звуковости переименования (число
определений каждого vreg не растёт), проверку, что ни одна пара **одновременно живых отрезков** не
делит регистр, проверку закрепления входящих, и проверку, что «занято» равно числу **разных выданных**
регистров (у этой проверки своя причина: «занято» когда-то означало «сколько регистров занято
последним отрезком» и равнялось 2 при десяти выданных — `docs/verification-debt.md`, случай 18).

**Чего это не доказывает.** Раскладка проверена как **преобразование потока** и сверена с кодированием
(round-trip каждой понижённой команды), но **не исполнением**. В сквозном прогоне пяти ядер теперь
**357 из 408** (было 277 из 408 до §7.9), у FIR — **86 из 94**: препятствием остались только `IR.ret`
(6) и `IR.call` (2), то есть парность процедур и модель окна — шаг 3. Регистр для `свёртки` (точная
граница 11) не закрыт: spill — следующий слой, разрешение брать временные рантайма `%b[10..11]`
владельцем не дано (`docs/hardware-debt.md` §3.16).

### 7.9. `IR.invoke` получает длину: 22 носителя FIR понижены (07.2026)

**Задача шага 2.** У `IR.invoke` нет формы «по мнемонике»: сколько команд он займёт, зависит от
**имени** хост-вызова, а имя лежит в операнде (`payload` — индекс в `invokeNames` образа оболочки).
Измерено (`.tmp/invoke-names.ts`, пять ядер): `система.массив.длина` — **1** команда (8 байт),
`создать` — **3** (24), `получить` — **6** (48), `добавить` — **9** (72). Пока формы нет, носитель не
размещается, и все адреса после него уезжают — это и было 22 отказа из 111 у FIR.

**Решение — спросить рантайм, а не угадать.** `carrierFormOf(instruction, { invokeNames })`
(`src/e2k/twoPassLayout.ts`) зовёт **тот же** `lowerArrayCall`, который делает понижение, и берёт
размер каждой команды из **таблицы форм** (`adds`/`ldd`/`std` — ALF1, 8 байт). Раскладка остаётся
независимой от кодировщика (размеры не спрашиваются у `Encoder`), но и не расходится с ним: оракул
`src/e2k/twoPassLayout.test.ts` сверяет обе величины — размер из таблицы против длины кодирования.

**Порядок обязателен: форма берётся только у РАЗЛОЖЕННОГО потока.** Рантайм массивов отвергает
операнд из `%b[10..15]` (куча, ноль, размер элемента, временные), а до раскладки номера vreg'ов как
раз туда и попадают. Измерено: на неразложенном потоке FIR форму получают лишь **15** носителей из 22,
на разложенном — **все 22**. Поэтому шаг 2 опирается на шаг 1, и это не оговорка, а проверяемое
свойство (оракул требует и 22 размещённых, и причину отказа на сыром потоке).

**Измерено после шага 2:** пять ядер **277 → 357** понижено (отказов **131 → 51**), байт 3 088 → 7 296;
FIR **64 → 86 из 94** (`IR.invoke` 22 из 22, было 0). Среди отказов остались `IR.ret` (32),
`IR.call` (11), `IR.invoke` (**7**: у `iir` одна вызов `система.математика.остаток` — не операция
массива; у `convolution` шесть — раскладка `свёртки` отказывает, её vreg'и остаются в `%b[10..]`, и
рантайм отвергает такие операнды с названной причиной) и `IR.div` (1).

### 7.10. Окно вызываемой процедуры: восемь регистров (07.2026)

**Замер, с которого начинается шаг 3.** Окно вызывающего — 16 регистров (`%r0..%r15`, измерено
`.tmp/rsz-sweep.ts`). Вызываемая получает **меньше**, и это не наша догадка: `call wbs` делает
`size_q -= wbs` (`qemu/target/e2k/tcg/translate-ct.c`, `e2k_cpu_exec_ct_CALL`: `base_q += wbs`,
`size_q -= wbs`, `BR = 0`), а индекс окна считается как `(base_d + idx) % MAXSR_D` с проверкой
`idx < size_d = 2*size_q` (`reg-index.h:55-81`). При `wbs = 4` и начальных `size_q = 8` это 8 регистров.

**Измерено прогоном** (`src/e2k/e2kCallWindowQemu.test.ts`, различающий перебор: ловушка на первой
команде тела значит «регистр недоступен»):

| что | результат |
|---|---|
| вызываемая пишет в свой `%r5`, `%r7` | **доступны** |
| вызываемая пишет в свой `%r8`, `%r9`, `%r10` | **ловушка** на первой команде тела |
| системный вызов из вызываемой | **невозможен**: номер вызова ABI читает из `%r8`, которого у вызываемой нет |
| `return %ctpr3` **одна** | порт **падает на утверждении** `op_descr->is_al` (`e2k_update_used_regs_context`, `translate-lookahead.c:318`), статус 134 |
| `return %ctpr3` **и** `ct %ctpr3` подряд | **управление возвращается** (статус 99 у вызывающего), утверждения нет — разведка и цитаты в `docs/e2k-return-port.md` |
| системный вызов вызывающего ПОСЛЕ возврата | **проходит** (код 99): геометрия окна восстанавливается из кадра вызова (`e2k_cpu_exec_ct_return`, `translate-ct.c:56-67`). Прежняя запись «падает с `syscall without proper WD configuration`» **снята**: она наблюдалась, когда возврата не было вовсе |

**Следствие для раскладки — и оно неприятное.** Процедура, которой нужно больше восьми регистров,
**вызвана быть не может**. Измерено по ядрам (`calleeWindow` в отчёте; столбец «нужно» **перемерен
2026-09-24 ТРЕТИЙ раз** — `.tmp/measure-realrun.ts`, после минимального вытеснения в память: у
`фильтр` и `корреляции` требование **упало 12 → 10**, потому что 1 и 2 значения уехали в слот):

| ядро | вызываемая | нужно регистров окна | влезает в 8? |
|---|---|---|---|
| fir | `фильтр` | **10** (было 12: два параметра плюс восемь занятых) | **нет** |
| fir | `сумма` | 6 | да |
| iir | `целое_деление` / `фильтр` / `сумма` | 4 / **7** / 6 | да |
| fft | `бпф4` | **9** | **нет** |
| correlation | `корреляция` | **10** (было 12) | **нет** |
| convolution | `свёртка` | **13** (раскладка и не удалась: нужно больше двух вытеснений) | **нет** |

То есть шаг 1 («17 vreg'ов в десять регистров») верен для **точки входа**, а как только появляется
вызов, бюджет вызываемой вдвое меньше — и `фильтр` ядра FIR в него не входит даже после вытеснения.
Расширить окно можно `setwd` (расширение измерено, §7.6), но с памятью модель ведёт себя неустойчиво,
и владельцем это отложено; вытеснение в память **сделано 2026-09-24** (`docs/e2k-regalloc-debt.md`
§14) и сократило требование до десяти — но не до восьми.

**Чего эти числа НЕ доказывают — и это важнее самих чисел.** Размер окна у вызываемой зависит от
**начальных** `psize_q = 4`, `size_q = 8`, а их задаёт **порт**, а не ISA
(`qemu/linux-user/e2k/cpu_loop.c:302-303` — инициализация процесса в этом порте). Настоящий e2k имеет
регистровый файл 256 регистров и окно до 224 (§7.6), то есть на железе окно вызываемой может быть
**больше восьми**. Поэтому «окно вызываемой — восемь» записано не фактом, а **долгом перед железом**
(`docs/hardware-debt.md` §3.18): проверяется только на железе. Здесь измерено другое, и оно твёрдое:
в этой модели процедура, которой нужно больше восьми регистров, вызвана быть не может.

### 7.11. Вызов и возврат: понижение и соглашение (07.2026)

Понижение сделано, потому что **не требует решения по регистрам** и проверяется без исполнения.

| шаг | что эмитируется | чем обосновано |
|---|---|---|
| аргументы (до 2) | `movts <аргумент>, %r(2*wbs + i)` — в **окно вызываемого** | индекс окна = `base_d + idx`, `call` прибавляет `2*wbs` двоичных слов (`reg-index.h:79`); измерено опытом §7.10: вызываемая читает свои `%r0`/`%r1`, а `%r8` и выше ей недоступны |
| передача | `disp %ctpr1, <смещение вызова>` + `call %ctpr1, wbs=4` | байты `call %ctpr1, wbs=4` сверены с `as` (`src/e2k/e2kSyllables.test.ts`); `wbs = 4` — минимум: модель требует `wbs ≥ psize_q`, начальный `psize_q = 4` |
| результат | вызываемая кладёт его в свой `%r0` (`movts` перед `return`), вызывающий читает из `%r(2*wbs)` | тот же сдвиг окна; приёмник назван, а не угадан |
| возврат | `return %ctpr3` | форма CS0, байты сверены с `as`; адрес возврата готовит сам `call` |

Смещение вызова считает **одна** функция — `callDisplacementsOf` (`src/e2k/e2kRealRun.ts`): цель это
адрес первой команды вызываемой процедуры, а `disp` идёт **после** пересылок аргументов, то есть не по
адресу носителя. Оракул берёт ту же функцию, а не свою копию формулы.

**Измерено после этого шага:** пять ядер **357 → 399** понижено, отказов **51 → 9**; у FIR
**94 из 94** — все носители понижены, отказов нет. Остались `iir` (вещественное `IR.div` и вызов
`система.математика.остаток` — не операция массива) и `convolution` (раскладка `свёртки` отказывает:
шесть вызовов массива без регистров и один вызов без адреса цели).

**Чего это не доказывает:** что вызов **исполнится**. Соглашение проверено по байтам, дизассемблеру и
круговой сверке; исполнение упирается в порт (§7.10: `return` — утверждение транслятора; окно
вызываемой — восемь регистров). Оракул `src/e2k/e2kCallLowering.test.ts` (10 проверок) фиксирует ровно
это: порядок команд, регистры аргументов, приёмник результата — и **не** обещает прогона.

### 7.12. Можно ли сократить `фильтр` до восьми регистров: материализация **не помогает** (07.2026)

**Прежняя запись этого раздела была неверной, и вот чем.** Здесь стояло: «повторная материализация
констант даёт семь регистров вместо десяти — путь без spill есть». Число было получено **моделью не
того**: замер выбрасывал отрезки всех vreg'ов, которые где-то определялись константой, — вместе с
отрезками, определёнными **пересылками**. Это не материализация, а «делаем вид, что этих регистров
нет». Правильный замер — реализация (`src/e2k/rematerialize.ts`), и он даёт другое.

**Что делает реализация.** Материализуется **одно определение**, а не «vreg вообще»: чтения берутся
между определением и следующим определением того же vreg; нужны минимум два чтения; если между
определением и последним чтением есть цель перехода или сам переход — отказ (иначе на чтение можно
прийти путём, где определение не исполнялось, а переопределение успело); определение-цель не убирается.
Правило проверено оракулом `src/e2k/rematerialize.test.ts` (7 проверок).

**Измерено реализацией — по всем пяти ядрам:** материализуется **ноль** определений.
У `фильтр` констант пять: у четырёх (v6, v12, v13, v14) у определения **одно** чтение, а у пятой (v7,
четыре чтения) промежуток до последнего чтения пересекает цель перехода (18) и переход (19) — правило
границ блоков отказывает. Нужно регистров окна `фильтр` как было **10** (2 закреплено + 8 выдано), и в
бюджет вызываемой (8) он по-прежнему **не входит**.

**Перемер 2026-09-24.** «Нужно 10» тоже снято против незвуковых правил. После правки раскладки
(`docs/e2k-regalloc-debt.md` §1–§3) сумма считается иначе: в окне вызываемой **11** живых отрезков при
8 свободных, а в десяти регистрах — **13** при 10, то есть раскладка `фильтр` **отказывает**, и
раскладка по отрезкам отказывает не из-за копий: их стало меньше (снято 7 вместо 8), а требование
выросло — слияние переносимых через цикл отрезков честно учитывает жизнь через обратную дугу.
Вывод раздела «материализация не помогает» **усилился**: она не помогает ещё и потому, что бюджет
теперь недостижим в принципе — нужен шаг 4 (§5 того же документа).

**Что осталось, чтобы `фильтр` влез в восемь регистров** (честный список, а не обещание):

| средство | состояние |
|---|---|
| устранение копий | сделано, даёт 10; до неподвижной точки — ничего (замер `.tmp/shrink-filter.ts`) |
| материализация констант | **реализована и не помогает** (этот раздел) |
| вытеснение в память (spill) | не сделано: следующий слой, требует памяти и правила выбора значений |
| `setwd` (окно шире) | расширение измерено (§7.6), но с памятью модель неустойчива — отложено владельцем |
| бюджет вызываемой на железе | возможно больше восьми: начальную геометрию окна задаёт порт (§7.10, `docs/hardware-debt.md` §3.18) |

### 7.13. Утверждение порта на `return`: обход через сборку **невозможен** (07.2026)
**Что именно падает.** `assert(op_descr->is_al)` в `e2k_update_used_regs_context`
(`qemu/target/e2k/tcg/translate-lookahead.c:318`): разбор AL-каналов получил операцию, чей дескриптор
не является AL-операцией. Замер (`.tmp/assert-probe.ts`) различает причины: программа из **одной**
команды `return %ctpr3` уже даёт статус **134** и это утверждение; та же передача управления формой `ct`
даёт обычную ловушку. То есть дело в **самой форме возврата**, а не в связке с пересылками.

**Наши байты при этом верны:** `return %ctpr3` → `01 40 00 00 00 00 00 f0` сверено с ассемблером МЦСТ
и читается дизассемблером (`src/e2k/e2kSyllables.test.ts`). Значит утверждение — свойство **порта**, а
не нашей кодировки.

**Обход через сборку проверен и невозможен.** Модель собрана с `buildtype=debug`, `b_ndebug=false`
(проверено `meson configure /root/qemu-build`), и в двоичном файле есть `__assert_fail`. Попытка
пересобрать без утверждений (`meson configure -Db_ndebug=true && ninja`) **отвергается самим QEMU**:

```
#error building with NDEBUG is not supported
```

Сборка не состоялась, двоичный файл не изменился (проверено: `qemu-e2k` от 18 сентября, размер тот же,
поведение то же — утверждение на `return` воспроизводится), конфигурация возвращена в `b_ndebug=false`.

**Что остаётся:** правка **исходника порта** (как с полями `WD._d`, §3.10) — то есть изменение модели,
которое нужно назвать своим и обосновать; либо признать долгом перед железом. Утверждение охраняет
инвариант («в AL-канале лежит AL-операция»), и снятие его без разбора означает, что разбор может
молча выдать неверную трансляцию. Решение — за владельцем; до него это долг (§3.18
`docs/hardware-debt.md`).



### 7.14. Деление и остаток: формы найдены (07.2026)

**Найдено в источнике** (`opcodes/e2k-opc.h`, binutils МЦСТ, ветка `binutils-mcst-2.41`; в НАШЕЙ таблице
их не было — отсюда отказ `IR.div` в ядре `iir`):

| строка | мнемоника | код | аргументы (МЦСТ) | смысл по руководству §10.3.3 |
|---|---|---|---|---|
| :59 | `udivs` | 0x40 | `ARGS_SSS` | деление без знака 32/32→32 |
| :64 | `udivd` | 0x41 | `ARGS_DDD` | деление без знака 64/64→64 |
| :69 | `sdivs` | 0x42 | `ARGS_SSS` | деление со знаком 32/32→32 |
| :74 | `sdivd` | 0x43 | `ARGS_DDD` | деление со знаком 64/64→64 |
| :39 | `udivx` | 0x44 | `ARGS_DSS` | деление без знака 64/32→32 |
| :44 | `umodx` | 0x45 | `ARGS_DSS` | остаток без знака 64/32→32 |
| :49 | `sdivx` | 0x46 | `ARGS_DSS` | деление со знаком 64/32→32 |
| :54 | `smodx` | 0x47 | `ARGS_DSS` | остаток со знаком 64/32→32 |

**Каналы — только пятый** (`{0,0,0,0,0,1}` против `{1,1,1,1,1,1}` у `adds`, :19). Это не мелочь: попытка
положить форму в другой канал — отказ с причиной («запрещён источником»), а не молчаливая запись бита.
Руководство и язык ассемблера говорят то же: пример §10.3.3 — `sdivs,5 %g17, %g16, %g16`, канал
пишется явно.

**Замерено ассемблером МЦСТ** (`as-new -mcpu=elbrus-v5`, `.tmp/div-forms.ts`) — собираются все восемь,
по 8 байт, код операции последним байтом:

| текст | байты |
|---|---|
| `sdivs,5 %b[1], %b[2], %b[3]` | `01 00 00 80 03 02 01 42` |
| `udivs,5 %b[1], %b[2], %b[3]` | `01 00 00 80 03 02 01 40` |
| `sdivd,5 %db[1], %db[2], %db[3]` | `01 00 00 80 03 02 01 43` |
| `udivd,5 %db[1], %db[2], %db[3]` | `01 00 00 80 03 02 01 41` |
| `sdivx,5 %db[1], %b[2], %b[3]` | `01 00 00 80 03 02 01 46` |
| `udivx,5 %db[1], %b[2], %b[3]` | `01 00 00 80 03 02 01 44` |
| `smodx,5 %db[1], %b[2], %b[3]` | `01 00 00 80 03 02 01 47` |
| `umodx,5 %db[1], %b[2], %b[3]` | `01 00 00 80 03 02 01 45` |

Оракул — `src/e2k/e2kDivisionForms.test.ts` (5 проверок): форма, код, каналы и разрядность из
источника; байты наши против пришпиленных измеренных; канал кроме пятого — отказ; живая сверка с
ассемблером МЦСТ (тексты те же, байты те же).

**Чего это не доказывает и что из-за этого НЕ сделано:**

- формы **не исполнены** моделью (в порте их не было вовсе — как и в нашей таблице);
- семантика **расходится** с нашим `IR.div`: в `src/runtime/vm/reginterpreter.ts:321` деление —
  **точное** (`a / b`), а `SDIVs` **отсекает** дробную часть и даёт `exc_div` при делителе 0. Подставить
  одно вместо другого — **решение**, а не следствие, поэтому `IR.div` остаётся отказом с этой причиной
  (в отчёте ядра `iir` она и печатается);
- **остатка 32-битного в источнике нет**: есть только `UMODX`/`SMODX` — 64/32→32 (расширенное делимое).
  Поэтому хост-вызов `система.математика.остаток` не понижен: нужен либо знаковый разряд 64-битного
  делимого, подтверждённый замером, либо вычисление `a − (a/b)·b`. Записано, а не выдумано.

