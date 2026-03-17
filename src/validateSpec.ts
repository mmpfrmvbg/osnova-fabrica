#!/usr/bin/env npx tsx
/**
 * validateSpec.ts — автоматический валидатор spec.yaml
 *
 * Проверяет соответствие spec.yaml реальному коду проекта.
 * Запуск: npx tsx src/tools/validateSpec.ts
 *
 * Поддерживает spec v0.1.0 (api_endpoints, missing_commands)
 * и spec v0.2.0 (api: {auth,billing,...}, telegram.missing, structure.src.lib, billing, ws).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

// ─────────────────────────────────────────────
// Типы
// ─────────────────────────────────────────────

interface CheckResult {
  category: string;
  check: string;
  status: 'pass' | 'fail' | 'warn';
  detail?: string;
}

interface Spec {
  project: Record<string, unknown>;
  stack: Record<string, unknown>;
  structure: Record<string, unknown>;
  env: { required: Record<string, string>; optional: Record<string, unknown> };
  pipeline: { steps: Array<{ id: string; action: string }> };
  agent_pipeline: Record<string, unknown>;
  // v0.1.0
  api_endpoints?: Record<string, { path?: string; [k: string]: unknown }>;
  // v0.2.0
  api?: Record<string, Record<string, string>>;
  telegram: { commands: Record<string, string>; missing_commands?: string[]; missing?: string[] };
  task_states: Record<string, unknown>;
  trace: Record<string, unknown>;
  security: Record<string, unknown>;
  tech_debt: Record<string, unknown>;
  roadmap: Record<string, unknown>;
}

// ─────────────────────────────────────────────
// Утилиты
// ─────────────────────────────────────────────

const ROOT = resolve(process.cwd());
const results: CheckResult[] = [];

function pass(category: string, check: string, detail?: string): void {
  results.push({ category, check, status: 'pass', detail });
}

function fail(category: string, check: string, detail?: string): void {
  results.push({ category, check, status: 'fail', detail });
}

function warn(category: string, check: string, detail?: string): void {
  results.push({ category, check, status: 'warn', detail });
}

function fileExists(relativePath: string): boolean {
  return existsSync(join(ROOT, relativePath));
}

function readFile(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf-8');
}

function isDirectory(relativePath: string): boolean {
  try {
    return statSync(join(ROOT, relativePath)).isDirectory();
  } catch {
    return false;
  }
}

function findSymbol(src: string, name: string): boolean {
  const patterns = [
    `function ${name}(`,
    `function ${name} (`,
    `async function ${name}(`,
    `async function ${name} (`,
    `${name}(`,
    `async ${name}(`,
    `${name} =`,
    `${name}:`,
    `export function ${name}`,
    `export async function ${name}`,
    `export const ${name}`,
  ];
  return patterns.some((p) => src.includes(p));
}

/** Парсинг ключа v0.2.0: "POST /api/auth/login" -> { method: 'post', path: '/api/auth/login' } */
function parseMethodPath(key: string): { method: string; path: string } | null {
  const m = key.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)/i);
  if (!m) return null;
  return { method: m[1].toLowerCase(), path: m[2] };
}

// ─────────────────────────────────────────────
// 1. Файловая структура
// ─────────────────────────────────────────────

function cleanSpecEntry(entry: unknown): string {
  return String(entry).split('#')[0].trim();
}

