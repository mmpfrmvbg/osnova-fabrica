/**
 * ЭМИТТЕР НА ВНУТРЕННЕЙ ОБОЛОЧКЕ — ФАЙЛ ЗАГОТОВКИ (до реализации).
 *
 * Реализация пишется **после** оракула (`src/e2k/emitterOracle.ts`): пока её нет, эмиттер
 * обязан **отказать**, а не выдать пустой или правдоподобный артефакт. Это тот же принцип,
 * что у заглушки e2k (`src/e2k/e2k.ts`): отсутствие кодировки — отказ, а не подстановка.
 *
 * Имя файла содержит `Shell` намеренно: это эмиттер **на оболочке**, не эмиттер e2k.
 */

import type { Encoder } from "./backend";
import { EmitterRefusalError, type ShellEmitResult } from "./emitterOracle";
import type { RegModule } from "../runtime/vm/regcode";

/**
 * Инъекция дефектов — ТОЛЬКО для негативного контроля.
 *
 * Тот же приём, что `PackDefects`/`PipelineDefects` в VLIW-конвейере: дефект описывается
 * данными и включается в тесте, а не правится в исходнике руками. Каждый дефект обязан
 * **краснить** конкретную проверку оракула; если он не краснит — оракул декоративен.
 */
export interface EmitterDefects {
  /** 4.1 — не ограничивать перестановку границами атома (переставлять через границу). */
  ignoreAtomBoundaries?: boolean;
  /** 4.2 — брать `optimizable` из разметки вызывающего, а не из `module.atoms`. */
  trustCallerFlags?: boolean;
  /** 4.2 — разметка вызывающего (подменяемая). */
  callerAtoms?: RegModule["atoms"];
  /** 4.3 — не отвергать инструкции без носителя, а подставлять носитель. */
  allowUnsupported?: boolean;
}

/** Опции эмиссии. */
export interface EmitOptions {
  /** Дефекты — только для негативного контроля. */
  defects?: EmitterDefects;
}

/**
 * Эмитировать код на оболочке.
 *
 * @throws EmitterRefusalError пока реализация не написана
 */
export function emitShell(
  _module: RegModule,
  _encoder: Encoder,
  _options: EmitOptions = {},
): ShellEmitResult {
  throw new EmitterRefusalError(
    "эмиттер на оболочке: реализация не написана — заглушка отказывает, а не выдаёт артефакт",
  );
}
