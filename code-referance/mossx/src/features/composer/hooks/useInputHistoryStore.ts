/**
 * Input history store for autocomplete.
 *
 * Manages history data in memory with async persistence to
 * ~/.codemoss/inputHistory.json via Tauri commands.
 *
 * Data format is fully compatible with idea-claude-code-gui,
 * enabling data interoperability between the two applications.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  getClientStoreSync,
  writeClientStoreValue,
} from "../../../services/clientStorage";

// ─── Constants (must match idea-claude-code-gui) ───

export const MAX_HISTORY_ITEMS = 200;
const MAX_COUNT_RECORDS = 200;
const MAX_SPLIT_LENGTH = 300;
const MIN_FRAGMENT_LENGTH = 3;
const SEPARATORS_RE = /[,，.。;；、\s\n\r]+/;
const INVISIBLE_CHARS_RE = /[\u200B-\u200D\uFEFF]/g;

// localStorage keys (compatible with idea-claude-code-gui)
const LS_HISTORY_KEY = "chat-input-history";
const LS_COUNTS_KEY = "chat-input-history-counts";

// ─── In-memory cache ───

let cachedItems: string[] = [];
let cachedCounts: Record<string, number> = {};
let initialized = false;

// ─── Helpers ───

function splitTextToFragments(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length > MAX_SPLIT_LENGTH) {
    return [];
  }

  const rawFragments = trimmed.split(SEPARATORS_RE);
  const result = new Set<string>();

  for (const fragment of rawFragments) {
    const cleaned = fragment.trim();
    if (cleaned.length >= MIN_FRAGMENT_LENGTH) {
      result.add(cleaned);
    }
  }

  if (trimmed.length >= MIN_FRAGMENT_LENGTH) {
    result.add(trimmed);
  }

  return Array.from(result);
}

function cleanupCounts(
  counts: Record<string, number>,
): Record<string, number> {
  const entries = Object.entries(counts);
  if (entries.length <= MAX_COUNT_RECORDS) return counts;

  entries.sort((a, b) => b[1] - a[1]);
  const kept = entries.slice(0, MAX_COUNT_RECORDS);
  return Object.fromEntries(kept);
}

function canUseLocalStorage(): boolean {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false;
  }
}

/** Sync to localStorage for interop with idea-claude-code-gui */
function syncToLocalStorage(items: string[], counts: Record<string, number>) {
  if (!canUseLocalStorage()) return;
  try {
    window.localStorage.setItem(LS_HISTORY_KEY, JSON.stringify(items));
    window.localStorage.setItem(LS_COUNTS_KEY, JSON.stringify(counts));
  } catch {
    // quota exceeded or other error, ignore
  }
}

// ─── Initialization ───

export async function initInputHistoryStore(): Promise<void> {
  if (initialized) return;
  try {
    const data = await invoke<{ items?: string[]; counts?: Record<string, number> }>(
      "input_history_read",
    );
    cachedItems = Array.isArray(data?.items) ? data.items : [];
    cachedCounts =
      data?.counts && typeof data.counts === "object" ? data.counts : {};
    initialized = true;
    // Sync to localStorage on init for interop
    syncToLocalStorage(cachedItems, cachedCounts);
  } catch {
    initialized = true;
  }
}

// ─── Read APIs ───

export function loadHistoryItems(): string[] {
  return cachedItems;
}

export function loadHistoryCounts(): Record<string, number> {
  return cachedCounts;
}

// ─── History completion enabled setting ───

const ENABLED_KEY = "historyCompletionEnabled";

export function isHistoryCompletionEnabled(): boolean {
  const val = getClientStoreSync<boolean>("composer", ENABLED_KEY);
  if (val === undefined) {
    // Fallback: check localStorage (interop with idea-claude-code-gui)
    if (canUseLocalStorage()) {
      try {
        const lsVal = window.localStorage.getItem("historyCompletionEnabled");
        return lsVal !== "false";
      } catch {
        return true;
      }
    }
    return true;
  }
  return val !== false;
}

export function setHistoryCompletionEnabled(enabled: boolean): void {
  writeClientStoreValue("composer", ENABLED_KEY, enabled);
  // Also write to localStorage for cross-app interop
  if (canUseLocalStorage()) {
    try {
      window.localStorage.setItem(
        "historyCompletionEnabled",
        enabled ? "true" : "false",
      );
    } catch {
      // ignore
    }
  }
  // Dispatch custom event for same-window listeners
  window.dispatchEvent(
    new CustomEvent("historyCompletionChanged", { detail: { enabled } }),
  );
}

