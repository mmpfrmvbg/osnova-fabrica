import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { compileSource } from "./compiler";

type GoldenTest = {
  id: string;
  description?: string;
  source: string;
  expectCompiler: {
    success: boolean;
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
    it(`[${test.id}] ${test.description ?? "без описания"}`, () => {
      const result = compileSource(test.source);

      if (test.expectCompiler.success) {
        expect(result.lexerErrors).toHaveLength(0);
        expect(result.parserErrors).toHaveLength(0);
        expect(result.module).not.toBeNull();
        expect(result.compilerSuccess).toBe(true);
      } else {
        expect(result.compilerSuccess).toBe(false);
      }
    });
  }
});