function checkStructure(spec: Spec): void {
  const cat = 'structure';
  const structure: any = spec.structure ?? {};

  // Корневые файлы
  const rootFiles: unknown[] = structure.root_files ?? [];
  for (const entry of rootFiles) {
    const fileName = cleanSpecEntry(entry);
    if (!fileName) continue;
    if (fileExists(fileName)) pass(cat, `root: ${fileName}`);
    else fail(cat, `root: ${fileName}`, 'Файл не найден');
  }

  // entry points
  const entryPoints: Record<string, string> = structure.src?.entry_points ?? {};
  for (const [file] of Object.entries(entryPoints)) {
    const path = `src/${file}`;
    if (fileExists(path)) pass(cat, `entry: ${path}`);
    else fail(cat, `entry: ${path}`, 'Entry point не найден');
  }

  // src/lib (v0.2.0)
  const libSection: any = structure.src?.lib;
  const libFiles: string[] =
    libSection && typeof libSection === 'object' && !Array.isArray(libSection)
      ? Object.keys(libSection)
      : ['auth-middleware.ts'];
  if (libSection !== undefined) {
    for (const file of libFiles) {
      const path = `src/lib/${file}`;
      if (fileExists(path)) pass(cat, `lib: ${file}`);
      else fail(cat, `lib: ${file}`, `${path} не найден`);
    }
  }

  // domain/agent
  const agentFiles: unknown[] = structure.src?.domain?.agent?.files ?? [];
  for (const entry of agentFiles) {
    const fileName = cleanSpecEntry(entry);
    if (!fileName) continue;
    const path = `src/domain/agent/${fileName}`;
    if (fileExists(path)) pass(cat, `agent: ${fileName}`);
    else fail(cat, `agent: ${fileName}`, `${path} не найден`);
  }

  // infrastructure
  for (const [subdir, entries] of [
    ['agent', structure.src?.infrastructure?.agent ?? []],
    ['git',   structure.src?.infrastructure?.git   ?? []],
    ['llm',   structure.src?.infrastructure?.llm   ?? []],
  ] as [string, unknown[]][]) {
    for (const entry of entries) {
      const fileName = cleanSpecEntry(entry);
      if (!fileName) continue;
      const path = `src/infrastructure/${subdir}/${fileName}`;
      if (fileExists(path)) pass(cat, `infra/${subdir}: ${fileName}`);
      else fail(cat, `infra/${subdir}: ${fileName}`, `${path} не найден`);
    }
  }

  // security
  if (structure.src?.security?.['pathScope.ts'] || structure.security?.['pathScope.ts']) {
    if (fileExists('src/lib/pathScope.ts')) pass(cat, 'security: pathScope.ts');
    else fail(cat, 'security: pathScope.ts', 'Файл не найден');
  }

  // Tauri: v0.2.0 — src_tauri объект с файлами; v0.1.0 — просто warn
  const srcTauri: any = structure.src_tauri;
  if (srcTauri && typeof srcTauri === 'object') {
    const rsFiles = Object.keys(srcTauri).filter((k) => k.endsWith('.rs'));
    if (rsFiles.length > 0) {
      for (const rs of rsFiles) {
        const path = `src-tauri/src/${rs}`;
        if (fileExists(path)) pass(cat, `tauri: ${rs}`);
        else warn(cat, `tauri: ${rs}`, 'Файл не найден (Tauri может быть не настроен)');
      }
    } else {
      if (isDirectory('src-tauri') && fileExists('src-tauri/src/main.rs'))
        pass(cat, 'tauri: src-tauri/src/main.rs');
      else
        warn(cat, 'tauri: src-tauri/src/main.rs', 'Файл не найден');
    }
  }

  // UI: v0.2.0 — structure.ui.entry; v0.1.0 — ui/App.tsx
  const uiSection: any = structure.ui;
  const uiEntry: string | undefined = uiSection?.entry;
  if (uiEntry) {
    if (fileExists(uiEntry)) pass(cat, `ui: ${uiEntry}`);
    else warn(cat, `ui: ${uiEntry}`, 'Файл не найден');
  } else {
    const candidates = ['ui/App.tsx', 'ui/src/App.tsx', 'ui/src/app/App.tsx', 'ui/src/main.tsx'];
    const found = candidates.find((c) => fileExists(c));
    if (found) pass(cat, `ui: ${found}`);
    else warn(cat, 'ui: App.tsx', 'Файл не найден (UI может быть не настроен)');
  }
}

// ─────────────────────────────────────────────
// 2. Переменные окружения
// ─────────────────────────────────────────────

