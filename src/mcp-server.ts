import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
import { run_patch_agent } from './patch-agent/index.js';

function collectTopErrors(traces: any[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of traces) {
    const br = t.buildReport;
    if (!br) continue;
    const allErrors = [
      ...(br.lexerErrors ?? []),
      ...(br.parserErrors ?? []),
      ...(br.compilerErrors ?? []),
      ...(br.semanticErrors ?? []),
    ];
    for (const e of allErrors) {
      const key = (e.message as string)
        .replace(/'[^']+'/g, "'X'")
        .replace(/\d+/g, 'N')
        .slice(0, 80);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function buildModelStats(traces: any[]): Map<string, { total: number; success: number; repairs: number }> {
  const byModel = new Map<string, { total: number; success: number; repairs: number }>();
  for (const t of traces) {
    const model = t.modelId ?? 'unknown';
    const cur = byModel.get(model) ?? { total: 0, success: 0, repairs: 0 };
    cur.total++;
    if (t.status === 'success') cur.success++;
    cur.repairs += t.repairAttempts ?? 0;
    byModel.set(model, cur);
  }
  return byModel;
}

function filterAndTransform(records: any[], minQuality = 0, minRepairs = -1): any[] {
  return records.filter(rec => {
    if (rec.status !== 'success') return false;
    const src = rec.source?.source?.trim();
    if (!src) return false;
    if (rec.buildReport?.success !== true) return false;
    if ((rec.goldenReport?.qualityScore ?? 0) < minQuality) return false;
    if (minRepairs >= 0 && (rec.repairAttempts ?? 0) < minRepairs) return false;
    return true;
  });
}

const server = new Server(
  { name: 'osnova-mcp-server', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'run_patch_agent',
      description: 'Запускает patch-agent: генерирует diff через Qwen и применяет его через git apply',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          allowed_paths: { type: 'array', items: { type: 'string' } },
          context_files: { type: 'array', items: { type: 'string' } },
          must_run_before_commit: { type: 'array', items: { type: 'string' } },
          blast_radius: { type: 'number' },
        },
        required: ['task', 'allowed_paths'],
      },
    },
    {
      name: 'analyze_trace_health',
      description: 'Анализирует runs/traces.jsonl: статистика по статусам, топ ошибок, success rate по моделям',
      inputSchema: {
        type: 'object',
        properties: {
          traces_path: { type: 'string', default: 'runs/traces.jsonl' },
          top_errors: { type: 'number', default: 10 },
        },
      },
    },
    {
      name: 'analyze_dataset_health',
      description: 'Анализирует качество датасета из traces: фильтр по minQuality и minRepairs',
      inputSchema: {
        type: 'object',
        properties: {
          traces_path: { type: 'string', default: 'runs/traces.jsonl' },
          min_quality: { type: 'number', default: 0 },
          min_repairs: { type: 'number', default: -1 },
        },
      },
    },
    {
      name: 'run_golden_case',
      description: 'Запускает golden-runner для конкретного .osnova файла и возвращает результат',
      inputSchema: {
        type: 'object',
        properties: {
          fixture_path: { type: 'string' },
        },
        required: ['fixture_path'],
      },
    },
    {
      name: 'read_repo',
      description: 'Читает структуру и содержимое файлов репозитория',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', default: 'src' },
          extensions: { type: 'array', items: { type: 'string' }, default: ['.ts'] },
          max_files: { type: 'number', default: 20 },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: rawArgs } = req.params;
  const args = rawArgs ?? ({} as Record<string, unknown>);

  if (name === 'run_patch_agent') {
    const result = await run_patch_agent({
      task: args.task as string,
      allowed_paths: (args.allowed_paths as string[]) ?? [],
      forbidden_paths: [],
      context_files: (args.context_files as string[]) ?? [],
      acceptance_criteria: [],
      max_files_changed: (args.blast_radius as number) ?? 5,
      must_run_before_commit: (args.must_run_before_commit as string[]) ?? [],
    });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  if (name === 'analyze_trace_health') {
    const tracesPath = path.resolve((args?.traces_path as string) ?? 'runs/traces.jsonl');
    if (!fs.existsSync(tracesPath)) {
      return { content: [{ type: 'text', text: `Файл не найден: ${tracesPath}` }] };
    }
    const traces = fs.readFileSync(tracesPath, 'utf-8')
      .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    const byStatus: Record<string, number> = {};
    for (const t of traces) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    const errors = collectTopErrors(traces);
    const topN = (args?.top_errors as number) ?? 10;
    const topErrors = [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
    const models = buildModelStats(traces);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ total: traces.length, byStatus, topErrors, models: Object.fromEntries(models) }, null, 2),
      }],
    };
  }

  if (name === 'analyze_dataset_health') {
    const tracesPath = path.resolve((args?.traces_path as string) ?? 'runs/traces.jsonl');
    if (!fs.existsSync(tracesPath)) {
      return { content: [{ type: 'text', text: `Файл не найден: ${tracesPath}` }] };
    }
    const records = fs.readFileSync(tracesPath, 'utf-8')
      .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    const examples = filterAndTransform(records, (args?.min_quality as number) ?? 0, (args?.min_repairs as number) ?? -1);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ total_records: records.length, filtered_examples: examples.length, sample: examples.slice(0, 2) }, null, 2),
      }],
    };
  }

  if (name === 'run_golden_case') {
    const fixturePath = path.resolve((args.fixture_path as string) ?? '');
    if (!fs.existsSync(fixturePath)) {
      return { content: [{ type: 'text', text: `Fixture не найден: ${fixturePath}` }] };
    }
    const { execSync } = await import('child_process');
    try {
      const out = execSync(`npx tsx src/compiler/golden-runner.test.ts ${fixturePath}`, { encoding: 'utf-8', timeout: 30000 });
      return { content: [{ type: 'text', text: out }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: e.message }] };
    }
  }

  if (name === 'read_repo') {
    const base = path.resolve((args?.path as string) ?? 'src');
    const exts = (args?.extensions as string[]) ?? ['.ts'];
    const maxFiles = (args?.max_files as number) ?? 20;
    const results: Record<string, string> = {};
    function walk(dir: string) {
      if (Object.keys(results).length >= maxFiles) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !['node_modules', 'dist', 'generated'].includes(entry.name)) {
          walk(path.join(dir, entry.name));
        } else if (entry.isFile() && exts.some(e => entry.name.endsWith(e))) {
          if (Object.keys(results).length < maxFiles) {
            results[path.join(dir, entry.name)] = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
          }
        }
      }
    }
    walk(base);
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.resume(); // держим процесс живым
}

main().catch(console.error);
