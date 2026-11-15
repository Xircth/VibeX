import { getSessionComposerStructuredTokenSegments } from './sessionComposerStructuredTokens';

export const MAX_COMPOSER_STASH_ITEMS = 10;
export const COMPOSER_STASH_STORAGE_PREFIX = 'vibex:composer-draft-stash:';

export type ComposerStashedDraft = {
  id: string;
  text: string;
  createdAt: number;
  attachmentCount: number;
  images?: string[];
};

export type ComposerDraftStashItem = ComposerStashedDraft;

const fallbackMemoryStore = new Map<string, ComposerStashedDraft[]>();

export function composerStashStorageKey(scopeId?: string | null): string {
  const normalizedScope = scopeId?.trim() || 'global';
  return `${COMPOSER_STASH_STORAGE_PREFIX}${normalizedScope}`;
}

function getSafeLocalStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignore SecurityError / disabled storage
  }
  return null;
}

function normalizeImagePaths(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cleaned = raw.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0
  );
  return cleaned.length > 0 ? cleaned : undefined;
}

function areImageListsEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function isValidStashedDraft(entry: unknown): entry is ComposerStashedDraft {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = entry as Partial<ComposerStashedDraft>;
  const hasImages = Boolean(normalizeImagePaths(candidate.images)?.length);
  const hasAttachments =
    hasImages ||
    (typeof candidate.attachmentCount === 'number' &&
      Number.isFinite(candidate.attachmentCount) &&
      candidate.attachmentCount > 0);
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.text === 'string' &&
    (candidate.text.trim().length > 0 || hasAttachments) &&
    typeof candidate.createdAt === 'number' &&
    Number.isFinite(candidate.createdAt)
  );
}

function sanitizeStashList(raw: unknown): ComposerStashedDraft[] {
  if (!Array.isArray(raw)) return [];
  const valid: ComposerStashedDraft[] = [];
  for (const item of raw) {
    if (!isValidStashedDraft(item)) continue;
    const images = normalizeImagePaths(item.images);
    const rawCount =
      typeof item.attachmentCount === 'number' &&
      Number.isFinite(item.attachmentCount) &&
      item.attachmentCount > 0
        ? Math.floor(item.attachmentCount)
        : 0;
    const attachmentCount = images ? images.length : rawCount;
    valid.push({
      id: item.id,
      text: item.text,
      createdAt: item.createdAt,
      attachmentCount,
      ...(images ? { images } : {}),
    });
    if (valid.length >= MAX_COMPOSER_STASH_ITEMS) break;
  }
  return valid;
}

export function loadComposerDraftStash(
  scopeId?: string | null
): ComposerStashedDraft[] {
  const key = composerStashStorageKey(scopeId);
  const storage = getSafeLocalStorage();
  if (storage) {
    try {
      const raw = storage.getItem(key);
      if (raw != null) {
        const parsed = JSON.parse(raw) as unknown;
        const sanitized = sanitizeStashList(parsed);
        fallbackMemoryStore.set(key, sanitized);
        return sanitized;
      }
    } catch {
      // Fall back to in-memory copy on corrupt JSON or storage error
    }
  }
  return [...(fallbackMemoryStore.get(key) ?? [])];
}

function persistComposerDraftStash(
  scopeId: string | null | undefined,
  items: ComposerStashedDraft[]
): ComposerStashedDraft[] {
  const capped = items.slice(0, MAX_COMPOSER_STASH_ITEMS);
  const key = composerStashStorageKey(scopeId);
  fallbackMemoryStore.set(key, capped);

  const storage = getSafeLocalStorage();
  if (!storage) return capped;

  try {
    if (capped.length === 0) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, JSON.stringify(capped));
    }
    return capped;
  } catch {
    // QuotaExceededError fallback: progressively trim oldest entries
    for (let limit = capped.length - 1; limit >= 1; limit -= 1) {
      const trimmed = capped.slice(0, limit);
      try {
        storage.setItem(key, JSON.stringify(trimmed));
        fallbackMemoryStore.set(key, trimmed);
        return trimmed;
      } catch {
        // Continue trimming
      }
    }
    return capped;
  }
}

