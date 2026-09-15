const HOST_HISTORY_TITLE_PREFIX = /^previous conversation:\s*(user:?\s*)?/i;

export function sanitizeSessionListTitle(title: string): string {
  const stripped = title.replace(HOST_HISTORY_TITLE_PREFIX, '').trim();
  return stripped.split(/\r?\n/, 1)[0]?.trim() ?? '';
}
