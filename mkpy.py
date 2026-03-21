import pathlib

js = """
const fs = require('fs');
const raw = fs.readFileSync('qwen-out-utf8.json', 'utf8');

// найти последний result-объект через brace matching
let lastResult = '';
let i = 0;
while (i < raw.length) {
  if (raw[i] !== '{') { i++; continue; }
  let depth = 0, j = i;
  while (j < raw.length) {
    if (raw[j] === '{') depth++;
    else if (raw[j] === '}') { depth--; if (depth === 0) break; }
    j++;
  }
  try {
    const obj = JSON.parse(raw.slice(i, j + 1));
    if (obj.type === 'result' && obj.result) lastResult = obj.result;
  } catch {}
  i = j + 1;
}

console.log('result:');
console.log(lastResult);

// извлечь diff
const m = lastResult.match(/```diff\\s*\\n([\\s\\S]*?)```/);
if (m) {
  const diff = m[1];
  fs.writeFileSync('test.diff', diff, 'utf8');
  console.log('\\ndiff saved, lines:', diff.split('\\n').length);
} else {
  console.log('no diff block found');
}
"""

pathlib.Path('mkdiff2.js').write_text(js, encoding='utf-8')
print('OK')
