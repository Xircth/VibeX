import type { ConflictHunk } from '@/types/mergeConflict';

export type HunkChoice = 'ours' | 'theirs' | 'both';

export function applyConflictHunk(
  result: string,
  hunks: readonly ConflictHunk[],
  hunkIndex: number,
  choice: HunkChoice
): string {
  const hunk = hunks.find((item) => item.index === hunkIndex);
  if (!hunk) return result;

  const replacement =
    choice === 'ours'
      ? hunk.ours
      : choice === 'theirs'
        ? hunk.theirs
        : [hunk.ours, hunk.theirs].filter((part) => part.length > 0).join('\n');

  return replaceNthConflictBlock(result, hunkIndex, replacement);
}

function replaceNthConflictBlock(
  result: string,
  hunkIndex: number,
  replacement: string
): string {
  const lines = result.split('\n');
  const output: string[] = [];
  let current = -1;
  let skipping = false;
  for (const line of lines) {
    if (line.startsWith('<<<<<<<')) {
      current += 1;
      if (current === hunkIndex) {
        skipping = true;
        if (replacement.length > 0) {
          output.push(...replacement.split('\n'));
        }
        continue;
      }
    }
    if (skipping) {
      if (line.startsWith('>>>>>>>')) {
        skipping = false;
      }
      continue;
    }
    output.push(line);
  }
  return output.join('\n');
}
