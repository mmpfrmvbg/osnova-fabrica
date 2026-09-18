# Syscall ABI e2k: извлечение из порта QEMU-e2k

Документ фиксирует **только то, что найдено в исходниках** порта QEMU-e2k
(`.tmp/e2k-sources/qemu-e2k/qemu/`). Каждый факт — со ссылкой `файл:строка`; то, чего
в источнике нет, помечено **НЕТ В ИСТОЧНИКЕ** и вынесено в §7.

Область: пользовательский режим (`linux-user`). Ядро Linux/e2k и libc в источнике
отсутствуют, поэтому «как задумано в Linux» здесь не утверждается — только «что делает
порт QEMU».

| | |
|---|---|
| дерево источников (только чтение) | `.tmp/e2k-sources/qemu-e2k/qemu/` |
| происхождение копии | `docs/e2k-sources-raw.md`, источник 3 (`qemu-e2k.tar.gz`, sha256) |
| архитектурный порт | `target/e2k/` |
| пользовательский режим | `linux-user/e2k/` |
| сверка поведения в модели | `docs/e2k-minimal-elf.md` §7, `docs/e2k-qemu-run.md` §2.9, §5 этого документа |
| оракул этого документа | `src/scripts/e2kSyscalls.audit.test.ts` |
| прогон `write`+`exit` в модели | `src/e2k/e2kSyscallRuntime.test.ts` (шлюз `npm run gate:qemu`) |
| опись аргументов каждого вызова | **НЕТ В ИСТОЧНИКЕ** — см. §7 |

---

## 1. Как передаются аргументы

Всё чтение аргументов — в одном месте, `void cpu_loop(CPUE2KState *env)`:

| шаг | код | источник | факт |
|---|---|---|---|
| номер вызова | `e2k_greg_unpacked_t * target_nr_p = e2k_try_get_window_reg_p(env, 0);` | `linux-user/e2k/cpu_loop.c:164` | номер берётся из **оконного** регистра с индексом 0 |
| защита | `if(!target_nr_p) { error_report("qemu: syscall without proper WD configuration - aborting"); exit(EXIT_FAILURE); }` | `linux-user/e2k/cpu_loop.c:165-169` | если окно не сконфигурировано — аварийный выход хоста, а не ошибка гостя |
| маска номера | `int target_nr = target_nr_p->lo & ((1ull << 10ull) - 1ull);` | `linux-user/e2k/cpu_loop.c:170` | номер — **младшие 10 бит** младшего слова регистра, беззнаково |
| аргументы | `uint64_t args[8] = { 0 }; for( int i = 0; i < 8; i++ ) { e2k_greg_unpacked_t * arg_p = e2k_try_get_window_reg_p(env, i+1); if(arg_p) args[i] = arg_p->lo; }` | `linux-user/e2k/cpu_loop.c:172-178` | аргументы — оконные регистры с индексами **1..8**, по порядку; каждый — младшее слово, **64 бита** |
| отсутствующий регистр | `if(arg_p)` без `else` | `linux-user/e2k/cpu_loop.c:176-177` | если индекс вне окна, аргумент остаётся **0** и вызов всё равно продолжается |
| передача в общий код | `do_syscall(env, target_nr, args[0], …, args[7])` | `linux-user/e2k/cpu_loop.c:182-183` | все 8 значений уходят в общий обработчик QEMU |

Что такое «оконный регистр с индексом N» — из `target/e2k/reg-index.h`:

| факт | источник |
|---|---|
| индекс окна переводится в физический регистр как `(wd_base_d + idx) % MAXSR_D`; выход за `size_d` — исключение (`exc_window_bounds`) | `target/e2k/reg-index.h:55-81` (строка 67 — проверка границы, строка 79 — формула) |
| физический индекс `0` — это первый регистр массива `rf.window` | `target/e2k/cpu.h:116-120` (`window[E2K_RF_WIN_INTERNAL_SIZE]`, `E2K_RF_WIN_INTERNAL_SIZE = MAXSR_D*2`, `cpu.h:82`) |
| `e2k_try_get_window_reg_p` возвращает `NULL`, если индекс вне окна, иначе указатель на регистр | `target/e2k/reg-index.h:131-139` |

