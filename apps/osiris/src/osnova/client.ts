import { runPipeline } from '../../../../src/pipeline/orchestrator';
import type { PipelineResult } from '../../../../src/pipeline/types';

export interface OsirisPipelineResult {
  status: 'success' | 'failed';
  task: string;
  summary: string;
  raw: unknown;
}

function isPipelineSuccess(result: PipelineResult): boolean {
  return result.status === 'success';
}

function buildSummary(task: string, result: PipelineResult): string {
  if (result.status === 'success') {
    const appName = result.source?.filename ?? 'неизвестное приложение';
    const goldenText = result.goldenReport?.passed === true ? 'passed' : 'not passed';
    return `Сгенерировано приложение ${appName}, golden: ${goldenText}.`;
  }

  const reason = result.error
    ?? result.buildReport?.compilerErrors?.[0]?.message
    ?? result.buildReport?.parserErrors?.[0]?.message
    ?? 'неизвестная причина';
  return `Pipeline завершился с ошибкой: ${reason}.`;
}

export async function runOsnovaPipeline(task: string): Promise<OsirisPipelineResult> {
  const normalizedTask = task.trim();
  if (!normalizedTask) {
    throw new Error('task must be a non-empty string');
  }

  console.log(`[osiris:pipeline] starting, task="${normalizedTask}"`);
  try {
    const rawResult = await runPipeline(normalizedTask);
    const status: OsirisPipelineResult['status'] = isPipelineSuccess(rawResult) ? 'success' : 'failed';
    const mapped: OsirisPipelineResult = {
      status,
      task: normalizedTask,
      summary: buildSummary(normalizedTask, rawResult),
      raw: rawResult,
    };
    console.log(
      `[osiris:pipeline] finished, status=${mapped.status}, pipelineStatus=${rawResult.status}`,
    );
    return mapped;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[osiris:pipeline] failed: ${message}`);
    throw e;
  }
}

