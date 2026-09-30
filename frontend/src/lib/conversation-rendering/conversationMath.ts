/**
 * Pull TeX out of conversation markdown before Astryx parses it.
 * Astryx treats every `\` as an escape (`\text` becomes `text`, `\[`
 * becomes `[`), so math that is not replaced with an opaque placeholder
 * is shown as garbled fragments.
 */

export type ConversationMathSegment = {
  tex: string;
  display: boolean;
};

export const MATH_PLACEHOLDER_PATTERN = /\uE000MATH(\d+)\uE000/g;

const MATH_FENCE_LANGUAGES = new Set(['math', 'latex', 'tex', 'katex']);

const MATH_ENVIRONMENTS = new Set([
  'align',
  'align*',
  'aligned',
  'alignedat',
  'alignedat*',
  'array',
  'bmatrix',
  'Bmatrix',
  'cases',
  'dcases',
  'darray',
  'eqnarray',
  'eqnarray*',
  'equation',
  'equation*',
  'gather',
  'gather*',
  'gathered',
  'matrix',
  'multline',
  'multline*',
  'pmatrix',
  'smallmatrix',
  'split',
  'subarray',
  'vmatrix',
  'Vmatrix',
]);

function isLineStart(value: string, index: number): boolean {
  return index === 0 || value[index - 1] === '\n';
}

function isDigit(char: string | undefined): boolean {
  return char != null && char >= '0' && char <= '9';
}

function isWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function matchFence(
  value: string,
  index: number
): { raw: string; lang: string; body: string; end: number } | null {
  if (!isLineStart(value, index)) return null;
  const open = value.slice(index).match(/^(\s*)(`{3,}|~{3,})([^\n]*)(?:\n|$)/);
  if (!open) return null;
  const indent = open[1];
  const ticks = open[2];
  const info = open[3]?.trim() ?? '';
  const lang = info.split(/\s+/)[0]?.toLowerCase() ?? '';
  const bodyStart = index + open[0].length;
  let search = bodyStart;
  while (search < value.length) {
    const lineStart = search;
    const lineEnd = value.indexOf('\n', search);
    const line =
      lineEnd === -1 ? value.slice(search) : value.slice(search, lineEnd);
    const close = line.match(/^(\s*)(`{3,}|~{3,})\s*$/);
    if (
      close &&
      close[2][0] === ticks[0] &&
      close[2].length >= ticks.length &&
      close[1].length <= indent.length
    ) {
      const end = lineEnd === -1 ? value.length : lineEnd + 1;
      return {
        raw: value.slice(index, end),
        lang,
        body: value.slice(bodyStart, lineStart),
        end,
      };
    }
    if (lineEnd === -1) break;
    search = lineEnd + 1;
  }
  return null;
}

function matchInlineCode(
  value: string,
  index: number
): { raw: string; end: number } | null {
  if (value[index] !== '`') return null;
  let ticks = 1;
  while (value[index + ticks] === '`') ticks += 1;
  const marker = '`'.repeat(ticks);
  const close = value.indexOf(marker, index + ticks);
  if (close === -1) return null;
  return { raw: value.slice(index, close + ticks), end: close + ticks };
}

function matchInlineDollar(
  value: string,
  index: number
): { tex: string; end: number } | null {
  if (value[index] !== '$' || value[index + 1] === '$') return null;
  if (index > 0 && value[index - 1] === '\\') return null;
  if (isDigit(value[index - 1])) return null;
  if (isWhitespace(value[index + 1])) return null;

  let cursor = index + 1;
  while (cursor < value.length) {
    const char = value[cursor];
    if (char === '\n' && value[cursor + 1] === '\n') return null;
    if (char === '$' && value[cursor - 1] !== '\\') {
      if (isWhitespace(value[cursor - 1])) return null;
      if (isDigit(value[cursor + 1])) {
        cursor += 1;
        continue;
      }
      if (cursor === index + 1) return null;
      return { tex: value.slice(index + 1, cursor), end: cursor + 1 };
    }
    cursor += 1;
  }
  return null;
}

function matchBeginEnvironment(
  value: string,
  index: number
): { tex: string; end: number } | null {
  if (!value.startsWith('\\begin{', index)) return null;
  const open = value.slice(index).match(/^\\begin\{([A-Za-z*]+)\}/);
  if (!open || !MATH_ENVIRONMENTS.has(open[1])) return null;
  const endTag = `\\end{${open[1]}}`;
  const close = value.indexOf(endTag, index + open[0].length);
  if (close === -1) return null;
  const end = close + endTag.length;
  return { tex: value.slice(index, end), end };
}

function delimitedSpan(
  value: string,
  index: number,
  open: string,
  close: string
): { tex: string; end: number } | null {
  if (!value.startsWith(open, index)) return null;
  const closeAt = value.indexOf(close, index + open.length);
  if (closeAt === -1) return null;
  return {
    tex: value.slice(index + open.length, closeAt),
    end: closeAt + close.length,
  };
}

export function protectConversationMath(value: string): {
  text: string;
  math: ConversationMathSegment[];
} {
  const math: ConversationMathSegment[] = [];
  let text = '';
  let index = 0;

  const pushMath = (tex: string, display: boolean) => {
    const placeholder = `\uE000MATH${math.length}\uE000`;
    math.push({ tex: tex.replace(/^\n+|\n+$/g, ''), display });
    if (display) {
      const prefix = text.endsWith('\n') || text.length === 0 ? '' : '\n\n';
      text += `${prefix}${placeholder}\n\n`;
    } else {
      text += placeholder;
    }
  };

  while (index < value.length) {
    const fence = matchFence(value, index);
    if (fence) {
      if (MATH_FENCE_LANGUAGES.has(fence.lang)) {
        pushMath(fence.body, true);
      } else {
        text += fence.raw;
      }
      index = fence.end;
      continue;
    }

    const inlineCode = matchInlineCode(value, index);
    if (inlineCode) {
      text += inlineCode.raw;
      index = inlineCode.end;
      continue;
    }

    const displayDollar = delimitedSpan(value, index, '$$', '$$');
    if (displayDollar) {
      pushMath(displayDollar.tex, true);
      index = displayDollar.end;
      continue;
    }

    const displayBracket = delimitedSpan(value, index, '\\[', '\\]');
    if (displayBracket) {
      pushMath(displayBracket.tex, true);
      index = displayBracket.end;
      continue;
    }

    const inlineParen = delimitedSpan(value, index, '\\(', '\\)');
    if (inlineParen) {
      pushMath(inlineParen.tex, false);
      index = inlineParen.end;
      continue;
    }

    const environment = matchBeginEnvironment(value, index);
    if (environment) {
      pushMath(environment.tex, true);
      index = environment.end;
      continue;
    }

    const inlineDollar = matchInlineDollar(value, index);
    if (inlineDollar) {
      pushMath(inlineDollar.tex, false);
      index = inlineDollar.end;
      continue;
    }

    text += value[index];
    index += 1;
  }

  return { text, math };
}
