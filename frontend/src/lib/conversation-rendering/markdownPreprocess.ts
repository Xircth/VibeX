import {
  replaceTagReferenceMarkersWithMarkdownLinks,
  stripTagReferenceAppendix,
} from '@/lib/tagReferenceMarkers';
import { MATH_ENVIRONMENTS } from './conversationMath';
import { hashMarkdownBlock } from './markdownBlockCache';
import { splitFencedCodeSegments } from './markdownFences';
import {
  isMarkdownTableSeparator,
  markdownTableCells,
  normalizeLooseTableRowsInText,
} from './markdownTables';

export const MATH_SPAN_PLACEHOLDER_PREFIX = '⟦VX_MATH_SPAN_';
const MATH_SPAN_PLACEHOLDER_REGEX = /⟦VX_MATH_SPAN_(\d+)⟧/g;

const TAG_APPENDIX_HEADING_REGEX =
  /(?:^|\n)( {0,3}##\s+(?:Tag References?|标签引用)[ \t]*(?=\n|$))/gi;

export interface PreprocessResult {
  body: string;
  tagAppendix: string | null;
  mathSpans: Map<number, string>;
}

export type MarkdownBlockKind =
  | 'heading'
  | 'blockquote'
  | 'list'
  | 'table'
  | 'hr'
  | 'code'
  | 'paragraph';

export interface MarkdownBlock {
  id: string;
  hash: string;
  text: string;
  kind: MarkdownBlockKind;
  closed: boolean;
}

function findInlineCodeCloseInParagraph(
  value: string,
  startIndex: number,
  targetRun: number
): number {
  let cursor = startIndex;
  while (cursor < value.length) {
    const ch = value[cursor];
    if (ch === '\n') {
      let nextNonSpace = cursor + 1;
      while (value[nextNonSpace] === ' ' || value[nextNonSpace] === '\t') {
        nextNonSpace += 1;
      }
      if (nextNonSpace >= value.length || value[nextNonSpace] === '\n') {
        return -1;
      }
      cursor += 1;
      continue;
    }
    if (ch === '`') {
      let run = 1;
      while (value[cursor + run] === '`') run += 1;
      if (run === targetRun) {
        return cursor;
      }
      cursor += run;
      continue;
    }
    cursor += 1;
  }
  return -1;
}

function matchBalancedMathEnvironment(
  value: string,
  index: number
): { raw: string; end: number } | null {
  if (!value.startsWith('\\begin{', index)) return null;
  const open = value.slice(index).match(/^\\begin\{([A-Za-z*]+)\}/);
  if (!open) return null;
  const envName = open[1];
  if (!MATH_ENVIRONMENTS.has(envName)) return null;

  const openTag = `\\begin{${envName}}`;
  const closeTag = `\\end{${envName}}`;
  let depth = 1;
  let search = index + openTag.length;

  while (search < value.length) {
    const nextOpen = value.indexOf(openTag, search);
    const nextClose = value.indexOf(closeTag, search);
    if (nextClose === -1) return null;

    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      search = nextOpen + openTag.length;
      continue;
    }

    depth -= 1;
    search = nextClose + closeTag.length;
    if (depth === 0) {
      return { raw: value.slice(index, search), end: search };
    }
  }

  return null;
}

function extractTrailingTagAppendix(value: string): {
  body: string;
  tagAppendix: string | null;
} {
  if (!value.includes('##')) {
    return { body: value, tagAppendix: null };
  }

  const segments = splitFencedCodeSegments(value);
  let offset = 0;
  let candidateStart = -1;

  for (const segment of segments) {
    if (segment.kind === 'text' && segment.text.includes('##')) {
      TAG_APPENDIX_HEADING_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = TAG_APPENDIX_HEADING_REGEX.exec(segment.text)) !== null) {
        const leadingBreak = match[0].startsWith('\n') ? 1 : 0;
        candidateStart = offset + match.index + leadingBreak;
      }

      if (candidateStart !== -1) {
        const afterHeading = segment.text.slice(
          Math.max(0, candidateStart - offset)
        );
        const firstNewline = afterHeading.indexOf('\n');
        if (firstNewline !== -1) {
          const rest = afterHeading.slice(firstNewline + 1);
          if (/(?:^|\n) {0,3}#{1,2}\s+/m.test(rest)) {
            candidateStart = -1;
          }
        }
      }
    }
    offset += segment.text.length;
  }

  if (candidateStart === -1) {
    return { body: value, tagAppendix: null };
  }

  const body = value.slice(0, candidateStart).replace(/\n+$/, '');
  const tagAppendix = value.slice(candidateStart).trimEnd();
  return {
    body,
    tagAppendix: tagAppendix.length > 0 ? tagAppendix : null,
  };
}

