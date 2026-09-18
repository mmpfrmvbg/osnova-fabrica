# Минимальный набор системных вызовов e2k

Семь вызовов, которых достаточно для файлового ввода-вывода и кучи в первой утилите:
`read`, `write`, `open`, `close`, `brk`, `mmap`, `exit`.

**Реализация запрещена в этом сеансе:** здесь только извлечение. Номера — из
`linux-user/e2k/syscall_nr.h`; порядок аргументов — из общего обработчика
`linux-user/syscall.c` и таблицы `linux-user/x86_64/syscall_64.tbl`; шаблон вызова —
из `docs/e2k-syscall-abi.md` (там же источники на каждую строку ABI).

**Как читать столбец «источник».** Для каждого вызова указано: (а) строка `#define` в
`syscall_nr.h` для номера; (б) строка `case TARGET_NR_*` в `linux-user/syscall.c`, по которой
виден порядок аргументов (`arg1`, `arg2`, …); (в) имя вызова и порядок его аргументов в Linux
(`syscall_64.tbl`). Ядро e2k и его `unistd.h` в источнике отсутствуют — соответствие
«номер → аргументы» подтверждается только обработчиком QEMU.

---

## 1. Сводная таблица

| вызов | номер | аргументы (`arg1`, `arg2`, …) | что возвращает | источник номера | источник аргументов |
|---|---|---|---|---|---|
| `exit` | **1** | `status` | не возвращает управления гостю; в модели — код выхода процесса | `linux-user/e2k/syscall_nr.h:9` | `linux-user/syscall.c:10517` |
| `read` | **3** | `fd`, `buf`, `count` | число прочитанных байт или `-errno` | `linux-user/e2k/syscall_nr.h:11` | `linux-user/syscall.c:10567-10580` |
| `write` | **4** | `fd`, `buf`, `count` | число записанных байт или `-errno` | `linux-user/e2k/syscall_nr.h:12` | `linux-user/syscall.c:10581-10599` |
| `open` | **5** | `path`, `flags`, `mode` | новый `fd` или `-errno` | `linux-user/e2k/syscall_nr.h:13` | `linux-user/syscall.c:10602-10610` |
| `close` | **6** | `fd` | `0` или `-errno` | `linux-user/e2k/syscall_nr.h:14` | `linux-user/syscall.c:10664-10666` |
| `brk` | **45** | `addr` | новое значение границы кучи или `-errno` | `linux-user/e2k/syscall_nr.h:53` | `linux-user/syscall.c:10680-10681` |
| `mmap` | **90** | `addr`, `length`, `prot`, `flags`, `fd`, `offset` | адрес отображения или `-errno` | `linux-user/e2k/syscall_nr.h:98` | `linux-user/syscall.c:11907-11928` |

**Номера не совпадают с x86_64** ни для одного из семи: на x86_64 `read=0`, `write=1`,
`open=2`, `close=3`, `brk=12`, `mmap=9`, `exit=60`
(`linux-user/x86_64/syscall_64.tbl:12-24`, `:72`). Это тот же класс расхождения, что и во всей
таблице (`docs/e2k-syscalls-raw.md` §2).

Порядок аргументов подтверждён именами вызовов ядра в таблице x86_64 (строка 13 —
`1 common write sys_write`), но **какой именно таблицы придерживается ядро e2k — НЕТ В
ИСТОЧНИКЕ** (`docs/e2k-syscall-abi.md` §7).

---

## 2. Шаблон вызова (общий для всех семи)

Извлечён из `exit(42)` — единственного проверенного исполнением
(`docs/e2k-minimal-elf.md` §2, §7; разбор ABI — `docs/e2k-syscall-abi.md` §3, §4):

```asm
        setbn   rsz = 4, rbs = 0, rcur = 0   ; окно должно вместить %r8..%r11+
        movts,0 <номер>,   %r8               ; номер вызова   (оконный r0 вызываемого)
        movts,0 <arg1>,    %r9               ; аргумент 1     (оконный r1)
        movts,0 <arg2>,    %r10              ; аргумент 2     (оконный r2)
        movts,0 <arg3>,    %r11              ; аргумент 3     (оконный r3)
        sdisp   %ctpr1, 0                    ; тег CTPSL      (translate-ctp.c:174)
        call    %ctpr1, wbs = 4              ; сдвиг окна wbs=4 (translate-ct.c:1090)
        ; результат — в оконном r0, то есть в %r8 (cpu_loop.c:209-215)
```

