const fs = require('fs');

fs.writeFileSync('src/patch-agent/qwen-cli.ts', [
  "import { spawn } from 'child_process'",
  "import * as os from 'os'",
  "import * as nodePath from 'path'",
  "",
  "export async function callQwenCli(prompt) {",
  "  return new Promise((resolve, reject) => {",
  "    const proc = spawn('qwen', ['--model', 'qwen-coder-plus', '--no-stream'], {",
  "      stdio: ['pipe', 'pipe', 'pipe'],",
  "      shell: true",
  "    })",
  "    let out = '', err = ''",
  "    proc.stdout.on('data', d => { out += d })",
  "    proc.stderr.on('data', d => { err += d })",
  "    proc.on('close', code => {",
  "      if (code !== 0 && !out) reject(new Error('Qwen exit ' + code + ': ' + err))",
  "      else resolve(out.replace(/\r\n/g, '\n').replace(/\r/g, '\n'))",
  "    })",
  "    proc.stdin.write(prompt, 'utf8')",
  "    proc.stdin.end()",
  "  })",
  "}"
].join('\n'));

fs.writeFileSync('src/patch-agent/diff-parser.ts', [
  "import * as fss from 'fs'",
  "",
  "export function extractDiff(r) {",
  "  fss.writeFileSync('last-raw.txt', r, 'utf8')",
  "  const s = r.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()",
  "  const f = s.match(/\\\diff\s*\n([\s\S]*?)\\\/)",
  "  if (f) return save(f[1].trim())",
  "  const m = s.match(/^(?:diff\s*\n)?(---[\s\S]+)/)",
  "  if (m) return save(m[1].trim())",
  "  throw new Error('No diff found:\n' + s.slice(0, 400))",
  "}",
  "",
  "function save(diff) {",
  "  const lf = diff.replace(/\r\n/g, '\n').replace(/\r/g, '\n')",
  "  fss.writeFileSync('last-diff.txt', lf, 'utf8')",
  "  if (!lf.includes('@@')) throw new Error('No hunks: ' + lf.slice(0,200))",
  "  return lf",
  "}"
].join('\n'));

console.log('OK');
