import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(process.cwd());

// --- Загрузка файлов ---
const gatesRaw = yaml.load(
  fs.readFileSync(path.join(ROOT, 'gates.yaml'), 'utf-8')
) as Record<string, unknown>;

const gateCheckerSrc = fs.readFileSync(
  path.join(ROOT, 'src/pipeline/gateChecker.ts'), 'utf-8'
);

const orchestratorSrc = fs.readFileSync(
  path.join(ROOT, 'src/pipeline/orchestrator.ts'), 'utf-8'
);

const thresholdsSrc = fs.readFileSync(
  path.join(ROOT, 'src/pipeline/thresholds.ts'), 'utf-8'
);

// --- Извлечение значений из YAML ---

// 1. g1_confidence: из condition "intent.confidence >= 0.7"
const gates = (gatesRaw as { gates: Array<{ id: string; checks?: Array<{ id: string; condition: string }> }> }).gates;

const g1Gate = gates.find(g => g.id === 'G1_spec_ready');
const g1ConfidenceCheck = g1Gate?.checks?.find(c => c.id === 'g1_confidence');
const g1ConditionStr = g1ConfidenceCheck?.condition ?? '';
const g1ConfidenceMatch = g1ConditionStr.match(/>=\s*([\d.]+)/);
const g1ConfidenceFromYaml = g1ConfidenceMatch ? parseFloat(g1ConfidenceMatch[1]) : null;

// 2. g2_build_time: из condition "buildReport.durationMs <= 30000"
const g2Gate = gates.find(g => g.id === 'G2_build_pass');
const g2BuildTimeCheck = g2Gate?.checks?.find(c => c.id === 'g2_build_time');
const g2ConditionStr = g2BuildTimeCheck?.condition ?? '';
const g2DurationMatch = g2ConditionStr.match(/<=\s*(\d+)/);
const g2DurationFromYaml = g2DurationMatch ? parseInt(g2DurationMatch[1], 10) : null;

// 3. maxRepairLoopsPerRun
const maxRepairFromYaml = (gatesRaw as { repairConstraints?: { maxRepairLoopsPerRun?: number } })
  .repairConstraints?.maxRepairLoopsPerRun ?? null;

// --- Извлечение значений из кода ---

// 1. QUALITY_PASS из thresholds.ts
const qualityPassMatch = thresholdsSrc.match(/QUALITY_PASS\s*=\s*([\d.]+)/);
const qualityPassFromCode = qualityPassMatch ? parseFloat(qualityPassMatch[1]) : null;

// 2. durationMs порог из gateChecker.ts
const durationMatch = gateCheckerSrc.match(/durationMs\s*>\s*(\d+)/);
const durationFromCode = durationMatch ? parseInt(durationMatch[1], 10) : null;

// 3. MAX_REPAIR_LOOPS из orchestrator.ts
const repairLoopsMatch = orchestratorSrc.match(/MAX_REPAIR_LOOPS\s*=\s*(\d+)/);
const repairLoopsFromCode = repairLoopsMatch ? parseInt(repairLoopsMatch[1], 10) : null;

// --- Сравнение ---

type DriftCheck = {
  name: string;
  yaml: number | null;
  code: number | null;
  yamlSource: string;
  codeSource: string;
};

const checks: DriftCheck[] = [
  {
    name: 'g1_confidence threshold',
    yaml: g1ConfidenceFromYaml,
    code: qualityPassFromCode,
    yamlSource: 'gates.yaml → G1_spec_ready → g1_confidence → condition',
    codeSource: 'src/pipeline/thresholds.ts → QUALITY_PASS',
  },
  {
    name: 'g2_build_time durationMs',
    yaml: g2DurationFromYaml,
    code: durationFromCode,
    yamlSource: 'gates.yaml → G2_build_pass → g2_build_time → condition',
    codeSource: 'src/pipeline/gateChecker.ts → durationMs >',
  },
  {
    name: 'maxRepairLoops',
    yaml: maxRepairFromYaml,
    code: repairLoopsFromCode,
    yamlSource: 'gates.yaml → repairConstraints.maxRepairLoopsPerRun',
    codeSource: 'src/pipeline/orchestrator.ts → MAX_REPAIR_LOOPS',
  },
];

let driftFound = false;

console.log('\n=== YAML drift check ===\n');

for (const check of checks) {
  if (check.yaml === null || check.code === null) {
    console.error(`[ERROR] Cannot extract value for: ${check.name}`);
    console.error(`  YAML source: ${check.yamlSource} → got: ${check.yaml}`);
    console.error(`  Code source: ${check.codeSource} → got: ${check.code}`);
    driftFound = true;
    continue;
  }
  if (check.yaml !== check.code) {
    console.error(`[DRIFT] ${check.name}`);
    console.error(`  YAML:  ${check.yaml}  (${check.yamlSource})`);
    console.error(`  CODE:  ${check.code}  (${check.codeSource})`);
    driftFound = true;
  } else {
    console.log(`[OK] ${check.name}: ${check.yaml}`);
  }
}

console.log('');

if (driftFound) {
  console.error('YAML drift detected. Update YAML or code to match.\n');
  process.exit(1);
} else {
  console.log('All values in sync.\n');
  process.exit(0);
}