function protectMathSpansInTextSegment(
  value: string,
  mathSpans: Map<number, string>
): string {
  if (
    !value.includes('$$') &&
    !value.includes('\\[') &&
    !value.includes('\\begin{')
  ) {
    return value;
  }

  let out = '';
  let copyStart = 0;
  let index = 0;

  const pushSpan = (raw: string): string => {
    const id = mathSpans.size;
    mathSpans.set(id, raw);
    return `${MATH_SPAN_PLACEHOLDER_PREFIX}${id}⟧`;
  };

  while (index < value.length) {
    const ch = value[index];

    if (ch === '`') {
      let run = 1;
      while (value[index + run] === '`') run += 1;
      const close = findInlineCodeCloseInParagraph(value, index + run, run);
      if (close !== -1) {
        index = close + run;
        continue;
      }
      index += run;
      continue;
    }

    if (ch === '$' && value[index + 1] === '$') {
      const closeAt = value.indexOf('$$', index + 2);
      if (closeAt !== -1) {
        const end = closeAt + 2;
        out += value.slice(copyStart, index) + pushSpan(value.slice(index, end));
        index = end;
        copyStart = end;
        continue;
      }
    }

    if (ch === '\\') {
      const next = value[index + 1];
      if (next === '[') {
        const closeAt = value.indexOf('\\]', index + 2);
        if (closeAt !== -1) {
          const end = closeAt + 2;
          out +=
            value.slice(copyStart, index) + pushSpan(value.slice(index, end));
          index = end;
          copyStart = end;
          continue;
        }
      } else if (next === 'b' && value.startsWith('\\begin{', index)) {
        const env = matchBalancedMathEnvironment(value, index);
        if (env) {
          out += value.slice(copyStart, index) + pushSpan(env.raw);
          index = env.end;
          copyStart = env.end;
          continue;
        }
      }
    }

    index += 1;
  }

  if (copyStart === 0) return value;
  return out + value.slice(copyStart);
}

/**
 * VibeX markdown pre-pass executed before blank-line block splitting:
 * 1. Resolves VibeX inline tag markers and strips prompt-materialized tag suffixes,
 *    plus separates any trailing `## Tag Reference` / `## 标签引用` section.
 * 2. Replaces display/multi-line math (`$$...$$`, `\[...\]`, `\begin{env}...\end{env}`)
 *    outside code with single-line placeholders so internal blank lines never split TeX.
 * 3. Compacts loose GFM table rows across blank lines outside code fences.
 */
export function preprocessForBlockSplit(value: string): PreprocessResult {
  const mathSpans = new Map<number, string>();
  if (!value) {
    return { body: '', tagAppendix: null, mathSpans };
  }

  const normalized = value.includes('\r')
    ? value.replace(/\r\n?/g, '\n')
    : value;
  const withInlineTagLinks = normalized.includes('[[tag:')
    ? replaceTagReferenceMarkersWithMarkdownLinks(
        stripTagReferenceAppendix(normalized)
      )
    : normalized;
  const { body: rawBody, tagAppendix } =
    extractTrailingTagAppendix(withInlineTagLinks);

  if (!rawBody) {
    return { body: '', tagAppendix, mathSpans };
  }

  const segments = splitFencedCodeSegments(rawBody);
  if (segments.length === 1 && segments[0]?.kind === 'text') {
    const withProtectedMath = protectMathSpansInTextSegment(
      segments[0].text,
      mathSpans
    );
    return {
      body: normalizeLooseTableRowsInText(withProtectedMath),
      tagAppendix,
      mathSpans,
    };
  }

  let body = '';
  for (const segment of segments) {
    if (segment.kind !== 'text') {
      body += segment.text;
      continue;
    }
    const withProtectedMath = protectMathSpansInTextSegment(
      segment.text,
      mathSpans
    );
    body += normalizeLooseTableRowsInText(withProtectedMath);
  }

  return {
    body,
    tagAppendix,
    mathSpans,
  };
}

export function restoreMathSpans(
  value: string,
  mathSpans: Map<number, string>
): string {
  if (mathSpans.size === 0 || !value.includes(MATH_SPAN_PLACEHOLDER_PREFIX)) {
    return value;
  }
  return value.replace(MATH_SPAN_PLACEHOLDER_REGEX, (fullMatch, rawId) => {
    const restored = mathSpans.get(Number(rawId));
    return restored ?? fullMatch;
  });
}

