/**
 * Удаляет markdown-блоки ```...``` с начала и конца строки.
 */

export function stripMarkdownFence(s: string): string {
  return s.replace(/^```[a-zA-Z]*\n?/i, '').replace(/\n?```$/i, '').trim();
}
