import type { FileChange } from 'shared/types';
import { deriveRelativeFilePath } from '@/utils/filePaths';
import type { ToolDisplayEntry } from './messageTurnTool';
import { resolveToolFilePath } from './tools/FileToolCard';
import { fileNameFromPath } from './tools/toolCallPath';

export type TurnToolDiffPreviewLine = {
  text: string;
  tone: 'add' | 'del' | 'ctx';
};

export type TurnToolDiffChip = {
  key: string;
  rawPath: string;
  displayPath: string;
  resolvedPath: string;
  fileName: string;
  additions: number;
  deletions: number;
  previewLines: TurnToolDiffPreviewLine[];
};

const MAX_PREVIEW_LINES = 10;

export function countFileChangeDiff(change: FileChange): {
  additions: number;
  deletions: number;
} {
  if (change.action === 'write') {
    return {
      additions:
        change.content.length > 0 ? change.content.split(/\r?\n/).length : 0,
      deletions: 0,
    };
  }
  if (change.action === 'delete') {
    return { additions: 0, deletions: 1 };
  }
  if (change.action !== 'edit') {
    return { additions: 0, deletions: 0 };
  }

  let additions = 0;
  let deletions = 0;
  for (const line of change.unified_diff.split(/\r?\n/)) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

export function countFileChangesStats(changes: readonly FileChange[]): {
  additions?: number;
  deletions?: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const change of changes) {
    const next = countFileChangeDiff(change);
    additions += next.additions;
    deletions += next.deletions;
  }
  return {
    additions: additions > 0 ? additions : undefined,
    deletions: deletions > 0 ? deletions : undefined,
  };
}

function appendPreviewLines(
  target: TurnToolDiffPreviewLine[],
  change: FileChange,
  displayPath: string,
  workspacePath?: string | null
) {
  if (target.length >= MAX_PREVIEW_LINES) return;

  if (change.action === 'write') {
    if (!change.content) return;
    for (const line of change.content.split(/\r?\n/)) {
      if (target.length >= MAX_PREVIEW_LINES) break;
      target.push({ text: line, tone: 'add' });
    }
    return;
  }

  if (change.action === 'delete') {
    if (target.length === 0) {
      target.push({ text: displayPath, tone: 'del' });
    }
    return;
  }

  if (change.action === 'rename') {
    const nextResolved = resolveToolFilePath(change.new_path, workspacePath);
    const nextDisplay =
      deriveRelativeFilePath(nextResolved, workspacePath) ?? change.new_path;
    target.push({ text: `${displayPath} -> ${nextDisplay}`, tone: 'ctx' });
    return;
  }

  for (const line of change.unified_diff.split(/\r?\n/)) {
    if (target.length >= MAX_PREVIEW_LINES) break;
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('@@') ||
      line.startsWith('\\ No newline')
    ) {
      continue;
    }
    if (line.startsWith('+')) {
      target.push({ text: line.slice(1), tone: 'add' });
    } else if (line.startsWith('-')) {
      target.push({ text: line.slice(1), tone: 'del' });
    } else if (line.startsWith(' ')) {
      target.push({ text: line.slice(1), tone: 'ctx' });
    }
  }
}

function disambiguateFileNames(chips: TurnToolDiffChip[]): TurnToolDiffChip[] {
  const counts = new Map<string, number>();
  for (const chip of chips) {
    counts.set(chip.fileName, (counts.get(chip.fileName) ?? 0) + 1);
  }
  return chips.map((chip) => {
    if ((counts.get(chip.fileName) ?? 0) <= 1) return chip;
    const segments = chip.displayPath.split(/[\\/]/).filter(Boolean);
    if (segments.length < 2) return chip;
    return {
      ...chip,
      fileName: `${segments.at(-2)}/${segments.at(-1)}`,
    };
  });
}

export function extractBatchDiffChips(
  entries: ReadonlyArray<ToolDisplayEntry>,
  workspacePath?: string | null
): TurnToolDiffChip[] {
  const byKey = new Map<string, TurnToolDiffChip>();

  for (const entry of entries) {
    if (
      entry.entry_type.type !== 'tool_use' ||
      entry.entry_type.action_type.action !== 'file_edit' ||
      entry.entry_type.status.status === 'failed'
    ) {
      continue;
    }
    const action = entry.entry_type.action_type;
    const fileEdits =
      entry.fileEdits && entry.fileEdits.length > 0
        ? entry.fileEdits
        : [{ path: action.path, changes: action.changes }];

    for (const edit of fileEdits) {
      const rawPath = edit.path.trim();
      if (!rawPath) continue;
      const resolvedPath = resolveToolFilePath(rawPath, workspacePath);
      const displayPath =
        deriveRelativeFilePath(resolvedPath, workspacePath) ?? rawPath;
      const key = displayPath.replace(/\\/g, '/');
      let acc = byKey.get(key);
      if (!acc) {
        acc = {
          key,
          rawPath,
          displayPath,
          resolvedPath,
          fileName: fileNameFromPath(displayPath),
          additions: 0,
          deletions: 0,
          previewLines: [],
        };
        byKey.set(key, acc);
      }
      for (const change of edit.changes) {
        const delta = countFileChangeDiff(change);
        acc.additions += delta.additions;
        acc.deletions += delta.deletions;
        appendPreviewLines(
          acc.previewLines,
          change,
          displayPath,
          workspacePath
        );
      }
    }
  }

  return disambiguateFileNames([...byKey.values()]);
}
