import pathlib

code = r"""import * as fs from 'fs/promises'
import * as os from 'os'
import * as nodePath from 'path'
import * as fss from 'fs'
import { execAsync } from './exec'
import { buildPatchPrompt } from './prompt'
import { callQwenCli } from './qwen-cli'
import { extractDiff } from './diff-parser'
import { validateBlastRadius } from './validator'
import { CursorTaskContract, PatchResult } from './types'

export async function run_patch_agent(contract: CursorTaskContract): Promise<PatchResult> {
  const files: Record<string, string> = {}
  for (const p of [...contract.allowed_paths, ...contract.context_files]) {
    files[p] = await fs.readFile(p, 'utf8').catch(() => '// not found')
  }
  const prompt = buildPatchPrompt(contract, files)
  const response = await callQwenCli(prompt)
  const diff = extractDiff(response)
  validateBlastRadius(diff, contract)
  const tmpDiff = nodePath.join(os.tmpdir(), 'patch-' + Date.now() + '.diff')
  const diffBuf = Buffer.from(diff.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8')
  fss.writeFileSync('last-applied.diff', diffBuf)
  await fs.writeFile(tmpDiff, diffBuf)
  try {
    await execAsync(`git apply --check -C 0 "${tmpDiff}"`).catch((e: Error) => {
      throw new Error('patch failed: ' + e.message)
    })
    await execAsync(`git apply -C 0 "${tmpDiff}"`)
    for (const cmd of contract.must_run_before_commit) {
      await execAsync(cmd).catch(async (e: Error) => {
        await execAsync('git checkout .')
        throw new Error('check failed: ' + cmd + '\n' + e.message)
      })
    }
    await execAsync(`git add -A && git commit -m "${contract.task.slice(0, 72)}"`)
    const { stdout: sha } = await execAsync('git rev-parse HEAD')
    return { status: 'success', commitSha: sha.trim(), diff }
  } finally {
    await fs.unlink(tmpDiff).catch(() => {})
  }
}
"""

pathlib.Path('src/patch-agent/index.ts').write_text(code, encoding='utf-8')
print('OK')
