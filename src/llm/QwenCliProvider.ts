// ============================================================
// src/llm/QwenCliProvider.ts
// Перенесено из llama-fabrica/src/infrastructure/llm/QwenCliProvider.ts
// Изменения:
//   - путь импорта типов → ./types
//   - удалены зависимости VectorDB / EmbeddingService / RAG
//     (в osnova-fabrica нет RAG-слоя в v0.1)
// ============================================================
import { spawn } from 'node:child_process';
import { platform, tmpdir } from 'node:os';
import type {
  LLMProvider,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMModelInfo,
  LLMProviderStatus,
} from './types.js';
import { parseQwenStdout } from './qwen-stdout-parser.js';

const isWindows = platform() === 'win32';
const QWEN_TIMEOUT_MS = Number(process.env.QWEN_TIMEOUT_MS ?? 300_000);

type LLMMessageLocal = LLMCompletionRequest['messages'][number];

export class QwenCliProvider implements LLMProvider {
  readonly id = 'qwen-cli';
  readonly name = 'Qwen CLI (Free OAuth)';

  async checkHealth(): Promise<LLMProviderStatus> {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
      if (isWindows) {
        await execFileAsync('cmd', ['/c', 'chcp 65001 >nul 2>&1 && qwen --version'], {
          timeout: 10_000,
          env,
        });
      } else {
        await execFileAsync('qwen', ['--version'], { timeout: 10_000, env });
      }
      return { available: true };
    } catch (error: unknown) {
      const err = error as { code?: string; message?: string };
      if (err.code === 'ENOENT') {
        return {
          available: false,
          error:
            'qwen CLI not found. Install:\n' +
            '  npm install -g @qwen-code/qwen-code\n' +
            'Then authenticate:\n' +
            '  qwen auth login --auth-type=qwen-oauth',
        };
      }
      return { available: false, error: String(err.message ?? err) };
    }
  }

  async listModels(): Promise<readonly LLMModelInfo[]> {
    return [{ name: 'qwen-coder-plus', size: 0, modifiedAt: '' }];
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const startTime = Date.now();
    const prompt = this.formatMessages(request.messages);
    const args = ['--auth-type=qwen-oauth', '--output-format=json', '-y', '--channel=CI'];
    if (request.model) args.push(`--model=${request.model}`);
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };

    try {
      const output = await this.runQwenWithStdin(prompt, args, env);

      // I-5: парсинг stdout вынесен в qwen-stdout-parser
      let text = parseQwenStdout(output);
      if (!text) text = output;
      if (!text || text.trim() === '') {
        throw new Error(
          `QwenCliProvider: failed to extract code from output. ` +
            `stdout length: ${output.length}, ` +
            `first 200 chars: ${output.slice(0, 200)}`,
        );
      }

      const promptTokens = this.estimateTokens(prompt);
      const completionTokens = this.estimateTokens(text);
      void startTime;
      return {
        content: text,
        tokensUsed: {
          prompt: promptTokens,
          completion: completionTokens,
          total: promptTokens + completionTokens,
        },
        model: request.model || 'qwen-coder-plus',
        done: true,
        truncated: false,
      };
    } catch (error: unknown) {
      const err = error as { code?: string; message?: string };
      if (err.code === 'ENOENT') {
        throw new Error(
          'qwen CLI not found. Install:\n' +
            '  npm install -g @qwen-code/qwen-code\n' +
            'Then authenticate:\n' +
            '  qwen auth login --auth-type=qwen-oauth',
        );
      }
      throw new Error(`Qwen CLI error: ${err.message ?? String(error)}`);
    }
  }

  async completeStream(
    _request: LLMCompletionRequest,
    _onToken: (token: string) => void,
  ): Promise<LLMCompletionResponse> {
    throw new Error('Qwen CLI streaming not implemented in osnova-fabrica v0.1');
  }

  private runQwenWithStdin(
    prompt: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const command = isWindows ? 'cmd' : 'qwen';
      const finalArgs = isWindows ? ['/c', 'qwen.cmd', ...args] : args;
      const child = spawn(command, finalArgs, {
        cwd: tmpdir(),
        env: { ...env, PYTHONIOENCODING: 'utf-8' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      let killed = false;
      let sigkillTimer: NodeJS.Timeout | undefined;

      const timeout = setTimeout(() => {
        killed = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        sigkillTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, 2_000);
      }, QWEN_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeout);
        if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = undefined; }
      };

      child.on('error', (err) => { cleanup(); reject(err); });
      child.on('close', (code) => {
        cleanup();
        const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
        if (killed || code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
          const msg = killed
            ? `qwen timed out after ${QWEN_TIMEOUT_MS}ms`
            : `qwen exited with code ${code}`;
          reject(new Error(stderr ? `${msg}\nstderr: ${stderr}` : msg));
          return;
        }

        resolve(stdout);
      });

      child.stdin?.write(prompt, 'utf8', (err) => {
        if (err) {
          cleanup();
          reject(err);
        } else {
          child.stdin?.end();
        }
      });
    });
  }

  private formatMessages(messages: readonly LLMMessageLocal[]): string {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    return system ? `${system}\n\n---\n\n${user}` : user;
  }

  private estimateTokens(text: string): number {
    if (!text) return 0;
    const hasCyrillic = /[\u0400-\u04FF]/.test(text);
    return Math.ceil(text.length / (hasCyrillic ? 2 : 4));
  }
}
