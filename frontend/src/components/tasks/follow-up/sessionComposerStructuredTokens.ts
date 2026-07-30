import { isAgentMentionCodeContext } from './AgentMention';

export type SessionComposerCommandType = '@' | '/' | '$' | '#' | '&';

export type SessionComposerStructuredTokenKind =
  | 'slash'
  | 'dollar'
  | 'file'
  | 'tag'
  | 'element'
  | 'agent_mention';

export type SessionComposerStructuredToken = {
  kind: SessionComposerStructuredTokenKind;
  type: SessionComposerCommandType;
  key: string;
  label: string;
  value: string;
  raw: string;
  title?: string;
};

export type SessionComposerStructuredTokenSegment =
  | { kind: 'text'; text: string }
  | {
      kind: 'token';
      token: SessionComposerStructuredToken;
      start: number;
      end: number;
    };

type TokenSegment = Extract<
  SessionComposerStructuredTokenSegment,
  { kind: 'token' }
>;

type StructuredTokenOptions = {
  includeLegacyTokens?: boolean;
};

type PreviewElementTokenPayload = {
  componentName: string;
  filePath: string;
  fullMarkdown: string;
};

const LEGACY_PREVIEW_ELEMENT_PREFIX = 'element:';
const LEGACY_PREVIEW_ELEMENT_STORAGE_PREFIX =
  'vibex:session-composer-preview-element:';
const COMMAND_TYPES = new Set<SessionComposerCommandType>(['@', '/', '$', '#']);

function parseAgentMentionAt(
  source: string,
  start: number
): { token: SessionComposerStructuredToken; end: number } | null {
  if (source.slice(start, start + 2) !== '[&') return null;
  const namePart = readEscapedPart(source, start + 2, ']');
  if (
    !namePart ||
    source.slice(namePart.end + 1, namePart.end + 16) !== '(vibex://agent/'
  ) {
    return null;
  }

  const kindStart = namePart.end + 16;
  const kindEnd = source.indexOf(')', kindStart);
  if (kindEnd < 0 || kindEnd === kindStart) return null;

  let agentKind: string;
  try {
    agentKind = decodeURIComponent(source.slice(kindStart, kindEnd));
  } catch {
    return null;
  }
  const raw = source.slice(start, kindEnd + 1);
  return {
    token: {
      kind: 'agent_mention',
      type: '&',
      key: agentKind,
      label: `&${namePart.value}`,
      value: agentKind,
      raw,
      title: agentKind,
    },
    end: kindEnd + 1,
  };
}

function getFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function previewElementStorage(): Storage | null {
  return typeof window !== 'undefined' && window.sessionStorage
    ? window.sessionStorage
    : null;
}

function readLegacyPreviewElementPayloadFromStorage(
  tokenId: string
): PreviewElementTokenPayload | null {
  try {
    const stored = previewElementStorage()?.getItem(
      `${LEGACY_PREVIEW_ELEMENT_STORAGE_PREFIX}${tokenId}`
    );
    if (!stored) return null;

    const parsed = JSON.parse(stored) as Partial<PreviewElementTokenPayload>;
    if (
      typeof parsed.componentName !== 'string' ||
      typeof parsed.filePath !== 'string' ||
      typeof parsed.fullMarkdown !== 'string'
    ) {
      return null;
    }

    return {
      componentName: parsed.componentName,
      filePath: parsed.filePath,
      fullMarkdown: parsed.fullMarkdown,
    };
  } catch {
    return null;
  }
}

function decodeLegacyPreviewElementPayload(
  encoded: string
): PreviewElementTokenPayload | null {
  try {
    const parsed = JSON.parse(
      decodeURIComponent(encoded)
    ) as Partial<PreviewElementTokenPayload>;
    if (
      typeof parsed.componentName !== 'string' ||
      typeof parsed.filePath !== 'string' ||
      typeof parsed.fullMarkdown !== 'string'
    ) {
      return null;
    }

    return {
      componentName: parsed.componentName,
      filePath: parsed.filePath,
      fullMarkdown: parsed.fullMarkdown,
    };
  } catch {
    return null;
  }
}