**Вывод (цепочка, не одна строка источника):** QEMU читает номер из оконного `r0`
и аргументы из оконных `r1`…`r8`. **НЕТ В ИСТОЧНИКЕ:** таблицы «номер аргумента → имя
регистра» в порте нет; соответствие «индекс 0 = `%r0`» следует из `reg-index.h:79` и
подтверждается прогоном (`docs/e2k-minimal-elf.md` §2, §7).

---

## 2. Как возвращается результат

| шаг | код | источник | факт |
|---|---|---|---|
| результат обёртки | `ret = do_syscall(env, target_nr, args[0], …)` | `linux-user/e2k/cpu_loop.c:182-183` | тип `abi_long` (`cpu_loop.c:139`) |
| запись результата | `e2k_greg_unpacked_t * ret_nr_p = e2k_try_get_window_reg_p(env, 0); if( ret_nr_p ) { ret_nr_p->lo = ret; ret_nr_p->hi = 0; ret_nr_p->tag_unpacked = 0; }` | `linux-user/e2k/cpu_loop.c:209-215` | результат пишется в **тот же оконный `r0`**, что и номер; старшее слово и тег обнуляются |
| если окна нет | `if( ret_nr_p )` без `else` | `linux-user/e2k/cpu_loop.c:210` | при отсутствии окна результат **теряется молча** |
| возврат управления | `env->sregs.ip = e2k_cpu_exec_ct_return(env);` | `linux-user/e2k/cpu_loop.c:217` | адрес возврата берётся из цепочки возврата (`CR0_HI.ip`) — `target/e2k/tcg/translate-ct.c:25-35` |
| «не портить регистры» | `if (ret == -QEMU_ESIGRETURN) { break; }` | `linux-user/e2k/cpu_loop.c:199-205` | при возврате из `sigreturn` запись результата **не выполняется** |

Возврат ошибки — общая конвенция QEMU, отдельного e2k-кода нет:

| факт | источник |
|---|---|
| ошибка — это отрицательный `errno` (`-errno`), признак — `(abi_ulong)ret >= (abi_ulong)(-4096)` | `linux-user/user-internals.h:113-116` |
| порт e2k никак не преобразует `ret` перед записью в `r0` | `linux-user/e2k/cpu_loop.c:209-215` |

**Следствие (утверждение документа):** гостю ошибка видна как значение в диапазоне
`0xFFFFFFFFFFFFF001`…`0xFFFFFFFFFFFFFFFF` (−4095…−1) в младшем слове оконного `r0`.

Специальные внутренние коды QEMU — до гостя не доходят:

| код | что делает порт | источник |
|---|---|---|
| `-QEMU_ERESTARTSYS` | `env->restart_syscall = true; env->sregs.ip = orig_ip;` — повтор вызова **на уровне порта**, потому что «повторить инструкцию с CALL уже нельзя: состояние CPU необратимо изменено» | `linux-user/e2k/cpu_loop.c:187-197` (комментарий — `:188-193`) |
| повтор при следующем входе | `if ( !env->restart_syscall ) { … trapnr = cpu_exec(cs); } else { trapnr = EXCP_SYSCALL; }` | `linux-user/e2k/cpu_loop.c:145-154` |
| `-QEMU_ESIGRETURN` | результат не пишется | `linux-user/e2k/cpu_loop.c:199-205` |

---

## 3. Как вызывается syscall — пошагово

### 3.1. Шаг 1: у вызывающего окно должно вмещать номер и аргументы

| факт | источник |
|---|---|
| индекс вне окна → `NULL` → номер не прочитан → аварийный выход | `linux-user/e2k/cpu_loop.c:165-169`; `target/e2k/reg-index.h:131-139` |
| начальные `psize_q = 4`, `size_q = 8` задаёт сам порт | `linux-user/e2k/cpu_loop.c:302-303` |
| `call` проверяет `psize_q ≤ wbs ≤ size_q` по **квадрословам** окна | `target/e2k/tcg/translate-ct.c:908-917` |

