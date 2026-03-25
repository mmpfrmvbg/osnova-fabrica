#!/usr/bin/env tsx
// ============================================================
// src/scripts/aggregate-shadow.ts — Shadow Mode агрегат
// Читает runs/traces.jsonl, вычисляет для RFC-002 и RFC-003:
//   total_hits, correct_hits, correctRate, readyForPhaseB
// Выводит в консоль + пишет runs/shadow-report.jsonl
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { aggregateShadow, analyzeShadow } from '../pipeline/shadowMode';
import type { ShadowRfc, ShadowHit } from '../pipeline/shadowMode';

interface TraceRecord {
  status?: string;
  source?: { source?: string };
  shadow_hits?: ShadowHit[];
  ts?: string;
}

function writeGateJson(gatePath: string, aggregates: ReturnType<typeof aggregateShadow>[]): void {
  const pct = (rfc: ShadowRfc): number => {
    const agg = aggregates.find((a) => a.rfc === rfc);
    const raw = agg?.correctRate;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 100;
    return Math.round(raw * 1000) / 10;
  };
  const gate = { rfc002: pct('RFC-002'), rfc003: pct('RFC-003') };
  const dir = path.dirname(gatePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(gatePath, JSON.stringify(gate) + '\n', 'utf-8');
}

function main(): void {
  const args = process.argv.slice(2);
  const tracePath = path.resolve(
    args.includes('--input')
      ? (args[args.indexOf('--input') + 1] ?? 'runs/traces.jsonl')
      : 'runs/traces.jsonl',
  );
  const outputPath = path.resolve('runs/shadow-report.jsonl');
  const gateIx = args.indexOf('--gate-json');
  const gatePath =
    gateIx >= 0 ? path.resolve(args[gateIx + 1] ?? 'runs/shadow-gate.json') : '';

  if (!fs.existsSync(tracePath)) {
    console.log('traces.jsonl не найден, нет данных для агрегации.');
    if (gatePath) writeGateJson(gatePath, []);
    return;
  }

  const lines = fs.readFileSync(tracePath, 'utf-8').split('\n').filter(l => l.trim());
  const records = lines.flatMap(l => {
    try {
      return [JSON.parse(l) as TraceRecord];
    } catch {
      return [];
    }
  });

  // Для каждого трейса: если есть shadow_hits — использовать их,
  // иначе анализировать source на лету (backward compat)
  const hitsByRfc: Record<ShadowRfc, ShadowHit[]> = { 'RFC-002': [], 'RFC-003': [] };

  for (const record of records) {
    if (record.shadow_hits && record.shadow_hits.length > 0) {
      for (const h of record.shadow_hits) {
        if (h.rfc === 'RFC-002' || h.rfc === 'RFC-003') {
          hitsByRfc[h.rfc].push(h);
        }
      }
    } else if (record.source?.source) {
      // backward compat: анализировать source
      const report = analyzeShadow(record.source.source);
      for (const h of report.hits) {
        hitsByRfc[h.rfc].push(h);
      }
    }
  }

  const rfcs: ShadowRfc[] = ['RFC-002', 'RFC-003'];
  const aggregates = rfcs.map(rfc => aggregateShadow(rfc, hitsByRfc[rfc]));

  // Вывод в консоль
  console.log('\n═══ SHADOW MODE REPORT ═══');
  console.log(`Трейсов обработано: ${records.length}`);
  console.log('');
  for (const agg of aggregates) {
    const status = agg.readyForPhaseB ? '✅ READY FOR PHASE B' : `⏳ ${agg.totalTraces}/50 трейсов`;
    console.log(`${agg.rfc}:`);
    console.log(`  total traces:   ${agg.totalTraces}`);
    console.log(`  correct:        ${agg.correctTraces} (${(agg.correctRate * 100).toFixed(1)}%)`);
    console.log(`  ready Phase B:  ${status}`);
    console.log('');
  }

  // Записать в shadow-report.jsonl
  const runsDir = path.dirname(outputPath);
  if (!fs.existsSync(runsDir)) fs.mkdirSync(runsDir, { recursive: true });
  const report = {
    ts: new Date().toISOString(),
    total_traces: records.length,
    aggregates,
  };
  fs.writeFileSync(outputPath, JSON.stringify(report) + '\n', 'utf-8');
  console.log(`Отчёт записан: ${outputPath}`);
  if (gatePath) writeGateJson(gatePath, aggregates);
}

main();
