import { describe, it, expect } from 'vitest';
import { parseQwenJsonEvents } from './qwen-stdout-parser';

describe('parseQwenJsonEvents', () => {
  it('JSON без result-события -> found: false, text пустой', () => {
    const r = parseQwenJsonEvents('[{"type":"assistant","content":"hello"}]');
    expect(r.found).toBe(false);
    expect(r.text).toBe('');
  });

  it('невалидный JSON -> found: false, text пустой', () => {
    const r = parseQwenJsonEvents('не-json-мусор');
    expect(r.found).toBe(false);
    expect(r.text).toBe('');
  });

  it('валидный result-event -> found: true, text корректный', () => {
    const r = parseQwenJsonEvents(
      '[{"type":"result","subtype":"success","result":"модуль А\\nконец"}]',
    );
    expect(r.found).toBe(true);
    expect(r.text).toBe('модуль А\nконец');
  });
});
