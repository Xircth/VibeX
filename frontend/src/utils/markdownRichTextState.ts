import {
  editorStateJSONToMarkdown,
  markdownToEditorStateJSON,
} from '@astryxdesign/richtext';

const FORMAT_BOLD = 1;
const FORMAT_ITALIC = 2;
const FORMAT_STRIKETHROUGH = 4;
const FORMAT_CODE = 16;

const WHITESPACE = /\s/;
const UNICODE_PUNCTUATION = /\p{P}/u;

const TAG_FORMAT: Record<string, number> = {
  '***': FORMAT_BOLD | FORMAT_ITALIC,
  ___: FORMAT_BOLD | FORMAT_ITALIC,
  '**': FORMAT_BOLD,
  __: FORMAT_BOLD,
  '*': FORMAT_ITALIC,
  _: FORMAT_ITALIC,
  '~~': FORMAT_STRIKETHROUGH,
};

type LexicalNode = {
  type?: string;
  text?: string;
  format?: number;
  children?: LexicalNode[];
  [key: string]: unknown;
};

type Delimiter = {
  active: boolean;
  canClose: boolean;
  canOpen: boolean;
  char: string;
  index: number;
  length: number;
};

type EmphasisMatch = {
  content: string;
  endIndex: number;
  startIndex: number;
  tag: string;
};

export function markdownToRichTextState(markdown: string): string {
  // YAML `---` under a paragraph is a setext underline to Lexical, so the
  // closing fence is joined into the summary line unless it is isolated.
  return applyUnicodeEmphasisToEditorState(
    markdownToEditorStateJSON(isolateYamlFrontmatter(markdown))
  );
}

export function richTextStateToMarkdown(editorStateJSON: string): string {
  return compactYamlFrontmatter(editorStateJSONToMarkdown(editorStateJSON));
}

export function isolateYamlFrontmatter(markdown: string): string {
  const parsed = parseLeadingYamlFrontmatter(markdown);
  if (!parsed) {
    return markdown;
  }
  return `---\n\n${parsed.body}\n\n---\n${parsed.rest}`;
}

export function compactYamlFrontmatter(markdown: string): string {
  const lines = markdown.split('\n');
  if (fenceLine(lines[0]) !== '---') {
    return markdown;
  }

  let bodyStart = 1;
  while (bodyStart < lines.length && fenceLine(lines[bodyStart]) === '') {
    bodyStart += 1;
  }

  for (let index = bodyStart; index < lines.length; index += 1) {
    if (fenceLine(lines[index]) !== '---') {
      continue;
    }
    if (index > 1 && fenceLine(lines[index - 1]) !== '') {
      return markdown;
    }

    const bodyLines = lines.slice(bodyStart, index);
    while (
      bodyLines.length > 0 &&
      fenceLine(bodyLines[bodyLines.length - 1]) === ''
    ) {
      bodyLines.pop();
    }
    const body = bodyLines.join('\n');
    if (!looksLikeYamlFrontmatter(body)) {
      return markdown;
    }
    const rest = lines.slice(index + 1).join('\n');
    return `---\n${body}\n---\n${rest}`;
  }

  return markdown;
}

function parseLeadingYamlFrontmatter(
  markdown: string
): { body: string; rest: string } | null {
  const lines = markdown.split('\n');
  if (fenceLine(lines[0]) !== '---') {
    return null;
  }

  for (let index = 1; index < lines.length; index += 1) {
    if (fenceLine(lines[index]) !== '---') {
      continue;
    }
    const body = lines.slice(1, index).join('\n');
    if (!looksLikeYamlFrontmatter(body)) {
      return null;
    }
    return {
      body,
      rest: lines.slice(index + 1).join('\n'),
    };
  }

  return null;
}

function fenceLine(line: string | undefined): string {
  return (line ?? '').replace(/\r$/, '').trimEnd();
}

function looksLikeYamlFrontmatter(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed === '') {
    return false;
  }
  const first = trimmed.split(/\r?\n/, 1)[0] ?? '';
  if (
    /^#{1,6}\s/.test(first) ||
    /^[-*+]\s/.test(first) ||
    /^\d+\.\s/.test(first)
  ) {
    return false;
  }
  return /^[\w.-]+\s*:/m.test(trimmed) || /^[^\s:#][^:\n]*:/m.test(trimmed);
}

export function applyUnicodeEmphasisToEditorState(
  editorStateJSON: string
): string {
  // Lexical only treats ASCII as flanking punctuation, so
  // `**name (Never-Share)**：` keeps literal asterisks. Unicode punctuation
  // is a valid closer in CommonMark.
  try {
    const state = JSON.parse(editorStateJSON) as { root?: LexicalNode };
    if (!state.root) {
      return editorStateJSON;
    }
    rewriteNode(state.root);
    return JSON.stringify(state);
  } catch {
    return editorStateJSON;
  }
}

function rewriteNode(node: LexicalNode): void {
  if (node.children) {
    node.children = node.children.flatMap((child) => {
      rewriteNode(child);
      if (typeof child.text === 'string') {
        return splitEmphasis(child);
      }
      return [child];
    });
  }
}