function isBlankRange(value: string, start: number, end: number): boolean {
  for (let i = start; i < end; i += 1) {
    const ch = value[i];
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

function isIndentedListContinuation(
  value: string,
  start: number,
  end: number
): boolean {
  if (start >= end) return false;
  if (value[start] === '\t') return true;
  return end - start >= 2 && value[start] === ' ' && value[start + 1] === ' ';
}

function matchOpeningFenceAtLine(
  value: string,
  start: number,
  end: number
): { char: '`' | '~'; length: number } | null {
  let cursor = start;
  while (cursor < end && (value[cursor] === ' ' || value[cursor] === '\t')) {
    cursor += 1;
  }
  if (cursor >= end) return null;
  const ch = value[cursor];
  if (ch !== '`' && ch !== '~') return null;

  let run = 1;
  while (cursor + run < end && value[cursor + run] === ch) {
    run += 1;
  }
  if (run < 3) return null;

  if (ch === '`') {
    for (let i = cursor + run; i < end; i += 1) {
      if (value[i] === '`') return null;
    }
  }

  return { char: ch, length: run };
}

function isClosingFenceAtLine(
  value: string,
  start: number,
  end: number,
  fenceChar: '`' | '~',
  fenceLength: number
): boolean {
  let cursor = start;
  while (cursor < end && (value[cursor] === ' ' || value[cursor] === '\t')) {
    cursor += 1;
  }
  if (cursor >= end || value[cursor] !== fenceChar) return false;

  let run = 1;
  while (cursor + run < end && value[cursor + run] === fenceChar) {
    run += 1;
  }
  if (run < fenceLength) return false;

  for (let i = cursor + run; i < end; i += 1) {
    const ch = value[i];
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

function isListStartLine(value: string, start: number, end: number): boolean {
  const line = value.slice(start, Math.min(end, start + 32));
  return /^ {0,3}(?:[-*+]|\d+[.)])\s+/.test(line);
}

export function classifyMarkdownBlock(text: string): MarkdownBlockKind {
  const firstNewline = text.indexOf('\n');
  const firstLine = firstNewline === -1 ? text : text.slice(0, firstNewline);

  if (matchOpeningFenceAtLine(firstLine, 0, firstLine.length)) {
    return 'code';
  }

  if (
    firstNewline === -1 &&
    /^ {0,3}(?:-\s*){3,}$|^ {0,3}(?:\*\s*){3,}$|^ {0,3}(?:_\s*){3,}$/.test(
      firstLine
    )
  ) {
    return 'hr';
  }

  if (/^ {0,3}#{1,6}(?:\s|$)/.test(firstLine)) {
    return 'heading';
  }

  if (/^ {0,3}>/.test(firstLine)) {
    return 'blockquote';
  }

  if (/^ {0,3}(?:[-*+]|\d+[.)])\s+/.test(firstLine)) {
    return 'list';
  }

  if (firstNewline !== -1) {
    const headerCells = markdownTableCells(firstLine);
    if (headerCells.length >= 2) {
      const secondStart = firstNewline + 1;
      const secondNewline = text.indexOf('\n', secondStart);
      const secondLine =
        secondNewline === -1
          ? text.slice(secondStart)
          : text.slice(secondStart, secondNewline);
      if (isMarkdownTableSeparator(secondLine, headerCells.length)) {
        return 'table';
      }
    }
  }

  return 'paragraph';
}

/**
 * Single-pass O(N) blank-line splitter that respects fenced code blocks and
 * restores pre-extracted display-math placeholders per block.
 */
export function splitIntoBlocks(
  body: string,
  mathSpans: Map<number, string>,
  isStreaming = true
): MarkdownBlock[] {
  if (!body) return [];

  const rawSlices: string[] = [];
  const len = body.length;
  let pos = 0;
  let blockStart = -1;
  let blockEnd = -1;
  let sawBlankSinceBlockContent = false;
  let inFence = false;
  let fenceChar: '`' | '~' = '`';
  let fenceLen = 0;
  let currentBlockIsList = false;

  while (pos < len) {
    const newlineIdx = body.indexOf('\n', pos);
    const lineStart = pos;
    const lineEnd = newlineIdx === -1 ? len : newlineIdx;
    const nextPos = newlineIdx === -1 ? len : newlineIdx + 1;

    if (inFence) {
      if (isClosingFenceAtLine(body, lineStart, lineEnd, fenceChar, fenceLen)) {
        blockEnd = lineEnd;
        inFence = false;
        fenceLen = 0;
      } else {
        blockEnd = nextPos;
      }
      pos = nextPos;
      continue;
    }

    if (isBlankRange(body, lineStart, lineEnd)) {
      if (blockStart !== -1) {
        sawBlankSinceBlockContent = true;
      }
      pos = nextPos;
      continue;
    }

    if (sawBlankSinceBlockContent && blockStart !== -1) {
      if (
        currentBlockIsList &&
        isIndentedListContinuation(body, lineStart, lineEnd)
      ) {
        sawBlankSinceBlockContent = false;
      } else {
        rawSlices.push(body.slice(blockStart, blockEnd));
        blockStart = -1;
        blockEnd = -1;
        sawBlankSinceBlockContent = false;
        currentBlockIsList = false;
      }
    }

    if (blockStart === -1) {
      blockStart = lineStart;
      currentBlockIsList = isListStartLine(body, lineStart, lineEnd);
    }

    blockEnd = lineEnd;

    const openFence = matchOpeningFenceAtLine(body, lineStart, lineEnd);
    if (openFence) {
      inFence = true;
      fenceChar = openFence.char;
      fenceLen = openFence.length;
      blockEnd = newlineIdx === -1 ? lineEnd : nextPos;
    }

    pos = nextPos;
  }

  if (blockStart !== -1) {
    rawSlices.push(body.slice(blockStart, blockEnd));
  }

  const lastIndex = rawSlices.length - 1;
  return rawSlices.map((rawSlice, index) => {
    const text = restoreMathSpans(rawSlice, mathSpans);
    const hash = hashMarkdownBlock(text);
    return {
      id: hash,
      hash,
      text,
      kind: classifyMarkdownBlock(text),
      closed: isStreaming ? index < lastIndex : true,
    };
  });
}
