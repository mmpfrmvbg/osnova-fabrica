import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import * as os from "os";
import * as fs from "fs";
import { compileSource } from "./compiler";
import { VM } from "../runtime/vm/interpreter";

type GoldenTest = {
  id: string;
  description?: string;
  source: string;
  files?: Array<{ path: string; source: string }>;
  expectCompiler: {
    success: boolean;
  };
  expectVM?: {
    returnValue: unknown;
  };
};

type GoldenSuite = {
  version: string;
  tests: GoldenTest[];
};

const suite = JSON.parse(
  readFileSync(join(__dirname, "../../docs/golden-tests.json"), "utf-8"),
) as GoldenSuite;

describe("golden-tests.json — компиляция MVP-кейсов", () => {
  for (const test of suite.tests) {
    it(`[${test.id}] ${test.description ?? "без описания"}`, async () => {
      const tmpDir = fs.mkdtempSync(join(os.tmpdir(), `osnova-golden-${test.id}-`));
      try {
        if (test.files) {
          for (const f of test.files) {
            const outPath = join(tmpDir, f.path);
            fs.mkdirSync(join(outPath, ".."), { recursive: true });
            fs.writeFileSync(outPath, f.source, "utf-8");
          }
        }

        const result = compileSource(test.source, { baseDir: tmpDir });

        if (test.expectCompiler.success) {
          expect(result.lexerErrors).toHaveLength(0);
          expect(result.parserErrors).toHaveLength(0);
          expect(result.module).not.toBeNull();
          expect(result.compilerSuccess).toBe(true);
        } else {
          expect(result.compilerSuccess).toBe(false);
          if (!result.compilerErrors?.length) throw new Error(`Expected compilerErrors for ${test.id}`);
        }

        if (test.expectVM && test.expectCompiler.success && result.module) {
          const vm = new VM(result.module, { maxSteps: 200_000 });
          // Главная процедура — основной entry для golden-тестов
          const idx = vm.findProcedureIndex("главная");
          const r = await vm.runProcedure(idx, []);
          expect(r).toBe(test.expectVM.returnValue);
        }
      } finally {
        // Удаление tmpDir не критично, тесты быстрые — оставляем для дебага при ошибках.
      }
    });
  }
});

