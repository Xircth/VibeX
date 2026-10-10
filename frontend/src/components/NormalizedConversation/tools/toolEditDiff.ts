import { splitCodeLines } from './toolArtifactModel';
import type { FileChange } from 'shared/types';

export type FileEditPreview = { path: string; changes: FileChange[] };

export function normalizeToolDiff(path: string, diff: string): string {
  const lines = splitCodeLines(diff);
  if (lines.some((line) => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line))) {
    return /^--- /m.test(diff) ? diff : `--- a/${path}\n+++ b/${path}\n${diff}`;
  }
  const hunks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (current.length) hunks.push(current);
      current = [];
    } else if (/^[ +-]/.test(line) && !line.startsWith('***')) {
      current.push(line);
    }
  }
  if (current.length) hunks.push(current);
  if (!hunks.length) return diff;
  let oldStart = 1;
  let newStart = 1;
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunks.flatMap((hunk) => {
      const oldCount = hunk.filter((line) => line[0] !== '+').length;
      const newCount = hunk.filter((line) => line[0] !== '-').length;
      const header = `@@ -${oldCount ? oldStart : oldStart - 1},${oldCount} +${newCount ? newStart : newStart - 1},${newCount} @@`;
      oldStart += oldCount;
      newStart += newCount;
      return [header, ...hunk];
    }),
  ].join('\n');
}

export function parseApplyPatch(patch: string): FileEditPreview[] {
  const files: FileEditPreview[] = [];
  const sections = patch.split(/(?=^\*\*\* (?:Add|Update|Delete) File: )/m);
  for (const section of sections) {
    const header = section.match(
      /^\*\*\* (Add|Update|Delete) File: (.+)\r?\n?/
    );
    if (!header) continue;
    const path = header[2].trim();
    const body = section
      .slice(header[0].length)
      .replace(/^\*\*\* (?:End Patch|End of File).*$/gm, '');
    const move = body.match(/^\*\*\* Move to: (.+)$/m);
    const changes: FileChange[] = [];
    if (header[1] === 'Delete') {
      changes.push({ action: 'delete' });
    } else {
      if (move) changes.push({ action: 'rename', new_path: move[1].trim() });
      changes.push({
        action: 'edit',
        unified_diff: normalizeToolDiff(path, body),
        has_line_numbers: false,
      });
    }
    files.push({ path, changes });
  }
  return files;
}

/** Fragment positions are local to the replacement, not actual file lines. */
export function replacementDiff(
  path: string,
  oldText: string,
  newText: string
): string {
  const oldLines = splitCodeLines(oldText);
  const newLines = splitCodeLines(newText);
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n');
}