### 3.2. Шаг 2: подготовка `%ctpr` тегом `CTPSL` — только `sdisp`

| факт | источник |
|---|---|
| тегов семь: `CTPEW=0, CTPDW=1, CTPPL=2, CTPLL=3, CTPNL=4, CTPSL=5, CTPPPL=6` (+ `RESERVED=7`) | `target/e2k/cpu-sregs.h:163-173` |
| `disp` **всегда** пишет `CTPLL`, база = `ip + disp*8` | `target/e2k/tcg/translate-ctp.c:67-108` (тег — `:81`) |
| `sdisp` пишет `opc=DISP`, база = `oscud_lo.base + sdisp*2048`, а тег выбирается по `psr.pm` и биту `osem[sdisp]`: `CTPSL`, если `psr.pm != osem[sdisp]`, иначе `CTPEW` | `target/e2k/tcg/translate-ctp.c:142-184` (база — `:153-160`, формула тега — `:174`) |
| `sdisp` читает `sdisp` из поля `disp` длиной 5 бит: `FIELD_EX32(instr_decoded->cs0, C0F2, disp) & 0x1full` | `target/e2k/tcg/translate-ctp.c:153` |
| `oscud_lo` (текущий пользовательский сегмент данных) сохраняется в кеш **до** вычисления базы | `target/e2k/tcg/translate-ctp.c:35-53` |
| у `return` тег **всегда** `CTPPL` | `target/e2k/tcg/translate-ctp.c:121-124` |

**Следствие (утверждение документа):** тег `CTPSL` в общем случае ставит именно `sdisp`;
при совпадении `psr.pm` с битом `osem[sdisp]` тот же `sdisp` даёт `CTPEW`, и системный вызов
не запускается.

### 3.3. Шаг 3: вызов — только `CALL` с тегом `CTPSL`

| факт | источник |
|---|---|
| при `CALL` порт разрешает «возможен системный вызов» (`can_have_syscall = true`), если ctpr не константа **или** его тег `CTPSL`; поле `have_syscall` при этом сбрасывается | `target/e2k/tcg/translate-ct.c:751-755` |
| сама передача управления — `e2k_cpu_exec_ct_CALL(env, next_ip, ctpr, wbs)` | `target/e2k/tcg/translate-ct.c:773-779` |
| `CTPSL` ставит `have_syscall = true` **только при `opc=DISP`**; иначе — исключение | `target/e2k/tcg/translate-ct.c:899-961` (успешная ветка — `:899-928`), `:1144-1145` |
| при `CTPSL` порт гасит прерывания: `psr.pm = 1`, `psr.ie = 0`, `psr.nmie = 0` | `target/e2k/tcg/translate-ct.c:1126-1131` |
| `CALL` сдвигает окно на `wbs` **квадрослов** и обнуляет `BR` | `target/e2k/tcg/translate-ct.c:1090` (`env->sregs.br = 0`) |
| `ct` по не подготовленному ctpr (тег `CTPEW`) — исключение, а не вызов | `target/e2k/tcg/translate-ct.c:835-844` (тег `CTPEW` — `:840-844`) |
| `ipd` по умолчанию — `E2K_CTPR_IPD_CTPIPDD = 3`, если слог SS отсутствует | `target/e2k/tcg/translate-ctp.c:181`; `target/e2k/cpu-sregs.h:175-178` |

### 3.4. Шаг 4: выход из трансляции и вход в `cpu_loop`

| факт | источник |
|---|---|
| на границе блока порт проверяет `have_syscall` и, если он взведён, вызывает `helper_e2k_loop_exit_syscall` | `target/e2k/tcg/translate-wi.c:569-579` |
| `helper_e2k_loop_exit_syscall` выставляет `cs->exception_index = EXCP_SYSCALL` и делает `cpu_loop_exit` | `target/e2k/tcg/translate-wi.c:86-100` |
| `EXCP_SYSCALL = 0x102` | `target/e2k/cpu.h:52-55` |
| `cpu_loop` разбирает `case EXCP_SYSCALL` | `linux-user/e2k/cpu_loop.c:160` |

