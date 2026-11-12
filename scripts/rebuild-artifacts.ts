/**
 * Аудит и пересборка артефактов `.osvbc.json` относительно текущего компилятора.
 *
 * Повод: на момент аудита 22 из 24 коммитнутых артефактов разошлись со свежей
 * сборкой — они были сгенерированы до появления поля `pure` в процедурах. Тесты
 * грузили устаревший байткод и проверяли не то, что производит компилятор.
 *
 * Сериализация та же, что у `osnova compile`: `JSON.stringify(module, null, 2)`.
 * Артефакты без парного `.osnova` (рукописные фикстуры) пропускаются: их
 * источник — не компилятор.
 *
 * Использование:
 *   npx tsx scripts/rebuild-artifacts.ts          # только проверка (exit 1 при дрейфе)
 *   npx tsx scripts/rebuild-artifacts.ts --write  # перезаписать устаревшие
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { compileSource } from '../src/compiler/compiler';

const ROOT = path.resolve(__dirname, '..');
const WRITE = process.argv.includes('--write');

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.osvbc.json')) out.push(p);
  }
  return out;
}

function main(): void {
  const artifacts = walk(path.join(ROOT, 'src')).sort();
  let actual = 0;
  let stale = 0;
  let noSource = 0;
  const staleList: string[] = [];

  for (const art of artifacts) {
    const srcPath = art.replace(/\.osvbc\.json$/, '.osnova');
    const rel = path.relative(ROOT, art);
    if (!fs.existsSync(srcPath)) {
      noSource++;
      continue;
    }
    const compiled = compileSource(fs.readFileSync(srcPath, 'utf-8'));
    if (!compiled.module) {
      const errors = [
        ...compiled.lexerErrors,
        ...compiled.parserErrors,
        ...compiled.compilerErrors,
      ]
        .map((e) => e.message)
        .join('; ');
      console.error(`  ОШИБКА  ${rel}: не компилируется — ${errors}`);
      staleList.push(rel);
      stale++;
      continue;
    }
    const fresh = JSON.stringify(compiled.module, null, 2);
    if (sha256(fresh) === sha256(fs.readFileSync(art, 'utf-8'))) {
      actual++;
      continue;
    }
    stale++;
    staleList.push(rel);
    if (WRITE) {
      fs.writeFileSync(art, fresh, 'utf-8');
      console.log(`  обновлён ${rel}`);
    } else {
      console.log(`  ДРЕЙФ    ${rel}`);
    }
  }

  console.log(
    `\n${WRITE ? 'ПЕРЕСБОРКА' : 'АУДИТ'}: актуальных ${actual} | дрейф ${stale} | без .osnova ${noSource}`,
  );

  if (stale > 0 && !WRITE) {
    console.error(
      `\n${stale} артефакт(ов) устарели. Пересобрать: npx tsx scripts/rebuild-artifacts.ts --write`,
    );
    process.exit(1);
  }
}

main();
