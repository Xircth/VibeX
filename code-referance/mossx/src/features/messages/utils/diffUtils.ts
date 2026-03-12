/**
 * Shared diff computation utilities
 * LCS-based diff with size guard to prevent browser freeze on large files
 */

export interface DiffStats {
  additions: number;
  deletions: number;
}

export type DiffLineType = 'unchanged' | 'deleted' | 'added';

export interface DiffLine {
  type: DiffLineType;
  content: string;
}

export interface DiffResult extends DiffStats {
  lines: DiffLine[];
}

const MAX_LCS_PRODUCT = 250_000;

function splitLines(value: string): string[] {
  if (!value) {
    return [];
  }
  return value.split('\n');
}

/**
 * Compute a full line-level diff (with line content) using LCS.
 * Falls back to a simple all-deleted / all-added view for very large inputs.
 */
export function computeDiff(oldStr: string, newStr: string): DiffResult {
  const oldLines = splitLines(oldStr);
  const newLines = splitLines(newStr);
  const oldLength = oldLines.length;
  const newLength = newLines.length;

  if (oldLength === 0 && newLength === 0) {
    return { lines: [], additions: 0, deletions: 0 };
  }
  if (oldLength === 0) {
    return {
      lines: newLines.map((content) => ({ type: 'added' as const, content })),
      additions: newLength,
      deletions: 0,
    };
  }
  if (newLength === 0) {
    return {
      lines: oldLines.map((content) => ({ type: 'deleted' as const, content })),
      additions: 0,
      deletions: oldLength,
    };
  }

  // Guard: fall back to simple diff for very large inputs
  if (oldLength * newLength > MAX_LCS_PRODUCT) {
    return {
      lines: [
        ...oldLines.map((content) => ({ type: 'deleted' as const, content })),
        ...newLines.map((content) => ({ type: 'added' as const, content })),
      ],
      additions: newLength,
      deletions: oldLength,
    };
  }

  const lcs: number[][] = Array.from({ length: oldLength + 1 }, () =>
    Array<number>(newLength + 1).fill(0),
  );

  for (let oi = 1; oi <= oldLength; oi++) {
    for (let ni = 1; ni <= newLength; ni++) {
      if (oldLines[oi - 1] === newLines[ni - 1]) {
        lcs[oi][ni] = lcs[oi - 1][ni - 1] + 1;
      } else {
        lcs[oi][ni] = Math.max(lcs[oi - 1][ni], lcs[oi][ni - 1]);
      }
    }
  }

  let additions = 0;
  let deletions = 0;
  let oi = oldLength;
  let ni = newLength;
  const lines: DiffLine[] = [];

  // Backtrack using push + reverse (O(n) total instead of O(n^2) from unshift)
  while (oi > 0 || ni > 0) {
    if (oi > 0 && ni > 0 && oldLines[oi - 1] === newLines[ni - 1]) {
      lines.push({ type: 'unchanged', content: oldLines[oi - 1] });
      oi--;
      ni--;
      continue;
    }
    if (ni > 0 && (oi === 0 || lcs[oi][ni - 1] >= lcs[oi - 1][ni])) {
      additions++;
      lines.push({ type: 'added', content: newLines[ni - 1] });
      ni--;
    } else {
      deletions++;
      lines.push({ type: 'deleted', content: oldLines[oi - 1] });
      oi--;
    }
  }

  lines.reverse();

  return { lines, additions, deletions };
}

/**
 * Compute only the diff stats (no line content) using LCS.
 * Falls back to simple line-count for very large inputs.
 */
export function computeDiffStats(oldStr: string, newStr: string): DiffStats {
  const result = computeDiff(oldStr, newStr);
  return { additions: result.additions, deletions: result.deletions };
}

/**
 * Parse a unified patch format and count additions/deletions.
 */
export function computeDiffFromUnifiedPatch(diffText: string): DiffStats {
  let additions = 0;
  let deletions = 0;
  const lines = diffText.split('\n');
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
    }
  }
  return { additions, deletions };
}
