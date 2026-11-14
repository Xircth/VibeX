/**
 * Fence helpers shared by preprocessing, block splitting, and rendering.
 * Extracted from `streamdownPlugins.ts` so the block pipeline can use them
 * without creating an import cycle.
 */

export type FenceSegmentKind = 'text' | 'closedFence' | 'openFence';

export type FenceSegment = {
  text: string;
  kind: FenceSegmentKind;
};

/** Fence language tags that carry TeX math rather than code. */
export const MATH_FENCE_LANGUAGES: ReadonlySet<string> = new Set([
  'math',
  'latex',
  'tex',
  'katex',
]);

function hasPotentialFence(value: string): boolean {
  return value.includes('```') || value.includes('~~~');
}

function matchOpeningFenceAtRange(
  value: string,
  start: number,
  end: number
): { char: '`' | '~'; length: number; info: string } | null {
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

  const infoStart = cursor + run;
  if (ch === '`') {
    for (let i = infoStart; i < end; i += 1) {
      if (value[i] === '`') return null;
    }
  }

  return {
    char: ch,
    length: run,
    info: value.slice(infoStart, end).trim(),
  };
}

function isClosingFenceAtRange(
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
    if (ch !== ' ' && ch !== '\t' && ch !== '\r') return false;
  }
  return true;
}

export function splitFencedCodeSegments(value: string): FenceSegment[] {
  if (!value) return [];
  if (!hasPotentialFence(value)) {
    return [{ text: value, kind: 'text' }];
  }

  const segments: FenceSegment[] = [];
  const len = value.length;
  let pos = 0;
  let segmentStart = 0;
  let inFence = false;
  let fenceChar: '`' | '~' = '`';
  let fenceLength = 0;

  while (pos < len) {
    const newlineIdx = value.indexOf('\n', pos);
    const lineEnd = newlineIdx === -1 ? len : newlineIdx;
    const nextPos = newlineIdx === -1 ? len : newlineIdx + 1;

    if (!inFence) {
      const open = matchOpeningFenceAtRange(value, pos, lineEnd);
      if (open) {
        if (pos > segmentStart) {
          segments.push({ text: value.slice(segmentStart, pos), kind: 'text' });
        }
        segmentStart = pos;
        inFence = true;
        fenceChar = open.char;
        fenceLength = open.length;
      }
      pos = nextPos;
      continue;
    }

    if (isClosingFenceAtRange(value, pos, lineEnd, fenceChar, fenceLength)) {
      segments.push({
        text: value.slice(segmentStart, nextPos),
        kind: 'closedFence',
      });
      segmentStart = nextPos;
      inFence = false;
      fenceLength = 0;
    }
    pos = nextPos;
  }

  if (segmentStart < len) {
    segments.push({
      text: value.slice(segmentStart),
      kind: inFence ? 'openFence' : 'text',
    });
  }

  return segments;
}

/**
 * Close a still-open fence at end of input so a partially streamed code block
 * renders as code instead of leaking its body as prose. Incomplete Mermaid
 * fences fall back to `text` because a half-written diagram cannot render.
 */
export function stabilizeUnclosedFencedCode(value: string): string {
  if (!value || !hasPotentialFence(value)) {
    return value;
  }

  const len = value.length;
  let pos = 0;
  let inFence = false;
  let fenceChar: '`' | '~' = '`';
  let fenceLength = 0;
  let openFenceLineStart = -1;
  let openFenceLineEnd = -1;
  let openFenceInfo = '';

  while (pos < len) {
    const newlineIdx = value.indexOf('\n', pos);
    const lineEnd = newlineIdx === -1 ? len : newlineIdx;
    const nextPos = newlineIdx === -1 ? len : newlineIdx + 1;

    if (!inFence) {
      const open = matchOpeningFenceAtRange(value, pos, lineEnd);
      if (open) {
        inFence = true;
        fenceChar = open.char;
        fenceLength = open.length;
        openFenceLineStart = pos;
        openFenceLineEnd = lineEnd;
        openFenceInfo = open.info;
      }
      pos = nextPos;
      continue;
    }

    if (isClosingFenceAtRange(value, pos, lineEnd, fenceChar, fenceLength)) {
      inFence = false;
      fenceLength = 0;
      openFenceLineStart = -1;
      openFenceLineEnd = -1;
      openFenceInfo = '';
    }
    pos = nextPos;
  }

  if (!inFence || openFenceLineStart < 0) {
    return value;
  }

  let body = value;
  if (/^mermaid\b/i.test(openFenceInfo)) {
    const openLine = value
      .slice(openFenceLineStart, openFenceLineEnd)
      .replace(/^(\s*)(`{3,}|~{3,})([^\n\r]*)/, '$1$2text');
    body = `${value.slice(0, openFenceLineStart)}${openLine}${value.slice(openFenceLineEnd)}`;
  }

  const lineBreak = body.endsWith('\n') || body.length === 0 ? '' : '\n';
  return `${body}${lineBreak}${fenceChar.repeat(fenceLength)}`;
}

/** Language tag of the first fence line in a block, lowercased. */
export function fenceInfoLanguage(value: string): string {
  const match = value.match(/^\s*(?:`{3,}|~{3,})([^\n]*)/);
  if (!match) return '';
  return (match[1] ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
}

export function isMathFenceLanguage(language: string): boolean {
  return MATH_FENCE_LANGUAGES.has(language);
}

/**
 * Astryx reads the fence info string up to the first whitespace, so languages
 * containing `-` or `+` (for example `ts-hooks`) must be encoded first.
 */
export function encodeFenceInfoLanguages(markdownText: string): string {
  if (!hasPotentialFence(markdownText)) return markdownText;
  return markdownText.replace(
    /^(`{3,}|~{3,})([A-Za-z0-9_+-]+)/gm,
    (_match, fence: string, lang: string) => {
      if (!lang.includes('-') && !lang.includes('+')) {
        return `${fence}${lang}`;
      }
      const encoded = lang
        .replace(/-/g, '__vx_dash__')
        .replace(/\+/g, '__vx_plus__');
      return `${fence}${encoded}`;
    }
  );
}

export function decodeFenceInfoLanguage(language?: string): string | undefined {
  if (!language) return language;
  return language.replace(/__vx_dash__/g, '-').replace(/__vx_plus__/g, '+');
}
