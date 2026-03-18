/**
 * Unit-тесты validateEnv()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateEnv } from './env';

const ORIGINAL_ENV = { ...process.env };

function setEnv(overrides: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function restoreEnv(): void {
  process.env = { ...ORIGINAL_ENV };
}

describe('validateEnv', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    restoreEnv();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('EXIT');
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    restoreEnv();
  });

  it('проходит при qwen-cli (default)', async () => {
    setEnv({ OSNOVA_PROVIDER: 'qwen-cli' });
    await validateEnv();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('проходит при ollama без OLLAMA_URL (warning only)', async () => {
    setEnv({ OSNOVA_PROVIDER: 'ollama' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await validateEnv();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('OLLAMA_URL'));
    warnSpy.mockRestore();
  });

  it('проходит при deepseek с DEEPSEEK_API_KEY', async () => {
    setEnv({ OSNOVA_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'sk-test' });
    await validateEnv();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('завершает с exit(1) при deepseek без DEEPSEEK_API_KEY', async () => {
    setEnv({ OSNOVA_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: undefined });
    await expect(validateEnv()).rejects.toThrow('EXIT');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('завершает с exit(1) при неверном OSNOVA_PROVIDER', async () => {
    setEnv({ OSNOVA_PROVIDER: 'invalid-provider' });
    await expect(validateEnv()).rejects.toThrow('EXIT');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('применяет LOG_LEVEL при допустимом значении', async () => {
    setEnv({ OSNOVA_PROVIDER: 'qwen-cli', LOG_LEVEL: 'debug' });
    await validateEnv();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('предупреждает при неверном LOG_LEVEL', async () => {
    setEnv({ OSNOVA_PROVIDER: 'qwen-cli', LOG_LEVEL: 'invalid' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await validateEnv();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('LOG_LEVEL'));
    warnSpy.mockRestore();
  });
});
