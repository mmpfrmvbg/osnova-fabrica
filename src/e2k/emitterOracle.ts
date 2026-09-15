/**
 * ОРАКУЛ ЭМИТТЕРА НА ВНУТРЕННЕЙ ОБОЛОЧКЕ.
 *
 * # Что это
 *
 * Здесь **контракт и проверки** эмиттера, а не сам эмиттер: реализация — `src/e2k/emitterShell.ts`.
 * Оракул написан **до** реализации, чтобы проверки не подгонялись под её поведение.
 *
 * # Что проверяется
 *
 * | # | проверка | как |
 * |---|---|---|
 * | 1.1 | карта размещения покрывает все инструкции `RegModule` без пропусков и пересечений | разбор `placement` |
 * | 1.2 | round-trip через кодировку: `encode(инструкция) → байты → decode(байты)` сохраняет поля | сравнение с `Encoder.decode` **и** побайтовое сравнение с `Encoder.encode` |
 * | 1.3 | инъективность: разным инструкциям — разные байты | шлюз `auditEncoder` |
 * | 1.4 | подмена одного бита не декодируется в ту же инструкцию | шлюз `auditEncoder` |
 * | 1.5 | эмиттер не переставляет инструкции через границу атома | множества индексов по регионам |
 *
 * # Чего оракул не проверяет
 *
 * Соответствия e2k — оболочка не e2k (`docs/e2k-backend.md`). Семантики исполнения: она
 * проверяется сквозным прогоном (`src/e2k/emitterRoundtrip.ts`). И корректности самих
 * носителей IR: они наши, а не документированные (см. `docs/e2k-emitter-shell.md`).
 */

import { OPCODES } from "./encoding";
import {
  auditEncoder,
  sameInstruction,
  type AsmInstruction,
  type Encoder,
  type EncodingStatus,
} from "./backend";
import type { RegAtomRegion, RegInstruction, RegModule } from "../runtime/vm/regcode";

/**
 * Префикс имён носителей IR.
 *
 * Носитель — это **наше** имя для передачи IR-инструкции через оболочку (`IR.add`, `IR.invoke`).
 * Оно не является мнемоникой e2k и не присутствует в извлечении руководства: правило проекта
 * «мнемоника либо скопирована посимвольно, либо её нет» соблюдается тем, что носители живут
 * в **отдельном** пространстве имён с этим префиксом, а не в таблице документированных операций.
 */
export const IR_CARRIER_PREFIX = "IR.";

/** Маркер формата артефакта эмиттера (наше имя формата, не стандарт). */
export const SHELL_IMAGE_FORMAT = "osnova-shell-image";

/** Версия формата артефакта (наша, как и у регистрового IR). */
export const SHELL_IMAGE_VERSION = 1;

/** Одна запись карты размещения: где в байтах лежит инструкция. */
export interface PlacementEntry {
  /** Индекс инструкции в **исходном** `module.code`. */
  readonly codeIndex: number;
  /** Позиция в раскладке эмиттера, `0..n-1`. */
  readonly position: number;
  /** Начало в байтах (включительно). */
  readonly start: number;
  /** Конец в байтах (исключительно). */
  readonly end: number;
  /** Имя носителя (мнемоника `AsmInstruction`). */
  readonly carrier: string;
  /** Атом участка, из которого пришла инструкция. */
  readonly atom: string;
  /** Индекс процедуры. */
  readonly procedure: number;
  /** Флаг участка (из `module.atoms`, не от вызывающего). */
  readonly optimizable: boolean;
}

/** Паспорт выхода: чем получен код и с каким статусом. */
export interface ImagePassport {
  /** Идентификатор бэкенда (`internal-shell`). */
  readonly backendId: string;
  /** Статус знания о кодировке (`ДОПУЩЕНИЕ` для оболочки). */
  readonly backendStatus: EncodingStatus;
  /** Размер инструкции в байтах. */
  readonly instructionSize: number | null;
  /** Оговорка, которую обязан нести выход. */
  readonly note: string;
}

/**
 * Артефакт эмиттера: то, что «едет».
 *
 * **Кода IR здесь нет намеренно:** `code` восстанавливается только из `bytes`
 * (`src/e2k/emitterRoundtrip.ts`), иначе круг «байты → IR» был бы подстановкой, а не проверкой.
 * Метаданные модуля (пул констант, процедуры, разметка атомов) едут отдельно и это сказано
 * прямо: байты несут инструкции, метаданные — заголовок.
 */