| требование шаблона | источник |
|---|---|
| номер читается из оконного `r0`, аргументы — из оконных `r1..r8` | `linux-user/e2k/cpu_loop.c:164-178` |
| `%r8` — это оконный `r0` при `wbs = 4` | вывод: `wbs` в квадрословах (`target/e2k/tcg/translate-ct.c:1090`), квадрослово = 2 регистровые единицы (`target/e2k/cpu.h:57-58`) |
| окно должно вмещать номера: `setbn` иначе не даст записать `%r8` | `target/e2k/reg-index.h:30-52` (окно `(rsz+1)*2` единиц) |
| `psize_q ≤ wbs ≤ size_q`, начальные 4 и 8 | `target/e2k/tcg/translate-ct.c:908-917`; `linux-user/e2k/cpu_loop.c:302-303` |
| тег `CTPSL` ставит только `sdisp` | `target/e2k/tcg/translate-ctp.c:174` |
| запуск вызова — только `CALL` с `CTPSL` | `target/e2k/tcg/translate-ct.c:751-755`, `:1144-1145` |
| ошибка приходит как `-errno` в оконный `r0` | `linux-user/user-internals.h:113-116`; `linux-user/e2k/cpu_loop.c:209-215` |
| при `-QEMU_ERESTARTSYS` вызов повторяется портом | `linux-user/e2k/cpu_loop.c:187-197` |

**Проверено исполнением:** `exit` (номер 1) и `write` (номер 4) — оба доведены до конца в модели
(`docs/e2k-minimal-elf.md` §7, `docs/e2k-syscall-abi.md` §5, `docs/e2k-qemu-run.md` §2.10).
Вместе с `write` решена и **загрузка 64-битного адреса** в оконный регистр: `movtd,0 _f64` формой
`0xdc` (16 байт), выбранной замером ассемблера (`docs/e2k-address-loading.md` §4.4).

**Не проверено исполнением:** остальные вызовы — `read`, `open`, `mmap`, `brk`, `ioctl`:
номер и порядок аргументов известны, прогона нет.

---

## 3. Каждый вызов по отдельности

### 3.1. `exit` — номер 1

| | |
|---|---|
| номер | `1` — `linux-user/e2k/syscall_nr.h:9` (`#define TARGET_NR_exit 1`) |
| аргументы | `arg1 = status` — единственный; читается из оконного `r1` |
| возврат | в модели процесс завершается (`linux-user/syscall.c:10517` — `case TARGET_NR_exit`, завершение через `_exit`); в гостя управление не возвращается |
| источник | `linux-user/syscall.c:10517-10521` (`case TARGET_NR_exit`); в Linux — `syscall_64.tbl:72` (`60 common exit sys_exit`) |
| статус | **ИСПОЛНЕНО В МОДЕЛИ**: `exit(42)` → код возврата 42 (`docs/e2k-minimal-elf.md` §7) |

```asm
        setbn   rsz = 4, rbs = 0, rcur = 0
        movts,0 1, %r8            ; exit (syscall_nr.h:9)
        movts,0 42, %r9           ; status = 42
        sdisp   %ctpr1, 0
        call    %ctpr1, wbs = 4
```

### 3.2. `read` — номер 3

| | |
|---|---|
| номер | `3` — `linux-user/e2k/syscall_nr.h:11` |
| аргументы | `arg1 = fd`, `arg2 = buf` (адрес), `arg3 = count` |
| возврат | число прочитанных байт; при ошибке `-errno` (в частности `-TARGET_EFAULT`, если `buf` недоступен для записи) |
| источник | `linux-user/syscall.c:10567-10580` (`case TARGET_NR_read`, `safe_read(arg1, p, arg3)`); порядок `read(fd, buf, count)` — `syscall_64.tbl:12` |
| статус | **НЕ ПРОВЕРЕНО ИСПОЛНЕНИЕМ** |

```asm
        setbn   rsz = 4, rbs = 0, rcur = 0
        movts,0 3, %r8            ; read (syscall_nr.h:11)
        movts,0 <fd>,    %r9      ; arg1
        movtd,0 _f64 <адрес buf>, %r10 ; arg2 — 64-битный литерал формы 0xdc
        movts,0 <count>, %r11     ; arg3
        sdisp   %ctpr1, 0
        call    %ctpr1, wbs = 4
```

