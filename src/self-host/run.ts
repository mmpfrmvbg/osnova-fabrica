// Запуск байткода Основа на встроенном VM (без упрощённого invoke-хендлера),
// чтобы были доступны система.объект.* и прочие встроенные syscall.
// Использование: npx tsx src/self-host/run.ts <файл.osvbc.json>

import * as fs from 'fs';
import { VM } from '../runtime/vm/interpreter';
import type { OsVbcModule } from '../runtime/vm/bytecode';

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error('Использование: npx tsx src/self-host/run.ts <файл.osvbc.json>');
    process.exit(1);
  }
  const raw = fs.readFileSync(file, 'utf-8');
  const mod = JSON.parse(raw) as OsVbcModule;
  const vm = new VM(mod, { maxSteps: 1_000_000 });
  const idx = vm.findProcedureIndex('главная');
  const result = await vm.runProcedure(idx, []);
  if (result !== null && result !== undefined) console.log(result);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
