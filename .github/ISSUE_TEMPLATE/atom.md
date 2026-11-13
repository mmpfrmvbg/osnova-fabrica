---
name: Атом
about: Один атом (часы-дни) с DoD-доказательством
title: ""
labels: atom
assignees: ""
---

## Контекст

Ссылка: `docs/<file>#<anchor>`, D-серия, commit. Не пересказывать документ — только ссылка.

## Что сделать

[конкретно: где, что, чем ограничено]

## Оракул до/после

- До: [число/отказ]
- После: [число]

## N self-red

Назван: N = [число]. Откат правки → ровно N red.

## Стоп-условия

- [ ] VLIW (`regAlloc`/`liveness`/`spill`) — не трогали / СТОП
- [ ] ABI — не трогали / СТОП
- [ ] `src/compiler/parser.ts` — не трогали
- [ ] `osnova-spec.ts`/`language-v2.md` — не трогали
- [ ] D4 — не наступил
- [ ] hardware — [N/0], если required

## DoD

- [ ] Commit sha: [заполнить]
- [ ] CI L1 checks: [числа]
- [ ] CI L2 qemu: [числа]
- [ ] CI L3 hardware: [числа / не required]
- [ ] Docs обновлены: §N / D-серия
- [ ] D4 не наступил
