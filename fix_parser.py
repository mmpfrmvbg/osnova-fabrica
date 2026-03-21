import pathlib

code = r"""import * as fss from 'fs'

export function extractDiff(qwenResponse: string): string {
  fss.writeFileSync('last-raw.txt', qwenResponse, 'utf8')
  const s = qwenResponse.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  const f = s.match(/```diff\s*\n([\s\S]*?)```/)
  if (f) return save(f[1].trim())
  const m = s.match(/^(?:diff\s*\n)?(---[\s\S]+)/)
  if (m) return save(m[1].trim())
  fss.writeFileSync('last-diff.txt', 'No diff found in:\n' + s.slice(0, 800), 'utf8')
  throw new Error('No diff found:\n' + s.slice(0, 400))
}

function save(diff: string): string {
  const lf = diff.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  fss.writeFileSync('last-diff.txt', lf, 'utf8')
  if (!lf.includes('@@')) throw new Error('No hunks: ' + lf.slice(0, 200))
  return lf
}
"""

pathlib.Path('src/patch-agent/diff-parser.ts').write_text(code, encoding='utf-8')
print('OK')
