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
| LDB, LDH, LDW, LDD | `ldb` (ALOPF1, `0x64`, :604); `ldd` (ALOPF1, `0x67`, :619); `ldh` (ALOPF1, `0x65`, :609); `ldw` (ALOPF1, `0x66`, :614) |  |
| STB, STH, STW, STD | `stb` (ALOPF3, `0x24`, :969); `std` (ALOPF3, `0x27`, :984); `sth` (ALOPF3, `0x25`, :974); `stw` (ALOPF3, `0x26`, :979) |  |
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

## 5. Сводка

| показатель | значение |
|---|---|
| строк спецификации разобрано | 66 |
| мнемоник найдено в таблице опкодов МЦСТ | 318 |
| строк спецификации без находки в таблице | 6 |
| записей в таблице опкодов всего | 4271 (уникальных имён 3096) |
| строк источника разобрано | 21372 |

