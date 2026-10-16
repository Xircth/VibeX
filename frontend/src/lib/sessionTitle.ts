const HOST_HISTORY_TITLE_PREFIX = /^previous conversation:\s*(user:?\s*)?/i;
const CJK_TITLE_RE = /[\u3000-\u9fff]/;

export function sanitizeSessionListTitle(title: string): string {
  const stripped = title.replace(HOST_HISTORY_TITLE_PREFIX, '').trim();
  return stripped.split(/\r?\n/, 1)[0]?.trim() ?? '';
}

export function sessionTitleIsCjk(title: string): boolean {
  return CJK_TITLE_RE.test(title);
}