function splitEmphasis(node: LexicalNode): LexicalNode[] {
  const text = node.text ?? '';
  const format = node.format ?? 0;
  if ((format & FORMAT_CODE) !== 0 || !/[*_~]/.test(text)) {
    return [node];
  }

  const match = findOutermostEmphasis(text);
  if (!match) {
    return [node];
  }

  const tagFormat = TAG_FORMAT[match.tag] ?? 0;
  const before = text.slice(0, match.startIndex);
  const after = text.slice(match.endIndex);
  const nodes: LexicalNode[] = [];

  if (before) {
    nodes.push(...splitEmphasis(cloneTextNode(node, before, format)));
  }
  nodes.push(
    ...splitEmphasis(cloneTextNode(node, match.content, format | tagFormat))
  );
  if (after) {
    nodes.push(...splitEmphasis(cloneTextNode(node, after, format)));
  }
  return nodes.length > 0 ? nodes : [node];
}

function cloneTextNode(
  node: LexicalNode,
  text: string,
  format: number
): LexicalNode {
  return {
    ...node,
    format,
    text,
  };
}

function findOutermostEmphasis(text: string): EmphasisMatch | null {
  const delimiters = scanDelimiters(text);
  if (delimiters.length === 0) {
    return null;
  }
  return processEmphasis(text, delimiters);
}

function scanDelimiters(text: string): Delimiter[] {
  const delimiterChars = new Set(['*', '_', '~']);
  const delimiters: Delimiter[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (!delimiterChars.has(char) || isEscaped(text, index)) {
      index += 1;
      continue;
    }
    let length = 1;
    while (index + length < text.length && text[index + length] === char) {
      length += 1;
    }
    const canOpen = canEmphasis(char, text, index, length, true);
    const canClose = canEmphasis(char, text, index, length, false);
    if (canOpen || canClose) {
      delimiters.push({
        active: true,
        canClose,
        canOpen,
        char,
        index,
        length,
      });
    }
    index += length;
  }
  return delimiters;
}

function processEmphasis(
  text: string,
  delimiters: Delimiter[]
): EmphasisMatch | null {
  const openersBottom: Record<string, number> = {};
  let currentPos = 0;
  let result: EmphasisMatch | null = null;

  while (currentPos < delimiters.length) {
    const closer = delimiters[currentPos];
    if (!closer.active || !closer.canClose || closer.length === 0) {
      currentPos += 1;
      continue;
    }

    const bottomKey = `${closer.char}${closer.canOpen}${closer.length % 3}`;
    const bottom = openersBottom[bottomKey] ?? -1;
    let foundOpener = false;

    for (let openIdx = currentPos - 1; openIdx > bottom; openIdx -= 1) {
      const opener = delimiters[openIdx];
      if (
        !opener.active ||
        !opener.canOpen ||
        opener.length === 0 ||
        opener.char !== closer.char
      ) {
        continue;
      }

      if (opener.canClose || closer.canOpen) {
        const sum = opener.length + closer.length;
        if (
          sum % 3 === 0 &&
          opener.length % 3 !== 0 &&
          closer.length % 3 !== 0
        ) {
          continue;
        }
      }

      const maxLen = Math.min(opener.length, closer.length);
      const matchedTag = Object.keys(TAG_FORMAT)
        .filter((tag) => tag[0] === opener.char && tag.length <= maxLen)
        .sort((left, right) => right.length - left.length)[0];
      if (!matchedTag) {
        continue;
      }

      foundOpener = true;
      const matchLen = matchedTag.length;
      const match: EmphasisMatch = {
        content: text.slice(opener.index + opener.length, closer.index),
        endIndex: closer.index + matchLen,
        startIndex: opener.index + (opener.length - matchLen),
        tag: matchedTag,
      };
      if (
        !result ||
        match.startIndex < result.startIndex ||
        (match.startIndex === result.startIndex &&
          match.endIndex > result.endIndex)
      ) {
        result = match;
      }

      for (let skip = openIdx + 1; skip < currentPos; skip += 1) {
        delimiters[skip].active = false;
      }
      opener.length -= matchLen;
      closer.length -= matchLen;
      opener.active = opener.length > 0;
      if (closer.length > 0) {
        closer.index += matchLen;
      } else {
        closer.active = false;
        currentPos += 1;
      }
      break;
    }

    if (!foundOpener) {
      openersBottom[bottomKey] = currentPos - 1;
      if (!closer.canOpen) {
        closer.active = false;
      }
      currentPos += 1;
    }
  }

  return result;
}

function canEmphasis(
  char: string,
  text: string,
  index: number,
  length: number,
  isOpen: boolean
): boolean {
  if (!isFlanking(text, index, length, isOpen)) {
    return false;
  }
  if (char === '*' || char === '~') {
    return true;
  }
  if (char === '_') {
    if (!isFlanking(text, index, length, !isOpen)) {
      return true;
    }
    const adjacentChar = isOpen ? text[index - 1] : text[index + length];
    return adjacentChar !== undefined && UNICODE_PUNCTUATION.test(adjacentChar);
  }
  return true;
}

function isFlanking(
  text: string,
  index: number,
  length: number,
  isLeft: boolean
): boolean {
  const charBefore = text[index - 1];
  const charAfter = text[index + length];
  const [primary, secondary] = isLeft
    ? [charAfter, charBefore]
    : [charBefore, charAfter];
  if (primary === undefined || WHITESPACE.test(primary)) {
    return false;
  }
  if (!UNICODE_PUNCTUATION.test(primary)) {
    return true;
  }
  return (
    secondary === undefined ||
    WHITESPACE.test(secondary) ||
    UNICODE_PUNCTUATION.test(secondary)
  );
}

function isEscaped(text: string, index: number): boolean {
  let count = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && text[cursor] === '\\';
    cursor -= 1
  ) {
    count += 1;
  }
  return count % 2 === 1;
}