function getLegacyPreviewElementPayload(
  tokenValue: string
): PreviewElementTokenPayload | null {
  return (
    readLegacyPreviewElementPayloadFromStorage(tokenValue) ??
    decodeLegacyPreviewElementPayload(tokenValue)
  );
}

function escapeCommandPart(value: string, closer: ']' | ')'): string {
  const pattern = closer === ']' ? /[\\\]]/g : /[\\)]/g;
  return value.replace(pattern, '\\$&');
}

function readEscapedPart(
  source: string,
  start: number,
  closer: ']' | ')'
): { value: string; end: number } | null {
  let cursor = start;
  let value = '';

  while (cursor < source.length) {
    const current = source.charAt(cursor);
    if (current === '\\') {
      const next = source.charAt(cursor + 1);
      if (!next) return null;
      value += next;
      cursor += 2;
      continue;
    }

    if (current === closer) {
      return { value, end: cursor };
    }

    value += current;
    cursor += 1;
  }

  return null;
}

function inferAtTokenKind(key: string, value: string): 'file' | 'element' {
  if (
    value.startsWith('From preview click:') ||
    value.includes('\n') ||
    value.includes('Selected start:')
  ) {
    return 'element';
  }

  if (!value || key === getFileName(value) || /[\\/]/.test(value)) {
    return 'file';
  }

  return 'element';
}

function createStructuredToken({
  type,
  key,
  value,
  raw,
}: {
  type: SessionComposerCommandType;
  key: string;
  value: string;
  raw: string;
}): SessionComposerStructuredToken {
  if (type === '/') {
    return {
      kind: 'slash',
      type,
      key,
      label: `/${key}`,
      value,
      raw,
    };
  }

  if (type === '$') {
    return {
      kind: 'dollar',
      type,
      key,
      label: `$${key}`,
      value,
      raw,
    };
  }

  if (type === '#') {
    return {
      kind: 'tag',
      type,
      key,
      label: `#${key}`,
      value,
      raw,
    };
  }

  const kind = inferAtTokenKind(key, value);
  return {
    kind,
    type,
    key,
    label: key,
    value,
    raw,
    title: value,
  };
}

function parseExplicitCommandAt(
  source: string,
  start: number
): { token: SessionComposerStructuredToken; end: number } | null {
  if (source.charAt(start) !== '[') return null;

  const type = source.charAt(start + 1) as SessionComposerCommandType;
  if (!COMMAND_TYPES.has(type) || source.charAt(start + 2) !== ':') {
    return null;
  }

  const keyPart = readEscapedPart(source, start + 3, ']');
  if (!keyPart || source.charAt(keyPart.end + 1) !== '(') {
    return null;
  }

  const valuePart = readEscapedPart(source, keyPart.end + 2, ')');
  if (!valuePart) {
    return null;
  }

  const raw = source.slice(start, valuePart.end + 1);
  return {
    token: createStructuredToken({
      type,
      key: keyPart.value,
      value: valuePart.value,
      raw,
    }),
    end: valuePart.end + 1,
  };
}