### 3.5. Шаг 5: возврат

| факт | источник |
|---|---|
| результат в оконный `r0`, переход на `e2k_cpu_exec_ct_return` | `linux-user/e2k/cpu_loop.c:209-217` |
| `e2k_cpu_exec_ct_return` читает адрес возврата из `cf.cr_pairs[cwd.base_q/2].cr0_hi.ip` | `target/e2k/tcg/translate-ct.c:25-35` |
| при `-QEMU_ERESTARTSYS` порт **восстанавливает IP вызова** и повторяет его на следующем входе | `linux-user/e2k/cpu_loop.c:187-197`, `:145-154` |

---

## 4. Пример: `exit(42)` — исполнено в модели

Пять инструкций (байты и адреса измерены, `docs/e2k-minimal-elf.md` §2 и §7):

| адрес | инструкция | что делает по этому ABI | источник |
|---|---|---|---|
| `0x100000` | `setbn rsz=4, rbs=0, rcur=0` | расширяет окно вращаемых регистров, чтобы номер и аргумент вообще попали в окно | байты — `docs/e2k-minimal-elf.md:44`; окно `(rsz+1)*2` единиц — `target/e2k/reg-index.h:30-52` |
| `0x100008` | `movts,0 1, %r8` | номер `1` (`exit`) | `linux-user/e2k/syscall_nr.h:9`; адрес — `docs/e2k-minimal-elf.md:45` |
| `0x100018` | `movts,0 42, %r9` | аргумент `1` = 42 | адрес — `docs/e2k-minimal-elf.md:46`; оконный `r1` — `linux-user/e2k/cpu_loop.c:175` |
| `0x100028` | `sdisp %ctpr1, 0` | тег `CTPSL` | `target/e2k/tcg/translate-ctp.c:174` |
| `0x100030` | `call %ctpr1, wbs=4` | сдвиг окна `wbs=4` → номер оказывается в оконном `r0`, запуск вызова | `target/e2k/tcg/translate-ct.c:1090`, `linux-user/e2k/cpu_loop.c:164`, `target/e2k/tcg/translate-ct.c:1144-1145` |

```asm
        setbn   rsz = 4, rbs = 0, rcur = 0
        movts,0 1, %r8
        movts,0 42, %r9
        sdisp   %ctpr1, 0
        call    %ctpr1, wbs = 4
```

**Чем подтверждено:** код возврата **42** в прогоне QEMU с шимом `mmap` и правкой полей
`WD._d` в порте — `docs/e2k-minimal-elf.md` §7, `docs/e2k-qemu-run.md` §2.9; байты сверены
ассемблером и дизассемблером МЦСТ — `docs/e2k-minimal-elf.md` §3.

**Соответствие «`%r8` — это оконный `r0`»** — вывод, а не строка источника: `call` сдвигает
окно на `wbs` квадрослов (`translate-ct.c:1090`), квадрослово — две регистровые единицы
(`target/e2k/cpu.h:57-58`: `MAXNR_Q = 128`, `MAXNR_D = MAXNR_Q*2`), значит `2*wbs + 0 = 8`.
**НЕТ В ИСТОЧНИКЕ:** явного «оставь номер в `%r8`» в порте нет.

---

## 5. Пример: `write(1, "hello", 5)` — ПРОВЕРЕНО ИСПОЛНЕНИЕМ

Собирается из того же шаблона; отличается числом вызова, набором аргументов и наличием
указателя на строку. Сборщик — `src/e2k/syscallRuntime.ts` (`buildHelloProgram`), оракул —
`src/e2k/e2kSyscallRuntime.test.ts` в шлюзе `npm run gate:qemu` (прогону нужен внешний ресурс:
`qemu-e2k` под шимом `mmap`, — поэтому он не в полном прогоне, `docs/verification-debt.md`, случай 12).

