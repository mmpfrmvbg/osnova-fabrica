import { spawn } from 'child_process'
import * as fs from 'fs/promises'

export async function callQwenCli(prompt: string): Promise<string> {
  const tmpFile = `/tmp/qwen-prompt-${Date.now()}.txt`
  await fs.writeFile(tmpFile, prompt, 'utf8')

  return new Promise((resolve, reject) => {
    const proc = spawn('qwen', ['--model', 'qwen-coder-plus', '--no-stream'], {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('close', (code) => {
      fs.unlink(tmpFile).catch(() => {})
      if (code !== 0 && !stdout) reject(new Error(`Qwen CLI exit ${code}: ${stderr}`))
      else resolve(stdout)
    })

    proc.stdin.write(prompt, 'utf8')
    proc.stdin.end()
  })
}