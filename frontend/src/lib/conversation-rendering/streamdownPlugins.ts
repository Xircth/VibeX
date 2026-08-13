import {
  replaceTagReferenceMarkersWithMarkdownLinks,
  stripTagReferenceAppendix,
} from '@/lib/tagReferenceMarkers';

export type ConversationMarkdownOptions = {
  softBreaks?: boolean;
};

function trimFilePathCandidate(value: string): string {
  return value
    .trim()
    .replace(/^['"`]+/, '')
    .replace(/['"`.,;]+$/, '')
    .replace(/[)\]}]+$/, '')
    .replace(/:(\d+)(?::\d+)?$/, '');
}

function isMarkdownImagePath(value: string): boolean {
  const candidate = trimFilePathCandidate(value);
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico)(?:[?#].*)?$/i.test(candidate);
}

function normalizeBareImageReferences(value: string): string {
  return value
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (
        !trimmed ||
        trimmed.startsWith('![') ||
        trimmed.startsWith('[') ||
        /\s/.test(trimmed) ||
        !isMarkdownImagePath(trimmed)
      ) {
        return line;
      }

      const label = trimmed.split(/[\\/]/).pop() ?? 'Image';
      return `${line.slice(0, line.indexOf(trimmed))}![${label}](${trimmed})`;
    })
    .join('\n');
}

function splitFencedCodeSegments(
  value: string
): Array<{ text: string; protected: boolean }> {
  const segments: Array<{ text: string; protected: boolean }> = [];
  const lines = value.match(/[^\n]*(?:\n|$)/g) ?? [];
  let buffer = '';
  let inFence = false;
  let fenceChar: '`' | '~' | null = null;
  let fenceLength = 0;

  const flush = (protectedSegment: boolean) => {
    if (!buffer) return;
    segments.push({ text: buffer, protected: protectedSegment });
    buffer = '';
  };

  for (const line of lines) {
    if (!line) continue;
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);

    if (!inFence && fenceMatch) {
      flush(false);
      inFence = true;
      fenceChar = fenceMatch[1][0] as '`' | '~';
      fenceLength = fenceMatch[1].length;
      buffer += line;
      continue;
    }

    if (inFence) {
      buffer += line;
      if (
        fenceMatch &&
        fenceChar &&
        fenceMatch[1][0] === fenceChar &&
        fenceMatch[1].length >= fenceLength
      ) {
        flush(true);
        inFence = false;
        fenceChar = null;
        fenceLength = 0;
      }
      continue;
    }

    buffer += line;
  }

  flush(inFence);
  return segments;
}

function normalizeInlineMathSegments(value: string): string {
  let result = '';
  let index = 0;

  while (index < value.length) {
    if (value[index] !== '`') {
      const nextTick = value.indexOf('`', index);
      const textSegment =
        nextTick === -1 ? value.slice(index) : value.slice(index, nextTick);
      result += convertTexMathDelimiters(textSegment);
      index = nextTick === -1 ? value.length : nextTick;
      continue;
    }

    const tickRunMatch = value.slice(index).match(/^`+/);
    const tickRun = tickRunMatch?.[0] ?? '`';
    const closingIndex = value.indexOf(tickRun, index + tickRun.length);

    if (closingIndex === -1) {
      result += value.slice(index);
      break;
    }

    result += value.slice(index, closingIndex + tickRun.length);
    index = closingIndex + tickRun.length;
  }

  return result;
}

function convertTexMathDelimiters(value: string): string {
  return value
    .replace(/\\\[([\s\S]+?)\\\]/g, (_match, content: string) => {
      return `$$${content}$$`;
    })
    .replace(/\\\(([\s\S]+?)\\\)/g, (_match, content: string) => {
      return `$${content}$`;
    });
}

function normalizeMathDelimiters(value: string): string {
  return splitFencedCodeSegments(value)
    .map((segment) =>
      segment.protected
        ? segment.text
        : normalizeInlineMathSegments(segment.text)
    )
    .join('');
}

function markdownTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  if (!trimmed.includes('|')) return [];

  return trimmed.split(/(?<!\\)\|/u).map((cell) => cell.trim());
}

function isMarkdownTableSeparator(line: string, columnCount: number): boolean {
  const cells = markdownTableCells(line);
  return (
    cells.length === columnCount &&
    cells.every((cell) => /^:?-{3,}:?$/u.test(cell))
  );
}

