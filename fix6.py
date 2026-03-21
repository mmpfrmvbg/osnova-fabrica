import pathlib

qwen = """import { spawn } from 'child_process'
import { ChildProcess } from 'child_process'

export async function callQwenCli(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc: ChildProcess = spawn('qwen', ['--output-format', 'json', '--input-format', 'text'], {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = '', stderr = ''
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code: number) => {
      if (code !== 0 && !stdout) return reject(new Error('Qwen error: ' + stderr))
      for (const line of stdout.trim().split('\n').reverse()) {
        try {
          const obj = JSON.parse(line)
          if (obj.type === 'result' && obj.result) { resolve(obj.result); return }
        } catch {}
      }
      resolve(stdout)
    })
    proc.stdin!.write(prompt, 'utf8')
    proc.stdin!.end()
  })
}
"""

pathlib.Path('src/patch-agent/qwen-cli.ts').write_text(qwen, encoding='utf-8')
print('OK')
