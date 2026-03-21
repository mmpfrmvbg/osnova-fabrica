import { spawn } from 'child_process'

export async function callQwenCli(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('qwen', ['-p', prompt, '-y'], {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd(),
    })

    let out = '', err = ''
    proc.stdout!.on('data', (d: Buffer) => { out += d.toString() })
    proc.stderr!.on('data', (d: Buffer) => { err += d.toString() })

    proc.on('close', (code: number) => {
      if (out.trim()) return resolve(out.trim())
      reject(new Error(`Qwen CLI exit ${code}: ${err.slice(0, 300)}`))
    })

    proc.on('error', (e: Error) => reject(e))
  })
}