import { join } from 'node:path';
import type { LLMProvider } from '../../domain/llm';
import { logger } from '../../infrastructure/logger';
import { runInterviewToCompletion } from '../../application/runInterviewPipeline';
import type { AppSpec } from '../../spec/schema';
import { buildOsnovaPrompt, buildOsnovaRepairPrompt } from './buildOsnovaPrompt';
import { compileSource } from '../osnova-compiler/compiler';
import {
  createTraceRecord,
  TraceWriter,
} from '../../domain/osnova/tracing';
import { LANGUAGE_VERSION } from '../osnova-compiler/language-registry';

function specToOsnovaDescription(spec: AppSpec): string {
  const parts = [
    `Приложение: ${spec.meta.name}, тип: ${spec.meta.type}.`,
  ];
  if (spec.modules?.length) {
    parts.push('Модули: ' + spec.modules.map((m) => m.name).join(', ') + '.');
  }
  const anySpec = spec as { scenes?: { name: string }[]; screens?: { name: string }[]; windows?: { name: string }[] };
  if (anySpec.scenes?.length) {
    parts.push('Сцены: ' + anySpec.scenes.map((s) => s.name).join(', ') + '.');
  }
  if (anySpec.screens?.length) {
    parts.push('Экраны: ' + anySpec.screens.map((s) => s.name).join(', ') + '.');
  }
  if (anySpec.windows?.length) {
    parts.push('Окна: ' + anySpec.windows.map((w) => w.name ?? w).join(', ') + '.');
  }
  if (spec.auth) {
    parts.push(`Аутентификация: ${spec.auth.provider}.`);
  } else {
    parts.push('Аутентификация: нет.');
  }
  return parts.join(' ');
}

const FABRICA_VERSION = 'dev';
const MAX_REPAIR_ATTEMPTS = 3;

function makeLLMClient(
  provider: LLMProvider,
  model: string,
  signal?: AbortSignal,
) {
  return {
    complete: async (prompt: string, opts?: { maxTokens?: number }): Promise<string> => {
      const res = await provider.complete({
        model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: opts?.maxTokens,
        ...(signal != null && { signal }),
      });
      return res.content;
    },
  };
}

function formatCompileErrors(compileResult: {
  lexErrors: { line: number; column: number; message: string }[];
  parseErrors: { message: string }[];
}): string[] {
  return [
    ...compileResult.lexErrors.map(
      (e) => `lex ${e.line}:${e.column}: ${e.message}`,
    ),
    ...compileResult.parseErrors.map((e) => `parse: ${e.message}`),
  ];
}

export interface RunPipelineResult {
  appId: string;
  success: boolean;
  source: string;
  errors: string[];
}

export async function runPipeline(
  text: string,
  provider: LLMProvider,
  model: string,
  workdir: string,
  signal?: AbortSignal,
): Promise<RunPipelineResult> {
  const log = logger.child({ module: 'pipeline-llm' });
  const llm = makeLLMClient(provider, model, signal);

  log.info({ model, providerId: provider.id }, 'LLM: sending request (interview)');
  const spec = await runInterviewToCompletion(text, llm);
  log.info({ model, providerId: provider.id }, 'LLM: got response (interview)');

  const description = specToOsnovaDescription(spec);

  log.info({ model, providerId: provider.id }, 'LLM: sending request (osnova prompt)');
  let source = await llm.complete(buildOsnovaPrompt(description));
  log.info({ model, providerId: provider.id }, 'LLM: got response (osnova prompt)');

  let compileResult = compileSource(source);
  let errors = formatCompileErrors(compileResult);
  let attempts = 0;

  while (!compileResult.module && attempts < MAX_REPAIR_ATTEMPTS && errors.length > 0) {
    const repairPrompt = buildOsnovaRepairPrompt(source, errors);
    log.info({ model, providerId: provider.id, attempt: attempts + 1 }, 'LLM: sending request (repair)');
    source = await llm.complete(repairPrompt);
    log.info({ model, providerId: provider.id }, 'LLM: got response (repair)');
    compileResult = compileSource(source);
    errors = formatCompileErrors(compileResult);
    attempts += 1;
  }

  const success = !!compileResult.module;
  const generatedFiles = compileResult.module
    ? [
        {
          path: 'module.osvbc.json',
          content: JSON.stringify(compileResult.module),
        },
      ]
    : [];

  const record = createTraceRecord({
    spec: { text },
    osnovaSource: source,
    compilerSuccess: success,
    compilerErrors: errors,
    generatedFiles,
    modelVersion: model,
    osnovaVersion: LANGUAGE_VERSION,
    fabricaVersion: FABRICA_VERSION,
  });

  const tracesDir = join(workdir, 'traces');
  const writer = new TraceWriter({ tracesDir });
  await writer.write(record);

  return {
    appId: record.trace_id,
    success,
    source,
    errors,
  };
}
