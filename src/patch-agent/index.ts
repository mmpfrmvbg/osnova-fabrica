import * as fs from 'fs/promises'
import { execAsync } from './exec'
import { buildPatchPrompt } from './prompt'
import { callQwenCli } from './qwen-cli'
import { extractDiff } from './diff-parser'
import { validateBlastRadius } from './validator'
import { CursorTaskContract, PatchResult } from './types'

export async function run_patch_agent(contract: CursorTaskContract): Promise<PatchResult> {
  // 1. читаем файлы
  const files: Record<string, string> = {}
  for (const path of [...contract.allowed_paths, ...contract.context_files]) {
    files[path] = await fs.readFile(path, 'utf8').catch(() => '// файл не найден')
  }

  // 2. вызываем Qwen CLI
  const prompt = buildPatchPrompt(contract, files)
  const response = await callQwenCli(prompt)

  // 3. парсим diff
  const diff = extractDiff(response)

  // 4. валидируем blast radius
  validateBlastRadius(diff, contract)

  // 5–8. apply + verify + commit (tmpDiff удаляется в любом случае)
  const tmpDiff = `/tmp/patch-${Date.now()}.diff`
  await fs.writeFile(tmpDiff, diff)

  try {
    // dry run
    await execAsync(`git apply --check "${tmpDiff}"`).catch((e: Error) => {
      throw new Error(`Патч не применяется: ${e.message}`)
    })

    // реальный apply
    await execAsync(`git apply "${tmpDiff}"`)

    // must_run_before_commit
    for (const cmd of contract.must_run_before_commit) {
      await execAsync(cmd).catch(async (e: Error) => {
        await execAsync('git checkout .')
        throw new Error(`Проверка провалилась: ${cmd}\n${e.message}`)
      })
    }

    // commit
    await execAsync(`git add -A && git commit -m "${contract.task.slice(0, 72)}"`)
    const { stdout: sha } = await execAsync('git rev-parse HEAD')

    return { status: 'success', commitSha: sha.trim(), diff }

  } finally {
    await fs.unlink(tmpDiff).catch(() => {})
  }
}