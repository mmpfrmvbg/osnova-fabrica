import { spawn } from 'child_process'
import { ChildProcess } from 'child_process'
import * as os from 'os'
import * as nodePath from 'path'
import * as fs from 'fs/promises'

export async function callQwenCli(prompt: string): Promise<string> {
  const tmpFile = nodePath.join(os.tmpdir(), 'qwen-prompt-' + Date.now() + '.txt')
  await fs.writeFile(tmpFile, prompt, 'utf8')
  return new Promise((resolve, reject) => {
    const proc: ChildProcess = spawn('qwen', ['--output-format', 'json', '--input-format', 'text'], {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let out = '', err = ''
    proc.stdout!.on('data', (d: Buffer) => { out += d.toString() })
    proc.stderr!.on('data', (d: Buffer) => { err += d.toString() })
    proc.on('close', (code: number) => {
      fs.unlink(tmpFile).catch(() => {})
      if (code !== 0 && !out) return reject(new Error('Qwen error: ' + err))
      let lastResult = ''
      let i = 0
      while (i < out.length) {
        if (out[i] !== '{') { i++; continue }
        let depth = 0, j = i
        while (j < out.length) {
          if (out[j] === '{') depth++
          else if (out[j] === '}') { depth--; if (depth === 0) break }
          j++
        }
        try {
          const obj = JSON.parse(out.slice(i, j + 1))
          if (obj.type === 'result' && obj.result) lastResult = obj.result
        } catch {}
        i = j + 1
      }
      if (lastResult) resolve(lastResult)
      else resolve(out)
    })
    proc.stdin!.write(prompt, 'utf8')
    proc.stdin!.end()
  })
}
