# Системная модель e2k (`qemu-system-e2k`) — сборка и пробы

Это **не** та модель, которой измерены закреплённые числа `src/e2k/**` и `src/vliw/**`.
Та — **user-mode** `qemu-e2k` (паспорт `src/e2k/qemuModelPassport.ts`, правка порта и
инструкция — в `tools/qemu-e2k/README.md`). Здесь — **системная** модель: полная машина
`-M e2k`, ядро вместо процесса. Собрана 2026-10-03, разбор и замеры — `docs/e2k-qemu-system.md`.

| | |
|---|---|
| источник | [`OpenE2K/qemu-e2k`](https://github.com/OpenE2K/qemu-e2k), ветка `e2k-softmmu` (зеркало `git.mentality.rip/OpenE2K/qemu-e2k`) |
| коммит | `e3304f721947f91deb3855dcdfc8243f948ee158` — «e2k: working (???) console», 2021-08-26 |
| версия | `QEMU emulator version 6.0.91` |
| бинарь в WSL | `/root/qemu-sys/qemu-system-e2k` (42 836 112 байт) |
| `sha256` | `5ace3daeeb03158306387943f08d33bfc8ed1e573218c8762dfcdd2b7a576188` |
| окружение сборки | chroot Alpine 3.14.9 (`/root/alpine314`): gcc 10.3.1, python 3.9.17, meson 0.58.1, glib 2.68.3 |
| состояние | машина поднимается и **исполняет наши байты**; программу до конца не доводит и ОС не грузит — четыре названные преграды в §5 дока |

## Как собрать

```bash
# в WSL-дистрибутиве e2k, от root
bash tools/qemu-e2k/system/build-system.sh     # клон → chroot Alpine 3.14 → configure → ninja → сверка sha256
bash tools/qemu-e2k/system/probe-system.sh     # что модель делает и на чём встаёт
```

`build-system.sh` печатает **вердикт сверки** `sha256` с записанным в этом файле и в доке:
совпал — сборка воспроизвелась побайтово; разошёлся — числа требуют перемера (и это красное,
а не «ну и ладно»).

## Почему chroot, а не сборка на современном Alpine

Замер 2026-10-03: `configure` на Alpine 3.24 (gcc 15.2.0, meson 1.11.1) проходит, а `ninja`
падает на несовместимостях QEMU 6.0.91 с новым инструментом:

- `hw/vfio/pci.c:2833`: `implicit declaration of function 'basename'`;
- `fpu/softfloat.c` + `fpu/softfloat-parts.c.inc:1294`: `conflicting types for 'parts128_compare'`.

Alpine 3.14 — ровесник ветки (2021), на нём собирается без правок исходников. Правок в
исходники ветки не внесено **ни одной**: то, что собрано, — это ровно она.

## Границы (кратко)

1. Прошивки `e2k.bin` (её машина требует без `-kernel`) в открытом доступе нет.
2. Системный режим не настраивает окно процедур (`wd.size_q/psize_q`) — на первом же `call`
   ловушка `EXCP_WINDOW_BOUNDS` (9).
3. Обработчик исключений — заглушка `exit(1)` (`target/e2k/cpu.c#e2k_cpu_do_interrupt`).
4. `initrd` не поддержан вовсе (`TODO` в `hw/e2k/e2k.c`), устройств хранения у машины нет.

Подробности, номера и следующий заход — `docs/e2k-qemu-system.md`.
