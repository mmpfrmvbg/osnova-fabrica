import { runPipeline } from '../../../../src/pipeline/orchestrator';
import type { PipelineResult, PipelineStatus } from '../../../../src/pipeline/types';

export interface OsirisPipelineResult {
  status: 'ok' | 'error';
  pipelineStatus: PipelineStatus;
  task: string;
  summary: string;
  raw: unknown;
}

export function toCompatStatus(status: PipelineStatus): 'ok' | 'error' {
  return status === 'success' || status === 'partial' ? 'ok' : 'error';
}

function isPipelineSuccessLike(status: PipelineStatus): boolean {
  return toCompatStatus(status) === 'ok';
}

function buildSummary(task: string, result: PipelineResult): string {
  if (isPipelineSuccessLike(result.status)) {
    const appName = result.source?.filename ?? 'неизвестное приложение';
    const goldenText = result.goldenReport?.passed === true ? 'passed' : 'not passed';
    return `Задача "${task}": сгенерировано приложение ${appName}, golden: ${goldenText}.`;
  }

  const reason = result.error
    ?? result.buildReport?.compilerErrors?.[0]?.message
    ?? result.buildReport?.parserErrors?.[0]?.message
    ?? 'неизвестная причина';
  return `Задача "${task}": pipeline завершился с ошибкой: ${reason}.`;
}

export async function runOsirisPipeline(
  task: string,
  onProgress?: (phase: string, message: string) => void,
): Promise<OsirisPipelineResult> {
  const normalizedTask = task.trim();
  if (!normalizedTask) {
    throw new Error('task must be a non-empty string');
  }

  console.log(`[osiris:pipeline] starting, task="${normalizedTask}"`);
  try {
    onProgress?.('start', `Запускаю Фабрику: "${normalizedTask}"...`);
    const rawResult = await runPipeline(normalizedTask);
    onProgress?.('pipeline_done', 'Пайплайн завершён, формирую ответ...');
    const mapped: OsirisPipelineResult = {
      status: toCompatStatus(rawResult.status),
      pipelineStatus: rawResult.status,
      task: normalizedTask,
      summary: buildSummary(normalizedTask, rawResult),
      raw: rawResult,
    };
    console.log(
      `[osiris:pipeline] completed, status=${mapped.status}, pipelineStatus=${mapped.pipelineStatus}`,
    );
    return mapped;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[osiris:pipeline] failed: ${message}`);
    throw e;
  }
}

// Backward-compatible alias for existing imports.
export const runOsnovaPipeline = runOsirisPipeline;

