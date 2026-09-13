---
title: _index
updated: '2026-09-13'
tags:
  - layer/system
  - status/active
---

# Memory index — OSNOVA-FABRIKA

## Active topic

Основа как самовоспроизводящаяся среда и будущая ОС под VLIW с ИИ. Метод: оракул на каждый слой.

## Where we left off

- Контуры: `loop` (verified), `self-improve` (verified), `resident` (mock + eval).
- Язык под агентов: динамический доступ + `eval` + кортежи.
- **Self-hosting достигнут**: `src/self-host/stage14.osnova` — полный конвейер лексер→парсер→кодоген→байткод на самой Основе, self-check → 9.
- Всё закоммичено точечными коммитами. Цель + карта: `BIG-PICTURE.md`.

Находки: ключевые слова как имена; поле байткода `op`; нет dotenv. [[2026-09-12]]

## Next step

Расширить self-hosting до полного языка (модуль/процедуры/все конструкции) → полный self-check. Затем VLIW, ядро ОС.

## Sessions

- [[2026-09-12]]
