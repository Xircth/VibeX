import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import changelogMarkdown from "../../../../CHANGELOG.md?raw";
import { getClientStoreSync, writeClientStoreValue } from "../../../services/clientStorage";
import type { DebugEntry } from "../../../types";

const RELEASE_NOTES_LAST_SEEN_KEY = "releaseNotesLastSeenVersion";

const CHANGELOG_HEADING_CN = /^#{5}\s+\*\*(.+?)（\s*(v?[^）]+)\s*）\*\*\s*$/;
const CHANGELOG_HEADING_ASCII = /^#{5}\s+\*\*(.+?)\(\s*(v?[^)]+)\s*\)\*\*\s*$/;
const ENGLISH_MARKER = /^English:\s*$/i;
const CHINESE_MARKER = /^中文[:：]\s*$/;
const RULE_LINE = /^-{3,}\s*$/;

type OpenReleaseNotesOptions = {
  preferredVersion?: string | null;
  forceRefresh?: boolean;
};

type UseReleaseNotesOptions = {
  enabled?: boolean;
  onDebug?: (entry: DebugEntry) => void;
};

export type ReleaseNotesEntry = {
  id: string;
  tagName: string;
  version: string;
  title: string;
  dateLabel: string;
  englishBody: string;
  chineseBody: string;
};

type ParsedHeading = {
  dateLabel: string;
  tagName: string;
  version: string;
};

