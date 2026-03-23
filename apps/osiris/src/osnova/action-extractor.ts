export type OsirisAction =
  | { kind: 'chat' }
  | { kind: 'build'; task: string };

const BUILD_PATTERNS: string[] = [
  'сделай приложение',
  'создай приложение',
  'напиши приложение',
  'сгенерируй приложение',
  'сделай ос-приложение',
  'сделай приложение для',
  'создать приложение',
  'нужно приложение',
];

export function extractAction(message: string): OsirisAction {
  const text = message.trim();
  if (!text) return { kind: 'chat' };
  const lower = text.toLowerCase();
  for (const phrase of BUILD_PATTERNS) {
    if (lower.includes(phrase)) {
      return { kind: 'build', task: text };
    }
  }
  return { kind: 'chat' };
}

