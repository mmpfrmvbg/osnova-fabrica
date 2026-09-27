/**
 * ГРУППИРОВКА ИНСТРУКЦИЙ В ШИРОКИЕ КОМАНДЫ e2k.
 *
 * # Зачем
 *
 * Кодировщик (`src/e2k/e2k-real.ts`) выдаёт **одну** команду на инструкцию: HS + один слог ALS.
 * Реальный e2k исполняет за такт несколько операций, если они лежат слогами одной широкой команды
 * (форма извлечена и замерена в `docs/e2k-wide-commands.md`). Этот модуль строит такие команды.
 *
 * # Что здесь правило, а что — измерение
 *
 * | утверждение | откуда |
 * |---|---|
 * | команда = HS + слоги ALS по возрастанию канала | `docs/e2k-wide-commands.md` §2.3–2.4 |
 * | `lng = слов/2 − 1`, `mdl` = слов до «средней точки» − 1 | там же §2.2, §4.2 |
 * | добивка до чётного числа 4-байтовых слогов | там же §2.5 (`gas/config/tc-e2k.c:9488-9492`) |
 * | две операции в один канал — отказ ассемблера | там же §2.6 (`gas/config/tc-e2k.c:8668`) |
 * | **нельзя класть в одну команду операции с зависимостью** | это **наше** правило: ассемблер зависимости не проверяет, а порядок слогов внутри команды не определён. Проверяется прогоном (`src/e2k/e2kWideQemu.test.ts`) |
 *
 * # Чего модуль НЕ делает
 *
 * Не планирует и не переставляет: порядок инструкций сохраняется, меняется только упаковка. Не
 * packает то, что не является короткой операцией ALS: сравнения (`nop = 2` живёт в HS и был бы общим
 * для всей команды), команды управления **отдельной инструкцией** (`setbn`, `setmas`, `call`),
 * 64-битный литерал (форма 0xdc — два слова LTS). Такие инструкции становятся командой из одного
 * слота **и разделяют пакеты** — они остаются барьером порядка.
 *
 * # Литерал в упаковщике ВКЛЮЧЁН 2026-09-27
 *
 * Раньше литерал был барьером пакетов «по решению»: раскладка была измерена, а включение отложено,
 * потому что сдвигало закреплённые числа. Включён вместе с перемером чисел. Два вида литерала ведут
 * себя по-разному, и оба измерены ассемблером МЦСТ:
 *
 * | литерал | как едет | чем измерено |
 * |---|---|---|
 * | значение 0…15 | обычный слог ALS короткой формы (`0xc0 \| N`), слова `LTS` нет | `.tmp/osnova-lts-short-probe.ts`, 6 форм |
 * | значение ≥ 16 | слог ALS + слово `LTS` последним, добивка встаёт перед ним | `src/e2k/e2kWideSsLts.test.ts`, 14 форм |
 *
 * В одной команде — не больше одного `LTS` (измерены формы с одним словом); два малых литерала
 * допустимы, потому что слова `LTS` они не несут вовсе.
 *
 * # Что модуль умеет с управляющим слогом
 *
 * Команду управления он паковать не начал: её по-прежнему нельзя положить в широкую команду
 * **отдельной инструкцией**. Но пара «операция ALS + управляющий слог» — это одна инструкция с
 * полем `control` (`src/e2k/backend.ts`), и такая инструкция пакуется: слог CS1 встаёт после
 * слогов ALS и до полуслогов ALES, а признаки идут в поля `cs`/`mdl` заголовочного слога
 * (`src/e2k/e2k-real.ts`, раздел «ШИРОКАЯ КОМАНДА «ОПЕРАЦИЯ ALS + УПРАВЛЯЮЩИЙ СЛОГ»»).
 * В одной команде управляющий слог **один** — вторая такая инструкция начинает новый пакет.
 */

