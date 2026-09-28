/**
 * ПРОВЕРКА ТЕКСТА §3.44 ДО ВСТАВКИ В ДОКУМЕНТ: теми же функциями, что у сторожа ссылок.
 *
 * Зачем: `docs/hardware-debt.md` — документ линии e2k, и сторож `src/scripts/e2kDocRefs.audit.test.ts`
 * запрещает в нём ссылки «файл:строка» и требует, чтобы каждая именованная ссылка `путь#СИМВОЛ`
 * указывала на существующую цель. Тексты правок ссылаются на файлы, которых ЕЩЁ НЕТ
 * (`windowGeometry.ts`) — их можно называть только без `#СИМВОЛ`. Эта проба ловит и то, и другое
 * до того, как документ станет красным.
 *
 * Запуск: npx tsx .tmp/osnova-task11-docrefs-check.ts <путь к черновику>
 */
import * as fs from 'fs';
import * as path from 'path';
import { collectCodeRefs, findBareLineRefs, findRawLineRefs, verifyCodeRefs } from '../src/scripts/e2kCodeRefs';

const target = process.argv[2] ?? '.tmp/osnova-task11-3.44-draft.md';
const text = fs.readFileSync(path.resolve(process.cwd(), target), 'utf-8');
const docName = 'docs/hardware-debt.md';

const raw = findRawLineRefs(text);
const bare = findBareLineRefs(text);
const refs = collectCodeRefs(text);
const refProblems = verifyCodeRefs(refs);

console.log(`# проверяемый текст: ${target} (${text.split('\n').length} строк)`);
console.log(`# гниющих номеров строк «путь:номер»: ${raw.length}${raw.length === 0 ? '' : ` — ${raw.join(', ')}`}`);
console.log(`# голых номеров строк «имя:номер»:   ${bare.length}${bare.length === 0 ? '' : ` — ${bare.join(', ')}`}`);
console.log(`# именованных ссылок «путь#СИМВОЛ»:  ${refs.length}`);
for (const ref of refs) console.log(`   ${ref.raw} → ${ref.file}#${ref.symbol}`);
console.log(`# неразрешённых целей: ${refProblems.length}${refProblems.length === 0 ? '' : `\n   ${refProblems.join('\n   ')}`}`);

const problems = [
  ...raw.map((item) => `гниющий номер строки: ${item}`),
  ...bare.map((item) => `голый номер строки: ${item}`),
  ...refProblems,
];
if (problems.length === 0) {
  console.log(`# текст ${docName} не сломает сторож ссылок: чисто`);
  process.exit(0);
}
console.log('# НАЙДЕНО (документ стал бы красным):');
for (const problem of problems) console.log(`  - ${problem}`);
process.exit(1);