function isLegacyTokenBoundary(source: string, index: number): boolean {
  return index === 0 || /[\s(]/.test(source.charAt(index - 1));
}

function readLegacyTokenValue(
  source: string,
  start: number,
  blockedChars: string
): number {
  let cursor = start;

  while (cursor < source.length) {
    const current = source.charAt(cursor);
    if (/\s/.test(current) || blockedChars.includes(current)) {
      break;
    }
    cursor += 1;
  }

  return cursor;
}

function parseLegacyTokenAt(
  source: string,
  start: number
): { token: SessionComposerStructuredToken; end: number } | null {
  const type = source.charAt(start) as SessionComposerCommandType;
  if (!COMMAND_TYPES.has(type) || !isLegacyTokenBoundary(source, start)) {
    return null;
  }

  const blockedChars =
    type === '/' ? '/' : type === '$' ? '$' : type === '@' ? '#@' : '#@';
  const end = readLegacyTokenValue(source, start + 1, blockedChars);
  if (end <= start + 1) {
    return null;
  }

  const tokenValue = source.slice(start + 1, end);
  const raw = source.slice(start, end);

  if (type === '@' && tokenValue.startsWith(LEGACY_PREVIEW_ELEMENT_PREFIX)) {
    const payload = getLegacyPreviewElementPayload(
      tokenValue.slice(LEGACY_PREVIEW_ELEMENT_PREFIX.length)
    );
    if (payload) {
      return {
        token: createStructuredToken({
          type: '@',
          key: payload.componentName || 'Preview element',
          value: payload.fullMarkdown,
          raw,
        }),
        end,
      };
    }
  }

  const key =
    type === '@'
      ? getFileName(tokenValue)
      : tokenValue.startsWith(type)
        ? tokenValue.slice(1)
        : tokenValue;
  const value = type === '@' ? tokenValue : `${type}${tokenValue}`;

  return {
    token: createStructuredToken({
      type,
      key,
      value,
      raw,
    }),
    end,
  };
}

export function formatSessionComposerCommand({
  type,
  key,
  value,
}: {
  type: SessionComposerCommandType;
  key: string;
  value: string;
}): string {
  return `[${type}:${escapeCommandPart(key, ']')}](${escapeCommandPart(
    value,
    ')'
  )})`;
}

export function getSessionComposerStructuredTokenSegments(
  value: string,
  options: StructuredTokenOptions = {}
): SessionComposerStructuredTokenSegment[] {
  const includeLegacyTokens = options.includeLegacyTokens ?? false;
  const segments: SessionComposerStructuredTokenSegment[] = [];
  let cursor = 0;
  let scan = 0;

  while (scan < value.length) {
    const mention = isAgentMentionCodeContext(value, scan)
      ? null
      : parseAgentMentionAt(value, scan);
    if (mention) {
      if (scan > cursor) {
        segments.push({ kind: 'text', text: value.slice(cursor, scan) });
      }
      segments.push({
        kind: 'token',
        token: mention.token,
        start: scan,
        end: mention.end,
      });
      cursor = mention.end;
      scan = mention.end;
      continue;
    }

    const explicit = parseExplicitCommandAt(value, scan);
    if (explicit) {
      if (scan > cursor) {
        segments.push({ kind: 'text', text: value.slice(cursor, scan) });
      }

      segments.push({
        kind: 'token',
        token: explicit.token,
        start: scan,
        end: explicit.end,
      });
      cursor = explicit.end;
      scan = explicit.end;
      continue;
    }

    if (includeLegacyTokens) {
      const legacy = parseLegacyTokenAt(value, scan);
      if (legacy) {
        if (scan > cursor) {
          segments.push({ kind: 'text', text: value.slice(cursor, scan) });
        }

        segments.push({
          kind: 'token',
          token: legacy.token,
          start: scan,
          end: legacy.end,
        });
        cursor = legacy.end;
        scan = legacy.end;
        continue;
      }
    }

    scan += 1;
  }

  if (cursor < value.length) {
    segments.push({ kind: 'text', text: value.slice(cursor) });
  }

  return segments;
}

export function getSessionComposerStructuredTokens(
  value: string,
  options: StructuredTokenOptions = {}
): SessionComposerStructuredToken[] {
  return getSessionComposerStructuredTokenSegments(value, options).flatMap(
    (segment) => (segment.kind === 'token' ? [segment.token] : [])
  );
}

function tokenSegments(
  value: string,
  options: StructuredTokenOptions = {}
): TokenSegment[] {
  return getSessionComposerStructuredTokenSegments(value, options).filter(
    (segment): segment is TokenSegment => segment.kind === 'token'
  );
}

function findTokenForCollapsedDeletion(
  value: string,
  offset: number,
  direction: 'backward' | 'forward'
): TokenSegment | null {
  const normalizedOffset = Math.max(0, Math.min(offset, value.length));

  return (
    tokenSegments(value).find((segment) => {
      if (direction === 'backward') {
        return (
          normalizedOffset > segment.start && normalizedOffset <= segment.end
        );
      }

      return (
        normalizedOffset >= segment.start && normalizedOffset < segment.end
      );
    }) ?? null
  );
}

function expandRangeToIntersectingTokens(
  value: string,
  selectionStart: number,
  selectionEnd: number
): { start: number; end: number } | null {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  if (start === end) return null;

  const intersectingTokens = tokenSegments(value).filter(
    (segment) => segment.end > start && segment.start < end
  );
  if (intersectingTokens.length === 0) return null;

  return {
    start: Math.min(start, ...intersectingTokens.map((token) => token.start)),
    end: Math.max(end, ...intersectingTokens.map((token) => token.end)),
  };
}

function absorbAdjacentTokenSpace(
  value: string,
  start: number,
  end: number
): { start: number; end: number } {
  const hasLeadingSpace = start > 0 && /\s/.test(value.charAt(start - 1));
  const hasTrailingSpace = end < value.length && /\s/.test(value.charAt(end));

  if (hasLeadingSpace && hasTrailingSpace) {
    return { start, end: end + 1 };
  }

  if (start === 0 && hasTrailingSpace) {
    return { start, end: end + 1 };
  }

  if (end === value.length && hasLeadingSpace) {
    return { start: start - 1, end };
  }

  return { start, end };
}

function addTextBoundarySpacing({
  prefix,
  suffix,
  text,
}: {
  prefix: string;
  suffix: string;
  text: string;
}): string {
  const needsLeadingSpace =
    prefix.length > 0 && !/\s$/.test(prefix) && !/^\s/.test(text);
  const needsTrailingSpace =
    text.length > 0 &&
    !/\s$/.test(text) &&
    (suffix.length === 0 || !/^\s/.test(suffix));

  return `${needsLeadingSpace ? ' ' : ''}${text}${
    needsTrailingSpace ? ' ' : ''
  }`;
}

export function deleteSessionComposerStructuredToken({
  value,
  selectionStart,
  selectionEnd,
  direction,
}: {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  direction: 'backward' | 'forward';
}): { value: string; caretOffset: number } | null {
  const normalizedStart = Math.max(0, Math.min(selectionStart, value.length));
  const normalizedEnd = Math.max(
    normalizedStart,
    Math.min(selectionEnd, value.length)
  );

  const range =
    normalizedStart === normalizedEnd
      ? findTokenForCollapsedDeletion(value, normalizedStart, direction)
      : expandRangeToIntersectingTokens(value, normalizedStart, normalizedEnd);

  if (!range) return null;

  const deletionRange = absorbAdjacentTokenSpace(value, range.start, range.end);
  return {
    value: value.slice(0, deletionRange.start) + value.slice(deletionRange.end),
    caretOffset: deletionRange.start,
  };
}

export function serializeSessionComposerBackendMessage(value: string): string {
  return getSessionComposerStructuredTokenSegments(value)
    .map((segment) =>
      segment.kind === 'text'
        ? segment.text
        : segment.token.kind === 'agent_mention'
          ? segment.token.raw
          : segment.token.value
    )
    .join('');
}

function insertCommandToken({
  value,
  selectionStart,
  selectionEnd,
  command,
}: {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  command: string;
}): { value: string; caretOffset: number } {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const prefix = value.slice(0, start);
  const suffix = value.slice(end);
  const insertion = addTextBoundarySpacing({ prefix, suffix, text: command });
  const caretOffset =
    prefix.length +
    insertion.length +
    (!/\s$/.test(insertion) && /^\s/.test(suffix) ? 1 : 0);

  return {
    value: prefix + insertion + suffix,
    caretOffset,
  };
}

export function insertFileReferenceToken({
  value,
  selectionStart,
  selectionEnd,
  relativePath,
}: {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  relativePath: string;
}): { value: string; caretOffset: number } {
  return insertCommandToken({
    value,
    selectionStart,
    selectionEnd,
    command: formatSessionComposerCommand({
      type: '@',
      key: getFileName(relativePath),
      value: relativePath,
    }),
  });
}

export function insertPreviewElementToken({
  value,
  selectionStart,
  selectionEnd,
  componentName,
  filePath,
  fullMarkdown,
}: {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  componentName: string;
  filePath: string;
  fullMarkdown: string;
}): { value: string; caretOffset: number } {
  const key = componentName.trim() || getFileName(filePath) || 'Element';

  return insertCommandToken({
    value,
    selectionStart,
    selectionEnd,
    command: formatSessionComposerCommand({
      type: '@',
      key,
      value: fullMarkdown,
    }),
  });
}
