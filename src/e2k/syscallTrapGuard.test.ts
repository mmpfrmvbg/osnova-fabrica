/**
 * СТОРОЖ КЛАССА: ни один сайт системного вызова в рантайме `src/e2k/**` не смеет эмитить `sdisp`
 * с номером ловушки мимо {@link SYSCALL_TRAP}.
 *
 * Повод — замер, а не вкус. 2026-10-09 на живой машине: с номером `0` команда опознаётся как
 * недопустимая (`SIGILL`, `ILL_ILLOPC`), и до вызова дело не доходит — так умирали ВСЕ 38 образов
 * кита (§3.116.3). У вендора тот же номер: в `/lib64/libc.so.6` **517** раз `sdisp %ctpr1, 0x3` и
 * лишь 4 раза `0x6`; в `/bin/true`, `/usr/bin/ld`, `/usr/bin/as`, `/bin/bash`, `/bin/ls` системных
 * вызовов нет вовсе — они в libc (§3.117.1).
 *
 * Почему ТЕКСТОМ, а не по собранному образу: сайтов тринадцать в десяти модулях (печать, память,
 * коллекции, строки, блок отказа, минимальный ELF, образ), и правка «в одном месте» эту тринадцатку
 * уже разъезжала — номер живёт в КАЖДОМ сайте отдельным литералом. Сторож ловит именно класс, а
 * негативный контроль ниже доказывает, что он не мёртв: правило «сторож, собравший ноль проверок,
 * зеленеет так же, как работающий» (случай 22, `docs/verification-debt.md`).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { SYSCALL_TRAP, SYSCALL_WBS, SYSCALL_NUMBER_REGISTER } from './elfMinimal';

const E2K = import.meta.dirname;

/** Номера строк, где `sdisp` эмитится без константы ловушки. Пустой список — класс закрыт. */
function offendingSites(source: string): number[] {
  return source
    .split('\n')
    .map((line, at) => ({ line, at: at + 1 }))
    // Только ЭМИССИЯ: строка обязана нести операнд. Иначе сторож ловит `case 'sdisp':` в разборе
    // готовой команды (`printCall.ts`) — это не сайт вызова, а ветка чтения.
    .filter(({ line }) => line.includes("'sdisp'") && line.includes('imm('))
    .filter(({ line }) => !line.includes('imm(SYSCALL_TRAP)'))
    .map(({ at }) => at);
}

describe('сайт вызова: номер ловушки и место номера — только через константы', () => {
  const files = readdirSync(E2K).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));

  it('ни один сайт не эмитит sdisp мимо SYSCALL_TRAP', () => {
    const sites: { file: string; at: number }[] = [];
    for (const file of files) {
      for (const at of offendingSites(readFileSync(join(E2K, file), 'utf8'))) sites.push({ file, at });
    }
    expect(sites, 'сайты с номером мимо константы').toEqual([]);
  });

  it('сами сайты есть — сторож собран не на пустом месте', () => {
    const sites = files.flatMap((file) =>
      readFileSync(join(E2K, file), 'utf8')
        .split('\n')
        .filter((line) => line.includes("'sdisp'") && line.includes('imm(')),
    );
    // 13 сайтов на 2026-10-09. Порог, а не равенство: новый сайт — не повод краснеть, пропажа — повод.
    expect(sites.length, 'сайтов sdisp в рантайме').toBeGreaterThanOrEqual(13);
  });

  it('место номера вызова следует из wbs, а не из литерала', () => {
    // Кадр: номер обязан лежать в оконном `r0` вызываемого, то есть в `%r(2·wbs)` (§3.117.1).
    // Литерал здесь означал бы, что переезд кадра придётся искать по дереву руками.
    //
    // `wbs = 4` — не оптимум, а зависимость (§3.117): поднять его до 8 на модели нельзя, потому что
    // вендорский закон `wbs = rbs + rcur` потребовал бы сдвига базы вращения, на которой стоит
    // раскладка. Проба это назвала: железо даёт 42, а модель теряет 91.
    expect(SYSCALL_WBS, 'ширина окна вызова').toBe(4);
    expect(SYSCALL_NUMBER_REGISTER, 'номер вызова — оконный r0 вызываемого').toBe(2 * SYSCALL_WBS);
    expect(SYSCALL_NUMBER_REGISTER).toBe(8);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: сторож ловит именно старую редакцию', () => {
    // Ровно та строка, которой жил весь рантайм до 2026-10-09.
    expect(offendingSites("  a('sdisp', [imm(1), imm(0)]),")).toEqual([1]);
    expect(offendingSites("  { mnemonic: 'sdisp', channel: 0, operands: [imm(2), imm(0)] },")).toEqual([1]);
    // А эта — нынешняя форма, и она чиста.
    expect(offendingSites("  a('sdisp', [imm(1), imm(SYSCALL_TRAP)]),")).toEqual([]);
    expect(SYSCALL_TRAP, 'номер ловушки измерен как 3').toBe(3);
  });
});
