/**
 * Map a selected text fragment back to a 1-based line range within `content`,
 * by locating the fragment in the known content string (robust to how the
 * viewer renders/highlights it). Returns null when the fragment is empty or not
 * found. Uses the first occurrence when the fragment repeats.
 */
export function computeLineRange(
  content: string,
  selectedText: string
): { startLine: number; endLine: number } | null {
  // Trailing newlines in a selection shouldn't count as an extra line.
  const fragment = selectedText.replace(/\r/g, '').replace(/\n+$/, '');
  if (!fragment.trim()) return null;

  const normalized = content.replace(/\r/g, '');
  const index = normalized.indexOf(fragment);
  if (index < 0) return null;

  const before = normalized.slice(0, index);
  const startLine = (before.match(/\n/g)?.length ?? 0) + 1;
  const spannedNewlines = fragment.match(/\n/g)?.length ?? 0;
  return { startLine, endLine: startLine + spannedNewlines };
}

/** Format a repo-relative path + line range as `path:start-end` (or `path:line`). */
export function formatFileRangeRef(
  filePath: string,
  startLine: number,
  endLine: number
): string {
  return startLine === endLine
    ? `${filePath}:${startLine}`
    : `${filePath}:${startLine}-${endLine}`;
}
