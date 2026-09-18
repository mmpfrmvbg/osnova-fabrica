# Загрузка 64-битного значения в регистр e2k: разведка, кандидаты, форма

**Что искалось.** Форма (или последовательность форм), которой 64-битное значение — адрес буфера,
имя файла, размер `mmap` — кладётся в **оконный** регистр `%rN`. Без неё из минимального набора
исполнимы только `exit` и `close` (`docs/e2k-syscalls-minimal.md` §2), потому что syscall ABI
читает аргументы из оконных `r1..r8` (`docs/e2k-syscall-abi.md` §1).

**Статус.** Форма **найдена** в источниках и подтверждена ассемблером МЦСТ. Прогоном в модели
**НЕ ПРОВЕРЕНО ИСПОЛНЕНИЕМ**. Реализация в этом сеансе не выполнялась.

| | |
|---|---|
| дерево источников (только чтение) | `.tmp/e2k-sources/` |
| ассемблер | `GNU assembler (GNU Binutils) 2.41.0-29.023` — `/root/build-gas/gas/as-new`, WSL1, `-mcpu=elbrus-v5` |
| дизассемблер | `GNU objdump (GNU Binutils) 2.41.0-29.023` — `/root/build/binutils/objdump` |
| пробы | `.tmp/addr-probe/` (`.s`, `.o`, `.bin`) |
| оракул этого документа | `src/scripts/e2kAddressLoading.audit.test.ts` |

---

## 1. Сырые данные (разведка)

### 1.1. `elbrus-docs/README.md` — таблица кодирования src2

Единственное место, где кодирование литералов описано **текстом** для человека:

| фрагмент источника | строка |
|---|---|
| `LTS \| Literal syllable - literals to be used as operands` | `elbrus-docs/README.md:129` |
| `src2 \| als[15:8] \| source operand 2 - can encode access to literal syllables (LTS)` | `elbrus-docs/README.md:436` |
| `1101 000x \| d0-d1 \| reference to 16 bit literal semi-syllable, low half of LTS0 or LTS1` | `elbrus-docs/README.md:458` |
| `1101 010x \| d4-d5 \| reference to 16 bit literal semi-syllable, high half of LTS0 and LTS1` | `elbrus-docs/README.md:459` |
| `1101 10xx \| d8-db \| reference to 32 bit literal syllable LTS0, LTS1, LTS2, or LTS3` | `elbrus-docs/README.md:460` |
| **`1101 11xx \| dc-de \| reference to 64 bit literal syllable pair LTS1:LTS0, LTS2:LTS1, or LTS3:LTS2`** | `elbrus-docs/README.md:461` |
| `Literal half-syllables are sign-extended on access.` | `elbrus-docs/README.md:464-465` |

**Это и есть искомое:** `dc-de` — ссылка на **пару** LTS-слогов, то есть 64-битный литерал.

Там же — соответствие 32- и 64-битных имён регистров (`elbrus-docs/README.md:50-54`):

```
 32-bit | 64-bit | description
 `%g0`  |`%dg0`  | Global register (0-31)
 `%r0`  |`%dr0`  | Procedure stack register, relative to start of current window
 `%b[0]`|`%db[0]`| Mobile base registers, relative to the start of the current window, plus `BR`
```

Следствие: `%drN` — **то же окно**, что `%rN`, только 64-битное представление. Значит запись в
`%drN` видна в оконном `rN`, который читает syscall ABI.

### 1.2. `binutils-gdb/opcodes/e2k-dis.c` — разбор литералов дизассемблером

| факт | источник |
|---|---|
| 16-битный: `(src2 & 0xf8) == 0xd0`, `lit_num = src2 & 3`, бит 2 — старшая половина | `binutils-gdb/opcodes/e2k-dis.c:459-479` |
| 32-битный: `(src2 & 0xfc) == 0xd8` | `binutils-gdb/opcodes/e2k-dis.c:480-484` |
| **64-битный: `(src2 & 0xfc) == 0xdc`**, занимает `lts[lit_num]` и `lts[lit_num+1]` | `binutils-gdb/opcodes/e2k-dis.c:485-508` |
| `lit_num == 3` для 64-битного — **нелегально** (`<illegal _f64,_lts3>`) | `binutils-gdb/opcodes/e2k-dis.c:490-491` |
| если второго слота нет — `<nonexistent _f64,_ltsN>` | `binutils-gdb/opcodes/e2k-dis.c:492-494` |
| печать значения: `0x%x%08x` — старшее слово первым | `binutils-gdb/opcodes/e2k-dis.c:503-506` |

### 1.3. `binutils-gdb/gas/config/tc-e2k.c` — таблицы ассемблера

| факт | источник |
|---|---|
| `{"_f16s", {LITERAL_16, 1}}, {"_f16", …}, {"_f32s", {LITERAL_32, 1}}, {"_f32", …}, {"_f64", {LITERAL_64, 0}}` | `binutils-gdb/gas/config/tc-e2k.c:1814-1819` |
| размещение: `_lts0lo{0,0}`, `_lts0hi{1,1}`, `_lts0{0,1}`, `_lts1lo{2,2}`, `_lts1hi{3,3}`, `_lts1{2,3}`, `_lts2{4,4}`, `_lts3{6,6}` | `binutils-gdb/gas/config/tc-e2k.c:1853-1862` |
| таблица допустимых размещений: `LITERAL_64` занимает `_lts0lo`, `_lts1lo`, `_lts2lo` (два слота) | `binutils-gdb/gas/config/tc-e2k.c:1864-1870` |
| `parse_mova_args` определена, но **не вызывается**: мнемоник `mova*` в таблице опкодов нет | `binutils-gdb/gas/config/tc-e2k.c:4635` |

