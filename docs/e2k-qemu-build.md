# QEMU-e2k: сборка (или почему нет)

**Дата:** 2026-09-15
**Статус: QEMU-e2k СОБРАН — в WSL1** (дистрибутив `e2k`, Alpine 3.24.1).
`qemu-e2k version 11.0.1`, бинарь `/root/qemu-build/qemu-e2k` (16 317 120 байт), цель
`e2k-linux-user`. **На Windows-хосте сборка по-прежнему невозможна** — причина записана в §2
и остаётся верной; сборка сделана в Linux-окружении внутри WSL (§2.5).

---

## 1. Что получено

| | |
|---|---|
| источник | `https://dev.mcst.ru/downloads/latest/qemu-e2k.tar.gz` |
| размер | 95 509 172 байта |
| `sha256` архива | `15b29347003ea1d7ff314d109957788226ff6305323af1822f7d0b5d0c4bab0f` |
| версия QEMU внутри | `11.0.1` (`qemu/VERSION`) |
| распаковано | `.tmp/e2k-sources/qemu-e2k/qemu` — 35 086 файлов (ошибок распаковки 36: файлы `rust/bindings/*/build.rs`, к цели `e2k` отношения не имеют) |
| цель сборки объявлена | `configs/targets/e2k-linux-user.mak` (`TARGET_ARCH=e2k`, `TARGET_LONG_BITS=64`) |
| собранного бинаря в архиве нет | проверено: среди `*.exe`/`*.so` в дереве только `linux-user/*/vdso*.so` чужих архитектур, ни одного `qemu-e2k` |

**Файлы порта e2k (все — в архиве):**

| файл | что содержит |
|---|---|
| `target/e2k/syllab-format.h` | битовые поля слогов (HS, ALF1…ALF10, ALEF1/ALEF2, CS, SS) |
| `target/e2k/instr-bits.h` | разбор широкой команды на слоги |
| `target/e2k/opcode-tables.h` | коды операций и расширений |
| `target/e2k/mas-format.h`, `target/e2k/decoder.c`, `target/e2k/disas.c` | MAS, декодер, дизассемблер |
| `target/e2k/cpu.c` | модели CPU |
| `target/e2k/tcg/translate-*.c` | трансляция в TCG |

**Поддерживаемые CPU** (`target/e2k/cpu.c:851-856`): `elbrus-v2`, `elbrus-v3`, `elbrus-v4`,
`elbrus-v5`, `elbrus-v6`, `elbrus-v7` — **шесть** моделей, то есть больше, чем «v2…v6» из
постановки. Строки уровня ISA: `target/e2k/cpu.c:784-793` (`elbrus-v2:any` … `elbrus-v7:any`).

---

## 2. Точная причина, почему сборка не состоялась

**Шаг, на котором остановилось: 3.1 — запуск `configure`.** До `make` дело не дошло.

### 2.1. Команда и её результат

Попытка выполнена из каталога `qemu`:

```
./configure --target-list=e2k-linux-user --disable-docs
```

Результат (PowerShell, дословно):

```
Невозможно запустить документ в середине конвейера:
D:\PROJECTS\OSNOVA-FABRIKA\.tmp\e2k-sources\qemu-e2k\qemu\configure
```

`configure` — это **shell-скрипт** (`#!/bin/sh`), а Windows не исполняет его напрямую.

### 2.2. Чего нет в окружении

| инструмент | состояние | зачем нужен |
|---|---|---|
| `sh` | **НЕТ** | `configure` и `meson.build` начинаются с него (`qemu/meson.build:78`: `sh = find_program('sh')`) |
| POSIX-оболочка вообще | **НЕТ** | `bash.exe` в системе — это запускатель WSL; `wsl -l -v` отвечает «нет установленных дистрибутивов» |
| C-компилятор (`gcc`, `cc`, `clang`) | **НЕТ** | `qemu/meson.build:81`: `cc = meson.get_compiler('c')` |
| `make` | **НЕТ** | шаг 3.1 предписывает `make` |
| `meson`, `ninja` | **НЕТ** | система сборки QEMU 11.x |
| `pkg-config`, `glib-2.0` | **НЕТ** | обязательные зависимости QEMU |

Проверено командой `Get-Command` по каждому имени; ни одного попадания, кроме `bash.exe`.

### 2.3. Почему это не ошибка порта e2k

Цель `e2k-linux-user` — **user-mode** эмуляция (`configs/targets/e2k-linux-user.mak`,
`TARGET_ARCH=e2k`). Сборка user-mode требует POSIX-хоста: `configure` и весь `meson.build`
написаны на shell и требуют C-компилятора. На Windows-хосте без WSL-дистрибутива и без
инструментальной цепочки сборка не начинается **не из-за e2k**, а из-за хоста: тот же
`configure` не собрал бы и `x86_64-linux-user`.

### 2.4. Шаги 3.2 и 3.3 постановки

| шаг | состояние |
|---|---|
| 3.1 распаковать, настроить, собрать | **распаковано** (§1); **на Windows не собирается** (§2.1–2.2); **собрано в WSL** (§2.5) |
| 3.2 записать путь к бинарю, версию, CPU | путь **в WSL**: `/root/qemu-build/qemu-e2k`; версия `11.0.1`; CPU — шесть моделей `elbrus-v2`…`elbrus-v7` (§1) |
| 3.3 записать точную причину | для Windows-хоста — §2.1–2.2; для WSL-сборки причины нет: сборка прошла |

---

## 2.5. Сборка, которая состоялась: WSL1 (Alpine)

Прав администратора не потребовалось **ни на одном шаге**.

