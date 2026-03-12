/**
 * Provides inline history completion for the composer textarea.
 *
 * Shows a ghost text suffix after the user's input that suggests a
 * completion from their input history. The user can press Tab to
 * accept the suggestion.
 *
 * Logic ported from idea-claude-code-gui's useInlineHistoryCompletion.ts.
 */

import { useCallback, useRef, useState, useEffect, useMemo } from "react";
import {
  loadHistoryItems,
  loadHistoryCounts,
  isHistoryCompletionEnabled,
} from "./useInputHistoryStore";

export interface UseInlineHistoryCompletionReturn {
  /** The suffix text to display as ghost text */
  suffix: string;
  /** Whether there is a suggestion available */
  hasSuggestion: boolean;
  /** Update the query text to find matching history */
  updateQuery: (text: string) => void;
  /** Clear the current suggestion */
  clear: () => void;
  /** Apply the current suggestion and return the full text */
  applySuggestion: () => string | null;
}

const INVISIBLE_CHARS_RE = /[\u200B-\u200D\uFEFF]/g;

export function useInlineHistoryCompletion({
  debounceMs = 100,
  minQueryLength = 2,
}: {
  debounceMs?: number;
  minQueryLength?: number;
} = {}): UseInlineHistoryCompletionReturn {
  const [suffix, setSuffix] = useState("");
  const [fullSuggestion, setFullSuggestion] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(() => isHistoryCompletionEnabled());
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastQueryRef = useRef("");

  // Listen for storage events (cross-tab sync)
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === "historyCompletionEnabled") {
        setEnabled(e.newValue !== "false");
      }
    };
    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  // Listen for custom event (same-tab sync)
  useEffect(() => {
    const handleCustomEvent = (e: Event) => {
      const customEvent = e as CustomEvent<{ enabled: boolean }>;
      setEnabled(customEvent.detail.enabled);
    };
    window.addEventListener("historyCompletionChanged", handleCustomEvent);
    return () =>
      window.removeEventListener("historyCompletionChanged", handleCustomEvent);
  }, []);

  const findBestMatch = useCallback(
    (query: string): string | null => {
      if (!enabled || query.length < minQueryLength) return null;

      const history = loadHistoryItems();
      const counts = loadHistoryCounts();

      const queryLower = query.toLowerCase();
      const matches = history.filter((item) => {
        const itemLower = item.toLowerCase();
        return itemLower.startsWith(queryLower) && item.length > query.length;
      });

      if (matches.length === 0) return null;

      // Sort by usage count (descending), then by length (shorter first)
      matches.sort((a, b) => {
        const countA = counts[a] || 0;
        const countB = counts[b] || 0;
        if (countB !== countA) return countB - countA;
        return a.length - b.length;
      });

      return matches[0];
    },
    [enabled, minQueryLength],
  );

  const updateQuery = useCallback(
    (text: string) => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      const cleanText = text.replace(INVISIBLE_CHARS_RE, "").trim();
      if (!cleanText || cleanText.length < minQueryLength) {
        setSuffix("");
        setFullSuggestion(null);
        lastQueryRef.current = "";
        return;
      }

      debounceTimerRef.current = setTimeout(() => {
        lastQueryRef.current = cleanText;

        const match = findBestMatch(cleanText);
        if (match) {
          const matchSuffix = match.slice(cleanText.length);
          setSuffix(matchSuffix);
          setFullSuggestion(match);
        } else {
          setSuffix("");
          setFullSuggestion(null);
        }
      }, debounceMs);
    },
    [debounceMs, minQueryLength, findBestMatch],
  );

  const clear = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    setSuffix("");
    setFullSuggestion(null);
    lastQueryRef.current = "";
  }, []);

  const applySuggestion = useCallback((): string | null => {
    if (!fullSuggestion) return null;

    const result = fullSuggestion;
    setSuffix("");
    setFullSuggestion(null);
    lastQueryRef.current = "";
    return result;
  }, [fullSuggestion]);

  const hasSuggestion = useMemo(
    () => !!suffix && !!fullSuggestion,
    [suffix, fullSuggestion],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  return {
    suffix,
    hasSuggestion,
    updateQuery,
    clear,
    applySuggestion,
  };
}
