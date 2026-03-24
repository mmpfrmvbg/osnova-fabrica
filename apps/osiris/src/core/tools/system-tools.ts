// apps/osiris/src/core/tools/system-tools.ts
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

const execAsync = promisify(exec);

const REPO_ROOT = process.env['REPO_ROOT'] ?? '/opt/osnova';
const SHELL_TIMEOUT = 15_000;

const ALLOWED_PREFIXES = [
  'git ',
  'npm ',
  'npx ',
  'node ',
  'tsx ',
  'pm2 ',
  'ls ',
  'ls\n',
  'cat ',
  'echo ',
  'pwd',
  'whoami',
  'curl ',
  'df ',
  'free ',
  'ps ',
  'top -b',
  'tail ',
  'head ',
  'grep ',
  'find ',
  'wc ',
];

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function shellExec(cmd: string): Promise<ShellResult> {
  const trimmed = cmd.trim().toLowerCase();
  const allowed = ALLOWED_PREFIXES.some((p) => trimmed.startsWith(p));
  if (!allowed) {
    return {
      stdout: '',
      stderr: `Команда не в списке разрешённых: "${cmd.trim()}"`,
      exitCode: 1,
    };
  }
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: SHELL_TIMEOUT,
      cwd: REPO_ROOT,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return {
      stdout: err.stdout?.trim() ?? '',
      stderr: err.stderr?.trim() ?? err.message,
      exitCode: typeof err.code === 'number' ? err.code : 1,
    };
  }
}

export interface FileReadResult {
  content: string;
  error?: string;
}

export async function fileRead(filePath: string): Promise<FileReadResult> {
  const resolved = path.resolve(REPO_ROOT, filePath);
  if (!resolved.startsWith(REPO_ROOT)) {
    return { content: '', error: `Доступ запрещён: путь вне репозитория (${resolved})` };
  }
  try {
    const content = await fs.readFile(resolved, 'utf-8');
    return { content };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: '', error: msg };
  }
}

export async function gitStatus(repoPath?: string): Promise<string> {
  const cwd = repoPath ?? REPO_ROOT;
  const result = await execAsync(
    'git status --short && echo "---" && git log --oneline -5',
    { timeout: SHELL_TIMEOUT, cwd },
  ).catch((e: Error) => ({ stdout: '', stderr: e.message }));
  return (result.stdout ?? '').trim() || ((result as { stderr?: string }).stderr ?? '');
}

export async function gitCommitDiff(sha: string): Promise<string> {
  if (!/^[0-9a-f]{6,40}$/i.test(sha)) {
    return `Ошибка: невалидный SHA "${sha}". Ожидается 6-40 hex-символов.`;
  }
  const result = await execAsync(
    `git show --stat ${sha}`,
    { timeout: SHELL_TIMEOUT, cwd: REPO_ROOT },
  ).catch((e: Error) => ({ stdout: '', stderr: e.message }));
  return (result.stdout ?? '').trim() || ((result as { stderr?: string }).stderr ?? '');
}

export async function notifyPush(
  text: string,
  urgency: 'low' | 'normal' | 'high' = 'normal',
): Promise<void> {
  const webhookUrl = process.env['PUSH_WEBHOOK_URL'];
  if (!webhookUrl) {
    console.log(`[PUSH][${urgency}] ${text}`);
    return;
  }
  try {
    const body = JSON.stringify({ text, urgency, timestamp: new Date().toISOString() });
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (e) {
    console.error('[osiris:notify_push] webhook failed:',
      e instanceof Error ? e.message : String(e));
    // тихо, без throw
  }
}
