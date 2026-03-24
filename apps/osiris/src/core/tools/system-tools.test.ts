import { describe, expect, it } from 'vitest';

describe('system-tools', () => {
  async function loadTools() {
    process.env['REPO_ROOT'] = process.cwd();
    return await import('./system-tools');
  }

  it('shellExec echo returns stdout', async () => {
    const { shellExec } = await loadTools();
    const result = await shellExec('echo hello');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello');
  });

  it('shellExec blocks rm -rf / (not in whitelist)', async () => {
    const { shellExec } = await loadTools();
    const result = await shellExec('rm -rf /');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('не в списке');
  });

  it('shellExec blocks sudo shutdown (not in whitelist)', async () => {
    const { shellExec } = await loadTools();
    const result = await shellExec('sudo shutdown now');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('не в списке');
  });

  it('shellExec allows git status', async () => {
    const { shellExec } = await loadTools();
    const result = await shellExec('git status');
    // Может вернуть ненулевой exitCode если нет репо — но не должен быть заблокирован
    expect(result.stderr).not.toContain('не в списке');
  });

  it('shellExec allows npm commands', async () => {
    const { shellExec } = await loadTools();
    const result = await shellExec('npm --version');
    expect(result.stderr).not.toContain('не в списке');
  });

  it('fileRead blocks path traversal', async () => {
    const { fileRead } = await loadTools();
    const result = await fileRead('../../../etc/passwd');
    // Если resolved путь вне REPO_ROOT — ошибка доступа
    // Если REPO_ROOT = /opt/osnova и реально не существует — тоже error
    expect(result.error).toBeDefined();
  });

  it('gitCommitDiff rejects invalid sha', async () => {
    const { gitCommitDiff } = await loadTools();
    const result = await gitCommitDiff('invalid!sha');
    expect(result).toContain('Ошибка');
  });

  it('gitCommitDiff rejects too short sha', async () => {
    const { gitCommitDiff } = await loadTools();
    const result = await gitCommitDiff('abc');
    expect(result).toContain('Ошибка');
  });
});
