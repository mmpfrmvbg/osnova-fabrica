import { describe, it, expect } from 'vitest';
import { parseRss } from './rss-generic';

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>Статья о языках программирования</title>
      <link>https://habr.com/ru/articles/123456/</link>
      <pubDate>Sat, 21 Mar 2026 10:00:00 +0000</pubDate>
      <description>Обзор современных DSL и инструментов компиляции</description>
    </item>
    <item>
      <title><![CDATA[Компиляторы и LLM: новый подход]]></title>
      <link>https://habr.com/ru/articles/789012/</link>
      <pubDate>Sat, 21 Mar 2026 11:00:00 +0000</pubDate>
      <description><![CDATA[Статья про генерацию кода с помощью LLM]]></description>
    </item>
  </channel>
</rss>`;

const ATOM_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Test Feed</title>
  <entry>
    <title>Atom статья про DSL</title>
    <link href="https://example.com/atom/dsl-article"/>
    <published>2026-03-21T09:00:00Z</published>
    <summary>Описание DSL-инструментов в Atom-формате</summary>
  </entry>
</feed>`;

describe('parseRss — RSS 2.0', () => {
  it('парсит 2 обычных item', () => {
    const items = parseRss(RSS_SAMPLE);
    expect(items).toHaveLength(2);
  });

  it('первый item: корректный title и link', () => {
    const items = parseRss(RSS_SAMPLE);
    expect(items[0]!.title).toBe('Статья о языках программирования');
    expect(items[0]!.link).toBe('https://habr.com/ru/articles/123456/');
  });

  it('второй item: CDATA title и CDATA description', () => {
    const items = parseRss(RSS_SAMPLE);
    expect(items[1]!.title).toBe('Компиляторы и LLM: новый подход');
    expect(items[1]!.summary).toContain('LLM');
  });

  it('pubDate присутствует', () => {
    const items = parseRss(RSS_SAMPLE);
    expect(items[0]!.pubDate).toContain('2026');
  });
});

describe('parseRss — Atom', () => {
  it('парсит Atom entry с link href', () => {
    const items = parseRss(ATOM_SAMPLE);
    expect(items).toHaveLength(1);
    expect(items[0]!.link).toBe('https://example.com/atom/dsl-article');
    expect(items[0]!.title).toBe('Atom статья про DSL');
  });
});
