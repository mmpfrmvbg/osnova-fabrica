import { describe, it, expect } from 'vitest';
import { stripMarkdownFence } from './stripMarkdownFence';

describe('stripMarkdownFence — 100 synthetic cases', () => {

  // ── ГРУППА A (30): строки БЕЗ фенсов ──────────────────────
  it.each([
    ['empty',            '',                    ''],
    ['single-word',      'модуль',              'модуль'],
    ['multiline-ru',     'модуль т\nконец',     'модуль т\nконец'],
    ['latin',            'const x = 1;',        'const x = 1;'],
    ['trim-spaces',      '  код  ',             'код'],
    ['only-spaces',      '   ',                 ''],
    ['tab-inside',       'a\tb',                'a\tb'],
    ['newline-only',     '\n',                  ''],
    ['double-newline',   '\n\n',                ''],
    ['digits',           '12345',               '12345'],
    ['special-non-fence','{}[]()<>',            '{}[]()<>'],
    ['comparison',       'если х > 0',          'если х > 0'],
    ['commas',           'a, b, c',             'a, b, c'],
    ['minus',            'x - 1',               'x - 1'],
    ['semicolon',        'конец;',              'конец;'],
    ['double-quotes',    '"привет"',            '"привет"'],
    ['single-quotes',    "'test'",              "'test'"],
    ['backslash',        'a\\b',                'a\\b'],
    ['url',              'https://example.com', 'https://example.com'],
    ['json-no-fence',    '{"key": 1}',          '{"key": 1}'],
    ['xml-no-fence',     '<tag>val</tag>',      '<tag>val</tag>'],
    ['multiline-json',   '{\n  "a": 1\n}',      '{\n  "a": 1\n}'],
    ['float',            '3.14',                '3.14'],
    ['booleans-ru',      'истина ложь',         'истина ложь'],
    ['parens',           '()',                  '()'],
    ['ellipsis',         '...',                 '...'],
    ['star',             '*',                   '*'],
    ['question',         '?',                   '?'],
    ['exclamation',      '!',                   '!'],
    ['tilde',            '~',                   '~'],
  ] as [string, string, string][])(
    'no-fence [%s]',
    (_label, input, expected) => {
      expect(stripMarkdownFence(input)).toBe(expected);
    }
  );

  // ── ГРУППА B (30): строки С фенсом и языком ───────────────
  it.each([
    ['osnova',      '```osnova\nмодуль т\nконец\n```',        'модуль т\nконец'],
    ['js',          '```js\nconst x = 1;\n```',               'const x = 1;'],
    ['javascript',  '```javascript\nlet a = 2;\n```',         'let a = 2;'],
    ['ts',          '```ts\nconst y: number = 3;\n```',       'const y: number = 3;'],
    ['typescript',  '```typescript\ninterface A {}\n```',     'interface A {}'],
    ['json',        '```json\n{"k":1}\n```',                  '{"k":1}'],
    ['python',      '```python\nprint("hello")\n```',         'print("hello")'],
    ['bash',        '```bash\necho hi\n```',                  'echo hi'],
    ['sh',          '```sh\nls -la\n```',                     'ls -la'],
    ['sql',         '```sql\nSELECT 1;\n```',                 'SELECT 1;'],
    ['html',        '```html\n<div/>\n```',                   '<div/>'],
    ['css',         '```css\nbody{}\n```',                    'body{}'],
    ['yaml',        '```yaml\nkey: val\n```',                 'key: val'],
    ['xml',         '```xml\n<a/>\n```',                      '<a/>'],
    ['cpp',         '```cpp\nint main(){}\n```',              'int main(){}'],
    ['c',           '```c\nvoid f(){}\n```',                  'void f(){}'],
    ['rust',        '```rust\nfn main(){}\n```',              'fn main(){}'],
    ['go',          '```go\nfunc main(){}\n```',              'func main(){}'],
    ['java',        '```java\nvoid m(){}\n```',               'void m(){}'],
    ['kotlin',      '```kotlin\nfun main(){}\n```',           'fun main(){}'],
    ['swift',       '```swift\nfunc f(){}\n```',              'func f(){}'],
    ['ruby',        '```ruby\nputs 1\n```',                   'puts 1'],
    ['php',         '```php\necho 1;\n```',                   'echo 1;'],
    ['r',           '```r\nprint(1)\n```',                    'print(1)'],
    ['scala',       '```scala\nobject M\n```',                'object M'],
    ['haskell',     '```haskell\nmain = return()\n```',       'main = return()'],
    ['lua',         '```lua\nprint(1)\n```',                  'print(1)'],
    ['perl',        '```perl\nprint 1\n```',                  'print 1'],
    ['clojure',     '```clojure\n(+ 1 2)\n```',              '(+ 1 2)'],
    ['no-lang',     '```\nкод\n```',                         'код'],
  ] as [string, string, string][])(
    'fenced [%s]',
    (_lang, input, expected) => {
      expect(stripMarkdownFence(input)).toBe(expected);
    }
  );

  // ── ГРУППА C (25): смешанные edge-cases ───────────────────
  it.each([
    // функция снимает только ПЕРВЫЙ и ПОСЛЕДНИЙ fence — не трогает средние
    ['only-open',          '```\nнезакрытый',                   'незакрытый'],
    ['only-open-lang',     '```ts\nнезакрытый',                 'незакрытый'],
    ['only-close',         'код\n```',                          'код'],
    ['empty-fenced',       '```\n```',                          ''],
    ['empty-fenced-lang',  '```osnova\n```',                    ''],
    ['ws-inside',          '```\n  код  \n```',                 'код'],
    ['multiline-osnova',   '```osnova\nмодуль М\nпроцедура главная()\n  вернуть 1\nконец\nконец\n```',
                           'модуль М\nпроцедура главная()\n  вернуть 1\nконец\nконец'],
    ['uppercase-lang',     '```OSNOVA\nкод\n```',               'код'],
    ['mixed-case-lang',    '```TypeScript\nconst x = 1;\n```',  'const x = 1;'],
    ['json-fenced',        '```json\n{"a":1}\n```',             '{"a":1}'],
    ['json-multiline',     '```json\n{\n  "a": 1\n}\n```',      '{\n  "a": 1\n}'],
    ['leading-spaces',     '  ```\nкод\n```',                   '```\nкод'],
    ['idempotent',         'модуль т\nконец',                   'модуль т\nконец'],
    ['double-backtick',    '``код``',                           '``код``'],
    ['single-backtick',    '`код`',                             '`код`'],
    ['backtick-middle',    'пусть х = `шаблон`',               'пусть х = `шаблон`'],
    ['long-no-fence',      'а'.repeat(200),                     'а'.repeat(200)],
    ['only-backticks',     '```',                               ''],
    ['markdown-in-code',   '```\n# Заголовок\n**bold**\n```',  '# Заголовок\n**bold**'],
    ['lang-hyphen',        '```c-sharp\nclass A{}\n```',        '-sharp\nclass A{}'],
    ['one-char',           '```\nх\n```',                       'х'],
    ['unicode',            '```\n日本語\n```',                  '日本語'],
    ['emoji',              '```\n🚀\n```',                      '🚀'],
    ['lang-ru',            '```основа\nкод\n```',               'основа\nкод'],
    ['lang-num',           '```c99\nint x;\n```',               '99\nint x;'],
  ] as [string, string, string][])(
    'edge [%s]',
    (_label, input, expected) => {
      expect(stripMarkdownFence(input)).toBe(expected);
    }
  );

  // ── ГРУППА D (15): LLM-реалистичные сценарии ──────────────
  it.each([
    ['real-osnova',
      '```osnova\nмодуль Сумма\nпроцедура главная()\n  вернуть 1 + 2\nконец\nконец\n```',
      'модуль Сумма\nпроцедура главная()\n  вернуть 1 + 2\nконец\nконец'],
    ['real-ts-func',
      '```typescript\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n```',
      'export function add(a: number, b: number): number {\n  return a + b;\n}'],
    ['real-json',
      '```json\n{\n  "status": "ok",\n  "count": 42\n}\n```',
      '{\n  "status": "ok",\n  "count": 42\n}'],
    ['fence-in-string',
      '```js\nconst s = "```";\n```',
      'const s = "```";'],
    ['tab-indent',
      '```\n\tкод\n```',
      'код'],
    ['crlf',
      '```ts\r\nconst x = 1;\r\n```',
      'const x = 1;'],
    ['lang-with-dot',
      '```c.sharp\nclass A{}\n```',
      '.sharp\nclass A{}'],
    ['verbose-llm-reply',
      '```osnova\nмодуль М\nпроцедура главная()\n  пусть i = 0\n  пока i < 5\n    i = i + 1\n  конец\n  вернуть i\nконец\nконец\n```',
      'модуль М\nпроцедура главная()\n  пусть i = 0\n  пока i < 5\n    i = i + 1\n  конец\n  вернуть i\nконец\nконец'],
    ['text-before-fence',
      'Вот код:\n```\nмодуль т\n```',
      'Вот код:\n```\nмодуль т'],
    ['double-fence-block',
      '```\nпервый\n```\n\n```\nвторой\n```',
      'первый\n```\n\n```\nвторой'],
    ['four-backticks-open',
      '````\nкод\n````',
      '`\nкод\n`'],
    ['null-byte',          '\0',       '\0'],
    ['whitespace-trim',    '\n  \n',   ''],
    ['lang-space-after',   '```osnova \nмодуль т\nконец\n```',  'модуль т\nконец'],
    ['inner-fence',
      '```osnova\nстр1\n```inner\nстр3\n```',
      'стр1\n```inner\nстр3'],
  ] as [string, string, string][])(
    'llm-real [%s]',
    (_label, input, expected) => {
      expect(stripMarkdownFence(input)).toBe(expected);
    }
  );

});