// ─── Write APIs ───

export function recordHistory(text: string): void {
  const sanitized = text.replace(INVISIBLE_CHARS_RE, "");
  if (!sanitized.trim()) return;

  const fragments = splitTextToFragments(sanitized);
  if (fragments.length === 0) return;

  // Update counts
  for (const fragment of fragments) {
    cachedCounts[fragment] = (cachedCounts[fragment] || 0) + 1;
  }
  cachedCounts = cleanupCounts(cachedCounts);

  // Update items (remove duplicates, append new)
  const newSet = new Set(fragments);
  const filtered = cachedItems.filter((item) => !newSet.has(item));
  cachedItems = [...filtered, ...fragments].slice(-MAX_HISTORY_ITEMS);

  // Sync to localStorage
  syncToLocalStorage(cachedItems, cachedCounts);

  // Persist to backend (async, fire-and-forget)
  invoke("input_history_record", { fragments }).catch(() => {});
}

export function deleteHistoryItem(item: string): void {
  cachedItems = cachedItems.filter((i) => i !== item);
  delete cachedCounts[item];

  syncToLocalStorage(cachedItems, cachedCounts);
  invoke("input_history_delete", { item }).catch(() => {});
}

export function clearAllHistory(): void {
  cachedItems = [];
  cachedCounts = {};

  syncToLocalStorage(cachedItems, cachedCounts);
  invoke("input_history_clear").catch(() => {});
}

// ─── Settings page APIs ───

export interface HistoryItem {
  text: string;
  importance: number;
}

export function loadHistoryWithImportance(): HistoryItem[] {
  const items = cachedItems;
  const counts = cachedCounts;

  const result: HistoryItem[] = items.map((text) => ({
    text,
    importance: counts[text] || 1,
  }));

  result.sort((a, b) => b.importance - a.importance);
  return result;
}

export function addHistoryItem(text: string, importance = 1): void {
  const sanitized = text.replace(INVISIBLE_CHARS_RE, "").trim();
  if (!sanitized) return;

  const filtered = cachedItems.filter((i) => i !== sanitized);
  cachedItems = [...filtered, sanitized].slice(-MAX_HISTORY_ITEMS);
  cachedCounts[sanitized] = Math.max(1, Math.floor(importance));
  cachedCounts = cleanupCounts(cachedCounts);

  syncToLocalStorage(cachedItems, cachedCounts);
  invoke("input_history_record", { fragments: [sanitized] }).catch(() => {});
}

export function updateHistoryItem(
  oldText: string,
  newText: string,
  importance: number,
): void {
  const sanitizedNew = newText.replace(INVISIBLE_CHARS_RE, "").trim();
  if (!sanitizedNew) return;

  const index = cachedItems.indexOf(oldText);
  if (index === -1) {
    addHistoryItem(sanitizedNew, importance);
    return;
  }

  if (oldText !== sanitizedNew) {
    const existingIndex = cachedItems.indexOf(sanitizedNew);
    if (existingIndex !== -1 && existingIndex !== index) {
      cachedItems.splice(index, 1);
      delete cachedCounts[oldText];
      cachedCounts[sanitizedNew] = Math.max(
        cachedCounts[sanitizedNew] || 1,
        Math.max(1, Math.floor(importance)),
      );
    } else {
      cachedItems[index] = sanitizedNew;
      delete cachedCounts[oldText];
      cachedCounts[sanitizedNew] = Math.max(1, Math.floor(importance));
    }
  } else {
    cachedCounts[oldText] = Math.max(1, Math.floor(importance));
  }

  syncToLocalStorage(cachedItems, cachedCounts);

  if (oldText !== sanitizedNew) {
    invoke("input_history_delete", { item: oldText }).catch(() => {});
    invoke("input_history_record", { fragments: [sanitizedNew] }).catch(
      () => {},
    );
  }
}

export function clearLowImportanceHistory(threshold = 1): number {
  let deletedCount = 0;
  const itemsToKeep: string[] = [];
  const itemsToDelete: string[] = [];

  for (const item of cachedItems) {
    const importance = cachedCounts[item] || 1;
    if (importance <= threshold) {
      itemsToDelete.push(item);
      delete cachedCounts[item];
      deletedCount++;
    } else {
      itemsToKeep.push(item);
    }
  }

  cachedItems = itemsToKeep;
  syncToLocalStorage(cachedItems, cachedCounts);

  for (const item of itemsToDelete) {
    invoke("input_history_delete", { item }).catch(() => {});
  }

  return deletedCount;
}