| шаг | что положить | почему | источник |
|---|---|---|---|
| 1 | `setbn rsz=5, rbs=0, rcur=0` | окно должно вместить `%r8`…`%r11` (номер + 3 аргумента) — это 12 регистровых единиц: `(rsz + 1) * 2` (`target/e2k/reg-index.h:30-52`); при `rsz=4` единиц 10, и `%r11` в окно не попадает | `target/e2k/reg-index.h:30-52` (формула); `rsz=5` — **прогон прошедший**, что рухнуло бы при `rsz=4` — НЕ ЗАМЕРЕНО |
| 2 | `movts,0 4, %r8` | номер `write` = **4** | `linux-user/e2k/syscall_nr.h:12` |
| 3 | `movts,0 1, %r9` | аргумент 1: `fd = 1` (stdout) — оконный `r1` | `linux-user/e2k/cpu_loop.c:175` |
| 4 | `movtd,0 _f64 <адрес>, %r10` | аргумент 2: `buf` — оконный `r2`; 64-битный адрес кладётся литералом формы **0xdc** (16 байт) | `docs/e2k-address-loading.md` §3, §4.4; реализация — `src/e2k/e2k-real.ts` |
| 5 | `movts,0 5, %r11` | аргумент 3: `count = 5` — оконный `r3` | `linux-user/e2k/cpu_loop.c:175` |
| 6 | `sdisp %ctpr1, 0` | тег `CTPSL` | `target/e2k/tcg/translate-ctp.c:174` |
| 7 | `call %ctpr1, wbs=4` | вызов; сдвиг окна `wbs = 4` | `target/e2k/tcg/translate-ct.c:1090` |
| 8 | после возврата | результат (`5` или `-errno`) — в оконном `r0`, то есть в `%r8` | `linux-user/e2k/cpu_loop.c:209-215` |

```asm
        setbn   rsz = 5, rbs = 0, rcur = 0
        movts,0 4, %r8              ; номер write (syscall_nr.h:12)
        movts,0 1, %r9              ; fd = 1
        movtd,0 _f64 0x100098, %r10 ; buf — адрес строки, литерал формы 0xdc
        movts,0 5, %r11             ; count = 5
        sdisp   %ctpr1, 0
        call    %ctpr1, wbs = 4
        movts,0 1, %r8              ; номер exit
        movts,0 0, %r9              ; код возврата
        sdisp   %ctpr1, 0
        call    %ctpr1, wbs = 4
```

Регистр `%dr10` в выводе дизассемблера — не опечатка: приёмник 64-битного литерала печатается
с приставкой `d` (`reg_prefix = {"", "d", "q", "qp"}` в дизассемблере binutils МЦСТ; разбор с
точными строками — `docs/e2k-address-loading.md` §1.2). Наш ассемблер пишет `%r10`, чужой
дизассемблер — `%dr10`; сверяется факт, а не обозначение. Ссылки на дерево binutils в этом
документе не ставятся: его сторож знает только дерево порта QEMU (`opcodes/e2k-dis.c` ему чужой).

**Статус: ПРОВЕРЕНО ИСПОЛНЕНИЕМ** (модель QEMU-e2k, шим `mmap` — `docs/e2k-qemu-run.md` §2.5, §2.8).
Измерено: код **157 байт**, адрес строки **0x100098**, `stdout` содержит `hello`, статус **0**;
отдельный образ с `exit(42)` вернул **42**. Три звена проверяются по отдельности, чтобы провал
называл своё:

1. **сборка** — форма 0xdc (16 байт, поле `0xdc`), обратный разбор даёт `imm64` с адресом строки;
2. **образ** — чужой дизассемблер печатает `movtd,0 _f64 0x100098, %dr10`,
   `setbn rbs = 0x0, rsz = 0x5, rcur = 0x0`, `call %ctpr1, wbs = 0x4`, `sdisp %ctpr1, 0x0`,
   а значение **0x100098** читается из его вывода и сверяется с измеренной константой;
3. **исполнение** — `stdout` содержит `hello`, а `exit(42)` возвращает 42.

Сверка значений (звено 2) устроена так намеренно: ожидание, выведенное из **наших же** вычислений,
уезжает вместе с ошибкой в них. Дефект 6.5 негативного контроля (сдвиг адреса на 8) это и
показывает: префиксная сверка строки остаётся зелёной, а сверка значения и прогон — нет
(`docs/e2k-real-run.md` §2.4.2).