import { getEncoder, type AsmInstruction, type Operand } from './backend';
import {
  alsSyllableOf,
  realControlOpcode,
  realOpcode,
  realRefusalReason,
  wideAlsSlotOf,
  wideCommandBytes,
  wideSyllablesOf,
  E2K_ALS_NUM,
  type WideAlsSlot,
  type WideCommandSyllables,
} from './e2k-real';

/** Сколько слогов ALS допускает форма: `E2K_ALS_NUM = 6` (`qemu/target/e2k/syllab-format.h:219`). */
export const MAX_SLOTS = E2K_ALS_NUM;

/** Слот широкой команды: инструкция и канал, в который её положил группировщик. */
export interface PackedSlot {
  readonly instruction: AsmInstruction;
  readonly channel: number;
}

/** Широкая команда: слоги и её байты. `refusal` — причина, по которой команда не закодирована. */
export interface WidePacket {
  readonly slots: readonly PackedSlot[];
  readonly bytes: Uint8Array;
  readonly refusal?: string;
}

const encoder = getEncoder('e2k');

/** Тождество регистра: файл регистров входит в него — `%b[3]` и `%r3` разные регистры. */
function registerKey(operand: Operand): string | undefined {
  if (operand.kind !== 'reg') return undefined;
  return `${operand.file ?? 'base'}:${operand.index}`;
}

/** Читаемые и записываемые регистры инструкции — по слотам формы (`src1`, `src2`, `dst`, `pdst`). */
export function registersOf(instruction: AsmInstruction): { reads: string[]; writes: string[] } {
  const entry = realOpcode(instruction.mnemonic);
  if (entry === undefined || entry.operands.length !== instruction.operands.length) {
    // Неизвестная форма: считаем, что инструкция читает и пишет всё, что у неё есть. Так она не
    // попадёт в пакет ни с чем — отказ в пользу сохранения порядка.
    const all = instruction.operands.map(registerKey).filter((key): key is string => key !== undefined);
    return { reads: all, writes: all };
  }
  const reads: string[] = [];
  const writes: string[] = [];
  entry.operands.forEach((slot, index) => {
    const key = registerKey(instruction.operands[index]!);
    if (key === undefined) return;
    if (slot === 'dst' || slot === 'pdst') writes.push(key);
    else reads.push(key);
  });
  return { reads, writes };
}

/**
 * Годится ли инструкция в слог широкой команды.
 *
 * Отказ — не ошибка: такая инструкция станет командой из одного слота. Причина отказа называется.
 */
