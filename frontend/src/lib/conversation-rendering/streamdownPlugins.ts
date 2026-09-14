import {
  replaceTagReferenceMarkersWithMarkdownLinks,
  stripTagReferenceAppendix,
} from '@/lib/tagReferenceMarkers';

export type ConversationMarkdownOptions = {
  softBreaks?: boolean;
};

type FenceSegmentKind = 'text' | 'closedFence' | 'openFence';

type FenceSegment = {
  text: string;
  kind: FenceSegmentKind;
};

export type ConversationMarkdownPrepareCache = {
  softBreaks: boolean;
  parts: Array<{ source: string; kind: FenceSegmentKind; prepared: string }>;
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

function splitFencedCodeSegments(value: string): FenceSegment[] {
  const segments: FenceSegment[] = [];
  const lines = value.match(/[^\n]*(?:\n|$)/g) ?? [];
  let buffer = '';
  let inFence = false;
  let fenceChar: '`' | '~' | null = null;
  let fenceLength = 0;

  const flush = (kind: FenceSegmentKind) => {
    if (!buffer) return;
    segments.push({ text: buffer, kind });
    buffer = '';
  };

  for (const line of lines) {
    if (!line) continue;
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);

    if (!inFence && fenceMatch) {
      flush('text');
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
        flush('closedFence');
        inFence = false;
        fenceChar = null;
        fenceLength = 0;
      }
      continue;
    }

    buffer += line;
  }

  flush(inFence ? 'openFence' : 'text');
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

export function applySoftBreaks(value: string): string {
  return splitFencedCodeSegments(value)
    .map((segment) =>
      segment.kind === 'text'
        ? applySoftBreaksToText(segment.text)
        : segment.text
    )
    .join('');
}

function transformTextSegment(
  text: string,
  options: ConversationMarkdownOptions
): string {
  const withImages = normalizeBareImageReferences(text);
  const withTables = normalizeLooseTableRowsInText(withImages);
  const withMath = normalizeInlineMathSegments(withTables);
  return options.softBreaks ? applySoftBreaksToText(withMath) : withMath;
}

function transformSegment(
  segment: FenceSegment,
  options: ConversationMarkdownOptions
): string {
  return segment.kind === 'text'
    ? transformTextSegment(segment.text, options)
    : segment.text;
}

export function prepareConversationMarkdownCached(
  value: string,
  options: ConversationMarkdownOptions = {},
  cache: ConversationMarkdownPrepareCache | null = null
): { text: string; cache: ConversationMarkdownPrepareCache } {
  const tagged = replaceTagReferenceMarkersWithMarkdownLinks(
    stripTagReferenceAppendix(value)
  );
  const segments = splitFencedCodeSegments(tagged);
  const softBreaks = Boolean(options.softBreaks);
  const reusableCache = cache?.softBreaks === softBreaks ? cache : null;
  const parts = segments.map((segment, index) => {
    const cached = reusableCache?.parts[index];
    if (
      cached &&
      cached.source === segment.text &&
      cached.kind === segment.kind
    ) {
      return cached;
    }
    return {
      source: segment.text,
      kind: segment.kind,
      prepared: transformSegment(segment, options),
    };
  });

  return {
    text: stabilizeUnclosedFencedCode(
      parts.map((part) => part.prepared).join('')
    ),
    cache: { softBreaks, parts },
  };
}

export function prepareConversationMarkdown(
  value: string,
  options: ConversationMarkdownOptions = {}
): string {
  return prepareConversationMarkdownCached(value, options).text;
}