**Что остаётся недоказанным:** что так поведёт себя **железо** — QEMU модель, а не Эльбрус.
И что `rsz=5` **обязателен**: прогон прошёл с ним, но опыт с `rsz=4` (ожидаемый отказ) не ставился.
Третье: `sdisp` берётся с иммедиатом **0** — это измеренное значение (`docs/e2k-minimal-elf.md` §7),
в постановке называлось `3`; какой иммедиат правилен по существу, НЕ ЗАМЕРЕНО.

**Порядок аргументов** (`fd`, `buf`, `count`) взят из общей таблицы Linux —
`linux-user/x86_64/syscall_64.tbl:13` (`1 common write sys_write`), назначение аргументов
задаёт `linux-user/syscall.c` (`TARGET_NR_write` → `write(fd, buf, count)`).
**Какого порядка придерживается ядро e2k — НЕТ В ИСТОЧНИКЕ** (§7). Что порядок `fd, buf, count`
верен для порта — следует теперь из прогона: строка напечатана, значит дескриптор, адрес и длина
прочитаны именно в этом порядке.

**Прежнее препятствие снято.** В первой редакции здесь стояло: «как загрузить 64-битный адрес
строки в оконный регистр — НЕТ В ИСТОЧНИКЕ». Ответ найден и проверен: `movtd,0 _f64` формы 0xdc,
16 байт, старшее слово первым (`docs/e2k-address-loading.md` §4.4; внешняя сверка с `as` —
`docs/e2k-external-as.md` §4; значение в образе — звено 2 выше).

---

## 6. Ограничения

| ограничение | значение | источник |
|---|---|---|
| максимум аргументов, читаемых портом | **8** (`i+1`, `i = 0..7`) | `linux-user/e2k/cpu_loop.c:172-178` |
| максимум, принимаемых общим обработчиком | **8** (`arg1..arg8`) | `linux-user/syscall.c:15341-15344` |
| что если аргументов больше | ничего: 9-й и далее порт не читает вовсе; ошибки нет | вывод из `linux-user/e2k/cpu_loop.c:172-178` (цикл до 8) |
| что если индекс регистра вне окна | аргумент = `0`; если вне окна **номер** — аварийный выход хоста | `linux-user/e2k/cpu_loop.c:176-177`, `linux-user/e2k/cpu_loop.c:165-169` |
| ширина аргумента | 64 бита (младшее слово регистра); старшее слово не читается | `linux-user/e2k/cpu_loop.c:177` |
| ширина номера | 10 бит, беззнаково | `linux-user/e2k/cpu_loop.c:170` |
| что если номер ≥ 1024 | он усечён маской `0x3ff` до вызова | вывод из `linux-user/e2k/cpu_loop.c:170` |
| ограничение на `wbs` при вызове | `psize_q ≤ wbs ≤ size_q`, иначе исключение | `target/e2k/tcg/translate-ct.c:908-917` |
| где регистрируется результат | тот же оконный `r0` (номер затирается результатом) | `linux-user/e2k/cpu_loop.c:209-215` |

**НЕТ В ИСТОЧНИКЕ:** проверки числа аргументов на стороне ядра e2k; поведения при
`target_nr > 463` (таблица `syscall_nr.h` кончается на 463); того, обязан ли вызывающий
восстанавливать окно после возврата.

---

## 7. Что не найдено в источнике

