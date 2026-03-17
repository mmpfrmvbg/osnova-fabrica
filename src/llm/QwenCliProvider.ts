// ============================================================
// src/llm/QwenCliProvider.ts
// Перенесено из llama-fabrica/src/infrastructure/llm/QwenCliProvider.ts
// Изменения:
//   - путь импорта типов → ./types
//   - удалены зависимости VectorDB / EmbeddingService / RAG
//     (в osnova-fabrica нет RAG-слоя в v0.1)
// ============================================================
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import type {
  LLMProvider,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMModelInfo,
  LLMProviderStatus,
} from './types.js';

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
        await execFileAsync('cmd', ['/c', 'chcp 65001 >nul 2>&1 && qwen --help'], {
          timeout: 10_000,
          env,
        });
      } else {
        await execFileAsync('qwen', ['--help'], { timeout: 10_000, env });
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
    const args = ['--auth-type=qwen-oauth', '--output-format=text', '-y'];
    if (request.model) args.push(`--model=${request.model}`);
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };

    try {
      const output = await this.runQwenWithStdin(prompt, args, env);
      const promptTokens = this.estimateTokens(prompt);
      const completionTokens = this.estimateTokens(output);
      void startTime;
      return {
        content: output,
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
      const child = spawn('qwen', args, {
        env: { ...env, PYTHONIOENCODING: 'utf-8' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const chunks: Buffer[] = [];
      child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk));

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
        const stdout = Buffer.concat(chunks).toString('utf8').trim();
        if (code !== 0 && !killed) {
          reject(new Error(`qwen exited with code ${code}`));
        } else if (killed && code !== 0) {
          reject(new Error(`qwen timed out after ${QWEN_TIMEOUT_MS}ms`));
        } else {
          resolve(stdout);
        }
      });

      child.stdin?.write(prompt, 'utf8', (err) => {
        if (err) { cleanup(); reject(err); }
        else { child.stdin?.end(); }
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
    return Math.ceil(text.length / 4);
  }
}