### 1.4. `binutils-gdb/opcodes/e2k-opc.h` — нужные мнемоники

| мнемоника | строка источника | запись |
|---|---|---|
| `movts` | `binutils-gdb/opcodes/e2k-opc.h:644` | `ALOPF2, NO_MAS, 0x60, {1,1,0,1,1,0}, ARGS_SS, 0xc0` |
| `movtd` | `binutils-gdb/opcodes/e2k-opc.h:664` | `ALOPF2, NO_MAS, 0x61, {1,1,0,1,1,0}, ARGS_DD, 0xc0` |
| `movtq` | `binutils-gdb/opcodes/e2k-opc.h:2814` | `ALOPF22, NO_MAS, 0x57, {1,1,0,1,1,0}, ARGS_QQ, 0xc0` |

### 1.5. QEMU — разбор и запись

| факт | источник |
|---|---|
| разбор src2: `(src & 0x10) == 0` → IMM_SHORT; иначе `(src & 0x08) == 0` → IMM16; иначе `(src & 0x04) == 0` → IMM32; иначе **IMM64** | `qemu-e2k/qemu/target/e2k/decoder.h:186-195` |
| приёмник: `dst` с `(rt7 && !rt6)` → `E2K_SRC_DST_PARSED_TYPE_WINDOW`, `val = dst & 0x3F` (для `0x88` это окно 8) | `qemu-e2k/qemu/target/e2k/decoder.h:215-219` |
| IMM64: `imm_val = lts[val]`; **старшие 32 бита добавляются только для `D`, `X`, `QP`** | `qemu-e2k/qemu/target/e2k/tcg/translate-al.c:1685-1703` |
| то же условие отдельной строкой | `qemu-e2k/qemu/target/e2k/tcg/translate-al.c:1697` |
| `MOVTS`: читает `get_src_val_sw` (32 бита) и пишет **только `lo32`** | `qemu-e2k/qemu/target/e2k/tcg/translate-al-c12.c:26-45` |
| `MOVTD_RF`: читает `get_src_val_dw` (64 бита) и пишет **весь `lo`** | `qemu-e2k/qemu/target/e2k/tcg/translate-al-c12.c:47-66` |
| `MOVTQ`: тоже 64-битная запись в `lo` (в источнике помечена как заглушка) | `qemu-e2k/qemu/target/e2k/tcg/translate-al-c12.c:68-88` |
| регистр — структура `{ uint64_t lo; uint64_t hi; uint32_t tag_unpacked; }` | `qemu-e2k/qemu/target/e2k/cpu.h:110-114` |
| `movtd` разбирается в `E2K_OP_MOVTD_CTPR` либо `E2K_OP_MOVTD_RF` | `qemu-e2k/qemu/target/e2k/decoder.c:590-608` |
| syscall ABI читает аргумент как `arg_p->lo` | `qemu-e2k/qemu/linux-user/e2k/cpu_loop.c:177` |

**Это ключ к выбору кандидата:** для `movts` (`S`) старшие 32 бита литерала в модели теряются
(`translate-al.c:1697` + запись `lo32` в `translate-al-c12.c:37`), а для `movtd` (`D`) записывается
весь `lo` (`translate-al-c12.c:58`).

### 1.6. LLVM — как компилятор объявляет те же формы

| факт | источник |
|---|---|
| `defm MOVTS : ALSEXTInst<0x60, 0xC0, "movts", format.alopf2, S_S, c.c0134>` | `llvm-project/llvm/lib/Target/E2K/E2KInstrInfo.td:513` |
| `defm MOVTD : ALSEXTInst<0x61, 0xC0, "movtd", format.alopf2, D_D, c.c0134>` | `llvm-project/llvm/lib/Target/E2K/E2KInstrInfo.td:520` |
| `defm MOVTQ : ALESEXT2Inst<0x57, 0x01, 0xC0, "movtq", format.alopf11, QQ_Q, c.c03>` | `llvm-project/llvm/lib/Target/E2K/E2KInstrInfo.td:950` |

### 1.7. Что умеет наш кодировщик (для планирования, не для правки)

| факт | источник |
|---|---|
| `movts` (opc `0x60`) и `movtd` (opc `0x61`) **есть** в таблице форм | `src/e2k/e2k-real.ts:232-233` |
| поля литералов: `LITERAL_FIELD_F16 = 0xd4`, `LITERAL_FIELD_F32 = 0xd8` | `src/e2k/e2k-real.ts:791-792` |
| 64-битная форма `0xdc` **не реализована** — бросается `EncodingRefusedError` с текстом «64-битная форма (0xdc, два слова литералов) не реализована» | `src/e2k/e2k-real.ts:806-810` |

### 1.8. Где искали и не нашли

| что искали | результат |
|---|---|
| мнемоники `movad`, `movaq`, `mova*` | **НЕТ В ИСТОЧНИКЕ**: в `binutils-gdb/opcodes/e2k-opc.h` ни одной строки с `mova`; `parse_mova_args` (`binutils-gdb/gas/config/tc-e2k.c:4635`) не вызывается ни разу |
| отдельная инструкция «загрузить адрес» | **НЕТ В ИСТОЧНИКЕ**: в таблице опкодов нет мнемоник с корнем `mova`; загрузка константы делается той же формой `movt*` |
| `movtq` с литералом | отвергается ассемблером (точный текст — §3) |
| модель загрузки адреса в `translate-mem.c` | там обрабатываются `is_imm` для src3 у LD/ST (`qemu-e2k/qemu/target/e2k/tcg/translate-mem.c:1051`, `:1342`), но это адрес **внутри** команды доступа к памяти, а не загрузка значения в регистр |

---

