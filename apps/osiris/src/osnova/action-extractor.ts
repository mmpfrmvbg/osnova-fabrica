export type OsirisAction =
  | { kind: 'chat' }
  | { kind: 'build'; task: string };

const BUILD_PATTERNS: string[] = [
  'сделай приложение',
  'создай приложение',
  'напиши приложение',
  'сгенерируй приложение',
  'сделай ос-приложение',
  'сделай ос приложение',
  'построй приложение',
];

export function extractAction(message: string): OsirisAction {
  const text = message.trim();
  const lower = text.toLowerCase();
  const isBuild = BUILD_PATTERNS.some((pattern) => lower.includes(pattern));
  if (isBuild) {
    return { kind: 'build', task: text };
  }
  return { kind: 'chat' };
}

