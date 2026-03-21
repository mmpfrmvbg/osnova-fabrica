// src/intelligence/collector.ts
// Обходит источники, применяет prefilter, вызывает summarizer,
// сохраняет сигналы через store.upsertSignal.
//
// Реализованы: arxiv, github-releases
// Заглушки с TODO: rss-generic, huggingface

import * as https from 'https';
import * as crypto from 'crypto';
import { passesPrefilter, type RawItem } from './prefilter';
import { summarizeItem } from './summarizer';
import { upsertSignal, type IntelligenceSignal } from './store';

// ── HTTP хелпер (переиспользуем паттерн из hh.ts) ────────

function httpsGet(url: string, extraHeaders?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'User-Agent': 'osnova-fabrica/0.1 (intelligence-collector)',
      ...extraHeaders,
    };
    const req = https.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('timeout')));
  });
}

// ── ID генерация ──────────────────────────────────────────

function makeId(source: string, title: string): string {
  return crypto.createHash('sha256').update(`${source}:${title}`).digest('hex').slice(0, 16);
}

// ── Источник: arxiv ───────────────────────────────────────

async function fetchArxiv(): Promise<RawItem[]> {
  const query = encodeURIComponent(
    '(ti:DSL OR ti:code+generation OR ti:program+synthesis OR ti:LLM+compiler) AND cat:cs.PL',
  );
  const url = `https://export.arxiv.org/api/query?search_query=${query}&max_results=20&sortBy=submittedDate&sortOrder=descending`;

  let xml: string;
  try {
    xml = await httpsGet(url);
  } catch (e) {
    console.warn('[collector:arxiv] fetch error:', e instanceof Error ? e.message : String(e));
    return [];
  }

  const items: RawItem[] = [];
  // Минимальный XML-парсинг без зависимостей
  const entries = xml.match(/<entry>([\s\S]*?)<\/entry>/g) ?? [];
  for (const entry of entries) {
    const titleM = entry.match(/<title>([\s\S]*?)<\/title>/);
    const title = (titleM?.[1] ?? '').replace(/\s+/g, ' ').trim();
    const idM = entry.match(/<id>([\s\S]*?)<\/id>/);
    const url_ = (idM?.[1] ?? '').trim();
    const dateM = entry.match(/<published>(.*?)<\/published>/);
    const date = (dateM?.[1] ?? '').trim();
    const summaryM = entry.match(/<summary>([\s\S]*?)<\/summary>/);
    const summary = (summaryM?.[1] ?? '').replace(/\s+/g, ' ').trim();
    if (title && url_) {
      items.push({ title, url: url_, date, snippet: summary.slice(0, 300) });
    }
  }
  return items;
}

// ── Источник: github-releases ─────────────────────────────

interface GhRelease {
  tag_name: string;
  name: string;
  html_url: string;
  published_at: string;
  body?: string;
}

// Репозитории за которыми следим
const GITHUB_REPOS = [
  'tree-sitter/tree-sitter',
  'nickel-lang/nickel',
  'gleam-lang/gleam',
  'microsoft/TypeSpec',
  'dafny-lang/dafny',
];

async function fetchGithubReleases(): Promise<RawItem[]> {
  const token = process.env.GITHUB_TOKEN ?? '';
  const items: RawItem[] = [];

  for (const repo of GITHUB_REPOS) {
    const url = `https://api.github.com/repos/${repo}/releases/latest`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
      const raw = await httpsGet(url, headers);
      const data = JSON.parse(raw) as GhRelease;
      if (data.tag_name) {
        items.push({
          title: `${repo} ${data.tag_name}: ${data.name ?? ''}`.trim(),
          url: data.html_url,
          date: data.published_at,
          snippet: (data.body ?? '').slice(0, 300),
        });
      }
    } catch (e) {
      console.warn(`[collector:github] ${repo}:`, e instanceof Error ? e.message : String(e));
    }
  }
  return items;
}

// ── Заглушки ──────────────────────────────────────────────

async function fetchRss(_feedUrl: string): Promise<RawItem[]> {
  // TODO: реализовать RSS-парсер
  console.log('[collector:rss] TODO — не реализован');
  return [];
}

async function fetchHuggingface(): Promise<RawItem[]> {
  // TODO: huggingface papers API
  console.log('[collector:huggingface] TODO — не реализован');
  return [];
}

// ── Основная функция ──────────────────────────────────────

export interface CollectorOptions {
  skipSummarize?: boolean; // пропустить LLM, только prefilter
  minRelevance?: number; // порог релевантности (default 0.5)
  dryRun?: boolean; // не писать в store
}

export async function runCollector(opts: CollectorOptions = {}): Promise<IntelligenceSignal[]> {
  const minRelevance = opts.minRelevance ?? 0.5;
  const results: IntelligenceSignal[] = [];

  // Источники в порядке приоритета
  const sources: Array<{ name: string; fetch: () => Promise<RawItem[]> }> = [
    { name: 'arxiv', fetch: fetchArxiv },
    { name: 'github-releases', fetch: fetchGithubReleases },
    { name: 'rss-generic', fetch: () => fetchRss('') },
    { name: 'huggingface', fetch: fetchHuggingface },
  ];

  for (const src of sources) {
    console.log(`[collector] Источник: ${src.name}…`);
    let items: RawItem[];
    try {
      items = await src.fetch();
    } catch (e) {
      console.warn(`[collector] ошибка источника ${src.name}:`, e instanceof Error ? e.message : String(e));
      continue;
    }

    // Prefilter (0 LLM)
    const filtered = items.filter(passesPrefilter);
    console.log(`[collector]   raw: ${items.length}, после prefilter: ${filtered.length}`);

    for (const item of filtered) {
      let summary = '';
      let relevance_score = 0.5;

      if (!opts.skipSummarize) {
        const result = await summarizeItem(item);
        summary = result.summary;
        relevance_score = result.relevance_score;
      }

      if (relevance_score < minRelevance && !opts.skipSummarize) {
        console.log(`[collector]   skip (relevance ${relevance_score.toFixed(2)}): ${item.title.slice(0, 50)}`);
        continue;
      }

      const signal: IntelligenceSignal = {
        id: makeId(src.name, item.title),
        source: src.name,
        title: item.title,
        url: item.url,
        raw_date: item.date ?? '',
        fetched_at: new Date().toISOString(),
        summary,
        relevance_score,
        status: 'new',
        tags: [],
      };

      results.push(signal);
      if (!opts.dryRun) {
        upsertSignal(signal);
      }
      console.log(`[collector]   ✓ [${relevance_score.toFixed(2)}] ${item.title.slice(0, 60)}`);
    }
  }

  console.log(`\n[collector] Итого сигналов: ${results.length}`);
  return results;
}

// ── CLI ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const skipSummarize = args.includes('--no-summarize');
  const dryRun = args.includes('--dry-run');

  console.log('[intelligence-collect] Старт...');
  await runCollector({ skipSummarize, dryRun });
}

if (require.main === module) {
  void main();
}