function checkEnv(spec: Spec): void {
  const cat = 'env';
  const required = spec.env?.required ?? {};
  const optional = spec.env?.optional ?? {};
  const allEnvVars: string[] = [...Object.keys(required), ...Object.keys(optional)];

  if (!fileExists('.env.example')) {
    fail(cat, '.env.example', 'Файл не найден');
  } else {
    const envExample = readFile('.env.example');
    for (const envVar of allEnvVars) {
      if (envExample.includes(envVar)) pass(cat, `example: ${envVar}`);
      else warn(cat, `example: ${envVar}`, 'Отсутствует в .env.example');
    }
  }

  const srcFiles = ['src/fabrica.ts', 'src/server.ts', 'src/bot.ts', 'src/cli.ts',
                    'src/lib/auth-middleware.ts'];
  const allSrc = srcFiles.filter((f) => fileExists(f)).map((f) => readFile(f)).join('\n');

  for (const envVar of allEnvVars) {
    const patterns = [
      `process.env.${envVar}`,
      `process.env['${envVar}']`,
      `process.env["${envVar}"]`,
    ];
    if (patterns.some((p) => allSrc.includes(p)))
      pass(cat, `usage: ${envVar}`);
    else
      warn(cat, `usage: ${envVar}`, 'Не найден в источниках (может использоваться в других модулях)');
  }
}

// ─────────────────────────────────────────────
// 3. Telegram-команды
// ─────────────────────────────────────────────

