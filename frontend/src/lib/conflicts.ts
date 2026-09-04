import type { ConflictOp } from 'shared/types';
import type { ConflictFileDetail } from '@/types/mergeConflict';

export function displayConflictOpLabel(op?: ConflictOp | null): string {
  switch (op) {
    case 'merge':
      return 'Merge';
    case 'cherry_pick':
      return 'Cherry-pick';
    case 'revert':
      return 'Revert';
    case 'rebase':
    default:
      return 'Rebase';
  }
}

function formatConflictHeader(
  op: ConflictOp | null | undefined,
  sourceBranch: string,
  baseBranch?: string,
  repoName?: string
): string {
  const repoContext = repoName ? ` in repository '${repoName}'` : '';
  switch (op) {
    case 'merge':
      return `Merge conflicts while merging into '${sourceBranch}'${repoContext}.`;
    case 'cherry_pick':
      return `Cherry-pick conflicts on '${sourceBranch}'${repoContext}.`;
    case 'revert':
      return `Revert conflicts on '${sourceBranch}'${repoContext}.`;
    case 'rebase':
    default:
      return `Rebase conflicts while rebasing '${sourceBranch}' onto '${baseBranch ?? 'base branch'}'${repoContext}.`;
  }
}

export function buildResolveConflictsInstructions(
  sourceBranch: string | null,
  baseBranch: string | undefined,
  conflictedFiles: string[],
  op?: ConflictOp | null,
  repoName?: string,
  fileDetail?: ConflictFileDetail | null
): string {
  const source = sourceBranch || 'current attempt branch';
  const base = baseBranch ?? 'base branch';
  const filesList = conflictedFiles.slice(0, 12);
  const filesBlock = filesList.length
    ? `\n\nFiles with conflicts:\n${filesList.map((f) => `- ${f}`).join('\n')}`
    : '';
  const stagesBlock = fileDetail ? formatStagePrompt(fileDetail) : '';

  const opTitle = displayConflictOpLabel(op);
  const header = formatConflictHeader(op, source, base, repoName);

  return (
    `${header}` +
    filesBlock +
    stagesBlock +
    `\n\nPlease resolve each file carefully. When continuing, ensure the ${opTitle.toLowerCase()} does not hang (set \`GIT_EDITOR=true\` or use a non-interactive editor).`
  );
}

function formatStagePrompt(detail: ConflictFileDetail): string {
  const hunks = detail.hunks
    .map(
      (hunk) =>
        `\nHunk ${hunk.index + 1}\nOurs:\n${hunk.ours}\nTheirs:\n${hunk.theirs}`
    )
    .join('');
  return (
    `\n\nFile: ${detail.path}` +
    formatStage('Base', detail.base.present, detail.base.content) +
    formatStage('Ours', detail.ours.present, detail.ours.content) +
    formatStage('Theirs', detail.theirs.present, detail.theirs.content) +
    hunks
  );
}

function formatStage(
  label: string,
  present: boolean,
  content: string | null | undefined
): string {
  if (!present) return `\n\n${label}: missing`;
  return `\n\n${label}:\n${content ?? ''}`;
}