export interface ShellImage {
  readonly format: string;
  readonly version: number;
  readonly instructionSize: number;
  /** Поток инструкций: по 10 байт на инструкцию. */
  readonly bytes: Uint8Array;
  /** Карта размещения. */
  readonly placement: readonly PlacementEntry[];
  /** Таблица имён хост-вызовов: `imm` у `IR.invoke` — индекс сюда. */
  readonly invokeNames: readonly string[];
  /** Метаданные модуля, которые байтами не выражаются. */
  readonly frontMatter: {
    readonly ir: string;
    readonly version: number;
    readonly moduleName: string;
    readonly constants: readonly unknown[];
    readonly procedures: RegModule["procedures"];
    readonly atoms: readonly RegAtomRegion[];
  };
  /** Паспорт выхода. */
  readonly passport: ImagePassport;
}

/** Отчёт по одному участку атома. */
export interface RegionReport {
  readonly atom: string;
  readonly procedure: number;
  readonly optimizable: boolean;
  readonly first: number;
  readonly last: number;
  /** Порядок изменён перестановкой внутри участка. */
  readonly reordered: boolean;
  /** Сколько инструкций в участке. */
  readonly instructions: number;
}

/** Отчёт эмиттера: что он сделал и чего не делал. */
export interface EmitReport {
  readonly regions: readonly RegionReport[];
  readonly instructions: number;
  readonly bytes: number;
  readonly carriers: readonly string[];
  readonly backendId: string;
  readonly backendStatus: EncodingStatus;
  /** Что эмиттер **не** делает и почему — обязательная часть отчёта. */
  readonly limitations: readonly string[];
}

/** Результат эмиссии: артефакт плюс материал для проверок. */
export interface ShellEmitResult {
  /** Артефакт (без кода IR — см. {@link ShellImage}). */
  readonly image: ShellImage;
  /** Инструкции оболочки по одной на элемент `code` — материал оракула. */
  readonly instructions: readonly AsmInstruction[];
  /** Эталон раскладки: модуль после перестановки внутри участков (НЕ часть артефакта). */
  readonly scheduled: RegModule;
  /** Отчёт эмиттера. */
  readonly report: EmitReport;
}

/** Отказ эмиттера: причина называется, а не замалчивается. */
export class EmitterRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmitterRefusalError";
  }
}

/** Канонический ключ инструкции IR — для сравнения «та же инструкция или нет». */
export function instructionKey(instruction: RegInstruction): string {
  const source = instruction as unknown as Record<string, unknown>;
  const parts: string[] = [String(source.op)];
  for (const field of [
    "d",
    "a",
    "b",
    "cond",
    "off",
    "v",
    "k",
    "type",
    "name",
    "fi",
    "argc",
    "catchReg",
    "key",
  ]) {
    if (source[field] !== undefined) parts.push(`${field}=${String(source[field])}`);
  }
  if (Array.isArray(source.args)) parts.push(`args=[${(source.args as number[]).join(",")}]`);
  return parts.join(" ");
}

/** Совпадают ли две инструкции IR (сравниваются адреса переходов — здесь это важно). */
export function sameRegInstruction(a: RegInstruction, b: RegInstruction): boolean {
  return instructionKey(a) === instructionKey(b);
}

/** Ключи всего линейного кода по порядку. */
export function moduleKeys(module: RegModule): string[] {
  return module.code.map((element) => {
    if ("packet" in element && (element as { packet?: boolean }).packet === true) {
      return "packet:" + (element as { slots: RegInstruction[] }).slots.map(instructionKey).join("|");
    }
    return instructionKey(element as RegInstruction);
  });
}

/**
 * Ключ инструкции **без адреса перехода**.
 *
 * Нужен там, где адреса законно меняются вместе с порядком: перестановка внутри участка
 * пересчитывает `off`, и сравнение «набор инструкций не изменился» по полному ключу давало бы
 * ложное нарушение. Так же устроено сравнение в `src/vliw/reorderEquivalence.ts`.
 */
export function instructionShapeKey(instruction: RegInstruction): string {
  const source = instruction as unknown as Record<string, unknown>;
  const parts: string[] = [String(source.op)];
  for (const field of ["d", "a", "b", "cond", "v", "k", "type", "name", "fi", "argc", "catchReg", "key"]) {
    if (source[field] !== undefined) parts.push(`${field}=${String(source[field])}`);
  }
  if (Array.isArray(source.args)) parts.push(`args=[${(source.args as number[]).join(",")}]`);
  return parts.join(" ");
}

/** Ключи формы всего линейного кода (без адресов переходов). */
export function moduleShapeKeys(module: RegModule): string[] {
  return module.code.map((element) => {
    if ("packet" in element && (element as { packet?: boolean }).packet === true) {
      return "packet:" + (element as { slots: RegInstruction[] }).slots.map(instructionShapeKey).join("|");
    }
    return instructionShapeKey(element as RegInstruction);
  });
}