function checkTelegram(spec: Spec): void {
  const cat = 'telegram';

  if (!fileExists('src/bot.ts')) {
    fail(cat, 'bot.ts', 'Файл не найден');
    return;
  }

  const botSrc = readFile('src/bot.ts');
  const commands = spec.telegram?.commands ?? {};

  for (const cmd of Object.keys(commands)) {
    const cmdName = cmd.replace(/^\//, '');
    const patterns = [
      `command('${cmdName}'`, `command("${cmdName}"`,
      `'/${cmdName}'`,        `"/${cmdName}"`,
    ];
    if (patterns.some((p) => botSrc.includes(p)))
      pass(cat, `cmd: /${cmdName}`);
    else
      fail(cat, `cmd: /${cmdName}`, 'Не найден в bot.ts');
  }

  // v0.2.0: missing[], v0.1.0: missing_commands[]
  const missing: string[] = (spec.telegram as any).missing ?? spec.telegram?.missing_commands ?? [];
  for (const entry of missing) {
    const match = String(entry).match(/^\/(\w+)/);
    if (!match) continue;
    const cmdName = match[1];
    const patterns = [
      `command('${cmdName}'`, `command("${cmdName}"`,
      `'/${cmdName}'`,        `"/${cmdName}"`,
    ];
    if (patterns.some((p) => botSrc.includes(p)))
      warn(cat, `missing: /${cmdName}`, 'Помечена как missing, но найдена в коде — обновить spec');
    else
      pass(cat, `missing: /${cmdName}`, 'Корректно отсутствует');
  }
}

// ─────────────────────────────────────────────
// 4. API-эндпоинты
// ─────────────────────────────────────────────

function checkApi(spec: Spec): void {
  const cat = 'api';

  if (!fileExists('src/server.ts')) {
    fail(cat, 'server.ts', 'Файл не найден');
    return;
  }

  const serverSrc = readFile('src/server.ts');

  function findRoute(method: string, path: string): boolean {
    // Ищем по всему файлу — подходит для многострочных регистраций
    return serverSrc.includes(path) &&
      (serverSrc.includes(`server.${method}`) || serverSrc.includes(`.${method}(`));
  }

  // ——— v0.2.0: spec.api {секция: {"METHOD /path": описание, ...}} ———
  if (spec.api && typeof spec.api === 'object') {
    for (const [section, entries] of Object.entries(spec.api)) {
      if (!entries || typeof entries !== 'object') continue;
      for (const key of Object.keys(entries)) {
        const parsed = parseMethodPath(key);
        if (!parsed) continue;
        const { method, path } = parsed;
        if (findRoute(method, path))
          pass(cat, `${method.toUpperCase()} ${path}`);
        else
          fail(cat, `${method.toUpperCase()} ${path}`, `Роут не найден в server.ts (section: ${section})`);
      }
    }
    return;
  }

  // ——— v0.1.0: spec.api_endpoints ———
  if (!spec.api_endpoints) return;

  for (const [key, value] of Object.entries(spec.api_endpoints)) {
    if (key === 'stub_endpoints') continue;
    const path = value.path;
    if (!path) continue;
    const [methodPart] = key.split('_');
    const method = (methodPart || 'GET').toLowerCase();
    if (findRoute(method, path))
      pass(cat, `${method.toUpperCase()} ${path}`);
    else
      fail(cat, `${method.toUpperCase()} ${path}`, 'Роут не найден в server.ts');
  }

  // stubs (v0.1.0)
  const stubs: any = spec.api_endpoints?.stub_endpoints ?? {};
  for (const [key, value] of Object.entries(stubs)) {
    if (key === 'note') continue;
    const stub = value as { path?: string };
    if (!stub.path) continue;
    if (serverSrc.includes(stub.path))
      pass(cat, `stub: ${stub.path}`);
    else
      fail(cat, `stub: ${stub.path}`, 'Stub роут не найден в server.ts');
  }
}

// ─────────────────────────────────────────────
// 5. Pipeline
// ─────────────────────────────────────────────

function checkPipeline(_spec: Spec): void {
  const cat = 'pipeline';

  const keyFunctions: Record<string, string[]> = {
    'src/fabrica.ts': ['fabrica', 'buildFileTree', 'createLLMProvider'],
    'src/domain/agent/orchestrator.ts': ['runAgent'],
    'src/domain/agent/runReport.ts': ['createRunReport'],
    'src/infrastructure/git/GitHubAdapter.ts': [
      'cloneRepo', 'createBranch', 'commit', 'push', 'createPullRequest', 'cleanup',
    ],
    'src/infrastructure/agent/RunArtifactsWriter.ts': ['ensureRunDir'],
  };

  for (const [filePath, functions] of Object.entries(keyFunctions)) {
    if (!fileExists(filePath)) {
      fail(cat, `file: ${filePath}`, 'Файл не найден');
      continue;
    }
    const src = readFile(filePath);
    for (const fn of functions) {
      if (findSymbol(src, fn)) pass(cat, `fn: ${fn}`);
      else fail(cat, `fn: ${fn}`, `Не найдена в ${filePath}`);
    }
  }
}

// ─────────────────────────────────────────────
// 6. Agent pipeline
// ─────────────────────────────────────────────

function checkAgentPipeline(_spec: Spec): void {
  const cat = 'agent';

  const agentFiles = [
    'src/domain/agent/orchestrator.ts',
    'src/domain/agent/codeGenerator.ts',
    'src/domain/agent/fixer.ts',
    'src/domain/agent/planner.ts',
    'src/domain/agent/fixLoop.ts',
    'src/domain/agent/fixGuards.ts',
    'src/domain/agent/scopeGuards.ts',
    'src/domain/agent/fileDirectiveParser.ts',
    'src/domain/agent/truncationGuard.ts',
    'src/domain/agent/errorNormalizer.ts',
    'src/domain/agent/promptMemory.ts',
    'src/domain/agent/runReport.ts',
    'src/domain/agent/diagnostics.ts',
  ];

  const promptFiles = [
    'src/domain/prompt/compilePrompt.ts',
    'src/domain/prompt/index.ts',
  ];

  const combinedSrc = [
    ...agentFiles.filter((f) => fileExists(f)).map((f) => readFile(f)),
    ...promptFiles.filter((f) => fileExists(f)).map((f) => readFile(f)),
  ].join('\n');

  if (!combinedSrc.trim()) {
    fail(cat, 'agent sources', 'Agent/prompt файлы не найдены');
    return;
  }

  const agentFunctions: Array<{ name: string; description: string }> = [
    { name: 'compilePrompt',                    description: 'compiled mode промпты' },
    { name: 'parsePlanStepsJson',               description: 'JSON парсинг плана' },
    { name: 'parsePlanningResponse',            description: 'legacy regex парсинг плана' },
    { name: 'codegenStep',                      description: 'codegen phase' },
    { name: 'buildCodegenPrompt',               description: 'legacy codegen промпт' },
    { name: 'parseFileDirectivesWithFallback',  description: 'парсинг // --file директив' },
    { name: 'detectTruncation',                 description: 'детекция обрезки' },
    { name: 'runFixLoop',                       description: 'fix loop' },
    { name: 'decideFixAction',                  description: 'решение retry/abort' },
    { name: 'normalizeErrorSignature',          description: 'подпись ошибки' },
    { name: 'buildFixPrompt',                   description: 'legacy fix промпт' },
    { name: 'parseDiagnostics',                 description: 'парсинг ошибок' },
    { name: 'filterNewErrors',                  description: 'фильтрация baseline' },
    { name: 'parseTscOutput',                   description: 'tsc parser' },
    { name: 'parseVitestOutput',                description: 'vitest parser' },
    { name: 'diffDiagnostics',                  description: 'diff диагностик' },
    { name: 'diagnosticsSignature',             description: 'error signature' },
    { name: 'formatDiagnosticsForPrompt',       description: 'format for LLM' },
    { name: 'computeAllowedFixPaths',           description: 'разрешённые пути fix' },
    { name: 'extractImportedSymbolsFromTest',   description: 'символы из импортов' },
    { name: 'computeAllowedSymbolsForTestStep', description: 'разрешённые символы' },
    { name: 'findUnexpectedImportedSymbols',    description: 'scope violations' },
    { name: 'createRunReport',                  description: 'создание RunReport' },
  ];

  for (const { name, description } of agentFunctions) {
    if (findSymbol(combinedSrc, name))
      pass(cat, `fn: ${name}`, description);
    else if (combinedSrc.includes(name))
      warn(cat, `fn: ${name}`, `${description} (partial match)`);
    else
      fail(cat, `fn: ${name}`, `${description} — не найдена`);
  }
}

// ─────────────────────────────────────────────
// 7. Версия и метаданные
// ─────────────────────────────────────────────

function checkMeta(spec: Spec): void {
  const cat = 'meta';

  if (!fileExists('package.json')) {
    fail(cat, 'package.json', 'Файл не найден');
    return;
  }

  const pkg = JSON.parse(readFile('package.json')) as { name: string; version: string };
  const specVersion = String((spec.project as any).version ?? '');
  const pkgVersion = pkg.version;

  if (specVersion === pkgVersion)
    pass(cat, 'version', `spec=${specVersion}, package.json=${pkgVersion}`);
  else
    warn(cat, 'version', `spec=${specVersion} ≠ package.json=${pkgVersion} (обнови package.json или spec)`);

  const specName = (spec.project as any).name;
  if (specName === pkg.name) pass(cat, 'name', specName);
  else fail(cat, 'name', `spec=${specName} ≠ package.json=${pkg.name}`);
}

// ─────────────────────────────────────────────
// 8. Security
// ─────────────────────────────────────────────

function checkSecurity(_spec: Spec): void {
  const cat = 'security';

  if (fileExists('src/lib/pathScope.ts')) {
    const src = readFile('src/lib/pathScope.ts');
    if (src.includes('isPathInsideRepo')) pass(cat, 'pathScope: isPathInsideRepo');
    else warn(cat, 'pathScope: isPathInsideRepo', 'Функция не найдена');
  } else {
    warn(cat, 'pathScope.ts', 'Файл не найден');
  }

  if (fileExists('src/infrastructure/agent/FsFileWriter.ts')) {
    const src = readFile('src/infrastructure/agent/FsFileWriter.ts');
    if (src.includes('isPathInsideRepo') || src.includes('pathScope'))
      pass(cat, 'FsFileWriter uses pathScope');
    else
      warn(cat, 'FsFileWriter uses pathScope', 'Нет импорта pathScope');
  }

  const dangerousPatterns = [
    /GITHUB_TOKEN\s*=\s*['"][^'"]{10,}['"]/,
    /DEEPSEEK_API_KEY\s*=\s*['"][^'"]{10,}['"]/,
    /TELEGRAM_BOT_TOKEN\s*=\s*['"][^'"]{10,}['"]/,
  ];
  for (const file of ['src/fabrica.ts', 'src/server.ts', 'src/bot.ts', 'src/cli.ts']) {
    if (!fileExists(file)) continue;
    const src = readFile(file);
    for (const pattern of dangerousPatterns) {
      if (pattern.test(src)) fail(cat, `hardcoded secret in ${file}`, pattern.source);
    }
  }
  pass(cat, 'no hardcoded secrets');
}

// ─────────────────────────────────────────────
// 9. Billing (v0.2.0)
// ─────────────────────────────────────────────

function checkBilling(_spec: Spec): void {
  // billing removed — single-user local tool
}

// ─────────────────────────────────────────────
// 10. WebSocket (v0.2.0)
// ─────────────────────────────────────────────

function checkWebSocket(_spec: Spec): void {
  const cat = 'websocket';

  if (fileExists('src/ws.ts')) {
    pass(cat, 'src/ws.ts');
    const src = readFile('src/ws.ts');
    if (src.includes('registerPulseGetter')) pass(cat, 'registerPulseGetter');
    else warn(cat, 'registerPulseGetter', 'Не найдена в ws.ts');
  } else {
    warn(cat, 'src/ws.ts', 'Файл не найден');
  }

  if (fileExists('src/ws-types.ts')) pass(cat, 'src/ws-types.ts');
  else warn(cat, 'src/ws-types.ts', 'Файл не найден');
}

// ─────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────

function main(): void {
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║   llama-fabrica spec.yaml validator      ║');
  console.log('╚═══════════════════════════════════════════╝');
  console.log();

  const specPath = join(ROOT, 'spec.yaml');
  if (!existsSync(specPath)) {
    console.error('❌ spec.yaml не найден в корне проекта');
    process.exit(1);
  }

  const specRaw = readFileSync(specPath, 'utf-8');
  let spec: Spec;
  try {
    spec = parseYaml(specRaw) as Spec;
  } catch (err) {
    console.error('❌ spec.yaml невалидный YAML:', err);
    process.exit(1);
  }

  console.log(`📋 spec.yaml v${(spec.project as any)?.version ?? '?'} загружен\n`);

  checkMeta(spec);
  checkStructure(spec);
  checkEnv(spec);
  checkTelegram(spec);
  checkApi(spec);
  checkPipeline(spec);
  checkAgentPipeline(spec);
  checkSecurity(spec);
  checkBilling(spec);
  checkWebSocket(spec);

  console.log('─'.repeat(70));
  console.log();

  const grouped = new Map<string, CheckResult[]>();
  for (const r of results) {
    if (!grouped.has(r.category)) grouped.set(r.category, []);
    grouped.get(r.category)!.push(r);
  }

  let totalPass = 0;
  let totalFail = 0;
  let totalWarn = 0;

  for (const [category, checks] of grouped) {
    console.log(`\n📦 ${category.toUpperCase()}`);
    for (const c of checks) {
      const icon = c.status === 'pass' ? '  ✅' : c.status === 'fail' ? '  ❌' : '  ⚠️';
      const detail = c.detail ? ` — ${c.detail}` : '';
      console.log(`${icon} ${c.check}${detail}`);
      if (c.status === 'pass') totalPass++;
      else if (c.status === 'fail') totalFail++;
      else totalWarn++;
    }
  }

  const total = totalPass + totalFail + totalWarn;
  const pct = total > 0 ? Math.round((totalPass / total) * 100) : 0;

  console.log('\n' + '═'.repeat(70));
  console.log(`\n📊 Результат: ${totalPass}/${total} проверок пройдено (${pct}%)`);
  console.log(`   ✅ Pass: ${totalPass}  ❌ Fail: ${totalFail}  ⚠️ Warn: ${totalWarn}`);

  if (totalFail > 0) {
    console.log('\n🔴 Есть расхождения между spec.yaml и кодом!');
    console.log('   Обнови spec.yaml или реализуй недостающий код.\n');
    process.exit(1);
  } else if (totalWarn > 0) {
    console.log('\n🟡 Все проверки пройдены, но есть предупреждения.\n');
    process.exit(0);
  } else {
    console.log('\n🟢 spec.yaml полностью соответствует коду!\n');
    process.exit(0);
  }
}

main();
