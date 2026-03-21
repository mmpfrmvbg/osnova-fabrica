import pathlib

qwen = """import { execFile } from 'child_process'

export async function callQwenCli(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('qwen', [prompt, '--output-format', 'json'], { shell: true, maxBuffer: 10485760 },
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

pathlib.Path('src/patch-agent/qwen-cli.ts').write_text(qwen, encoding='utf-8')
print('OK')
