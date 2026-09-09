import { readLocalStorage, writeLocalStorage } from '@/lib/safeStorage';
import {
  BLANK_PAGE,
  browserUrlsEquivalent,
  normalizeBrowserUrl,
} from './browserUrl';

export const BROWSER_ADDRESS_HISTORY_KEY = 'vibex:browser-address-history';
export const BROWSER_ADDRESS_HISTORY_LIMIT = 50;
export const BROWSER_ADDRESS_SUGGESTION_LIMIT = 8;

function isRecordableAddress(url: string): boolean {
  return (
    url !== BLANK_PAGE && !url.startsWith('data:') && !url.startsWith('about:')
  );
}

function parseHistory(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is string =>
        typeof entry === 'string' && isRecordableAddress(entry)
    );
  } catch {
    return [];
  }
}

export function readBrowserAddressHistory(): string[] {
  return parseHistory(readLocalStorage(BROWSER_ADDRESS_HISTORY_KEY));
}

export function recordBrowserAddress(url: string): string[] {
  const normalized = normalizeBrowserUrl(url);
  if (!isRecordableAddress(normalized)) {
    return readBrowserAddressHistory();
  }
  const next = [
    normalized,
    ...readBrowserAddressHistory().filter(
      (entry) => !browserUrlsEquivalent(entry, normalized)
    ),
  ].slice(0, BROWSER_ADDRESS_HISTORY_LIMIT);
  writeLocalStorage(BROWSER_ADDRESS_HISTORY_KEY, JSON.stringify(next));
  return next;
}

export function suggestBrowserAddresses(
  query: string,
  history = readBrowserAddressHistory()
): string[] {
  const needle = query
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '');
  const matches = needle
    ? history.filter((entry) => {
        const haystack = entry.toLowerCase().replace(/^https?:\/\//, '');
        return (
          haystack.includes(needle) || entry.toLowerCase().includes(needle)
        );
      })
    : history;
  return matches.slice(0, BROWSER_ADDRESS_SUGGESTION_LIMIT);
}
