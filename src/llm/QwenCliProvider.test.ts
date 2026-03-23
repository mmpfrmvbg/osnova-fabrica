/**
 * Тесты QwenCliProvider: stdout/stderr разделены, content не содержит stderr.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QwenCliProvider } from './QwenCliProvider';

// Valid JSON from qwen --output-format=json
const STDOUT_JSON = '[{"type":"result","subtype":"success","result":"hello"}]';
const STDERR_TEXT = 'Python warning: deprecated API';

function createMockSpawn(stdout: string, stderr: string, exitCode: number) {
  return vi.fn((_cmd: string, _args: string[], opts: { stdio?: unknown[] }) => {
    const child = {
      stdout: null as { on: (ev: string, cb: (chunk: Buffer) => void) => void } | null,
      stderr: null as { on: (ev: string, cb: (chunk: Buffer) => void) => void } | null,
      stdin: {
        write: (_: string, _enc: string, cb?: () => void) => {
          if (cb) setImmediate(cb);
          return true;
        },
        end: () => {},
      },
      on: (ev: string, cb: (code?: number) => void) => {
        if (ev === 'close') {
          setImmediate(() => cb(exitCode));
        }
        return child;
      },
      kill: () => {},
    };

    if (opts?.stdio?.[1] === 'pipe') {
      child.stdout = {
        on: (ev: string, cb: (chunk: Buffer) => void) => {
          if (ev === 'data') setImmediate(() => cb(Buffer.from(stdout)));
          return;
        },
      };
    }
    if (opts?.stdio?.[2] === 'pipe') {
      child.stderr = {
        on: (ev: string, cb: (chunk: Buffer) => void) => {
          if (ev === 'data') setImmediate(() => cb(Buffer.from(stderr)));
          return;
        },
      };
    }

    return child;
  });
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

describe('QwenCliProvider: stdout/stderr', () => {
  let spawnMock: ReturnType<typeof createMockSpawn>;

  beforeEach(async () => {
    const { spawn } = await import('node:child_process');
    spawnMock = createMockSpawn(STDOUT_JSON, STDERR_TEXT, 0);
    vi.mocked(spawn).mockImplementation(spawnMock as never);
  });

  it('content содержит только stdout, не stderr', async () => {
    const provider = new QwenCliProvider();
    const response = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.content).not.toContain('warning');
    expect(response.content).toBe('hello');
  });
});

describe('QwenCliProvider: empty output guard', () => {
  it('пустой stdout бросает ошибку с диагностикой', async () => {
    const { spawn } = await import('node:child_process');
    const emptyMock = createMockSpawn('', '', 0);
    vi.mocked(spawn).mockImplementation(emptyMock as never);
    const provider = new QwenCliProvider();
    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'test' }] }),
    ).rejects.toThrow('QwenCliProvider: failed to extract code from output');
  });

  it('whitespace-only stdout бросает ошибку с диагностикой', async () => {
    const { spawn } = await import('node:child_process');
    const wsMock = createMockSpawn('   \n  ', '', 0);
    vi.mocked(spawn).mockImplementation(wsMock as never);
    const provider = new QwenCliProvider();
    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'test' }] }),
    ).rejects.toThrow('QwenCliProvider: failed to extract code from output');
  });

  it('JSON-мусор в stdout уходит в fallback и не падает', async () => {
    const { spawn } = await import('node:child_process');
    const junkMock = createMockSpawn('[{"type":"assistant","content":"what"}]', '', 0);
    vi.mocked(spawn).mockImplementation(junkMock as never);
    const provider = new QwenCliProvider();
    const response = await provider.complete({
      messages: [{ role: 'user', content: 'test' }],
    });
    expect(response.content).toBe('[{"type":"assistant","content":"what"}]');
  });
});
