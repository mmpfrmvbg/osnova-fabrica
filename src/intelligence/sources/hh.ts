#!/usr/bin/env tsx
// ============================================================
// src/intelligence/sources/hh.ts — CVT-0: Competitor Velocity Tracker
// Snapshot hh.ru API по ключевым словам конкурентов.
// Результат append в runs/competitor-snapshots.jsonl
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

const SEARCH_QUERY = '1С OR POS OR кассовое ПО OR DSL OR генерация кода';
const HH_API_URL = 'https://api.hh.ru/vacancies';
const SNAPSHOT_FILE = path.resolve('runs/competitor-snapshots.jsonl');

export interface CompetitorSnapshot {
  ts: string; // ISO timestamp
  vacancy_count: number; // общее число вакансий по запросу
  new_skills: string[]; // ключевые навыки из top-20 вакансий
  raw_snapshot: {
    query: string;
    found: number;
    items_preview: Array<{ id: string; name: string; employer?: string }>;
  };
}

/**
 * Делает HTTPS GET запрос, возвращает строку ответа.
 */
export function httpsGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'osnova-fabrica/0.1 (competitor-velocity-tracker)',
          'HH-User-Agent': 'osnova-fabrica/0.1 (8757272@gmail.com)',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error('hh.ru API timeout (10s)'));
    });
  });
}

/**
 * Извлекает уникальные навыки из списка вакансий hh API.
 * Берёт поле key_skills если есть, иначе парсит из name.
 */
export function extractSkills(items: Array<Record<string, unknown>>): string[] {
  const skills = new Set<string>();
  for (const item of items) {
    // hh API /vacancies не возвращает key_skills в списке,
    // но возвращает snippet.requirement
    const req = (item as { snippet?: { requirement?: string } }).snippet?.requirement;
    if (typeof req === 'string') {
      // Грубый парсинг: слова длиннее 4 букв с заглавной
      const words = req.match(/[А-ЯA-Z][а-яa-z]{3,}/g) ?? [];
      for (const w of words) skills.add(w);
    }
    // Берём название вакансии как сигнал
    if (typeof item.name === 'string') {
      skills.add(item.name.slice(0, 40));
    }
  }
  return Array.from(skills).slice(0, 30); // не более 30
}

/**
 * Основная функция: делает запрос к hh.ru API и формирует snapshot.
 */
export async function fetchHHSnapshot(): Promise<CompetitorSnapshot> {
  const params = new URLSearchParams({
    text: SEARCH_QUERY,
    area: '1', // Москва (крупнейший рынок)
    per_page: '20',
    page: '0',
    search_field: 'name',
  });

  const url = `${HH_API_URL}?${params.toString()}`;
  const raw = await httpsGet(url);

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`hh.ru API вернул невалидный JSON: ${raw.slice(0, 200)}`);
  }

  const found = typeof data.found === 'number' ? data.found : 0;
  const items = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : [];

  const snapshot: CompetitorSnapshot = {
    ts: new Date().toISOString(),
    vacancy_count: found,
    new_skills: extractSkills(items),
    raw_snapshot: {
      query: SEARCH_QUERY,
      found,
      items_preview: items.slice(0, 5).map((i) => ({
        id: String(i.id ?? ''),
        name: String(i.name ?? ''),
        employer:
          typeof i.employer === 'object' && i.employer !== null
            ? String((i.employer as { name?: string }).name ?? '')
            : undefined,
      })),
    },
  };

  return snapshot;
}

/**
 * Appends snapshot to runs/competitor-snapshots.jsonl
 */
export function appendSnapshot(snapshot: CompetitorSnapshot, outPath = SNAPSHOT_FILE): void {
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(outPath, JSON.stringify(snapshot) + '\n', 'utf-8');
}

async function main(): Promise<void> {
  console.log('CVT-0: fetching hh.ru snapshot…');
  try {
    const snapshot = await fetchHHSnapshot();
    appendSnapshot(snapshot);
    console.log(`✅ vacancy_count: ${snapshot.vacancy_count}`);
    console.log(`   new_skills (${snapshot.new_skills.length}): ${snapshot.new_skills.slice(0, 5).join(', ')}…`);
    console.log(`   saved → ${SNAPSHOT_FILE}`);
  } catch (err) {
    console.error('❌ CVT-0 error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
