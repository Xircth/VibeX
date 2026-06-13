import type { JsonValue } from 'shared/types';

/** Narrow a JsonValue to a plain object (not array, not null). */
export function isRecord(value: JsonValue | null | undefined): value is {
  [key: string]: JsonValue | undefined;
} {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Return the first non-empty string found at any of `keys` on a record value.
 * Accepts a single key or a prioritized list.
 */
export function readString(
  value: JsonValue | null | undefined,
  keys: string | string[]
): string | null {
  if (!isRecord(value)) return null;
  const keyList = Array.isArray(keys) ? keys : [keys];
  for (const key of keyList) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }
  return null;
}
