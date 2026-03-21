// src/intelligence/sources/rss-generic.ts
// Минимальный RSS-парсер без внешних зависимостей.
// Парсит <item> теги из RSS 2.0 / Atom-подобных фидов.

import * as https from 'https';
import * as http from 'http';
import type { RawItem } from '../prefilter';

// ── HTTP fetch (поддержка http + https) ───────────────────

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(
      url,
      { headers: { 'User-Agent': 'osnova-fabrica/0.1 (rss-collector)' } },
      (res) => {
        if (
          (res.statusCode === 301 || res.statusCode === 302) &&
          res.headers.location
        ) {
          res.resume();
          const next = new URL(res.headers.location, url).href;
          fetchUrl(next).then(resolve).catch(reject);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('timeout')));
  });
}

// ── XML-парсинг (без зависимостей) ───────────────────────

/** Извлекает содержимое тега, поддерживает CDATA. */
function extractTag(xml: string, tag: string): string {
  const cdataRe = new RegExp(
    `<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`,
    'i',
  );
  const cdataM = xml.match(cdataRe);
  if (cdataM) return cdataM[1]!.trim();

  const plainRe = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const plainM = xml.match(plainRe);
  if (plainM) return plainM[1]!.replace(/<[^>]+>/g, '').trim();

  return '';
}

export interface RssItem {
  title: string;
  link: string;
  pubDate: string;
  summary: string;
}

/** Парсит RSS XML → массив RssItem. */
export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemPattern = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/g;
  let match: RegExpExecArray | null;

  while ((match = itemPattern.exec(xml)) !== null) {
    const block = match[1]!;
    const title = extractTag(block, 'title');
    const linkTag =
      block.match(/<link[^>]*href="([^"]+)"/) ?? block.match(/<link[^>]*>([\s\S]*?)<\/link>/);
    const link = linkTag?.[1]?.trim() ?? '';
    const pubDate =
      extractTag(block, 'pubDate') ||
      extractTag(block, 'published') ||
      extractTag(block, 'updated');
    const summary =
      extractTag(block, 'description') ||
      extractTag(block, 'summary') ||
      extractTag(block, 'content');

    if (title && link) {
      items.push({ title, link, pubDate, summary: summary.slice(0, 400) });
    }
  }
  return items;
}

/** Загружает RSS по URL и возвращает RawItem[]. */
export async function fetchRssGeneric(feedUrl: string): Promise<RawItem[]> {
  let xml: string;
  try {
    xml = await fetchUrl(feedUrl);
  } catch (e) {
    console.warn(
      `[rss-generic] fetch error (${feedUrl}):`,
      e instanceof Error ? e.message : String(e),
    );
    return [];
  }

  const parsed = parseRss(xml);
  console.log(`[rss-generic] ${feedUrl}: ${parsed.length} items`);

  return parsed.map((item) => ({
    title: item.title,
    url: item.link,
    date: item.pubDate,
    snippet: item.summary.slice(0, 300),
  }));
}