function problemRange(entry: PlacementEntry): string {
  return `инструкция ${entry.codeIndex}: байты ${entry.start}..${entry.end}`;
}

/**
 * Проверить результат эмиссии против исходного модуля.
 *
 * @returns список нарушений; пустой список — проверки пройдены
 */
export function checkEmitResult(
  result: ShellEmitResult,
  source: RegModule,
  encoder: Encoder,
): string[] {
  const problems: string[] = [];
  const { image, instructions, scheduled, report } = result;
  const size = image.instructionSize;
  const code = source.code;
  const regions = source.atoms;

  // ── 1.1. Карта размещения: покрытие без пропусков и пересечений ──────────────
  if (code.some((element) => "packet" in element && (element as { packet?: boolean }).packet === true)) {
    problems.push("исходный модуль содержит пакеты: эмиттер работает по линейному коду");
  }
  if (image.bytes.length !== code.length * size) {
    problems.push(
      `длина потока ${image.bytes.length} байт не равна ${code.length} × ${size} = ${code.length * size}`,
    );
  }
  if (instructions.length !== code.length) {
    problems.push(`инструкций оболочки ${instructions.length}, элементов кода ${code.length}`);
  }
  if (image.placement.length !== code.length) {
    problems.push(`записей размещения ${image.placement.length}, элементов кода ${code.length}`);
  }

  const byPosition = [...image.placement].sort((a, b) => a.position - b.position);
  byPosition.forEach((entry, index) => {
    if (entry.position !== index) {
      problems.push(`позиция ${index}: в карте стоит ${entry.position} — порядок с пропуском или сбоем`);
    }
    if (entry.start !== index * size || entry.end !== entry.start + size) {
      problems.push(
        `${problemRange(entry)}: ожидались байты ${index * size}..${index * size + size}`,
      );
    }
  });

  const seenIndexes = new Map<number, number>();
  for (const entry of image.placement) {
    seenIndexes.set(entry.codeIndex, (seenIndexes.get(entry.codeIndex) ?? 0) + 1);
  }
  for (let index = 0; index < code.length; index++) {
    const count = seenIndexes.get(index) ?? 0;
    if (count !== 1) problems.push(`инструкция ${index} встречается в карте ${count} раз`);
  }

  // ── 1.5. Границы атомов: внутри участка — перестановка, через границу — никогда ──
  if (regions === undefined || regions.length === 0) {
    problems.push("у исходного модуля нет разметки атомов: границы проверить не с чем");
  } else {
    for (const region of regions) {
      const inside = image.placement.filter(
        (entry) => entry.codeIndex >= region.start && entry.codeIndex < region.end,
      );
      const expected = region.end - region.start;
      if (inside.length !== expected) {
        problems.push(
          `атом ${region.atom} (${region.start}..${region.end}): в карте ${inside.length} инструкций из ${expected}`,
        );
      }
      const indexes = inside.map((entry) => entry.codeIndex).sort((a, b) => a - b);
      for (let i = 0; i < indexes.length; i++) {
        if (indexes[i] !== region.start + i) {
          problems.push(
            `атом ${region.atom}: набор инструкций изменился — ожидался ${region.start + i}, получен ${indexes[i]}`,
          );
          break;
        }
      }
      for (const entry of inside) {
        if (entry.atom !== region.atom) {
          problems.push(
            `инструкция ${entry.codeIndex} из атома ${region.atom} помечена атомом ${entry.atom}`,
          );
        }
        if (entry.optimizable !== region.optimizable) {
          problems.push(
            `инструкция ${entry.codeIndex}: optimizable=${String(entry.optimizable)}, у атома ${region.atom} — ${String(region.optimizable)}`,
          );
        }
        if (entry.procedure !== region.procedure) {
          problems.push(
            `инструкция ${entry.codeIndex}: процедура ${entry.procedure}, у атома ${region.atom} — ${region.procedure}`,
          );
        }
      }
    }
  }

  // ── 1.2. Round-trip: байты ↔ инструкция ──────────────────────────────────────
  for (const entry of byPosition) {
    const asm = instructions[entry.position];
    if (asm === undefined) {
      problems.push(`позиция ${entry.position}: нет инструкции оболочки`);
      continue;
    }
    if (asm.mnemonic !== entry.carrier) {
      problems.push(`позиция ${entry.position}: мнемоника «${asm.mnemonic}», в карте «${entry.carrier}»`);
    }
    let expectedBytes: Uint8Array;
    try {
      expectedBytes = encoder.encode(asm);
    } catch (error) {
      problems.push(
        `позиция ${entry.position} («${asm.mnemonic}»): кодирование не состоялось — ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const actual = image.bytes.slice(entry.start, entry.end);
    if (expectedBytes.length !== actual.length || expectedBytes.some((b, i) => b !== actual[i])) {
      problems.push(`позиция ${entry.position}: байты потока не совпадают с кодированием инструкции`);
      continue;
    }
    try {
      const back = encoder.decode(actual);
      if (!sameInstruction(back, asm)) {
        problems.push(
          `позиция ${entry.position}: после decode получено «${back.mnemonic}» с ${back.operands.length} операндами вместо «${asm.mnemonic}»`,
        );
      }
    } catch (error) {
      problems.push(
        `позиция ${entry.position}: decode отверг байты — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ── 1.3 и 1.4. Инъективность и чувствительность к подмене бита ────────────────
  const audit = auditEncoder(encoder, instructions);
  if (audit.outcome !== "готов") {
    problems.push(`шлюз кодировки: исход «${audit.outcome}» — ${audit.notes.join("; ")}`);
  } else {
    for (const check of audit.checks) {
      if (!check.ok) problems.push(`шлюз кодировки, проверка «${check.name}»: ${check.note}`);
    }
  }

  // ── Оракул не должен оказаться декоративным: артефакт обязан быть без кода IR ──
  const allowed = new Set([
    "format",
    "version",
    "instructionSize",
    "bytes",
    "placement",
    "invokeNames",
    "frontMatter",
    "passport",
  ]);
  for (const key of Object.keys(image)) {
    if (!allowed.has(key)) {
      problems.push(`артефакт несёт лишнее поле «${key}»: код IR не должен ехать вместе с байтами`);
    }
  }
  if (image.format !== SHELL_IMAGE_FORMAT) {
    problems.push(`формат артефакта «${image.format}», ожидался «${SHELL_IMAGE_FORMAT}»`);
  }
  if (image.version !== SHELL_IMAGE_VERSION) {
    problems.push(`версия артефакта ${image.version}, ожидалась ${SHELL_IMAGE_VERSION}`);
  }

  // ── Паспорт выхода ───────────────────────────────────────────────────────────
  if (image.passport.backendId !== encoder.description.id) {
    problems.push(
      `паспорт: бэкенд «${image.passport.backendId}», у кодировщика «${encoder.description.id}»`,
    );
  }
  if (image.passport.backendStatus !== encoder.description.status) {
    problems.push(
      `паспорт: статус «${image.passport.backendStatus}», у кодировщика «${encoder.description.status}»`,
    );
  }
  if (image.passport.instructionSize !== image.instructionSize) {
    problems.push(
      `паспорт: размер ${String(image.passport.instructionSize)}, у артефакта ${image.instructionSize}`,
    );
  }
  if (image.passport.note.trim() === "") {
    problems.push("паспорт: оговорка пуста — выход обязан нести, что это код на оболочке, а не e2k");
  }

  // ── Носители: наши имена, не мнемоники e2k ──────────────────────────────────
  const documented = new Set(OPCODES.map((entry) => entry.mnemonic));
  for (const carrier of report.carriers) {
    if (!carrier.startsWith(IR_CARRIER_PREFIX)) {
      problems.push(
        `носитель «${carrier}» без префикса «${IR_CARRIER_PREFIX}»: имя носителя обязано быть помечено как наше`,
      );
    }
    if (documented.has(carrier)) {
      problems.push(`носитель «${carrier}» совпадает с документированной мнемоникой`);
    }
  }

  // ── Эталон раскладки: план и порядок ────────────────────────────────────────
  if (scheduled.code.length !== code.length) {
    problems.push(`эталон раскладки: элементов ${scheduled.code.length}, ожидалось ${code.length}`);
  }
  const before = moduleShapeKeys(source).slice().sort();
  const after = moduleShapeKeys(scheduled).slice().sort();
  if (before.length !== after.length || before.some((key, i) => key !== after[i])) {
    problems.push(
      "эталон раскладки: набор инструкций изменился (адреса переходов в сравнении не участвуют)",
    );
  }

  return problems;
}

/** То же, но с исключением: эмиттер обязан проверять себя до возврата артефакта. */
export function assertEmitResult(result: ShellEmitResult, source: RegModule, encoder: Encoder): void {
  const problems = checkEmitResult(result, source, encoder);
  if (problems.length > 0) {
    throw new EmitterRefusalError(
      `самопроверка эмиттера нашла ${problems.length} нарушений:\n- ${problems.join("\n- ")}`,
    );
  }
}

/** Человекочитаемая форма списка нарушений. */
export function formatEmitProblems(problems: readonly string[]): string {
  return problems.length === 0 ? "нарушений нет" : problems.map((p) => `- ${p}`).join("\n");
}
