export function extractDiff(qwenResponse: string): string {
  const response = qwenResponse.replace(/\r\n/g, '\n')

  // вариант 1: ```diff ... ```
  const fenced = response.match(/```diff\s*\n([\s\S]*?)```/)
  if (fenced) return validateNonEmpty(fenced[1].trim())

  // вариант 2: сырой unified diff
  const rawMatch = response.match(/(--- a\/.+[\s\S]*)$/)
  if (rawMatch) return validateNonEmpty(rawMatch[1].trim())

  throw new Error(
    `Не удалось извлечь diff из ответа Qwen:\n${response.slice(0, 500)}`
  )
}

function validateNonEmpty(diff: string): string {
  if (!diff || !diff.includes('@@')) {
    throw new Error(`Diff пустой или не содержит hunks (@@): "${diff.slice(0, 200)}"`)
  }
  return diff
}