| шаг | что сделано | результат |
|---|---|---|
| WSL | `C:\Program Files\WSL\wsl.exe --version` | **WSL 2.6.3.0 уже установлен** пакетом `MicrosoftCorporationII.WindowsSubsystemForLinux` (2.6.3.0, состояние Ok), служба `WslService` работает. Заглушка `System32\wsl.exe` про дистрибутивы не знает — она и отвечала «нет установленных дистрибутивов» |
| обновление WSL | `Microsoft.WSL_2.7.14.0_x64_ARM64.msixbundle` (495 МБ) | **не понадобилось**; скачивание оборвалось (`ECONNRESET`). Установленная 2.6.3 работает |
| дистрибутив, попытка 1 | `wsl --install -d Ubuntu --no-launch` | **не удалось**: `Wsl/InstallDistro/0x80072efe` — обрыв соединения при скачивании |
| дистрибутив, попытка 2 | `alpine-minirootfs-3.24.1-x86_64.tar.gz` (3 698 422 байта, целостность проверена полной распаковкой gzip) + `wsl --import e2k D:\wsl\e2k … --version 2` | **не удалось**: `Wsl/Service/RegisterDistro/CreateVm/HCS/ERROR_INVALID_DATA` — виртуальная машина на этом хосте не создаётся |
| дистрибутив, попытка 3 | тот же образ, `--version 1` | **получилось**: WSL1, `Linux … 4.4.0-22543-Microsoft`, Alpine 3.24.1 |
| пакеты | `apk add build-base python3 pkgconf glib-dev glib-static pixman-dev zlib-dev ninja meson bash flex bison` | meson 1.11.1, python 3.14.7, gcc 15.2.0 |
| конфигурация | `../qemu/configure --target-list=e2k-linux-user --disable-docs --disable-werror --disable-slirp` | успешно (в логе: `slirp: disabled`, `werror: false`) |
| сборка | `make -j12` | **1019 шагов, без ошибок**; `Linking target qemu-e2k` |
| проверка | `qemu-e2k --version` | `qemu-e2k version 11.0.1` |

**Помех вроде CRLF и отсутствующих каталогов здесь не было:** архив МЦСТ распакован **внутри**
WSL нативным `tar`, дерево полное (35 086 файлов), сборочные скрипты пришли с LF.

**Проверено ли, что собран именно рабочий QEMU:** да, контрольным экспериментом — тем же
`configure`/`make` собран `qemu-x86_64` той же версии, и он запускает статический бинарник
x86-64 (`docs/e2k-qemu-run.md` §2.3). То есть сборка QEMU в этом окружении работоспособна, а
препятствие к **прогону** e2k — отдельное и названо там же.

---

## 3. Что осталось НЕ проверенным

| проверка | состояние |
|---|---|
| наши байты принимает MCST-objdump | **выполнено**: binutils собран в WSL, 10 из 10 образцов совпали — `docs/e2k-external-validation.md` §4 |
| прогон наших байтов эмулятором | **не выполнено**: QEMU собран (§2.5), но `qemu-e2k` не может разместить гостя — точная причина в `docs/e2k-qemu-run.md` §2 |
| прогон пяти DSP-ядер на реальном эмуляторе | **не выполнен**: нет e2k-бинарника из конвейера проекта (`docs/e2k-qemu-run.md` §3) |

**Что это значит для доказательности на 2026-09-15:** раскладка полей подтверждена совпадением
четырёх независимых описаний **и** внешним дизассемблером МЦСТ на десяти образцах. Не проверено
исполнение: эмулятор собран, но в этом окружении не запускает e2k-гостя (`docs/e2k-qemu-run.md`).

---

## 4. Что нужно, чтобы сборка состоялась (и как она состоялась)

| условие | зачем | состояние |
|---|---|---|
| Linux-окружение | `configure` — shell-скрипт; user-mode цель требует POSIX-хоста | **получено**: WSL1 + Alpine (§2.5) |
| `gcc`, `make` | сборка | есть (gcc 15.2.0, make 4.4.1) |
| `meson >= 1.5`, `ninja`, `python3` | система сборки QEMU 11.x | есть (meson 1.11.1, ninja 1.9, python 3.14.7) |
| `glib-2.0`, `pkg-config`, `pixman` | зависимости | есть (`glib-dev`, `glib-static`, `pixman-dev`) |

Порядок, который сработал: `wsl --import e2k … --version 1` → `apk add …` → распаковать архив
внутри WSL → `mkdir build && cd build` → `../qemu/configure --target-list=e2k-linux-user
--disable-docs --disable-werror --disable-slirp` → `make -j12`. Бинарь: `/root/qemu-build/qemu-e2k`.

**На Windows-хосте** (без WSL) ни один из шагов не выполним — §2.1–2.2 остаются в силе.

---

## 5. Статусы

| утверждение | статус |
|---|---|
| архив МЦСТ получен, целостность по `sha256` совпадает | **ФАКТ** (§1; сверяет `src/scripts/e2kSources.audit.test.ts`) |
| порт e2k в архиве есть, цель `e2k-linux-user` объявлена | **ФАКТ** (§1) |
| поддерживаются `elbrus-v2`…`elbrus-v7` | **ФАКТ** (`target/e2k/cpu.c:851-856`) |
| QEMU-e2k собран | **ДА** — в WSL1, версия 11.0.1 (§2.5) |
| на Windows-хосте сборка невозможна | **ФАКТ** (§2.1–2.3) |
| собранный QEMU запускает e2k-бинарник | **НЕТ** — `guest_base` не размещается в WSL1; причина и контрольный эксперимент — `docs/e2k-qemu-run.md` §2 |
