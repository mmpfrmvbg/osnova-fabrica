import { CursorTaskContract } from './types'

export function buildPatchPrompt(contract: CursorTaskContract, files: Record<string, string>): string {
  const fileBlock = Object.entries(files)
    .map(([path, content]) => `=== ${path} ===\n${content}`)
    .join('\n\n')

  return `Ты — эксперт по TypeScript. Твоя задача: написать unified diff патч.

ЗАДАЧА:
${contract.task}

ФАЙЛЫ КОТОРЫЕ МОЖНО МЕНЯТЬ (allowed):
${contract.allowed_paths.join(', ')}

ФАЙЛЫ КОТОРЫЕ НЕЛЬЗЯ ТРОГАТЬ (forbidden):
${contract.forbidden_paths.join(', ')}

КРИТЕРИИ ПРИЁМКИ:
${contract.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

ОГРАНИЧЕНИЯ:
- Максимум изменённых файлов: ${contract.max_files_changed}
- Изменять ТОЛЬКО файлы из allowed_paths
- Отвечай ТОЛЬКО unified diff, никакого текста вокруг

ТЕКУЩЕЕ СОДЕРЖИМОЕ ФАЙЛОВ:
${fileBlock}

Ответ строго в формате:
\`\`\`diff
--- a/путь/к/файлу
+++ b/путь/к/файлу
@@ ... @@
 строки контекста
-удалённые строки
+добавленные строки
\`\`\``
}