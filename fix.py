import pathlib

qwen = (
    "import { spawn } from 'child_process'\n"
    "import * as os from 'os'\n"
    "import * as nodePath from 'path'\n"
    "\n"
    "export async function callQwenCli(prompt: string): Promise<string> {\n"
    "  return new Promise((resolve, reject) => {\n"
    "    const proc = spawn('qwen', ['--model', 'qwen-coder-plus', '--no-stream'], {\n"
    "      stdio: ['pipe', 'pipe', 'pipe'],\n"
    "      shell: true\n"
    "    })\n"
    "    let out = '', err = ''\n"
    "    proc.stdout.on('data', (d: Buffer) => { out += d.toString() })\n"
    "    proc.stderr.on('data', (d: Buffer) => { err += d.toString() })\n"
    "    proc.on('close', (code) => {\n"
    "      if (code !== 0 && !out) reject(new Error('Qwen exit ' + code + ': ' + err))\n"
    "      else resolve(out.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n'))\n"
    "    })\n"
    "    proc.stdin.write(prompt, 'utf8')\n"
    "    proc.stdin.end()\n"
    "  })\n"
    "}\n"
)

parser = (
    "import * as fss from 'fs'\n"
    "\n"
    "export function extractDiff(qwenResponse: string): string {\n"
    "  fss.writeFileSync('last-raw.txt', qwenResponse, 'utf8')\n"
    "  const s = qwenResponse.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n').trim()\n"
    "  const f = s.match(/\\\diff\\s*\\n([\\s\\S]*?)\\\/)\n"
    "  if (f) return save(f[1].trim())\n"
    "  const m = s.match(/^(?:diff\\s*\\n)?(---[\\s\\S]+)/)\n"
    "  if (m) return save(m[1].trim())\n"
    "  throw new Error('No diff:\\n' + s.slice(0, 400))\n"
    "}\n"
    "\n"
    "function save(diff: string): string {\n"
    "  const lf = diff.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n')\n"
    "  fss.writeFileSync('last-diff.txt', lf, 'utf8')\n"
    "  if (!lf.includes('@@')) throw new Error('No hunks: ' + lf.slice(0, 200))\n"
    "  return lf\n"
    "}\n"
)

pathlib.Path('src/patch-agent/qwen-cli.ts').write_text(qwen, encoding='utf-8')
pathlib.Path('src/patch-agent/diff-parser.ts').write_text(parser, encoding='utf-8')
print('OK')
