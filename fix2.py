import pathlib

qwen = """import { execFile } from 'child_process'
import * as os from 'os'
import * as nodePath from 'path'
import * as fs from 'fs/promises'

export async function callQwenCli(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('qwen', ['-p', prompt, '--output-format', 'json'], { shell: true, maxBuffer: 10485760 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error('Qwen error: ' + stderr))
        const lines = stdout.trim().split('\\n')
        for (const line of [...lines].reverse()) {
          try {
            const obj = JSON.parse(line)
            if (obj.type === 'result' && obj.result) { resolve(obj.result); return }
          } catch {}
        }
        resolve(stdout)
      }
    )
  })
}
"""

parser = """import * as fss from 'fs'

export function extractDiff(qwenResponse: string): string {
  fss.writeFileSync('last-raw.txt', qwenResponse, 'utf8')
  const s = qwenResponse.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n').trim()
  const f = s.match(/```diff\\s*\\n([\\s\\S]*?)```/)
  if (f) return save(f[1].trim())
  const m = s.match(/^(?:diff\\s*\\n)?(---[\\s\\S]+)/)
  if (m) return save(m[1].trim())
  throw new Error('No diff found:\\n' + s.slice(0, 400))
}

function save(diff: string): string {
  const lf = diff.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n')
  fss.writeFileSync('last-diff.txt', lf, 'utf8')
  if (!lf.includes('@@')) throw new Error('No hunks: ' + lf.slice(0, 200))
  return lf
}
"""

pathlib.Path('src/patch-agent/qwen-cli.ts').write_text(qwen, encoding='utf-8')
pathlib.Path('src/patch-agent/diff-parser.ts').write_text(parser, encoding='utf-8')
print('OK')
