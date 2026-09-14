/**
 * Оракул статусов паритета: «обе VM упали» — это НЕ паритет.
 *
 * Повод: до этого среза `runParity` возвращал `ok: true`, когда падали обе VM.
 * Три фикстуры из восьми (`game_rounds`, `micro_crm`, `todo` — оконные
 * приложения с бесконечным `цикл`) «проходили» паритет, ни разу не выполнившись.
 * Этот тест фиксирует инвариант: успех возможен только со статусом `ok`.
 *
 * Второй инвариант — регрессия на `null` vs `undefined`: до нормализации в
 * `reginterpreter.ts` фикстуры `storage_demo` и `блокнот` расходились по трассе
 * («return null» против «return undefined»). Теперь обе обязаны проходить.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { runParity } from "./parity";

const FIXTURES = path.join(__dirname, "..", "runtime", "fixtures");
const REG_FIXTURES = path.join(FIXTURES, "reg-parity");

/** Лимит шагов: конечные фикстуры укладываются, приложения с `цикл` — нет. */
const MAX_STEPS = 50_000;

async function statusOf(file: string): Promise<{ status: string; ok: boolean; message: string }> {
  const dir = file.includes("/") ? REG_FIXTURES : FIXTURES;
  const source = fs.readFileSync(path.join(dir, path.basename(file)), "utf-8");
  const result = await runParity(source, { maxSteps: MAX_STEPS });
  if ("skipped" in result) throw new Error(`${file}: вне среза — ${result.reason}`);
  return { status: result.status, ok: result.ok, message: result.message };
}

describe("oracle/parity: статус — часть оракула, а не украшение", () => {
  /**
   * Приложения с бесконечным `цикл`: обе VM не завершаются. Честный вердикт —
   * «несравнимо» (`both_hit_step_limit`), а не «совпало». Раньше здесь было
   * `ok: true` — то есть отсутствие проверки выдавалось за её успех.
   */
  const unbounded = ["game_rounds.osnova", "micro_crm.osnova", "todo.osnova"];

  for (const file of unbounded) {
    it(`${file}: обе VM упёрлись в лимит — это не OK`, async () => {
      const r = await statusOf(file);
      expect(r.status).toBe("both_hit_step_limit");
      expect(r.ok).toBe(false);
    });
  }

  /**
   * Регрессия `null`/`undefined` на внешнем возврате: `reginterpreter.ts`
   * нормализует `undefined → null` так же, как для вложенного вызова.
   */
  const outerReturn = ["storage_demo.osnova", "блокнот.osnova"];

  for (const file of outerReturn) {
    it(`${file}: внешний возврат совпадает (null, а не undefined)`, async () => {
      const r = await statusOf(file);
      expect(r.message).not.toContain("return undefined");
      expect(r.status).toBe("ok");
      expect(r.ok).toBe(true);
    });
  }

  it("ни одна готовая фикстура не «проходит» на взаимном падении", async () => {
    const files = [
      ...fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".osnova")),
      ...fs.readdirSync(REG_FIXTURES).filter((f) => f.endsWith(".osnova")).map((f) => `reg-parity/${f}`),
    ].sort();
    expect(files.length).toBeGreaterThan(0);

    const falseOk: string[] = [];
    for (const file of files) {
      const r = await statusOf(file);
      if (r.ok && r.status !== "ok") falseOk.push(`${file}: status=${r.status}, ok=true`);
    }
    expect(falseOk, `ложное «ok» при падении обеих VM:\n${falseOk.join("\n")}`).toEqual([]);
  });
});