function createStashId(now: number): string {
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  return `stash-${now.toString(36)}-${randomSuffix}`;
}

export function pushComposerDraftStash(
  scopeId: string | null | undefined,
  input: {
    text: string;
    attachmentCount?: number;
    images?: string[];
    now?: number;
  }
): ComposerStashedDraft[] {
  const current = loadComposerDraftStash(scopeId);
  const images = normalizeImagePaths(input.images);
  const rawCount =
    typeof input.attachmentCount === 'number' &&
    Number.isFinite(input.attachmentCount) &&
    input.attachmentCount > 0
      ? Math.floor(input.attachmentCount)
      : 0;
  const attachmentCount = images ? images.length : rawCount;
  if (!input.text.trim() && attachmentCount === 0) {
    return current;
  }

  const now = input.now ?? Date.now();

  if (
    current[0] &&
    current[0].text === input.text &&
    areImageListsEqual(current[0].images, images)
  ) {
    const { images: _prevImages, ...restTop } = current[0];
    const updatedTop: ComposerStashedDraft = {
      ...restTop,
      createdAt: now,
      attachmentCount,
      ...(images ? { images } : {}),
    };
    return persistComposerDraftStash(scopeId, [
      updatedTop,
      ...current.slice(1),
    ]);
  }

  const entry: ComposerStashedDraft = {
    id: createStashId(now),
    text: input.text,
    createdAt: now,
    attachmentCount,
    ...(images ? { images } : {}),
  };
  return persistComposerDraftStash(scopeId, [entry, ...current]);
}

export function popComposerDraftStash(
  scopeId?: string | null,
  targetId?: string
): {
  popped: ComposerStashedDraft | null;
  items: ComposerStashedDraft[];
} {
  const current = loadComposerDraftStash(scopeId);
  if (current.length === 0) {
    return { popped: null, items: [] };
  }

  const index = targetId
    ? current.findIndex((item) => item.id === targetId)
    : 0;
  if (index < 0) {
    return { popped: null, items: current };
  }

  const popped = current[index] ?? null;
  const remaining = [
    ...current.slice(0, index),
    ...current.slice(index + 1),
  ];
  const persisted = persistComposerDraftStash(scopeId, remaining);
  return { popped, items: persisted };
}

export function removeComposerDraftStash(
  scopeId: string | null | undefined,
  id: string
): ComposerStashedDraft[] {
  const current = loadComposerDraftStash(scopeId);
  const next = current.filter((item) => item.id !== id);
  if (next.length === current.length) return current;
  return persistComposerDraftStash(scopeId, next);
}

export function reorderComposerDraftStash(
  scopeId: string | null | undefined,
  fromIndex: number,
  toIndex: number
): ComposerStashedDraft[] {
  const current = loadComposerDraftStash(scopeId);
  if (
    fromIndex < 0 ||
    fromIndex >= current.length ||
    toIndex < 0 ||
    toIndex >= current.length ||
    fromIndex === toIndex
  ) {
    return current;
  }

  const next = [...current];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return persistComposerDraftStash(scopeId, next);
}

export function clearComposerDraftStash(
  scopeId?: string | null
): ComposerStashedDraft[] {
  return persistComposerDraftStash(scopeId, []);
}

export function formatComposerStashPreview(
  text: string,
  maxChars = 50
): string {
  const readable = getSessionComposerStructuredTokenSegments(text)
    .map((segment) =>
      segment.kind === 'text' ? segment.text : segment.token.label
    )
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

  const chars = Array.from(readable);
  if (chars.length <= maxChars) return readable;
  return `${chars.slice(0, maxChars).join('')}…`;
}

export function formatComposerStashRelativeTime(
  createdAt: number,
  now: number,
  formatters: {
    justNow: string;
    minutesAgo: (count: number) => string;
    hoursAgo: (count: number) => string;
    daysAgo: (count: number) => string;
  }
): string {
  const diffSeconds = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (diffSeconds < 60) {
    return formatters.justNow;
  }
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) {
    return formatters.minutesAgo(minutes);
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return formatters.hoursAgo(hours);
  }
  const days = Math.floor(hours / 24);
  return formatters.daysAgo(days);
}
