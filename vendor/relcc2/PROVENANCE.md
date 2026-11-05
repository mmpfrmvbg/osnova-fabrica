<!-- Это ЧУЖОЙ документ-опись, а не наш док: в docs/manifest.yaml он не заведён намеренно (см. «Границы»). -->

# `vendor/relcc2` — чужая спецификация e2k (ABI и ISA): копия побайтово

**Что это.** Дословная копия каталога `spec/` репозитория
[`OpenE2K/relcc2`](https://github.com/OpenE2K/relcc2/tree/main/spec): спецификация ABI
(`spec/abi/`) и ISA (`spec/isa/`) процессоров «Эльбрус», собранная сообществом OpenE2K.
**46** файлов, **3 533 483** Б.

**Чем доказано, что копия та самая.** Каждый файл скачан с закреплённого коммита и сверен
**git-blob sha1** — тем самым хешем содержимого, который называет GitHub в описи дерева:
`sha1("blob <len>\0" + bytes)`. Совпало **46/46**, расхождений **0**; опись — `inventory.json`.
Проверка воспроизводится без сети:

```bash
node vendor/relcc2/fetch-spec.mjs check    # сверить лежащую копию с описью (выход 1 при расхождении)
node vendor/relcc2/fetch-spec.mjs table    # таблица описи, которая напечатана ниже
node vendor/relcc2/fetch-spec.mjs fetch    # залить заново с закреплённого коммита (нужна сеть)
```

## Ревизия источника

| поле | значение |
|---|---|
| репозиторий | `OpenE2K/relcc2` |
| ветка | `main` |
| коммит | `8ec8ee6f12cb84266f004e9d0e18d66c21c86991` |
| дата коммита | 2026-11-03T18:17:08Z |
| дерево (`git/trees` пин) | `aba0e4f8f05131617d69b416b51a0ff6625e5a41` |
| залито в это дерево | 2026-11-06 |
| канал | `api.github.com` + `raw.githubusercontent.com` (обычный TLS) |
| сверка | git-blob sha1 против описи дерева GitHub, 46/46 |

Ревизия закреплена **коммитом**, а не веткой: ветка уедет, а опись обязана остаться
проверяемой. Любую строку таблицы ниже можно перепроверить независимо от нас — через API по
этому коммиту.

## Зачем это в дереве

`spec/abi/registers.md` уже цитируется нашим кодом **как закон**, а не как мнение:

- `src/e2k/twoPassLayout.ts` (комментарий о законе окна, §3.166): предел клеток вызываемой —
  `min(2·(rsz + 1), 2·(wsz − wbs))`, а не восемь клеток «по закону окна»; раздел
  `spec/abi/registers.md` → **«Register file (guide 9.3.1)» → «Window and rotating-base units»**.
- `src/e2k/arrayRuntime.ts` (тот же предел, объяснение `wsz = 16` против `rsz`).
- Разбор с числами — `docs/hardware-debt.md` §3.166.

Без локальной копии цитату нечем перепроверить: ссылка на документ, которого нет под рукой,
источником не является. Машина бывает без сети (и на живой машине МЦСТ чужого репозитория тоже
нет), а спор «спецификация говорит так» решается чтением той же ревизии.

## Границы — названы, а не умолчаны

- **Это не канон «Основы» и не источник истины о языке.** Язык — `docs/language-v2.md` и код
  компилятора; здесь спецификация **железа**. Расхождение нашей реализации со этим текстом —
  предмет разбора, а не автоматическая правота текста.
- **Не редактировать.** Любая правка ломает сверку: `check` покраснеет, и «копия та самая»
  перестанет быть доказанным. Правка upstream — это `fetch` отдельным коммитом.
- **Ссылаться на раздел по имени, а не на номер строки** (правило дерева: номер строки гниёт).
- **В `docs/manifest.yaml` намеренно НЕ заведено.** Реестр доков про **наши** доки: `docs:check`
  проставляет в файлы штамп `<!-- doc-status: … -->`, а копия обязана остаться байт в байт.
  Поэтому `vendor/` лежит вне `docs/**`, и сторож документации его не трогает.
- **В `.gitattributes` каталог помечен `-text`** — содержимое хранится как есть, без
  нормализации переводов строк. Репозиторий строит доказательства на байтах, поэтому молчаливое
  преобразование содержимого здесь запрещено так же, как и в наших доках.

## Лицензия — чужая, и это важно

- `spec/LICENSE` — **CC BY-SA 4.0**; `spec/NOTICE.md` — атрибуция: части спецификации
  адаптированы из «Руководства по эффективному программированию на платформе „Эльбрус“»
  (версия 1.1, © 2021 АО «МЦСТ», CC BY 4.0), факты об кодировках и системных интерфейсах взяты из
  GPL/LGPL-исходников МЦСТ. Оба файла лежат рядом с материалом и **не удаляются** — это условие
  распространения.
- Код «Основы» лицензирован иначе (`COPYING`: GPL-3.0-only + коммерческая лицензия,
  `LICENSE-COMMERCIAL.md`). Здесь лежит **дословная, не адаптированная** копия чужого текста со
  своей лицензией и атрибуцией: она остаётся своим блоком и в лицензию «Основы» не переходит.
  При коммерческом или ином публичном использовании это смотреть отдельно — своей правовой оценки
  этот файл не даёт.

## Как обновлять

1. `node vendor/relcc2/fetch-spec.mjs fetch` — заново залить и перезаписать `inventory.json`
   (в нём окажется новый коммит).
2. `node vendor/relcc2/fetch-spec.mjs check` — сверить залитое с описью.
3. Обновить таблицу ниже (`table`) и строки ревизии в этом файле.
4. Отдельным коммитом, назвав в сообщении старый и новый коммит-источник: числа, которые держатся
   на конкретной ревизии, обязаны быть перемерами, а не «теми же».

## Опись

Таблица сгенерирована из `inventory.json` (`fetch-spec.mjs table`): `git-blob sha1` — значение,
которое называет GitHub, `sha256` — то, чем копию можно сверить локально, без API.

| файл в `spec/` | размер, Б | git-blob sha1 (тот же хеш называет GitHub) | sha256 |
|---|---|---|---|
| `spec/LICENSE` | 20138 | `2d58298e6eda10e7204abb52722efbc840db2390` | `28a9529c7d0bb4dc51f4bf5c116a3d16ef247a052f7591466768ddf563fd1cf5` |
| `spec/NOTICE.md` | 1349 | `e1c7e5c257c5d9b21c8c156c73a40b169c0d27d0` | `cb59a47d585fb862131bfdec2deafc16e7818da98857e80ad5a431fa97e1e5ad` |
| `spec/abi/README.md` | 8571 | `1eb127dce15335da4c7dc101449479bf70989278` | `d67ad2efc8f7ab6e680529a6f201ea16f60dcbec4fc696b8460688725d4488c7` |
| `spec/abi/atomics.md` | 33502 | `092815ad3ec87ac3fc351d4c43292e75c87c96b4` | `c76c688c79cf2f0c9a73d6dc52842936e51d401660f14652a16ab2ff46e4fb36` |
| `spec/abi/calling-convention.md` | 38752 | `60963c473c5b0550a0e301aa1e7dcf6332d5edab` | `7e5ac9e68729093a6c6c9d51423607ac9889a471f2bb9d71392b1c2ab32846ee` |
| `spec/abi/data-layout.md` | 4270 | `65d0681cce6a2fc16231dc6e9bd7ec911291f78c` | `a2fd6ebf247f99d4c677a2cd881de99ea161cd218d2bae2f55205e4db6c6bfa7` |
| `spec/abi/elf.md` | 42513 | `1095d4f52306eea7e8857d616b76d2dd5c0ef333` | `211db4b5ca707b1a3af0ddbcf88ee291741f9d579b39b58381ad3e634cbe878e` |
| `spec/abi/kernel-build.md` | 66379 | `1ed3aab127822da5c46752d324fc17e85750d260` | `54431ca07c617ccd3773bdedc11cdaff6f6c1176b8c673e0ec7da2ad505267e4` |
| `spec/abi/kernel-interface.md` | 116668 | `a7dc51d4c23a6d6bd6b5447f08adc72371eff827` | `dc27f2f2834b2640d71ad1bb12b93f40dfe4425e0005cf7eadd199eced8a8b72` |
| `spec/abi/lcc-builtins-check.yaml` | 60529 | `9f4dda921638eb1bd421fd33a67be5101ab0f1df` | `ce0fae2aaa80eaaca436993725bc24bae1e0b19a66a4a8a9b575a6e46baa2a7d` |
| `spec/abi/lcc-builtins-misc.yaml` | 118751 | `30e5890d9e3d3c79dff7f25e21b8111eb980ce54` | `1b4a15fae86fdba3f726976d580e3bb252d4d317a29f5ab50fbb25275c369266` |
| `spec/abi/lcc-builtins-names.yaml` | 69640 | `ae6f5ee5c9e475761cb17ea6dc3f2b27f35209e0` | `9a8dbd14adc30befef71c3d9eb07a66557a40199881ae7254976a5c8c878c21f` |
| `spec/abi/lcc-builtins.md` | 26722 | `f13c93b9de1872b19c7a465e7f51058a37229be9` | `f9b8b4f244b6439c14bac5954703d7f5db25ae6a11c7df1aff2f53bff9cd75d7` |
| `spec/abi/lcc-builtins.yaml` | 78094 | `1abbc49d01372e50786f7f6c591aa6e5d5107857` | `56a1c0cc63808f6a037b46b62be6cde3ea56bbeb21c6262dbf6bb06a299821ba` |
| `spec/abi/mode32.md` | 43461 | `95aace2daf08ffaf8d416cbdf00a7008977eea9e` | `92c941ef76c4407c33f6b11db654aca8863d06d4e2a6708372020967bc8fd498` |
| `spec/abi/protected-mode.md` | 56267 | `b71c99d9827128a10db89bae4d1944824e4f20cb` | `d66322c1f9d6af9700b7c282fee73765d44f327a821aea73c190b13cfe28d422` |
| `spec/abi/registers.md` | 62718 | `38147dc897367d1101b66b493222c93fe47f92d9` | `fc173793385f9ba2c4fbbe2530785300338228c3d8f6c7d1ff2be7e6f13b88dd` |
| `spec/abi/source-compat.md` | 71275 | `0083913d900622476ff1ccfd856b8402ccca2bf5` | `57d29f1a421333b836b6fe1d6e33b9e5f8636ae56777330da09cda040970f2a1` |
| `spec/abi/stack-and-unwinding.md` | 74731 | `18381b76ef7abb805063f743806ad36390d02b9a` | `61d15f5d533c3cdc6dcb4c783ff92281a3c6e8ca83bcc29a43958d2215ed9a62` |
| `spec/isa/README.md` | 5615 | `4a360e8a424714741dfabe4b338c87160d889627` | `3161d9b99014d2d53b701d1b933166eac316d225913f1514a045041efee6f1e8` |
| `spec/isa/apb.md` | 67722 | `5973e583745d46e20241e61e93f54681f2dbdb56` | `557438b052a56d41202c2e5c44b440a15bb79c29e45a9c9deab1d46ce969c8a9` |
| `spec/isa/binutils-ops.yaml` | 537053 | `04e2ee1359b17674a9a95222b16fecb40202d6ee` | `3d827adb505d1bb7fecb2f28a4994f96363ad5a663c45dabfdd61dbe4c7d792d` |
| `spec/isa/bundle.md` | 42423 | `e835e16005772cbb8c61dbeabb4e1c96275100dd` | `a83034580c810c10d2694bcf948355f2c542300f239859e6d24eb73a78cadef8` |
| `spec/isa/control-transfer.md` | 31916 | `dbe3e6559e567920a69a329deb88d888fd9e42cd` | `534f463cc08d7ebd8b26e96c3812ca8ee5c7fd9723cc76c3fa8bd8e38dc0f887` |
| `spec/isa/hwbugs.md` | 21886 | `f23306aa5804beafc209efce7ff5fa43516fde2d` | `c70190c905556297b2a761298dfa7f539f43d9ca7b033c5c2eea464d7e25a232` |
| `spec/isa/lcc-usage.yaml` | 14658 | `7d83bbb8b24e701ce93558bf79fb10f506dc2c9d` | `164e3cdf4b6f7f97cbf35d23f30c94413aa86c3284dc80bf978d9d62686399a1` |
| `spec/isa/loops.md` | 41925 | `f4e20b4d2c9ce355ba555107ae175b7ce0b1716e` | `113ab6d1c93f44c9fa63112c06e23f8004dc915de627ebd53705fe608c544e87` |
| `spec/isa/monitors.md` | 32450 | `1ac2d059ce5669f23c734150ba71b454dfbcb057` | `0f756cf45a1874681a8c72e8d6594afcd7f377be40151334043802869b7f3f1e` |
| `spec/isa/operations-v3.md` | 54776 | `750a551c5eb6f8a8e214625e3d8fccbd4746dcf5` | `b7608951f7249cd4a7225ae3dc4ac40ec77933a05ce5cf5c99f05951b4f69189` |
| `spec/isa/operations-v3.yaml` | 47310 | `e4ba69a8f4303ae222a281fc0d5ca9a3d045d34d` | `9c48d76138e9f219e3239661eaa2049262c2806b3f76b33871cbb263b30e5106` |
| `spec/isa/operations-v5.md` | 28459 | `9ff16d19b1449794b55f557a8ffeb9ba0781bbc1` | `544bc19c429c109fffc97bda1198eb9c12e5c8a23ed7f4377b2b24e63dbd766b` |
| `spec/isa/operations-v5.yaml` | 26713 | `50bfd2e79392f6c5310955460e79fde007611fd1` | `7c957b33919a3a1cdcad529953165a509a5744e573071b7a13b8d1399e987cb0` |
| `spec/isa/operations-v6.md` | 10229 | `8145566391db0b367ee2e29732a29f689287c2db` | `ed4b462103cdbe0aab909a724f495042a2df81ba4c83c3289ae374c146f190e4` |
| `spec/isa/operations-v6.yaml` | 9724 | `dbb9dd1872169592d7f5dc0497703526a06d007b` | `0a4e34827efdabea7c841b23b8d8053cbf3d1335f6b6654533bc9aae0c2e82ff` |
| `spec/isa/operations-v7.md` | 2297 | `836f73b86f39372e954619b36209316a79dcbad6` | `75bd6be426053691f68818256371ef5356bb1686457f4bc9d53bd247786acf68` |
| `spec/isa/operations-v7.yaml` | 2320 | `e52d6453fe55283609afdae4fe4c1c509f24e0fb` | `1c7854eda39c131cf95142bd5546fc3763cbe08d3a2095c84ee3c0473b254206` |
| `spec/isa/predicates.md` | 48810 | `082bd2ae9ad16755d31bbf26b6b0a18c91c99887` | `a11e94018b3364a150b01fdea0cd2368a2d51b5637830b2d4f8a2a315df73773` |
| `spec/isa/registers.yaml` | 19388 | `996f33954f5e14800c5c4274d31186270caa1b0d` | `36d17402d681420304f6ddb474df7c768043b1c9311a4040e452c08587b63582` |
| `spec/isa/reservations.yaml` | 506884 | `94413d135103697ad4dc7f01f9a4cfaee5a0ce60` | `091a31ed4f310536c04918e92556ea0f0214c30f108aacd47964ed1d257bc55b` |
| `spec/isa/semantics.md` | 68742 | `d233911c2776842cc9b35b3bc768e6db791cfe80` | `0ad76da00c0ae5afee1088d4d18c06654c993c826b3c0c2142198cd4d115793e` |
| `spec/isa/speculation.md` | 60401 | `317cc275febcbde5da3e59a1857267bf7a0faee7` | `e9bc9c83dab8ade3c0cb6d94afd9dde4f3b2ab0aa6b7fa318be185e2212db1f2` |
| `spec/isa/timing-e2c3.yaml` | 260127 | `0ae9bb4c6341ae690263423232f516c0f1efc592` | `8ab8d0472af29da6356bcfdcee4582a402db0909d6ff999d9a2ee2949d9bea15` |
| `spec/isa/timing-e2s.yaml` | 206578 | `3231cbee7053339ca95955a89cead580d10848db` | `3f353d4a8aec6fb0484c11ef51e0abfeda92e02204798e41eb8064e0541720f6` |
| `spec/isa/timing-e8c2.yaml` | 245865 | `dfea5564edd82b8072467412d5ce66020a262184` | `02a3e0caff2b01daae66ee9b16edb43b687796cf72c1b8d4006c1f6dbccee3f6` |
| `spec/isa/timing.md` | 127360 | `d708d9ed29bdce133c25834229f80b76020ddd7a` | `e5b519c34b67db4f22bae05365163a93b655c932ee78e17fcff8d543af195570` |
| `spec/isa/x86-support.md` | 17522 | `022f85041f13652a7cf4bb16e96f5814efa8e360` | `36f7c857188e00cb0f00ccb9bed62beba537457d92b6b69ce0e9d52f03a9c861` |

Всего: **46** файлов, **3533483** Б.

