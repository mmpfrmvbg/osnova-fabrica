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

## 2. Кандидаты

Все байты ниже **измерены** ассемблером (§3). Форма записи: `мнемоника,канал литерал, приёмник`.

### К1. `movts,0 <32-бит>, %rN` — 32-битный литерал (`_f32s`)

| | |
|---|---|
| мнемоника | `movts` — `binutils-gdb/opcodes/e2k-opc.h:644` |
| формат | ALF2, поле src2 = `0xd8` (`_f32s`); S_S |
| разрядность | **32 бита** (`d8-db` — `elbrus-docs/README.md:460`) |
| как грузить | одним операндом-литералом: `movts,0 0x100000, %r8` |
| ограничение | значения вне `±2^31` ассемблер **молча обрезает** (см. §3, строка «обрезка») |
| модель QEMU | `IMM32` → `lts[val]` (`qemu-e2k/qemu/target/e2k/tcg/translate-al.c:1677-1684`), запись в `lo32` (`translate-al-c12.c:37`) |
| годится для | адресов < 4 ГБ — в том числе буфера и имени файла внутри нашего ELF |

### К2. `movts,0 _f64 <64-бит>, %rN` — 64-битный литерал в S-форме

| | |
|---|---|
| мнемоника | `movts` — `binutils-gdb/opcodes/e2k-opc.h:644` |
| формат | ALF2, поле src2 = `0xdc` (`_f64`); два LTS-слота |
| разрядность | **64 бита кодируются** (`dc-de` — `elbrus-docs/README.md:461`) |
| как грузить | `movts,0 _f64 0x0000d00000000000, %r8` |
| ассемблер | собирает, байты 64-битного значения сохранены полностью (§3) |
| модель QEMU | **теряет старшие 32 бита**: для `S` условие `translate-al.c:1697` не выполняется, а `MOVTS` пишет только `lo32` (`translate-al-c12.c:37`) |
| вывод | кодируется, но модель QEMU-e2k для оконного `S`-приёмника доводит до регистра только младшие 32 бита |

### К3. `movtd,0 _f64 <64-бит>, %rN` — 64-битный литерал в D-форме (**рекомендуется**)

| | |
|---|---|
| мнемоника | `movtd` — `binutils-gdb/opcodes/e2k-opc.h:664` |
| формат | ALF2, opcode `0x61`, поле src2 = `0xdc` (`_f64`); D_D |
| разрядность | **64 бита** (`dc-de` — `elbrus-docs/README.md:461`; `LITERAL_64` — `binutils-gdb/gas/config/tc-e2k.c:1819`) |
| как грузить | `movtd,0 _f64 <64-бит>, %rN` — одним операндом |
| приёмник | `%rN` и `%drN` — один и тот же регистр окна (`elbrus-docs/README.md:50-54`) |
| ассемблер | собирает; 64-битное значение в байтах сохранено полностью (§3) |
| модель QEMU | для `D` условие `translate-al.c:1697` **выполняется** → `imm_val` 64-битный; `MOVTD_RF` пишет весь `lo` (`translate-al-c12.c:58`), а syscall читает `arg_p->lo` (`qemu-e2k/qemu/linux-user/e2k/cpu_loop.c:177`) |
| ограничение | канал тот же, что у `movts` — `{1,1,0,1,1,0}` (`binutils-gdb/opcodes/e2k-opc.h:644`, `:664`): каналы 2 и 5 запрещены |

### К4. `movtd,0 <32-бит>, %rN` — 32-битный литерал в D-форме

| | |
|---|---|
| формат | ALF2, opcode `0x61`, src2 = `0xd8` (`_f32s`) |
| разрядность | 32 бита значения в 64-битную запись |
| модель QEMU | `IMM32` → 32-битное `imm_val`, `MOVTD_RF` пишет `lo` целиком (`translate-al-c12.c:58`) |
| смысл | то же, что К1, но с расширением до 64 бит при записи; для адресов < 4 ГБ разницы с К1 нет |

### К5. `movtq,0 _f64 <64-бит>, %qrN` — **отвергнут ассемблером**

| | |
|---|---|
| мнемоника | `movtq` — `binutils-gdb/opcodes/e2k-opc.h:2814` |
| результат | отказ, точный текст — §3 |
| причина по источнику | форма `ARGS_QQ` в `format.alopf11` (`llvm-project/llvm/lib/Target/E2K/E2KInstrInfo.td:950` — `QQ_Q`); литерал в позиции quad-операнда запрещён |

### Сравнение

| кандидат | разрядность | ассемблер | модель QEMU | годится для |
|---|---|---|---|---|
| К1 `movts`+`_f32s` | 32 бита | собирает | сохраняет 32 бита | адреса < 4 ГБ |
| К2 `movts`+`_f64` | 64 бита в коде | собирает | теряет старшие 32 бита | — (форма кодируется, но модель её не доводит) |
| **К3 `movtd`+`_f64`** | **64 бита** | **собирает** | **сохраняет все 64 бита** | **любые 64-битные значения** |
| К4 `movtd`+`_f32s` | 32 бита | собирает | сохраняет 32 бита | адреса < 4 ГБ |
| К5 `movtq`+`_f64` | — | отказ | — | — |