| чего нет | как проверено |
|---|---|
| **таблицы аргументов каждого syscall** (типы, порядок, имена) | в `linux-user/e2k/` только `syscall_nr.h` (номера); сигнатуры — общий `linux-user/syscall.c` |
| **явного «номер в оконном `r0`, аргументы в `r1..r8`» текстом** | формулировка собрана из кода `linux-user/e2k/cpu_loop.c:164-178`; систематического описания ABI в порте нет |
| **имён регистров `%r0…%r8` в связи с syscall** | порт обращается к «оконному регистру с индексом N» (`target/e2k/reg-index.h:131-139`); имён `%rN` в этом коде нет |
| **ABI ядра Linux/e2k** (исходники ядра) | в `.tmp/e2k-sources/` дерева ядра нет; `linux-user/e2k/syscall_nr.h:1-4` ссылается на `arch/e2k/include/uapi/asm/unistd.h`, файла нет |
| **конвенции libc** (обёртки, `errno`) | libc в источнике нет |
| **`e2k_syswork`, `el_posix`, `el_binary`, `access_hw_stacks` и прочая специфика МЦСТ** (22 номера) | в `linux-user/e2k/syscall_nr.h` есть только номера; реализации/назначения нет (`docs/e2k-syscalls-raw.md` §2) |
| **почему `TARGET_NR_syscalls = 436` при максимальном номере 463** | `linux-user/e2k/syscall_nr.h:451`; поле не используется в дереве (`docs/e2k-syscalls-raw.md` §1) |
| **поведения `sdisp` при `psr.pm == osem[sdisp]`** (ставит `CTPEW` вместо `CTPSL`) | код есть (`target/e2k/tcg/translate-ctp.c:163-179`), **условие на практике не проверено** — прогон `exit(42)` шёл при ином сочетании |
| **загрузка 64-битного адреса в оконный регистр** | **снято**: форма `movtd,0 _f64` 0xdc (16 байт), выбрана замером ассемблером (`docs/e2k-address-loading.md` §4.4) и подтверждена прогоном (§5) |
| **реализации syscall'ов в нашем рантайме** | общего рантайма нет: `src/e2k/e2kRealRun.ts` только понижает IR; есть ровно два вызова — `write` и `exit` (`src/e2k/syscallRuntime.ts`), остальные НЕ РЕАЛИЗОВАНЫ |

---

## 8. Проверяемость

Оракул `src/scripts/e2kSyscalls.audit.test.ts`:

- требует у каждого факта этого документа маркер источника (`файл:строка`) либо явную
  пометку **НЕТ В ИСТОЧНИКЕ**;
- проверяет по таблице якорей (ниже), что в названной строке названного файла лежит
  ожидаемый фрагмент кода, а не выдуманная ссылка;
- проверяет §5: он обязан называть исполнение **проверенным** (`ПРОВЕРЕНО ИСПОЛНЕНИЕМ`), называть
  оракул прогона (`src/e2k/e2kSyscallRuntime.test.ts`, файл обязан существовать) и называть, чего
  прогон **не** доказывает (`НЕ ЗАМЕРЕНО` / `НЕТ В ИСТОЧНИКЕ`); при этом §5 не имеет права
  одновременно стоять под пометкой `НЕ ПРОВЕРЕНО ИСПОЛНЕНИЕМ`, а документ — обещать исполнение
  без оговорок (сторож отказывается и от слов похвальбы — см. проверку ниже);
- проверяет, что ни один документ серии не ссылается на несуществующий файл.

Якоря оракула (`docs/e2k-syscall-abi.md` → источник; каждый проверяется сравнением строки):