export function packetableRefusal(instruction: AsmInstruction): string | undefined {
  const entry = realOpcode(instruction.mnemonic);
  if (entry === undefined) {
    // Команда управления **отдельной инструкцией** в широкую команду не идёт: у неё нет слога ALS.
    // В паре с операцией ALS тот же слог несёт поле `control` (см. `wideControlSyllableOf`).
    if (realControlOpcode(instruction.mnemonic) !== undefined) {
      return (
        `«${instruction.mnemonic}»: команда управления — идёт отдельной командой; ` +
        'в одной широкой команде с операцией ALS её несёт поле control'
      );
    }
    return realRefusalReason(instruction.mnemonic);
  }
  if ((entry.implicitNops ?? 0) !== 0) {
    return `«${instruction.mnemonic}»: поле nop = ${String(entry.implicitNops)} живёт в HS и было бы общим для всей команды`;
  }
  // Литерал в широкой команде: раскладка ИЗМЕРЕНА и кодируется (`wideAlsSlotOf`,
  // `src/e2k/e2kWideSsLts.test.ts`, `docs/hardware-debt.md` §3.34), но в упаковщик НЕ включена —
  // причина названа, а не спрятана. Замер 2026-09-27: с ней литерал перестаёт быть барьером
  // пакетов, и закреплённые числа корпуса сдвигаются (пакетов 220 → 210, «литеральных с отказом»
  // 20 → 0, отказы по `movts` исчезают). По правилу проекта сдвинутое число — отдельный коммит с
  // датой (`AGENTS.md`, «Инварианты правок в `src/e2k/**`»), поэтому включение — следующий шаг.
  const nonRegister = instruction.operands.filter((operand) => operand.kind !== 'reg');
  if (nonRegister.length > 0) {
    const kind = nonRegister[0]!.kind;
    if (kind === 'imm64') {
      // 64-битный литерал — форма 0xdc, ДВА слова LTS. В широкую команду не идёт: раскладка
      // «ALS + два LTS» не измерялась (`docs/hardware-debt.md` §3.34; отдельная ветвь кодировщика
      // `encodeImm64` собирает её только для одиночной команды).
      return (
        `«${instruction.mnemonic}»: 64-битный литерал (${kind}) в широкую команду не кладётся — ` +
        'форма 0xdc несёт два слова LTS, и раскладка «ALS + два LTS» ассемблером МЦСТ не измерялась'
      );
    }
    if (kind !== 'imm') {
      return `«${instruction.mnemonic}»: операнд вида ${kind} в широкую команду не кладётся`;
    }
    // Литерал (`imm`) в упаковщик ВКЛЮЧЁН 2026-09-27. Раскладка измерена: `HS, [SS], ALS…,
    // [CS0|CS1], [ALES…], [добивка], [LTS]` — литерал входит в счёт добивки (`src/e2k/e2kWideSsLts.test.ts`,
    // 14 форм сверены с `as` побайтово), а малый литерал (0…15) и вовсе идёт короткой формой без
    // слова LTS (замер 2026-09-27, `.tmp/osnova-lts-short-probe.ts`). Дальше решение принимает
    // `wideAlsSlotOf`: если форма литерал не выражает (длинная форма ALF11), причина вернётся оттуда.
  }
  try {
    wideAlsSlotOf(instruction);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  // Слоги управления пары раскладываются ли в слог широкой команды вообще (`ct`, `sdisp`, `call`,
  // `setbn`, `setmas`) — иначе инструкция станет командой из одного слота, и причина будет названа.
  if (instruction.control !== undefined) {
    try {
      wideSyllablesOf(instruction.control);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return `«${instruction.mnemonic}» + «${instruction.control.mnemonic}»: ${reason}`;
    }
  }
  return undefined;
}

/** Есть ли зависимость между двумя инструкциями: RAW, WAR или WAW. */
function dependent(a: { reads: string[]; writes: string[] }, b: { reads: string[]; writes: string[] }): string | undefined {
  const shared = (left: readonly string[], right: readonly string[]): string[] =>
    left.filter((key) => right.includes(key));
  const writeWrite = shared(a.writes, b.writes);
  if (writeWrite.length > 0) return `WAW по ${writeWrite.join(', ')}`;
  const readWrite = shared(a.reads, b.writes);
  if (readWrite.length > 0) return `RAW по ${readWrite.join(', ')}`;
  const writeRead = shared(a.writes, b.reads);
  if (writeRead.length > 0) return `WAR по ${writeRead.join(', ')}`;
  return undefined;
}

/**
 * Байты широкой команды из слогов: HS + ALS по каналам + управляющий слог + полуслоги ALES +
 * добивка.
 *
 * Раскладка живёт в `src/e2k/e2k-real.ts` (`wideCommandBytes`) — одна на одиночный кодировщик и
 * на группировщик: вторая реализация разошлась бы с первой, и расхождение не поймал бы ни один
 * оракул.
 */
export function encodeWideGroup(
  group: readonly { instruction: AsmInstruction; syllable: WideAlsSlot }[],
  syllables: WideCommandSyllables = {},
): Uint8Array {
  const ordered = [...group].sort((a, b) => a.syllable.channel - b.syllable.channel);
  return wideCommandBytes(
    ordered.map((slot) => ({
      channel: slot.syllable.channel,
      channels: slot.syllable.channels,
      als: slot.syllable.als,
      ...(slot.syllable.ales === undefined ? {} : { ales: slot.syllable.ales }),
      ...(slot.syllable.lts === undefined ? {} : { lts: slot.syllable.lts }),
    })),
    syllables,
  );
}

/** Команда из одного слота: байты берутся у одиночного кодировщика — один источник раскладки. */
function singlePacket(instruction: AsmInstruction, refusal: string | undefined): WidePacket {
  // Канал у непackуемой команды берём у неё самой: слога ALS у неё может и не быть (литерал,
  // управляющий слог), но одиночный кодировщик знает, как её закодировать.
  let channel = instruction.channel;
  try {
    channel = alsSyllableOf(instruction).channel;
  } catch {
    // Причина отказа уже названа вызывающим; здесь важен только канал.
  }
  try {
    // Причина отказа сохраняется и тогда, когда байты есть: `refusal` — это ответ на вопрос «почему
    // команда НЕ в широкой команде», а не «почему её не удалось закодировать». До 2026-09-27 поле
    // заполнялось только при отказе одиночного кодировщика, поэтому причины-барьеры (управляющий
    // слог, `nop = 2` в HS, 64-битный литерал) до `wideStats.refusals` не доходили: статистика
    // молчала о сознательно отложенном, и «отказов нет» читалось как «барьеров нет».
    return {
      slots: [{ instruction, channel }],
      bytes: encoder.encode(instruction),
      ...(refusal === undefined ? {} : { refusal }),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { slots: [{ instruction, channel }], bytes: new Uint8Array(0), refusal: refusal ?? reason };
  }
}

/**
 * Упаковать инструкции одной процедуры в широкие команды.
 *
 * Порядок инструкций сохраняется; в один пакет попадают только те, что не связаны по регистрам
 * (RAW/WAR/WAW) и не совпадают по каналу. Всё, что не является короткой операцией ALS, становится
 * командой из одного слота и границей пакета. Инструкция с управляющим слогом (`control`) пакуется
 * как обычная операция ALS, но таких в одной команде не больше одной: слог управления в команде
 * один (`qemu/target/e2k/syllab-format.h:24-25`).
 */
export function packWide(instructions: readonly AsmInstruction[]): WidePacket[] {
  const packets: WidePacket[] = [];
  let group: { instruction: AsmInstruction; syllable: WideAlsSlot; registers: { reads: string[]; writes: string[] } }[] =
    [];
  const usedChannels = new Set<number>();
  let groupReads: string[] = [];
  let groupWrites: string[] = [];
  /** Слоги SS/CS пакета: у инструкции с полем `control` они едут в той же команде. */
  let groupSyllables: WideCommandSyllables = {};

  const flush = (): void => {
    if (group.length === 0) return;
    if (group.length === 1) {
      // Одиночный слот — байты у одиночного кодировщика: один источник раскладки (он же собирает
      // пару «ALS + слоги SS/CS/LTS», если она у инструкции есть).
      packets.push(singlePacket(group[0]!.instruction, undefined));
    } else {
      packets.push({
        slots: group.map((slot) => ({ instruction: slot.instruction, channel: slot.syllable.channel })),
        bytes: encodeWideGroup(group, groupSyllables),
      });
    }
    group = [];
    usedChannels.clear();
    groupReads = [];
    groupWrites = [];
    groupSyllables = {};
  };

  for (const instruction of instructions) {
    const refusal = packetableRefusal(instruction);
    if (refusal !== undefined) {
      flush(); // барьер: то, что до и после, в одну команду не сливается
      packets.push(singlePacket(instruction, refusal));
      continue;
    }
    const syllable = wideAlsSlotOf(instruction);
    const registers = registersOf(instruction);
    // Слоги SS/CS пары: раскладка уже проверена `packetableRefusal`, здесь они нужны для пакета.
    const syllables = instruction.control === undefined ? {} : wideSyllablesOf(instruction.control);
    const hasSs = syllables.ss !== undefined;
    const hasCs = syllables.cs !== undefined;
    const alreadySs = groupSyllables.ss !== undefined;
    const alreadyCs = groupSyllables.cs !== undefined;
    // Канал: первый разрешённый, которого нет в пакете. Занят — инструкция ждёт следующей команды.
    const channel = syllable.channels.find((candidate) => !usedChannels.has(candidate));
    const conflict =
      group.length === 0
        ? undefined
        : dependent({ reads: groupReads, writes: groupWrites }, registers) ??
          (group.length >= MAX_SLOTS ? `в пакете уже ${group.length} слогов (предел ${MAX_SLOTS})` : undefined) ??
          (hasSs && alreadySs ? 'в пакете уже есть слог SS: слог SS в команде один' : undefined) ??
          (hasCs && alreadyCs ? `в пакете уже есть управляющий слог «${groupSyllables.cs!.form}»` : undefined) ??
          (syllable.lts !== undefined && group.some((slot) => slot.syllable.lts !== undefined)
            ? 'в пакете уже есть литерал: измерены формы с одним словом LTS'
            : undefined);
    if (channel === undefined || conflict !== undefined) {
      flush();
      const retry = syllable.channels.find((candidate) => !usedChannels.has(candidate));
      if (retry === undefined) {
        // Такого быть не может: в пустом пакете свободны все каналы операции. Но если случится,
        // причина называется, а не пропускается молча.
        packets.push(singlePacket(instruction, `«${instruction.mnemonic}»: нет свободного канала в пустом пакете`));
        continue;
      }
      group.push({ instruction, syllable: { ...syllable, channel: retry }, registers });
      usedChannels.add(retry);
      groupReads = [...groupReads, ...registers.reads];
      groupWrites = [...groupWrites, ...registers.writes];
      groupSyllables = { ...groupSyllables, ...syllables };
      continue;
    }
    group.push({ instruction, syllable: { ...syllable, channel }, registers });
    usedChannels.add(channel);
    groupReads = [...groupReads, ...registers.reads];
    groupWrites = [...groupWrites, ...registers.writes];
    groupSyllables = { ...groupSyllables, ...syllables };
  }
  flush();
  return packets;
}

/** Замер: линейный код против пакетов. */
export interface WideStats {
  /** Сколько было бы команд без группировки: одна на инструкцию. */
  readonly linearCommands: number;
  /** Сколько команд получилось с группировкой. */
  readonly packets: number;
  readonly bytesLinear: number;
  readonly bytesWide: number;
  /** Сколько инструкций реально уехало в команды из двух и более слогов. */
  readonly packedSlots: number;
  /** Сколько инструкций одиночный кодировщик **отказался** кодировать (носители `IR.*`). */
  readonly refused: number;
  /** Отказы группировки: мнемоника → причина. */
  readonly refusals: ReadonlyMap<string, string>;
}

/** Посчитать замер по списку инструкций одной процедуры. */
export function wideStats(instructions: readonly AsmInstruction[]): WideStats {
  const packets = packWide(instructions);
  // Отказ одиночного кодировщика — не исключение для замера: инструкция без кодировки считается
  // отдельно, иначе замер падал бы на первом же носителе `IR.*` вместо того, чтобы его назвать.
  let bytesLinear = 0;
  let refused = 0;
  for (const instruction of instructions) {
    try {
      bytesLinear += encoder.encode(instruction).length;
    } catch {
      refused++;
    }
  }
  const bytesWide = packets.reduce((sum, packet) => sum + packet.bytes.length, 0);
  const refusals = new Map<string, string>();
  for (const packet of packets) {
    if (packet.refusal !== undefined) refusals.set(packet.slots[0]!.instruction.mnemonic, packet.refusal);
  }
  return {
    linearCommands: instructions.length,
    packets: packets.length,
    bytesLinear,
    bytesWide,
    packedSlots: packets.filter((packet) => packet.slots.length > 1).reduce((sum, packet) => sum + packet.slots.length, 0),
    refused,
    refusals,
  };
}

/** Склеить байты пакетов подряд — образ процедуры для прогона и разбора. */
export function wideBytes(packets: readonly WidePacket[]): Uint8Array {
  const total = packets.reduce((sum, packet) => sum + packet.bytes.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const packet of packets) {
    bytes.set(packet.bytes, offset);
    offset += packet.bytes.length;
  }
  return bytes;
}
