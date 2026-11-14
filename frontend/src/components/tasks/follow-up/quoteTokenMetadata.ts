export type QuoteTokenMetadata = {
  conversationId?: string;
  turnId?: string;
  messageId?: string;
  blockIndex?: number;
  utf16Offset?: number;
  prefixAnchor?: string;
  suffixAnchor?: string;
  annotation?: string;
};

export type QuoteTokenInputMetadata = QuoteTokenMetadata & {
  comment?: string;
};

const QUOTE_HEADER_BASE = ':quote';
const QUOTE_HEADER_PREFIX = ':quote|';
const MAX_ANCHOR_CONTEXT_CHARS = 20;

function normalizeNonNegativeInt(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function normalizeQuoteTokenMetadata(
  input?: QuoteTokenInputMetadata | null
): QuoteTokenMetadata | undefined {
  if (!input) return undefined;

  const conversationId = input.conversationId?.trim() || undefined;
  const turnId = input.turnId?.trim() || undefined;
  const messageId = input.messageId?.trim() || undefined;
  const blockIndex = normalizeNonNegativeInt(input.blockIndex);
  const utf16Offset = normalizeNonNegativeInt(input.utf16Offset);
  const prefixAnchor = input.prefixAnchor
    ? input.prefixAnchor.slice(-MAX_ANCHOR_CONTEXT_CHARS)
    : undefined;
  const suffixAnchor = input.suffixAnchor
    ? input.suffixAnchor.slice(0, MAX_ANCHOR_CONTEXT_CHARS)
    : undefined;
  const rawNote = input.annotation ?? input.comment;
  const annotation = rawNote?.trim() || undefined;

  if (
    !conversationId &&
    !turnId &&
    !messageId &&
    blockIndex === undefined &&
    utf16Offset === undefined &&
    !prefixAnchor &&
    !suffixAnchor &&
    !annotation
  ) {
    return undefined;
  }

  return {
    ...(conversationId ? { conversationId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(blockIndex !== undefined ? { blockIndex } : {}),
    ...(utf16Offset !== undefined ? { utf16Offset } : {}),
    ...(prefixAnchor ? { prefixAnchor } : {}),
    ...(suffixAnchor ? { suffixAnchor } : {}),
    ...(annotation ? { annotation } : {}),
  };
}

export function hasQuoteSourceAnchor(
  metadata?: QuoteTokenMetadata | null
): boolean {
  return Boolean(metadata?.turnId || metadata?.messageId);
}

export function encodeQuoteTokenHeader(
  metadata?: QuoteTokenInputMetadata | null
): string {
  const normalized = normalizeQuoteTokenMetadata(metadata);
  if (!normalized) return QUOTE_HEADER_BASE;

  const params = new URLSearchParams();
  if (normalized.conversationId) params.set('conv', normalized.conversationId);
  if (normalized.turnId) params.set('turn', normalized.turnId);
  if (normalized.messageId) params.set('msg', normalized.messageId);
  if (normalized.blockIndex !== undefined) {
    params.set('block', String(normalized.blockIndex));
  }
  if (normalized.utf16Offset !== undefined) {
    params.set('off', String(normalized.utf16Offset));
  }
  if (normalized.prefixAnchor) params.set('pre', normalized.prefixAnchor);
  if (normalized.suffixAnchor) params.set('suf', normalized.suffixAnchor);
  if (normalized.annotation) params.set('note', normalized.annotation);

  const query = params.toString();
  return query ? `${QUOTE_HEADER_PREFIX}${query}` : QUOTE_HEADER_BASE;
}

function parseOptionalIntParam(raw: string | null): number | undefined {
  if (raw == null || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

export function decodeQuoteTokenHeader(header: string): {
  valid: boolean;
  metadata?: QuoteTokenMetadata;
} {
  if (header === QUOTE_HEADER_BASE) {
    return { valid: true };
  }
  if (!header.startsWith(QUOTE_HEADER_PREFIX)) {
    return { valid: false };
  }

  const query = header.slice(QUOTE_HEADER_PREFIX.length);
  const params = new URLSearchParams(query);
  const metadata = normalizeQuoteTokenMetadata({
    conversationId: params.get('conv') ?? undefined,
    turnId: params.get('turn') ?? undefined,
    messageId: params.get('msg') ?? undefined,
    blockIndex: parseOptionalIntParam(params.get('block')),
    utf16Offset: parseOptionalIntParam(params.get('off')),
    prefixAnchor: params.get('pre') ?? undefined,
    suffixAnchor: params.get('suf') ?? undefined,
    annotation: params.get('note') ?? undefined,
  });

  return { valid: true, metadata };
}

export function serializeQuoteTokenForPrompt(
  value: string,
  metadata: QuoteTokenMetadata | undefined,
  formatPlainQuote: (context: string) => string
): string {
  const plainQuote = formatPlainQuote(value);
  const note = metadata?.annotation?.replace(/\s+/g, ' ').trim();
  if (!note) return plainQuote;
  return `${plainQuote} (Note: ${note})`;
}