| утверждение документа | файл:строка | фрагмент |
|---|---|---|
| номер вызова — оконный `r0` | `linux-user/e2k/cpu_loop.c:164` | `e2k_try_get_window_reg_p(env, 0)` |
| защита от неверного окна | `linux-user/e2k/cpu_loop.c:167` | `syscall without proper WD configuration` |
| номер — младшие 10 бит | `linux-user/e2k/cpu_loop.c:170` | `1ull << 10ull` |
| аргументы — оконные `r1..r8` | `linux-user/e2k/cpu_loop.c:172-178` | `args[8]` + `e2k_try_get_window_reg_p(env, i+1)` |
| результат — в оконный `r0` | `linux-user/e2k/cpu_loop.c:209-215` | `ret_nr_p->lo = ret` |
| возврат по цепочке возврата | `linux-user/e2k/cpu_loop.c:217` | `e2k_cpu_exec_ct_return` |
| повтор вызова вместо повтора инструкции | `linux-user/e2k/cpu_loop.c:187-197` | `env->restart_syscall = true` |
| номер и аргументы по индексу окна | `target/e2k/reg-index.h:131-139` | `e2k_try_get_window_reg_p` |
| индекс окна → физический регистр | `target/e2k/reg-index.h:79` | `% MAXSR_D` |
| физический индекс 0 — первый регистр окна | `target/e2k/cpu.h:116-120` | `window[E2K_RF_WIN_INTERNAL_SIZE]` |
| квадрослово — две регистровые единицы | `target/e2k/cpu.h:57-58` | `MAXNR_D` |
| признак ошибки — `ret >= -4096` | `linux-user/user-internals.h:113-116` | `(abi_ulong)(-4096)` |
| общий обработчик принимает 8 аргументов | `linux-user/syscall.c:15341-15344` | `abi_long arg8` |
| тег `CTPSL = 5` | `target/e2k/cpu-sregs.h:163-173` | `E2K_CTPR_TAG_CTPSL` |
| `disp` всегда пишет `CTPLL` | `target/e2k/tcg/translate-ctp.c:81` | `E2K_CTPR_TAG_CTPLL` |
| `sdisp` — тег `CTPSL`, база от `oscud` | `target/e2k/tcg/translate-ctp.c:142-184` | `E2K_CTPR_TAG_CTPSL` + `sdisp * 2048` |
| `CALL` с `CTPSL` → «возможен syscall» | `target/e2k/tcg/translate-ct.c:751-755` | `can_have_syscall` |
| `wbs` ограничен размерами окна | `target/e2k/tcg/translate-ct.c:908-917` | `WD, psize_q` |
| `CALL` сбрасывает `BR` | `target/e2k/tcg/translate-ct.c:1090` | `env->sregs.br = 0` |
| `CTPSL` взводит `have_syscall` | `target/e2k/tcg/translate-ct.c:1144-1145` | `have_syscall = true` |
| выход из трансляции по `have_syscall` | `target/e2k/tcg/translate-wi.c:569-579` | `have_syscall` |
| `EXCP_SYSCALL = 0x102` | `target/e2k/cpu.h:52-55` | `EXCP_SYSCALL` |
| начальные `psize_q`/`size_q` | `linux-user/e2k/cpu_loop.c:302-303` | `psize_q` |
| `exit` = 1 | `linux-user/e2k/syscall_nr.h:9` | `TARGET_NR_exit` |
| `write` = 4 | `linux-user/e2k/syscall_nr.h:12` | `TARGET_NR_write` |
| порядок аргументов Linux | `linux-user/x86_64/syscall_64.tbl:13` | `write` |

### 8.1. Дополнительные якоря (код модели и заголовки порта)

| утверждение (документ серии) | файл:строка | фрагмент |
|---|---|---|
| x86_64: `read = 0`, `mmap = 9`, `brk = 12`, `exit = 60` | `linux-user/x86_64/syscall_64.tbl:12-24` | `read` |
| реализация `brk` в модели | `linux-user/syscall.c:871-909` | `do_brk` |
| `mmap`: шесть аргументов напрямую, без структуры | `linux-user/syscall.c:11926` | `do_mmap(arg1, arg2, arg3, arg4, arg5, arg6)` |
| старый `mmap` (структура из шести слов) — только i386/arm-32, m68k, microblaze, s390x; e2k в списке нет | `linux-user/syscall_defs.h:3135-3140` | `TARGET_ARCH_WANT_SYS_OLD_MMAP` |
| флаги `open` для e2k берутся из общего заголовка | `linux-user/e2k/target_fcntl.h:9` | `../generic/fcntl.h` |
| флаги `mmap` для e2k в порте есть | `linux-user/e2k/target_mman.h:8-22` | `TARGET_MAP_ANONYMOUS`, `TARGET_MAP_FIXED_NOREPLACE` |

Слабое место названо прямо: `.tmp/e2k-sources/` не коммитится, поэтому на чистой копии
репозитория проверка якорей не выполняется — тест сообщает об этом, а не выдаёт пропуск за
успех (как в `src/scripts/e2kSources.audit.test.ts`).
