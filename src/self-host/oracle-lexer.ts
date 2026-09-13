// Оракул: TS-лексер на той же строке, формат "kind|lexeme" для сравнения.
import { tokenize } from '../compiler/lexer';

const source = 'пусть x = 12 + 3';
const { tokens, errors } = tokenize(source);
for (const t of tokens) {
  console.log(t.kind + '|' + t.lexeme);
}
if (errors.length) {
  for (const e of errors) console.error('ОШИБКА', e.line + ':' + e.column, e.message);
}
