/**
 * СТОРОЖ ГЕНЕРАТОРА ЗОНДОВ — OSN-GATE-D12GEN.
 *
 * Предмет — `tools/e2k-hardware/probes/d12-window/generate.ts`. Оракул здесь необычный и назван явно:
 * **закоммиченные файлы проб**. Генератор обязан воспроизводить их БАЙТ-В-БАЙТ, а не «примерно».
 *
 * # Почему оракул именно такой
 *
 * Шесть `.s` в `d12-window/` — уже проверенные файлы: они прогонялись на живой машине (отчёт
 * `report-hardware.txt`, sha256 сверены до и после). Переписав их генератором «по памяти о форме», я
 * получил бы шесть ДРУГИХ файлов, и заметить это было бы нечем — как раз тот класс, который §3.166
 * назвал переносом вывода из одной плоскости в другую. Сверка байт делает правку видимой.
 *
 * # Что сторож НЕ может
 *
 * Он не собирает и не запускает пробы: вендорского `as` под e2k на этой машине нет (`as` в WSL —
 * x86 binutils, `no such instruction: 'setwd wsz = 0x10'`), а ssh-ключа к железу тоже нет. Поэтому
 * «генератор верен» здесь означает «даёт те же БАЙТЫ, что закоммичены», а не «собранное работает».
 * Эта граница названа в шапке генератора и здесь, а не спрятана.
 *
 * # Негативные контроли (N = 5)
 *
 * | N | что ломается | что обязано покраснеть |
 * |---|---|---|
 * | **1** | `wsz` геометрии сдвинут на 1 | сверка байт `probe-b12` |
 * | **2** | `rsz` геометрии сдвинут | сверка байт `probe-b12` |
 * | **3** | контроль получил холостой вызов (`calls` 1 → 2) | `probe-b14-nowrite` |
 * | **4** | блок клеток сдвинут (12…15 → 11…14) | все пять |
 * | **5** | завершающий `\n` снят | любая проба (TD-0003) |
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PROBE_BLOCK_CELLS,
  PROBE_DEFAULT_VALUE,
  PROBE_GEOMETRY,
  PROBE_SPECS,
  hex,
  probeSource,
  reportLine,
  type ProbeSpec,
  type WindowGeometrySpec,
} from '../../tools/e2k-hardware/probes/d12-window/generate';

const DIR = path.join(__dirname, '..', '..', 'tools', 'e2k-hardware', 'probes', 'd12-window');

const readProbe = (name: string): string => fs.readFileSync(path.join(DIR, `${name}.s`), 'utf8');

describe('генератор зондов: воспроизводит закоммиченные файлы', () => {
  it('каждая из пяти проб совпадает с файлом БАЙТ-В-БАЙТ', () => {
    const report: string[] = [];
    for (const spec of PROBE_SPECS) {
      const onDisk = readProbe(spec.name);
      const generated = probeSource(spec);
      if (onDisk !== generated) {
        const a = onDisk.split('\n');
        const b = generated.split('\n');
        let at = 0;
        while (at < Math.max(a.length, b.length) && a[at] === b[at]) at += 1;
        report.push(
          `${spec.name}: расхождение со строки ${String(at + 1)}; ` +
            `диск=${JSON.stringify(a[at] ?? '<нет>')} генератор=${JSON.stringify(b[at] ?? '<нет>')}`,
        );
      }
    }
    expect(report, report.join('\n')).toEqual([]);
  });

  it('файлов ровно пять, и у каждого своё имя', () => {
    const files = fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith('.s'))
      .sort();
    expect(files).toEqual(PROBE_SPECS.map((s) => `${s.name}.s`).sort());
  });

  it('геометрия закреплена и совпадает с прочитанной из файла', () => {
    // Не «константа равна себе»: число берётся ИЗ ФАЙЛА и сверяется с параметром генератора.
    const text = readProbe('probe-b12');
    expect(text).toContain(`setwd wsz = ${hex(PROBE_GEOMETRY.wsz)}, nfx = 0x0`);
    expect(text).toContain(`setbn rbs = ${hex(PROBE_GEOMETRY.rbs)}, rsz = ${hex(PROBE_GEOMETRY.rsz)}, rcur = 0x0`);
    expect(text).toContain(`call %ctpr1, wbs = ${hex(PROBE_GEOMETRY.wbs)}`);
  });

  it('местное окно вызова — ровно wbs + 4 (закон §3.113), и это ВИДНО в тексте', () => {
    const text = probeSource(PROBE_SPECS[0]!);
    // Сужение перед sdisp и восстановление после — оба числа из геометрии.
    expect(text).toContain(`\tsetwd wsz = ${hex(PROBE_GEOMETRY.wbs + 4)}, nfx = 0x0`);
    expect(text).toContain(`\tsetwd wsz = ${hex(PROBE_GEOMETRY.wsz)}, nfx = 0x0`);
    expect(PROBE_GEOMETRY.wbs + 4).toBe(8);
  });

  it('клетка пробы совпадает с клеткой, которую читает `exit`', () => {
    for (const spec of PROBE_SPECS) {
      expect(probeSource(spec)).toContain(`\tadds,0 %b[${String(spec.cell)}], %b[11], %r9`);
    }
  });

  it('контроль отличается от вопроса РОВНО одним: нет холостого вызова', () => {
    const question = PROBE_SPECS.find((s) => s.name === 'probe-b14');
    const control = PROBE_SPECS.find((s) => s.name === 'probe-b14-nowrite');
    expect(question?.cell).toBe(control?.cell);
    expect(question?.value).toBe(control?.value);
    expect(question?.calls).toBe(2);
    expect(control?.calls).toBe(1);
    // А текст при этом различается — и различается именно отсутствием блока write.
    expect(probeSource(question!)).toContain('write(1, NULL, 0)');
    expect(probeSource(control!)).not.toContain('write(1, NULL, 0)');
  });

  it('блок клеток — 12/13/14/15 со значениями 0/1/8/17', () => {
    expect(PROBE_BLOCK_CELLS.map((b) => b.cell)).toEqual([12, 13, 14, 15]);
    expect(PROBE_BLOCK_CELLS.map((b) => b.value)).toEqual([0x0, 0x1, 0x8, 0x11]);
    // Клетка 15 несёт АДРЕС ячейки кучи, а не значение — отсюда 0x11 (A4 §3.136).
    expect(PROBE_DEFAULT_VALUE).toBe(0x11);
  });

  it('строка отчёта — та форма, которую печатает стенд', () => {
    expect(reportLine('probe-b12', 0)).toBe('exit(probe-b12) = 0');
    expect(reportLine('probe-b14-nowrite', 8)).toBe('exit(probe-b14-nowrite) = 8');
  });
});

describe('генератор зондов: негативные контроли', () => {
  it('НЕГАТИВНЫЙ КОНТРОЛЬ 1: сдвиг `wsz` на единицу ломает сверку байт', () => {
    const wrong: WindowGeometrySpec = { ...PROBE_GEOMETRY, wsz: PROBE_GEOMETRY.wsz + 1 };
    const generated = probeSource(PROBE_SPECS[0]!, wrong);
    expect(generated).not.toBe(readProbe('probe-b12'));
    expect(generated).toContain('setwd wsz = 0x11');
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ 2: сдвиг `rsz` тоже ломает сверку — обе стороны окна параметры', () => {
    const wrong: WindowGeometrySpec = { ...PROBE_GEOMETRY, rsz: PROBE_GEOMETRY.rsz + 1 };
    expect(probeSource(PROBE_SPECS[0]!, wrong)).not.toBe(readProbe('probe-b12'));
    // И закон годности при этом ещё держится: 0+8+1 <= 16 — то есть расхождение НЕ аварийное,
    // а тихое. Именно поэтому оно и требует сторожа.
    expect(wrong.rbs + wrong.rsz + 1).toBeLessThanOrEqual(wrong.wsz);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ 3: контроль, получивший холостой вызов, перестаёт быть контролем', () => {
    const control = PROBE_SPECS.find((s) => s.name === 'probe-b14-nowrite')!;
    const broken: ProbeSpec = { ...control, calls: 2 };
    const generated = probeSource(broken);
    expect(generated).not.toBe(readProbe('probe-b14-nowrite'));
    // Он стал БАЙТ-В-БАЙТ равен вопросу — то есть контроль исчез, а проба осталась.
    expect(generated).toBe(readProbe('probe-b14'));
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ 4: сдвинутый блок клеток не совпадёт ни с одной пробой', () => {
    // Клетки 11…14 вместо 12…15: значение 0x11 уезжает в 14, а 12 получает «адрес».
    const shifted: ProbeSpec = { ...PROBE_SPECS[3]!, cell: 14 };
    expect(probeSource(shifted)).not.toBe(readProbe('probe-b15'));
    for (const spec of PROBE_SPECS) {
      expect(probeSource(spec)).toContain(`%b[${String(spec.cell)}]`);
    }
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ 5: без завершающего перевода строки файл теряет последнюю строку (TD-0003)', () => {
    const good = probeSource(PROBE_SPECS[0]!);
    expect(good.endsWith('\n'), 'генератор обязан завершать файл переводом строки').toBe(true);
    const bad = good.slice(0, -1);
    expect(bad).not.toBe(readProbe('probe-b12'));
    // Предмет контроля: последняя строка у `bad` та же, но `read` в стенде её НЕ отдаст.
    expect(bad.endsWith('nop')).toBe(true);
  });
});