### 3.3. `write` — номер 4

| | |
|---|---|
| номер | `4` — `linux-user/e2k/syscall_nr.h:12` |
| аргументы | `arg1 = fd`, `arg2 = buf` (адрес), `arg3 = count` |
| возврат | число записанных байт; при ошибке `-errno` (в частности `-TARGET_EFAULT`, если `buf` недоступен для чтения) |
| источник | `linux-user/syscall.c:10581-10599` (`case TARGET_NR_write`, `safe_write(arg1, p, arg3)`); порядок `write(fd, buf, count)` — `syscall_64.tbl:13` |
| статус | **ИСПОЛНЕНО В МОДЕЛИ**: write(1,"hello",5) — в stdout уходит hello, exit того же образа возвращает 42 (`docs/e2k-syscall-abi.md` §5, `docs/e2k-qemu-run.md` §2.10) |

```asm
        setbn   rsz = 5, rbs = 0, rcur = 0 ; 12 единиц: %r8…%r11 (rsz = 4 дал бы 10)
        movts,0 4, %r8            ; write (syscall_nr.h:12)
        movts,0 1, %r9            ; arg1: fd = 1 (stdout)
        movtd,0 _f64 <адрес "hello">, %r10 ; arg2: адрес строки — литерал 0xdc
        movts,0 5, %r11           ; arg3: count = 5
        sdisp   %ctpr1, 0
        call    %ctpr1, wbs = 4
```

### 3.4. `open` — номер 5

| | |
|---|---|
| номер | `5` — `linux-user/e2k/syscall_nr.h:13` |
| аргументы | `arg1 = path` (адрес строки), `arg2 = flags`, `arg3 = mode` |
| возврат | новый `fd` или `-errno` |
| источник | `linux-user/syscall.c:10602-10610` (`case TARGET_NR_open` под `#ifdef TARGET_NR_open`, `:10601`; `lock_user_string(arg1)`, `arg2`, `arg3`) |
| флаги | значения `O_*` для e2k порт берёт из общего `linux-user/generic/fcntl.h` — свой `linux-user/e2k/target_fcntl.h` только включает его (`linux-user/e2k/target_fcntl.h:9`); **числовых значений `O_*` для e2k в источнике нет** |
| статус | **НЕ ПРОВЕРЕНО ИСПОЛНЕНИЕМ** |

```asm
        setbn   rsz = 4, rbs = 0, rcur = 0
        movts,0 5, %r8            ; open (syscall_nr.h:13)
        ; <адрес имени> -> %r9    ; arg1
        movts,0 <flags>, %r10     ; arg2
        movts,0 <mode>,  %r11     ; arg3
        sdisp   %ctpr1, 0
        call    %ctpr1, wbs = 4
```

### 3.5. `close` — номер 6

| | |
|---|---|
| номер | `6` — `linux-user/e2k/syscall_nr.h:14` |
| аргументы | `arg1 = fd` |
| возврат | `0` или `-errno` |
| источник | `linux-user/syscall.c:10664-10666` (`case TARGET_NR_close`, `get_errno(close(arg1))`); порядок `close(fd)` — `syscall_64.tbl:15` |
| статус | **НЕ ПРОВЕРЕНО ИСПОЛНЕНИЕМ** |

```asm
        setbn   rsz = 4, rbs = 0, rcur = 0
        movts,0 6, %r8            ; close (syscall_nr.h:14)
        movts,0 <fd>, %r9         ; arg1
        sdisp   %ctpr1, 0
        call    %ctpr1, wbs = 4
```

### 3.6. `brk` — номер 45

| | |
|---|---|
| номер | `45` — `linux-user/e2k/syscall_nr.h:53`. На x86_64 `brk = 12` (`syscall_64.tbl:24`) — номер другой |
| аргументы | `arg1 = addr` (новое значение границы кучи) |
| возврат | новое значение границы кучи (`do_brk` возвращает адрес, а не `0`): при уменьшении ниже начальной границы — текущее значение, при совпадении страниц — запрошенное |
| источник | `linux-user/syscall.c:10680-10681` (`case TARGET_NR_brk`, `do_brk(arg1)`); реализация — `linux-user/syscall.c:871-909` (комментарий `:871`, возвраты `:882`, `:891`, `:899`, `:909`) |
| «номер в источнике» | `syscall_nr.h:53` — `#define TARGET_NR_brk 45`; в `syscall_nr.h:25` есть также устаревший `TARGET_NR_break 17`, он **не** используется |
| статус | **НЕ ПРОВЕРЕНО ИСПОЛНЕНИЕМ** |

