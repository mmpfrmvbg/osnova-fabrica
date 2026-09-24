/**
 * Оракул команд CLI компилятора: `parity`, `schedule`, `reorder`.
 *
 * Зачем отдельно от тестов бэкендов: сами преобразования проверяются своими
 * оракулами (`src/oracle/parity.test.ts`, `src/vliw/*`), а здесь проверяется, что
 * команда **работает из командной строки** — тот путь, которым пользуется человек
 * и учебник. Команды перенесены сюда из `src/cli.ts`, где они жили рядом с
 * командами пайплайна; проверка ловит разъезд «функция есть, команды нет».
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

const ROOT = path.resolve(__dirname, "..", "..");

function cli(args: string): { code: number; out: string; err: string } {
  const r = spawnSync(`npx tsx src/cli/index.ts ${args}`, {
    shell: true,
    cwd: ROOT,
    encoding: "utf-8",
  });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

describe("CLI компилятора: parity, schedule, reorder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-cli-"));
  const sourceFile = path.join(dir, "ядро.osnova");
  const bytecodeFile = path.join(dir, "ядро.osvbc.json");

  fs.writeFileSync(
    sourceFile,
    [
      "модуль ядро",
      "",
      "процедура главная(): Число",
      "  пусть а = 3",
      "  пусть б = 4",
      "  пусть с = а * а + б * б",
      "  вернуть с",
      "конец_процедуры",
      "",
      "конец_модуля",
      "",
    ].join("\n"),
    "utf-8",
  );

  it("`compile` пишет байткод", () => {
    const r = cli(`compile ${JSON.stringify(sourceFile)} -o ${JSON.stringify(bytecodeFile)}`);
    expect(r.code, r.err).toBe(0);
    expect(fs.existsSync(bytecodeFile)).toBe(true);
  });

  it("`parity` сверяет стековую и регистровую VM", () => {
    const r = cli(`parity ${JSON.stringify(sourceFile)}`);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("[OK]");
    expect(r.out).toContain("совпало");
  });

  it("`schedule` печатает модуль версии 2 — с пакетами", () => {
    const r = cli(`schedule ${JSON.stringify(bytecodeFile)}`);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('"version": 2');
  });

  it("`reorder` сообщает эквивалентность и счётчики", () => {
    const r = cli(`reorder ${JSON.stringify(sourceFile)}`);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/эквивалент|совпал|такты/i);
  });

  it("неизвестная команда печатает подсказку и выходит с кодом 1", () => {
    const r = cli("ерунда");
    expect(r.code).toBe(1);
    expect(r.err).toContain("osnova parity");
  });
});