function normalizeLooseTableRowsInText(value: string): string {
  const lines = value.split('\n');
  const normalized: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const header = lines[index] ?? '';
    const headerCells = markdownTableCells(header);
    if (headerCells.length < 2) {
      normalized.push(header);
      index += 1;
      continue;
    }

    let separatorIndex = index + 1;
    while (lines[separatorIndex]?.trim() === '') separatorIndex += 1;
    if (
      separatorIndex >= lines.length ||
      !isMarkdownTableSeparator(lines[separatorIndex] ?? '', headerCells.length)
    ) {
      normalized.push(header);
      index += 1;
      continue;
    }

    normalized.push(header, lines[separatorIndex] ?? '');
    index = separatorIndex + 1;

    while (index < lines.length) {
      const gapStart = index;
      while (lines[index]?.trim() === '') index += 1;
      const row = lines[index];
      if (row && markdownTableCells(row).length === headerCells.length) {
        normalized.push(row);
        index += 1;
        continue;
      }

      normalized.push(...lines.slice(gapStart, index));
      break;
    }
  }

  return normalized.join('\n');
}

function normalizeLooseMarkdownTables(value: string): string {
  return splitFencedCodeSegments(value)
    .map((segment) =>
      segment.protected
        ? segment.text
        : normalizeLooseTableRowsInText(segment.text)
    )
    .join('');
}

function stabilizeUnclosedFencedCode(value: string): string {
  const lines = value.match(/[^\n]*(?:\n|$)/g) ?? [];
  let inFence = false;
  let fenceChar: '`' | '~' | null = null;
  let fenceLength = 0;
  let openFenceLineIndex = -1;
  let openFenceInfo = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})([^\n\r]*)/);
    if (!fenceMatch) continue;

    const currentFence = fenceMatch[2];
    if (!inFence) {
      inFence = true;
      fenceChar = currentFence[0] as '`' | '~';
      fenceLength = currentFence.length;
      openFenceLineIndex = index;
      openFenceInfo = fenceMatch[3]?.trim() ?? '';
      continue;
    }

    if (
      fenceChar &&
      currentFence[0] === fenceChar &&
      currentFence.length >= fenceLength
    ) {
      inFence = false;
      fenceChar = null;
      fenceLength = 0;
      openFenceLineIndex = -1;
      openFenceInfo = '';
    }
  }

  if (!inFence || !fenceChar || openFenceLineIndex < 0) {
    return value;
  }

  if (/^mermaid\b/i.test(openFenceInfo)) {
    lines[openFenceLineIndex] = lines[openFenceLineIndex].replace(
      /^(\s*)(`{3,}|~{3,})([^\n\r]*)/,
      '$1$2text'
    );
  }

  const body = lines.join('');
  const lineBreak = body.endsWith('\n') || body.length === 0 ? '' : '\n';
  return `${body}${lineBreak}${fenceChar.repeat(fenceLength)}`;
}

function isSoftBreakBlockBoundary(line: string): boolean {
  const trimmed = line.trim();
  return (
    !trimmed ||
    /^#{1,6}\s/.test(trimmed) ||
    /^([-*+]|\d+[.)])\s+/.test(trimmed) ||
    /^>/.test(trimmed) ||
    /^[-*_]{3,}$/.test(trimmed) ||
    /^\|.*\|$/.test(trimmed)
  );
}

function applySoftBreaksToText(value: string): string {
  const lines = value.split('\n');
  return lines
    .map((line, index) => {
      if (index === lines.length - 1) return line;

      const nextLine = lines[index + 1] ?? '';
      if (
        isSoftBreakBlockBoundary(line) ||
        isSoftBreakBlockBoundary(nextLine) ||
        /\s{2}$/.test(line) ||
        /\\$/.test(line)
      ) {
        return line;
      }

      return `${line}  `;
    })
    .join('\n');
}

function applySoftBreaks(value: string): string {
  return splitFencedCodeSegments(value)
    .map((segment) =>
      segment.protected ? segment.text : applySoftBreaksToText(segment.text)
    )
    .join('');
}

export function prepareConversationMarkdown(
  value: string,
  options: ConversationMarkdownOptions = {}
): string {
  const normalized = stabilizeUnclosedFencedCode(
    normalizeMathDelimiters(
      normalizeLooseMarkdownTables(
        normalizeBareImageReferences(
          replaceTagReferenceMarkersWithMarkdownLinks(
            stripTagReferenceAppendix(value)
          )
        )
      )
    )
  );

  return options.softBreaks ? applySoftBreaks(normalized) : normalized;
}
