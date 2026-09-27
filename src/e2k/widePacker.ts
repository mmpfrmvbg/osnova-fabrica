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
 * packает то, что не является короткой операцией ALS: литералы, сравнения (`nop = 2` живёт в HS
 * и был бы общим для всей команды), команды управления отдельной инструкцией (`setbn`, `setmas`,
 * `call`). Такие инструкции становятся командой из одного слота **и разделяют пакеты** — они
 * остаются барьером порядка.
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
  wideCommandBytes,
  wideControlSyllableOf,
  E2K_ALS_NUM,
  type AlsSyllable,
  type WideControlSyllable,
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
  if (!instruction.operands.every((operand) => operand.kind === 'reg')) {
    return `«${instruction.mnemonic}»: не все операнды — регистры (литералы кодируются слогами LTS)`;
  }
  try {
    alsSyllableOf(instruction);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  // Управляющий слог пары раскладывается ли в слог широкой команды вообще (`setbn`, `setmas`) —
  // иначе инструкция станет командой из одного слота, и причина отказа будет названа.
  if (instruction.control !== undefined) {
    try {
      wideControlSyllableOf(instruction.control);
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
  group: readonly { instruction: AsmInstruction; syllable: AlsSyllable }[],
  control?: WideControlSyllable,
): Uint8Array {
  const ordered = [...group].sort((a, b) => a.syllable.channel - b.syllable.channel);
  return wideCommandBytes(
    ordered.map((slot) => ({
      channel: slot.syllable.channel,
      als: slot.syllable.als,
      ...(slot.syllable.ales === undefined ? {} : { ales: slot.syllable.ales }),
    })),
    control,
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
    return { slots: [{ instruction, channel }], bytes: encoder.encode(instruction) };
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
  let group: { instruction: AsmInstruction; syllable: AlsSyllable; registers: { reads: string[]; writes: string[] } }[] =
    [];
  const usedChannels = new Set<number>();
  let groupReads: string[] = [];
  let groupWrites: string[] = [];
  /** Управляющий слог пакета: у инструкций с полем `control` он едет в той же команде. */
  let groupControl: WideControlSyllable | undefined;

  const flush = (): void => {
    if (group.length === 0) return;
    if (group.length === 1) {
      // Одиночный слот — байты у одиночного кодировщика: один источник раскладки (он же собирает
      // пару «ALS + управляющий слог», если она у инструкции есть).
      packets.push(singlePacket(group[0]!.instruction, undefined));
    } else {
      packets.push({
        slots: group.map((slot) => ({ instruction: slot.instruction, channel: slot.syllable.channel })),
        bytes: encodeWideGroup(group, groupControl),
      });
    }
    group = [];
    usedChannels.clear();
    groupReads = [];
    groupWrites = [];
    groupControl = undefined;
  };

  for (const instruction of instructions) {
    const refusal = packetableRefusal(instruction);
    if (refusal !== undefined) {
      flush(); // барьер: то, что до и после, в одну команду не сливается
      packets.push(singlePacket(instruction, refusal));
      continue;
    }
    const syllable = alsSyllableOf(instruction);
    const registers = registersOf(instruction);
    // Слог управления пары: раскладка уже проверена `packetableRefusal`, здесь он нужен для пакета.
    const control = instruction.control === undefined ? undefined : wideControlSyllableOf(instruction.control);
    // Канал: первый разрешённый, которого нет в пакете. Занят — инструкция ждёт следующей команды.
    const channel = syllable.channels.find((candidate) => !usedChannels.has(candidate));
    const conflict =
      group.length === 0
        ? undefined
        : dependent({ reads: groupReads, writes: groupWrites }, registers) ??
          (group.length >= MAX_SLOTS ? `в пакете уже ${group.length} слогов (предел ${MAX_SLOTS})` : undefined) ??
          (control !== undefined && groupControl !== undefined
            ? `в пакете уже есть управляющий слог «${groupControl.form}»: слог управления в команде один`
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
      groupControl = control ?? groupControl;
      continue;
    }
    group.push({ instruction, syllable: { ...syllable, channel }, registers });
    usedChannels.add(channel);
    groupReads = [...groupReads, ...registers.reads];
    groupWrites = [...groupWrites, ...registers.writes];
    groupControl = control ?? groupControl;
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
