#!/usr/bin/env ts-node
// ============================================================
// src/scripts/osnova-mini-os-e2e.ts — E2E прогон мини-ОС
// Шаги: list, run todo, run notepad, run file-viewer
// ============================================================

import { spawnSync } from 'child_process';
import * as path from 'path';

const CLI = path.resolve(__dirname, '../cli.ts');

type PassFn = (code: number, stdout: string, stderr: string, signal?: NodeJS.Signals | null) => boolean;

function runStep(
  step: string,
  name: string,
  args: string[],
  passFn: PassFn,
  opts?: { timeout?: number }
): boolean {
  const timeout = opts?.timeout ?? 10000;
  const result = spawnSync('npx', ['tsx', CLI, ...args], {
    stdio: 'pipe',
    encoding: 'utf-8',
    cwd: process.cwd(),
    shell: true,
    timeout,
  });
  const stdout = (result.stdout ?? '').toString();
  const stderr = (result.stderr ?? '').toString();
  const code = result.status ?? -1;
  const passed = passFn(code, stdout, stderr, result.signal);
  const mark = passed ? '✓ PASS' : '✗ FAIL';
  console.log(`  [${step}] ${name.padEnd(25)} ${mark}`);
  if (!passed && (stderr || stdout)) {
    const excerpt = (stderr || stdout).trim().slice(0, 200);
    console.log(`    └ ${excerpt}${excerpt.length >= 200 ? '...' : ''}`);
  }
  return passed;
}

function main(): number {
  console.log('\n─── мини-ОС e2e ───\n');

  const results: boolean[] = [];

  results.push(
    runStep('1/4', 'osnova list', ['list'], (code, stdout) => code === 0 && stdout.includes('Всего:'))
  );

  const runPassFn: PassFn = (code, _stdout, stderr, signal) => {
    const timedOut = signal === 'SIGTERM';
    const hasError = (stderr ?? '').match(/Error|fatal|Exception/i);
    return code === 0 || (timedOut && !hasError);
  };

  results.push(
    runStep('2/4', 'todo.osapp.yaml', ['run', '--manifest', 'src/runtime/fixtures/todo.osapp.yaml', '--in-process', '--ui', 'cli'], runPassFn, { timeout: 3000 })
  );

  results.push(
    runStep('3/4', 'notepad.osapp.yaml', ['run', '--manifest', 'src/runtime/fixtures/notepad.osapp.yaml', '--in-process', '--ui', 'cli'], runPassFn, { timeout: 3000 })
  );

  results.push(
    runStep('4/4', 'file-viewer.osapp.yaml', ['run', '--manifest', 'src/runtime/fixtures/file-viewer.osapp.yaml', '--in-process', '--ui', 'cli'], runPassFn, { timeout: 3000 })
  );

  const passed = results.filter(Boolean).length;
  const total = results.length;
  console.log(`\nИтог: ${passed}/${total} passed ${passed === total ? '✓' : '✗'}\n`);

  return passed === total ? 0 : 1;
}

process.exit(main());