**Проще всего** К3: одна инструкция, одно значение, 64 бита, ширина не зависит от величины адреса.

---

## 3. Проверка ассемблером

`/root/build-gas/gas/as-new -mcpu=elbrus-v5`, дизассемблер `/root/build/binutils/objdump`.
Байты — из `objcopy -O binary -j .text`. Пробы лежат в `.tmp/addr-probe/`.

| № | ассемблерный текст | байты (hex) | дизассемблер МЦСТ |
|---|---|---|---|
| контроль | `movts,0 1, %r8` | `0100000488c1c060` (8 байт) | `movts,0 0x1, %r8` |
| К1 | `movts,0 0x100000, %r8` | `1100000488d8c0600000000000001000` | `movts,0 _f32s 0x100000, %r8` |
| К2 | `movts,0 _f64 0x100000, %r8` | `1100000488dcc0600000000000001000` | `movts,0 _f64 0x100000, %r8` |
| К2 | `movts,0 _f64 0x100000, %r9` | `1100000489dcc0600000000000001000` | `movts,0 _f64 0x100000, %r9` |
| К2 | `movts,0 _f64 0x100000, %r11` | `110000048bdcc0600000000000001000` | `movts,0 _f64 0x100000, %r11` |
| **К3** | `movtd,0 _f64 0x100000, %r8` | `1100000488dcc0610000000000001000` | `movtd,0 _f64 0x100000, %dr8` |
| К3 | `movtd,0 _f64 0x100000000, %r8` | `1100000488dcc0610100000000000000` | `movtd,0 _f64 0x100000000, %dr8` |
| К3 | `movtd,0 _f64 0xdeadbeefcafebabe, %r8` | `1100000488dcc061efbeaddebebafeca` | `movtd,0 _f64 0xdeadbeefcafebabe, %dr8` |
| К3 | `movtd,0 _f64 0x0000d00000000000, %r8` | `1100000488dcc06100d0000000000000` | `movtd,0 _f64 0xd00000000000, %dr8` |
| К3 | `movtd,0 _f64 0xffffffffffffffff, %r8` | `1100000488dcc061ffffffffffffffff` | `movtd,0 _f64 0xffffffffffffffff, %dr8` |
| К3 | `movtd,0 _f64 0x100000, %r11` | `110000048bdcc0610000000000001000` | `movtd,0 _f64 0x100000, %dr11` |
| К4 | `movtd,0 0x100000, %r8` | `1100000488d8c0610000000000001000` | `movtd,0 _f32s 0x100000, %dr8` |

**Различие К1/К2 и К3 в байтах — один байт:** позиция 7 (`0x60` — `movts`, `0x61` — `movtd`);
различие 32- и 64-битного литерала — позиция 5 (`0xd8` — `_f32s`, `0xdc` — `_f64`).

### Обрезка при 32-битном литерале — **молчаливая**

| ассемблерный текст | байты | дизассемблер |
|---|---|---|
| `movts,0 0x100000000, %r8` | `1100000488d8c0600000000000000000` | `movts,0 _f32s 0x0, %r8` |
| `movts,0 _f32s 0x100000000, %r8` | `1100000488d8c0600000000000000000` | `movts,0 _f32s 0x0, %r8` |

Ассемблер **собрал** обе строки без предупреждения и без ошибки; значение `0x100000000`
заменилось на `0x0`. Практический вывод: явный `_f64` обязателен, иначе адрес старше 4 ГБ
теряется незаметно.

### Отказы (точный текст)

| ассемблерный текст | текст ошибки |
|---|---|
| `movtq,0 _f64 0x100000, %qr8` | `Error: literal is not allowed in position of %q(uad) operand` |
| `movtq,0 0x100000, %r8` | `Error: literal is not allowed in position of %q(uad) operand` |
| `movts,0 _f32s,_lts0hi 0x100000, %r8` | `Error: Invalid combination of literal format and location` |

---

## 4. Документ

### 4.1. Что найдено в источнике

1. **64-битный литерал существует как отдельная форма ссылки**: `1101 11xx | dc-de` — «reference to
   64 bit literal syllable pair LTS1:LTS0, LTS2:LTS1, or LTS3:LTS2» (`elbrus-docs/README.md:461`).
2. **Разбор этой формы в дизассемблере**: `(src2 & 0xfc) == 0xdc`, два LTS-слота, `lit_num == 3`
   нелегален (`binutils-gdb/opcodes/e2k-dis.c:485-508`, `:490-491`).
3. **Спецификатор для ассемблера**: `{"_f64", {LITERAL_64, 0}}`
   (`binutils-gdb/gas/config/tc-e2k.c:1819`), размещение — `_lts0lo`/`_lts1lo`/`_lts2lo`
   (`binutils-gdb/gas/config/tc-e2k.c:1867-1869`).
