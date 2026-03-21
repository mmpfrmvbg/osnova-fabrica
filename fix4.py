import pathlib

qwen = """import { execFile } from 'child_process'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

export async function callQwenCli(prompt: string): Promise<string> {
  const tmp = path.join(os.tmpdir(), 'qwen-' + Date.now() + '.txt')
  await fs.writeFile(tmp, prompt, 'utf8')
  return new Promise((resolve, reject) => {
    execFile('qwen', [prompt, '--output-format', 'json'], { shell: true, maxBuffer: 10485760 },
      (err, stdout, stderr) => {
        fs.unlink(tmp).catch(() => {})
        if (err && !stdout) return reject(new Error('Qwen error: ' + stderr))
        for (const line of stdout.trim().split('\\n').reverse()) {
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

pathlib.Path('src/patch-agent/qwen-cli.ts').write_text(qwen, encoding='utf-8')
print('OK')
