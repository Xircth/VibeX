const HOST_HISTORY_TITLE_PREFIX = /^previous conversation:\s*(user:?\s*)?/i;
const CJK_TITLE_RE = /[\u3000-\u9fff]/;

export const MAX_SESSION_TITLE_CHARS = 32;

export function truncateSessionTitle(
  title: string,
  maxChars: number = MAX_SESSION_TITLE_CHARS
): string {
  const chars = Array.from(title);
  if (chars.length <= maxChars) {
    return title;
  }
  return chars.slice(0, maxChars).join('');
}

export function sanitizeSessionListTitle(title: string): string {
  const stripped = title.replace(HOST_HISTORY_TITLE_PREFIX, '').trim();
  const singleLine = stripped.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return truncateSessionTitle(singleLine);
}

export function sessionTitleIsCjk(title: string): boolean {
  return CJK_TITLE_RE.test(title);
}