4. **Разбор в модели**: `(src & 0x04) != 0` → `IMM64` (`qemu-e2k/qemu/target/e2k/decoder.h:191-195`).
5. **Запись 64 бит в оконный регистр**: `MOVTD_RF` пишет `temp_res_full.lo` целиком из
   `get_src_val_dw` (`qemu-e2k/qemu/target/e2k/tcg/translate-al-c12.c:53-58`), при этом старшие
   32 бита читаются из второго LTS-слота для типа `D` (`qemu-e2k/qemu/target/e2k/tcg/translate-al.c:1697`).
6. **`%drN` и `%rN` — один регистр окна** (`elbrus-docs/README.md:50-54`).
7. **Ассемблер собирает** `movtd,0 _f64 <64-бит>, %rN` и сохраняет значение целиком (§3).

### 4.2. Что не найдено

| чего нет | как проверено |
|---|---|
| мнемоник `movad`/`movaq`/`mova*` | в `binutils-gdb/opcodes/e2k-opc.h` нет ни одной строки с `mova`; `parse_mova_args` (`binutils-gdb/gas/config/tc-e2k.c:4635`) не вызывается |
| отдельной инструкции «загрузить адрес» | в таблице опкодов такой мнемоники нет; используется та же `movt*` |
| текста «вот так грузится 64-битный адрес» | формула собрана из трёх источников (таблица литералов + модель + ассемблер), прямого описания нет |
| **прогона формы в модели** | НЕ ПРОВЕРЕНО ИСПОЛНЕНИЕМ: исполнения `movtd` с `_f64` в QEMU в этом сеансе не было |
| проверки формы в кодировщике проекта | 64-битная форма `0xdc` в `src/e2k/e2k-real.ts:806-810` **не реализована** |
| `_f128` | закомментирован: `/* {"_f128_hi", }, {"_f128_lo", }, {"_f128", }*/` (`binutils-gdb/gas/config/tc-e2k.c:1820-1822`) |

### 4.3. Кандидаты (с источником и проверкой ассемблера)

К1–К5 — раздел 2; у каждого назван источник формата, источник разрядности и результат прогона
ассемблера. Отдельно: дизассемблер **подтверждает** выбор формы обратно — для байтов К3 он печатает
`movtd,0 _f64 0x100000, %dr8`, то есть 64-битное значение и 64-битный регистр
(`.tmp/addr-probe`, §3).

### 4.4. Рекомендация

**Грузить 64-битный адрес формой К3 — `movtd,0 _f64 <значение>, %rN`:**

```asm
        movtd,0 _f64 0x100000, %r8        ; окно 8 → оконный r0 вызываемого (wbs=4)
```

Байты (измерено): `11 00 00 04 88 dc c0 61 00 00 00 00 00 00 10 00`
(`movtd, opcode 0x61`, литерал `_f64`, окно `%r8`).

Для адресов, заведомо меньших 4 ГБ, годится и К1 — `movts,0 <адрес>, %rN`; но тогда `_f32s`
подставляется ассемблером **молча**, и ошибка величины не диагностируется (§3).

Полная последовательность для `write(1, buf, 5)` приняла бы вид (аргументы — из
`docs/e2k-syscalls-minimal.md` §3.3; шаблон вызова — `docs/e2k-syscall-abi.md` §3):

```asm
        setbn   rsz = 4, rbs = 0, rcur = 0
        movts,0 4,    %r8          ; номер write (linux-user/e2k/syscall_nr.h:12)
        movts,0 1,    %r9          ; fd = 1
        movtd,0 _f64 <адрес>, %r10 ; buf — 64-битный адрес (К3)
        movts,0 5,    %r11         ; count = 5
        sdisp   %ctpr1, 0          ; тег CTPSL
        call    %ctpr1, wbs = 4
```

**Статус примера: НЕ ПРОВЕРЕНО ИСПОЛНЕНИЕМ.** Проверено только кодирование строки `movtd`.

### 4.5. Что осталось допущением

| допущение | чем подкреплено | чего не хватает |
|---|---|---|
| `movtd` кладёт 64 бита именно в тот регистр окна, который читает syscall ABI | `%drN` ≡ `%rN` (`elbrus-docs/README.md:50-54`); `MOVTD_RF` пишет `lo` (`translate-al-c12.c:58`); syscall читает `lo` (`qemu-e2k/qemu/linux-user/e2k/cpu_loop.c:177`) | прогона в модели |
| литерал `_f64` в D-форме доходит до приёмника без изменений | условие `translate-al.c:1697` (тип `D` в списке) | прогона в модели |
| окно `rsz=4` достаточно для записи `%r10` | окно `(rsz+1)*2 = 10` единиц (`qemu-e2k/qemu/target/e2k/reg-index.h:30-52`) | прогона в модели |
| старшие 32 бита регистра не заняты «мусором» | `MOVTD_RF` пишет `lo` целиком (`translate-al-c12.c:58`) | прогона в модели |
| байты, полученные ассемблером, совпадут с ожиданиями нашего кодировщика | форма `0xdc` в `src/e2k/e2k-real.ts` ещё не реализована (`:806-810`) | реализации кодировщика |
