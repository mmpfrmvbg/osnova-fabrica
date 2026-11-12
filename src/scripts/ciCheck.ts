#!/usr/bin/env tsx
/**
 * `npm run check:ci`: сторож самого CI.
 *
 * Проверяет не код языка, а контур доставки: workflow лежит там, где его читает
 * GitVerse, уровни L1/L2/L3 не подменены, секреты названы допустимо, release
 * зависит от всех трёх уровней, а lock-файл способен пережить `npm ci` на Node 20.
 *
 * Почему это отдельный шаг, а не комментарий в workflow: конфиг CI меняется
 * вместе с кодом, и ошибка в нём стоит дороже ошибки в тесте — она отключает
 * проверки молча. Сторож должен краснеть в том же прогоне, где сломан конфиг.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { load } from 'js-yaml';

const ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOW = path.join(ROOT, '.gitverse', 'workflows', 'full-ci.yaml');
const REQUIRED_JOBS = ['build-and-test', 'qemu-test', 'hardware-test', 'release'] as const;
const REQUIRED_SCRIPTS = [
  'tools/e2k-hardware/ci-run.sh',
  'scripts/sync-public.sh',
  'scripts/ci-local.sh',
  'scripts/release-local.sh',
] as const;

interface Step {
  run?: string;
  uses?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
}

interface Job {
  'runs-on'?: string | string[];
  needs?: string | string[];
  steps?: Step[];
  if?: string;
}

interface Workflow {
  name?: string;
  jobs?: Record<string, Job>;
}

const problems: string[] = [];
let checks = 0;

function check(ok: boolean, message: string): void {
  checks++;
  if (!ok) problems.push(message);
}

function runsOn(job: Job | undefined): string[] {
  const value = job?.['runs-on'];
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function jobText(job: Job | undefined): string {
  return (job?.steps ?? [])
    .map((step) => `${step.run ?? ''}\n${step.uses ?? ''}\n${JSON.stringify(step.env ?? {})}\n${JSON.stringify(step.with ?? {})}`)
    .join('\n');
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

let workflow: Workflow;
try {
  workflow = load(readFileSync(WORKFLOW, 'utf8')) as Workflow;
} catch (error) {
  console.error(`ci-check: не разобран ${path.relative(ROOT, WORKFLOW)}: ${(error as Error).message}`);
  process.exit(1);
}

const jobs = workflow.jobs ?? {};
check(workflow.name === 'Full CI', 'workflow: имя должно быть Full CI');
for (const id of REQUIRED_JOBS) check(Boolean(jobs[id]), `workflow: нет job ${id}`);

const l1 = jobs['build-and-test'];
const l1Text = jobText(l1);
check(/npm run build\b/.test(l1Text), 'L1: нет npm run build');
check(/npm run ci\b/.test(l1Text), 'L1: нет полного npm run ci');
check(/npm run check:ci\b/.test(l1Text), 'L1: нет сторожа npm run check:ci');

const qemu = jobs['qemu-test'];
const qemuLabels = runsOn(qemu);
const qemuText = jobText(qemu);
check(qemuLabels.includes('self-hosted'), 'L2: QEMU должен идти на self-hosted');
check(qemuLabels.includes('windows'), 'L2: QEMU должен идти на windows');
check(qemuLabels.includes('x64'), 'L2: QEMU должен идти на x64');
check(!qemuLabels.includes('ubuntu-latest'), 'L2: ubuntu-latest не умеет WSL/QEMU этого проекта');
check(/npm run gate:qemu\b/.test(qemuText), 'L2: нет npm run gate:qemu');

const runnerScript = path.join(ROOT, 'tools', 'gitverse-runner', 'register-windows.ps1');
check(existsSync(runnerScript), 'L2: нет tools/gitverse-runner/register-windows.ps1');
const runnerText = existsSync(runnerScript) ? readFileSync(runnerScript, 'utf8') : '';
check(/self-hosted:host/.test(runnerText), 'L2: регистрация раннера без метки self-hosted');
check(/windows:host/.test(runnerText), 'L2: регистрация раннера без метки windows');
check(/x64:host/.test(runnerText), 'L2: регистрация раннера без метки x64');
check(/GITVERSE_RUNNER_TOKEN/.test(runnerText), 'L2: токен регистрации не берётся из окружения');
check(/act_runner_windows_amd64/.test(runnerText), 'L2: регистрация не использует Windows-сборку act_runner');
const runnerIgnore = path.join(ROOT, 'tools', 'gitverse-runner', '.gitignore');
check(existsSync(runnerIgnore), 'L2: нет .gitignore для бинаря и .runner');
const ignoreText = existsSync(runnerIgnore) ? readFileSync(runnerIgnore, 'utf8') : '';
check(/\.runner/.test(ignoreText), 'L2: .runner не исключён из git');
check(/\.bin\//.test(ignoreText), 'L2: бинарь раннера не исключён из git');

const hardware = jobs['hardware-test'];
const hardwareText = jobText(hardware);
check(/tools\/e2k-hardware\/ci-run\.sh/.test(hardwareText), 'L3: нет запуска tools/e2k-hardware/ci-run.sh');
check(/secrets\.E2K_SSH_KEY/.test(hardwareText), 'L3: не подключён секрет E2K_SSH_KEY');
check(/secrets\.E2K_HOST/.test(hardwareText), 'L3: не подключён секрет E2K_HOST');
check(/secrets\.E2K_USER/.test(hardwareText), 'L3: не подключён секрет E2K_USER');
check(/secrets\.E2K_PORT/.test(hardwareText), 'L3: не подключён секрет E2K_PORT');
check(/hardware:kit/.test(hardwareText), 'L3: кит не пересобирается перед прогоном');

const release = jobs.release;
const releaseText = jobText(release);
const needs = Array.isArray(release?.needs) ? release.needs : release?.needs ? [release.needs] : [];
for (const id of REQUIRED_JOBS.slice(0, 3)) {
  check(needs.includes(id), `release: не зависит от ${id}`);
}
check(/secrets\.RELEASE_API_KEY/.test(releaseText), 'release: не подключён секрет RELEASE_API_KEY');
check(/gitverse\.ref/.test(release?.if ?? ''), 'release: условие не привязано к gitverse.ref');
check(/merge-base --is-ancestor/.test(releaseText), 'release: тег не проверяется на принадлежность master');
check(/fetch-depth["']?\s*:\s*0/.test(releaseText), 'release: checkout без полной истории, merge-base не сработает');

const serialized = JSON.stringify(workflow);
check(!/secrets\.GITVERSE_/.test(serialized), 'секрет с запрещённым префиксом GITVERSE_');
check(!/\$\{\{\s*github\./.test(serialized), 'workflow использует github.* вместо gitverse.*');

for (const rel of REQUIRED_SCRIPTS) {
  const staged = git('ls-files', '--stage', '--', rel).trim();
  check(staged.startsWith('100755'), `${rel}: в git не выставлен режим 100755`);
  const source = readFileSync(path.join(ROOT, rel), 'utf8');
  check(!source.includes('|| true'), `${rel}: найден || true, который скрывает отказ`);
  check(!source.includes('|| :'), `${rel}: найден || :, который скрывает отказ`);
}

const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};
for (const name of ['build', 'ci', 'check:ci', 'gate:qemu', 'hardware:kit']) {
  check(Boolean(packageJson.scripts?.[name]), `package.json: нет script ${name}`);
}

const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')) as {
  packages?: Record<string, unknown>;
};
check(Boolean(lock.packages?.['node_modules/@emnapi/core']), 'lock: нет @emnapi/core (npm 10 на Node 20)');
check(Boolean(lock.packages?.['node_modules/@emnapi/runtime']), 'lock: нет @emnapi/runtime (npm 10 на Node 20)');

const tracked = git('ls-files').split('\n').filter(Boolean);
const forbidden = /(^|\/)(?:key\.openssh|.*\.ppk|id_rsa(?:\..*)?|id_ed25519(?:\..*)?|\.env)$/i;
for (const rel of tracked) {
  check(!forbidden.test(rel), `${rel}: секретный файл попал в git`);
}

if (problems.length > 0) {
  console.error(`ci-check: ${problems.length} проблем(ы) из ${checks} проверок:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`ci-check: ${checks} проверок, 0 проблем`);