```asm
        setbn   rsz = 4, rbs = 0, rcur = 0
        movts,0 45, %r8           ; brk (syscall_nr.h:53)
        movts,0 <addr>, %r9       ; arg1
        sdisp   %ctpr1, 0
        call    %ctpr1, wbs = 4
```

### 3.7. `mmap` — номер 90

| | |
|---|---|
| номер | `90` — `linux-user/e2k/syscall_nr.h:98`. На x86_64 `mmap = 9` (`syscall_64.tbl:21`) — номер другой |
| аргументы | `arg1 = addr`, `arg2 = length`, `arg3 = prot`, `arg4 = flags`, `arg5 = fd`, `arg6 = offset` |
| возврат | адрес отображения или `-errno` |
| источник | `linux-user/syscall.c:11907-11928` (`case TARGET_NR_mmap`); e2k **не** попадает под `TARGET_ARCH_WANT_SYS_OLD_MMAP` (список архитектур — `linux-user/syscall_defs.h:3135-3140`: только i386/arm в ABI32, m68k, microblaze, s390x), поэтому аргументы берутся напрямую: `do_mmap(arg1, arg2, arg3, arg4, arg5, arg6)` (`:11926`) — без структуры из шести слов |
| `offset` | передаётся **в байтах** (`do_mmap(…, arg6)`), а не в страницах: ветка `mmap2` с `<< MMAP_SHIFT` — отдельный вызов, `linux-user/syscall.c:11929-11936` |
| второй номер | `TARGET_NR_mmap2 192` тоже есть в таблице e2k (`linux-user/e2k/syscall_nr.h:200`) — для 32-битного ABI; в первой утилите нужен `mmap` |
| флаги | значения `MAP_*` для e2k есть в порте: `TARGET_MAP_ANONYMOUS 0x10`, `TARGET_MAP_FIXED 0x100`, `TARGET_MAP_FIXED_NOREPLACE 0x400000` и др. — `linux-user/e2k/target_mman.h:8-22` |
| статус | **НЕ ПРОВЕРЕНО ИСПОЛНЕНИЕМ** |

```asm
        setbn   rsz = 4, rbs = 0, rcur = 0
        movts,0 90, %r8           ; mmap (syscall_nr.h:98)
        movts,0 <addr>,   %r9     ; arg1
        movts,0 <length>, %r10    ; arg2
        movts,0 <prot>,   %r11    ; arg3
        ; arg4..arg6 (flags, fd, offset) — требуют оконных r4..r6,
        ; адреса и старшие аргументы — литералом 0xdc (docs/e2k-address-loading.md §4.4); прогона этих вызовов нет
        sdisp   %ctpr1, 0
        call    %ctpr1, wbs = 4
```

Примечание: `mmap` требует **шести** аргументов (оконные `r1`…`r6`), то есть окно должно
вмещать `%r8`…`%r13`. Ограничение «8 аргументов» (`linux-user/e2k/cpu_loop.c:172-178`) при этом
не нарушено, но шаблон `setbn rsz=4` (10 регистровых единиц) для `mmap` **недостаточен** —
нужен больший `rsz`, а какой именно — **НЕ ПРОВЕРЕНО**.

---

## 4. Что проверяет оракул

`src/scripts/e2kSyscalls.audit.test.ts`:

1. все семь имён (`read`, `write`, `open`, `close`, `brk`, `mmap`, `exit`) перечислены;
2. у каждого указан номер и он **совпадает** с `#define` в `linux-user/e2k/syscall_nr.h`
   (номер не выдуман: тест читает источник);
3. у каждого указан источник, и тест проверяет якоря: `syscall_nr.h:<строка>` и
   `linux-user/syscall.c:<строка>` реально содержат объявленные номер и порядок аргументов;
4. у каждого есть блок кода вызова с `sdisp` и `call %ctpr1`;
5. отсутствие утверждения «выполняется без оговорок» и наличие пометки «НЕ ПРОВЕРЕНО» у шести
   из семи (`exit` — исключение: исполнен в модели).

Слабое место названо прямо: `.tmp/e2k-sources/` не коммитится, поэтому на чистой копии
проверка якорей не выполняется — тест сообщает причину, а не выдаёт пропуск за успех.
