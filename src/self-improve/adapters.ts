// ============================================================
// src/self-improve/adapters.ts — Реальные порты self-improve
//
// Генерация правок — через LLM (Ollama/DeepSeek/Qwen по env): модель
// возвращает изменённые файлы целиком (full-file), не diff.
// Применение/откат — прямая перезапись файлов с бэкапом (git не нужен).
// Гейт — список shell-команд (vitest по ядру + golden), все exit 0.
// ============================================================

import * as fsp from 'fs/promises';
import * as path from 'path';
import { getLLMProvider } from '../llm/index';
import { execAsync } from '../patch-agent/exec';
import type { PatchGenPort, PatchPort, GatePort, PatchGenRequest, FileEdits } from './core';

/** Генератор правок через LLM: full-file (целые файлы), не diff. */
export function createLlmPatchGen(opts?: { model?: string }): PatchGenPort {
  return {
    async generate(req: PatchGenRequest): Promise<string> {
      const provider = getLLMProvider();
      const model = opts?.model ?? process.env.OSNOVA_MODEL ?? 'qwen-coder-plus';

      const filesBlock = Object.entries(req.files)
        .map(([p, c]) => `=== ${p} ===\n${c}`)
        .join('\n\n');

      const feedbackBlock = req.feedback.length
        ? `\n\nПРОШЛЫЕ ОШИБКИ (исправь их):\n${req.feedback
            .map((f, i) => `#${i + 1} ${f}`)
            .join('\n\n')}`
        : '';

      const userPrompt =
        `Цель: ${req.goal}\n\n` +
        `Текущие файлы:\n${filesBlock}${feedbackBlock}\n\n` +
        `Верни ТОЛЬКО изменённые файлы ЦЕЛИКОМ (не diff). Каждый файл в блоке:\n` +
        `=== <путь к файлу> ===\n<полное новое содержимое файла>\n\n` +
        `Изменяй только файлы из набора выше.`;

      const resp = await provider.complete({
        model,
        messages: [
          {
            role: 'system',
            content:
              'Ты — инженер ядра языка Основа. Верни изменённые файлы целиком, каждый в блоке === путь ===. Никакого diff и никакого текста вне блоков.',
          },
          { role: 'user', content: userPrompt },
        ],
        maxTokens: 12000,
        temperature: 0.1,
      });

      return resp.content;
    },
  };
}

/** Применение/откат правок: перезапись файлов с бэкапом. */
export function createFilePatchPort(opts?: { cwd?: string }): PatchPort {
  const cwd = opts?.cwd ?? process.cwd();
  const backups: Record<string, string | null> = {};

  return {
    async apply(edits: FileEdits): Promise<void> {
      for (const [p, content] of Object.entries(edits)) {
        const abs = path.resolve(cwd, p);
        const original = await fsp.readFile(abs, 'utf-8').catch(() => null);
        backups[p] = original; // null = файла не было
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, content, 'utf-8');
      }
    },

    async revert(): Promise<void> {
      for (const [p, original] of Object.entries(backups)) {
        const abs = path.resolve(cwd, p);
        if (original === null) {
          await fsp.unlink(abs).catch(() => {});
        } else {
          await fsp.writeFile(abs, original, 'utf-8');
        }
      }
      for (const k of Object.keys(backups)) delete backups[k];
    },
  };
}

/** Гейт: список команд, каждая должна завершиться с exit 0. */
export function createCommandGate(commands: readonly string[], opts?: { cwd?: string }): GatePort {
  return {
    async run(): Promise<{ passed: boolean; output: string }> {
      const outputs: string[] = [];
      for (const cmd of commands) {
        try {
          await execAsync(cmd, { cwd: opts?.cwd });
        } catch (err) {
          outputs.push(`[${cmd}]\n${err instanceof Error ? err.message : String(err)}`);
          return { passed: false, output: outputs.join('\n\n') };
        }
      }
      return { passed: true, output: '' };
    },
  };
}

/** Проверка, что файлы ядра чисты (нет чужого dirty), иначе перезапись опасна. */
export async function assertCleanWorkingTree(paths: readonly string[], cwd?: string): Promise<void> {
  const { stdout } = await execAsync(`git status --porcelain -- ${paths.join(' ')}`, { cwd });
  if (stdout.trim()) {
    throw new Error(
      `Файлы ядра имеют незакоммиченные изменения — отказываюсь применять правки:\n${stdout}`,
    );
  }
}
