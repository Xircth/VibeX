import type { ConflictHunk } from '@/types/mergeConflict';

export type HunkChoice = 'ours' | 'theirs' | 'both';

export interface ParsedConflictBlock {
  blockIndex: number;
  startLine: number;
  endLine: number;
  ours: string;
  theirs: string;
}

function stripTrailingCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function hunkSignature(ours: string, theirs: string): string {
  return `${ours}\0${theirs}`;
}

export function parseConflictBlocks(result: string): ParsedConflictBlock[] {
  const lines = result.split('\n');
  const blocks: ParsedConflictBlock[] = [];
  let state: 'plain' | 'ours' | 'theirs' = 'plain';
  let startLine = -1;
  let ours: string[] = [];
  let theirs: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = stripTrailingCarriageReturn(lines[i]);
    if (line.startsWith('<<<<<<<')) {
      state = 'ours';
      startLine = i;
      ours = [];
      theirs = [];
      continue;
    }
    if (line.startsWith('=======') && state === 'ours') {
      state = 'theirs';
      continue;
    }
    if (line.startsWith('>>>>>>>') && state === 'theirs') {
      blocks.push({
        blockIndex: blocks.length,
        startLine,
        endLine: i,
        ours: ours.join('\n'),
        theirs: theirs.join('\n'),
      });
      state = 'plain';
      startLine = -1;
      continue;
    }
    if (state === 'ours') {
      ours.push(line);
    } else if (state === 'theirs') {
      theirs.push(line);
    }
  }

  return blocks;
}

export function getResolvedHunkIndices(
  result: string,
  hunks: readonly ConflictHunk[],
  resolvedOrder: readonly number[] = []
): Set<number> {
  const blocks = parseConflictBlocks(result);
  const blockCounts = new Map<string, number>();
  for (const block of blocks) {
    const sig = hunkSignature(block.ours, block.theirs);
    blockCounts.set(sig, (blockCounts.get(sig) ?? 0) + 1);
  }

  const hunksBySig = new Map<string, ConflictHunk[]>();
  for (const hunk of hunks) {
    const sig = hunkSignature(hunk.ours, hunk.theirs);
    const group = hunksBySig.get(sig) ?? [];
    group.push(hunk);
    hunksBySig.set(sig, group);
  }

  const resolved = new Set<number>();
  for (const [sig, group] of hunksBySig) {
    const remainingCount = blockCounts.get(sig) ?? 0;
    const resolvedCount = Math.max(0, group.length - remainingCount);
    if (resolvedCount === 0) continue;
    if (resolvedCount >= group.length) {
      for (const hunk of group) {
        resolved.add(hunk.index);
      }
      continue;
    }

    const groupIndices = new Set(group.map((h) => h.index));
    const orderedClicks = resolvedOrder.filter((idx) => groupIndices.has(idx));
    const keptClicks = orderedClicks.slice(0, resolvedCount);
    for (const idx of keptClicks) {
      resolved.add(idx);
    }
    let groupResolved = keptClicks.length;
    for (const hunk of group) {
      if (groupResolved >= resolvedCount) break;
      if (!resolved.has(hunk.index)) {
        resolved.add(hunk.index);
        groupResolved++;
      }
    }
  }

  return resolved;
}

export function applyConflictHunk(
  result: string,
  hunks: readonly ConflictHunk[],
  hunkIndex: number,
  choice: HunkChoice,
  resolvedIndices?: ReadonlySet<number>
): string {
  if (resolvedIndices?.has(hunkIndex)) return result;

  const hunk = hunks.find((item) => item.index === hunkIndex);
  if (!hunk) return result;

  const blocks = parseConflictBlocks(result);
  if (blocks.length === 0) return result;

  const sig = hunkSignature(hunk.ours, hunk.theirs);
  const matchingBlocks = blocks.filter(
    (block) => hunkSignature(block.ours, block.theirs) === sig
  );
  if (matchingBlocks.length === 0) return result;

  let targetBlock: ParsedConflictBlock | undefined;
  if (blocks.length === hunks.length) {
    const pos = hunks.findIndex((item) => item.index === hunkIndex);
    const candidate = pos >= 0 ? blocks[pos] : undefined;
    if (candidate && hunkSignature(candidate.ours, candidate.theirs) === sig) {
      targetBlock = candidate;
    }
  }

  if (!targetBlock) {
    const activeMatchingHunks = hunks.filter(
      (item) =>
        hunkSignature(item.ours, item.theirs) === sig &&
        !resolvedIndices?.has(item.index)
    );
    const ordinal = Math.max(
      0,
      activeMatchingHunks.findIndex((item) => item.index === hunkIndex)
    );
    targetBlock = matchingBlocks[Math.min(ordinal, matchingBlocks.length - 1)];
  }

  if (!targetBlock) return result;

  const replacement =
    choice === 'ours'
      ? hunk.ours
      : choice === 'theirs'
        ? hunk.theirs
        : [hunk.ours, hunk.theirs].filter((part) => part.length > 0).join('\n');

  const lines = result.split('\n');
  const replacementLines =
    replacement.length > 0 ? replacement.split('\n') : [];
  return [
    ...lines.slice(0, targetBlock.startLine),
    ...replacementLines,
    ...lines.slice(targetBlock.endLine + 1),
  ].join('\n');
}