function normalizeDateLabel(raw: string): string {
  const trimmed = raw.trim();
  const zhMatch = trimmed.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  if (zhMatch) {
    const [, year, month, day] = zhMatch;
    return `${year}/${month.padStart(2, "0")}/${day.padStart(2, "0")}`;
  }
  const isoMatch = trimmed.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${year}/${month.padStart(2, "0")}/${day.padStart(2, "0")}`;
  }
  return trimmed;
}

function parseHeading(line: string): ParsedHeading | null {
  const trimmed = line.trim();
  const matched = trimmed.match(CHANGELOG_HEADING_CN) ?? trimmed.match(CHANGELOG_HEADING_ASCII);
  if (!matched) {
    return null;
  }

  const dateLabel = normalizeDateLabel(matched[1] ?? "");
  const normalizedVersion = normalizeReleaseVersion(matched[2] ?? "");
  if (!normalizedVersion) {
    return null;
  }
  return {
    dateLabel,
    tagName: `v${normalizedVersion}`,
    version: normalizedVersion,
  };
}

function trimBlock(lines: string[]): string {
  const filtered = lines.filter((line) => !RULE_LINE.test(line.trim()));
  let start = 0;
  let end = filtered.length;
  while (start < end && !filtered[start]?.trim()) {
    start += 1;
  }
  while (end > start && !filtered[end - 1]?.trim()) {
    end -= 1;
  }
  return filtered.slice(start, end).join("\n");
}

function parseLanguageSections(lines: string[]): { englishBody: string; chineseBody: string } {
  const englishIndex = lines.findIndex((line) => ENGLISH_MARKER.test(line.trim()));
  const chineseIndex = lines.findIndex((line) => CHINESE_MARKER.test(line.trim()));

  if (englishIndex < 0 && chineseIndex < 0) {
    const shared = trimBlock(lines);
    return {
      englishBody: shared,
      chineseBody: shared,
    };
  }

  const englishLines =
    englishIndex >= 0
      ? lines.slice(englishIndex + 1, chineseIndex >= 0 ? chineseIndex : lines.length)
      : [];
  const chineseLines =
    chineseIndex >= 0
      ? lines.slice(chineseIndex + 1)
      : [];

  return {
    englishBody: trimBlock(englishLines),
    chineseBody: trimBlock(chineseLines),
  };
}

export function normalizeReleaseVersion(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/^v/i, "");
}

export function parseChangelogEntries(markdown: string): ReleaseNotesEntry[] {
  const lines = markdown.split(/\r?\n/);
  const entries: ReleaseNotesEntry[] = [];

  let currentHeading: ParsedHeading | null = null;
  let currentBlock: string[] = [];

  const flush = () => {
    if (!currentHeading) {
      return;
    }
    const sections = parseLanguageSections(currentBlock);
    entries.push({
      id: currentHeading.version,
      tagName: currentHeading.tagName,
      version: currentHeading.version,
      title: currentHeading.tagName,
      dateLabel: currentHeading.dateLabel,
      englishBody: sections.englishBody,
      chineseBody: sections.chineseBody,
    });
  };

  for (const line of lines) {
    const heading = parseHeading(line);
    if (heading) {
      flush();
      currentHeading = heading;
      currentBlock = [];
      continue;
    }
    if (!currentHeading) {
      continue;
    }
    currentBlock.push(line);
  }

  flush();
  return entries;
}

export function findReleaseIndex(
  entries: ReleaseNotesEntry[],
  preferredVersion: string | null | undefined,
): number {
  if (!entries.length) {
    return 0;
  }
  const normalized = normalizeReleaseVersion(preferredVersion);
  if (!normalized) {
    return 0;
  }
  const index = entries.findIndex((entry) => entry.version === normalized);
  return index >= 0 ? index : 0;
}

export function useReleaseNotes({
  enabled = true,
  onDebug,
}: UseReleaseNotesOptions = {}) {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<ReleaseNotesEntry[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const entriesRef = useRef<ReleaseNotesEntry[]>([]);
  const appVersionRef = useRef<string | null>(null);
  const autoCheckDoneRef = useRef(false);
  const parsedEntries = useMemo(
    () => parseChangelogEntries(changelogMarkdown),
    [],
  );

  const loadEntries = useCallback(
    async (forceRefresh = false): Promise<ReleaseNotesEntry[]> => {
      if (!forceRefresh && entriesRef.current.length > 0) {
        return entriesRef.current;
      }

      if (parsedEntries.length === 0) {
        throw new Error("CHANGELOG.md has no release entries.");
      }
      entriesRef.current = parsedEntries;
      setEntries(parsedEntries);
      return parsedEntries;
    },
    [parsedEntries],
  );

  const openReleaseNotes = useCallback(
    async (options?: OpenReleaseNotesOptions) => {
      setIsOpen(true);
      setLoading(true);
      setError(null);

      try {
        const list = await loadEntries(Boolean(options?.forceRefresh));
        const preferredVersion = options?.preferredVersion ?? appVersionRef.current;
        setActiveIndex(findReleaseIndex(list, preferredVersion));
      } catch (caughtError) {
        const message =
          caughtError instanceof Error ? caughtError.message : String(caughtError);
        setError(message);
        onDebug?.({
          id: `${Date.now()}-release-notes-open-error`,
          timestamp: Date.now(),
          source: "error",
          label: "release-notes/open-error",
          payload: message,
        });
      } finally {
        setLoading(false);
      }
    },
    [loadEntries, onDebug],
  );

  const closeReleaseNotes = useCallback(() => {
    setIsOpen(false);
    if (appVersionRef.current) {
      writeClientStoreValue("app", RELEASE_NOTES_LAST_SEEN_KEY, appVersionRef.current);
    }
  }, []);

  const goToPrevious = useCallback(() => {
    setActiveIndex((prev) => (prev > 0 ? prev - 1 : prev));
  }, []);

  const goToNext = useCallback(() => {
    setActiveIndex((prev) => (prev < entriesRef.current.length - 1 ? prev + 1 : prev));
  }, []);

  const retryLoad = useCallback(() => {
    void openReleaseNotes({ forceRefresh: true });
  }, [openReleaseNotes]);

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    if (!enabled || autoCheckDoneRef.current) {
      return;
    }
    autoCheckDoneRef.current = true;
    let cancelled = false;

    void getVersion()
      .then((version) => {
        if (cancelled) {
          return;
        }

        const normalizedVersion = normalizeReleaseVersion(version);
        appVersionRef.current = normalizedVersion;

        if (!normalizedVersion) {
          return;
        }

        const seenVersion = normalizeReleaseVersion(
          getClientStoreSync<string>("app", RELEASE_NOTES_LAST_SEEN_KEY),
        );

        if (seenVersion === normalizedVersion) {
          return;
        }

        void openReleaseNotes({ preferredVersion: normalizedVersion });
      })
      .catch((caughtError) => {
        const message =
          caughtError instanceof Error ? caughtError.message : String(caughtError);
        onDebug?.({
          id: `${Date.now()}-release-notes-version-error`,
          timestamp: Date.now(),
          source: "error",
          label: "release-notes/version-error",
          payload: message,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, onDebug, openReleaseNotes]);

  const activeEntry = useMemo(
    () => entries[activeIndex] ?? null,
    [activeIndex, entries],
  );

  return {
    isOpen,
    loading,
    error,
    entries,
    activeIndex,
    activeEntry,
    openReleaseNotes,
    closeReleaseNotes,
    goToPrevious,
    goToNext,
    retryLoad,
  };
}
