// src/intelligence/prefilter.ts
// Keyword-фильтр: 0 LLM-запросов.
// Отсекает нерелевантные сигналы до summarizer.

export interface RawItem {
  title: string;
  url: string;
  date?: string;
  snippet?: string;
}

// Ключевые слова релевантные для ОС-НОВА
const POSITIVE_KEYWORDS = [
  'DSL',
  'language design',
  'code generation',
  'codegen',
  'compiler',
  'bytecode',
  'virtual machine',
  'LLM',
  'program synthesis',
  'prompt',
  'fine-tun',
  'SaaS',
  'POS',
  'низкокод',
  'генерация кода',
  'кодогенерац',
  'язык программирования',
  'компилятор',
];

const NEGATIVE_KEYWORDS = [
  'javascript framework',
  'CSS',
  'game engine',
  'blockchain',
  'crypto',
  'NFT',
  'hiring',
  'internship',
  'стажировк',
];

function normalize(text: string): string {
  return text.toLowerCase();
}

export function passesPrefilter(item: RawItem): boolean {
  const text = normalize(`${item.title} ${item.snippet ?? ''}`);
  const hasPositive = POSITIVE_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()));
  const hasNegative = NEGATIVE_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()));
  return hasPositive && !hasNegative;
}

export function prefilterItems(items: RawItem[]): RawItem[] {
  return items.filter(passesPrefilter);
}
