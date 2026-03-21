import { CursorTaskContract } from './types'

export function validateBlastRadius(diff: string, contract: CursorTaskContract): void {
  const changedFiles = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)]
    .map(m => m[1])

  for (const file of changedFiles) {
    if (contract.forbidden_paths.some(f => file.includes(f))) {
      throw new Error(`BLAST RADIUS VIOLATION: ${file} в forbidden_paths`)
    }
    if (!contract.allowed_paths.some(a => file.includes(a))) {
      throw new Error(`BLAST RADIUS VIOLATION: ${file} не в allowed_paths`)
    }
  }

  if (changedFiles.length > contract.max_files_changed) {
    throw new Error(`BLAST RADIUS VIOLATION: изменено ${changedFiles.length} файлов, лимит ${contract.max_files_changed}`)
  }
}