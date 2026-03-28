/**
 * Точка входа «VM компилятора»: байткод-машина для скомпилированных модулей Основы.
 * Оператор исходника `%` компилируется в инструкцию `rem` (см. codegen); выполнение —
 * в `src/runtime/vm/interpreter.ts` (case "rem", семантика как у JavaScript `%`).
 * Здесь — стабильный re-export для тестов и инструментов в зоне compiler.
 *
 * MOD / `%` — где смотреть и краевые случаи (аудит ATM):
 * - Регрессионные тесты: `src/compiler/vm.test.ts` (оператор `%`, байткод `rem`, Issues #2/#4 — порядок операндов и ноль).
 * - Реализация не в этом файле: `interpreter.ts`, ветка `rem` (стек: сначала делимое `a`, затем делитель `b`).
 * - Деление на ноль: при `b === 0` выбрасывается `InterpreterError` («Remainder by zero», op `rem`) — единственный
 *   путь «жёсткой» ошибки для `%` на уровне байткода; иначе результат — число по правилам JS `%`.
 * - Отрицательные операнды: как в ECMAScript (остаток по знаку делимого); крашей нет.
 * - Несогласованность: `система.математика.остаток` в том же `interpreter.ts` делает `a % b` без проверки `b === 0`
 *   и даёт `NaN`, тогда как оператор `%` → `rem` при нулевом делителе — исключение (не краш процесса, но отличие
 *   поведения от байткодного пути).
 */
export { VM, InterpreterError, runProgram, loadModule } from "../runtime/vm/interpreter";
export type { StackValue, InvokeHandler, InterpreterOptions, RunProgramOptions } from "../runtime/vm/interpreter";
export type { OsVbcModule } from "../runtime/vm/bytecode";
