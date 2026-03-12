import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import SearchIcon from "lucide-react/dist/esm/icons/search";
import type { PanelTabId } from "../../layout/components/PanelTabs";
import {
  searchWorkspaceText,
  type WorkspaceTextSearchFileResult,
  type WorkspaceTextSearchResponse,
} from "../../../services/tauri";

type FileOpenLocation = {
  line: number;
  column: number;
};

type WorkspaceSearchPanelProps = {
  workspaceId: string | null;
  filePanelMode: PanelTabId;
  onFilePanelModeChange: (mode: PanelTabId) => void;
  onOpenFile: (path: string, location?: FileOpenLocation) => void;
};

export function WorkspaceSearchPanel({
  workspaceId,
  filePanelMode: _filePanelMode,
  onFilePanelModeChange: _onFilePanelModeChange,
  onOpenFile,
}: WorkspaceSearchPanelProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchDetailsVisible, setSearchDetailsVisible] = useState(false);
  const [includePattern, setIncludePattern] = useState("");
  const [excludePattern, setExcludePattern] = useState("");
  const [searchResults, setSearchResults] = useState<WorkspaceTextSearchResponse | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  const deferredQuery = useDeferredValue(query);
  const normalizedQuery = deferredQuery.trim();
  const isSearchMode = normalizedQuery.length > 0;

  useEffect(() => {
    setQuery("");
    setSearchCaseSensitive(false);
    setSearchWholeWord(false);
    setSearchRegex(false);
    setSearchDetailsVisible(false);
    setIncludePattern("");
    setExcludePattern("");
    setSearchResults(null);
    setSearchLoading(false);
    setSearchError(null);
    setExpandedFiles(new Set());
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId || !isSearchMode) {
      setSearchResults(null);
      setSearchLoading(false);
      setSearchError(null);
      setExpandedFiles(new Set());
      return;
    }

    let cancelled = false;
    setSearchLoading(true);
    setSearchError(null);
    void searchWorkspaceText(workspaceId, {
      query: normalizedQuery,
      caseSensitive: searchCaseSensitive,
      wholeWord: searchWholeWord,
      isRegex: searchRegex,
      includePattern: includePattern.trim() || null,
      excludePattern: excludePattern.trim() || null,
    })
      .then((response) => {
        if (cancelled) return;
        setSearchResults(response);
        setExpandedFiles(new Set(response.files.map((entry) => entry.path)));
      })
      .catch((error) => {
        if (cancelled) return;
        setSearchResults(null);
        setSearchError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) {
          setSearchLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    excludePattern,
    includePattern,
    isSearchMode,
    normalizedQuery,
    searchCaseSensitive,
    searchRegex,
    searchWholeWord,
    workspaceId,
  ]);

  const summaryText = useMemo(() => {
    if (!workspaceId) {
      return t("files.selectWorkspaceToSearch");
    }
    if (!isSearchMode) {
      return t("files.searchReady");
    }
    if (searchLoading) {
      return t("files.searching");
    }
    if (searchError) {
      return searchError;
    }
    if (!searchResults) {
      return t("files.searchReady");
    }
    return t("files.searchResultsSummary", {
      files: searchResults.file_count,
      matches: searchResults.match_count,
    });
  }, [isSearchMode, searchError, searchLoading, searchResults, t, workspaceId]);

  const toggleExpanded = (path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderResult = (result: WorkspaceTextSearchFileResult) => {
    const isExpanded = expandedFiles.has(result.path);
    return (
      <div key={result.path} className="workspace-search-result-group">
        <button
          type="button"
          className="workspace-search-result-file"
          onClick={() => toggleExpanded(result.path)}
        >
          <span className={`file-tree-chevron${isExpanded ? " is-open" : ""}`}>›</span>
          <span className="workspace-search-result-path">{result.path}</span>
          <span className="workspace-search-result-count">{result.match_count}</span>
        </button>
        {isExpanded ? (
          <div className="workspace-search-result-matches">
            {result.matches.map((match, index) => (
              <button
                key={`${result.path}-${match.line}-${match.column}-${index}`}
                type="button"
                className="workspace-search-result-match"
                onClick={() => onOpenFile(result.path, { line: match.line, column: match.column })}
              >
                <span className="workspace-search-result-location">
                  {match.line}:{match.column}
                </span>
                <span className="workspace-search-result-preview">{match.preview}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <section className="diff-panel workspace-search-panel">
      <div className="workspace-search-body">
        <div className="workspace-search-bar">
          <SearchIcon className="workspace-search-icon" aria-hidden />
          <input
            className="workspace-search-input"
            type="search"
            placeholder={t("files.filterPlaceholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t("files.filterPlaceholder")}
            disabled={!workspaceId}
          />
          <button
            type="button"
            className={`ghost workspace-search-option${searchCaseSensitive ? " is-active" : ""}`}
            onClick={() => setSearchCaseSensitive((prev) => !prev)}
            aria-label={t("files.matchCase")}
            title={t("files.matchCase")}
            disabled={!workspaceId}
          >
            Aa
          </button>
          <button
            type="button"
            className={`ghost workspace-search-option${searchWholeWord ? " is-active" : ""}`}
            onClick={() => setSearchWholeWord((prev) => !prev)}
            aria-label={t("files.matchWholeWord")}
            title={t("files.matchWholeWord")}
            disabled={!workspaceId}
          >
            ab
          </button>
          <button
            type="button"
            className={`ghost workspace-search-option${searchRegex ? " is-active" : ""}`}
            onClick={() => setSearchRegex((prev) => !prev)}
            aria-label={t("files.useRegex")}
            title={t("files.useRegex")}
            disabled={!workspaceId}
          >
            .*
          </button>
          <button
            type="button"
            className={`ghost workspace-search-option${searchDetailsVisible ? " is-active" : ""}`}
            onClick={() => setSearchDetailsVisible((prev) => !prev)}
            aria-label={t("files.searchDetails")}
            title={t("files.searchDetails")}
            disabled={!workspaceId}
          >
            …
          </button>
        </div>

        {(searchDetailsVisible || isSearchMode) && workspaceId ? (
          <div className="workspace-search-details">
            <input
              className="workspace-search-details-input"
              type="text"
              placeholder={t("files.includePattern")}
              value={includePattern}
              onChange={(event) => setIncludePattern(event.target.value)}
              aria-label={t("files.includePattern")}
            />
            <input
              className="workspace-search-details-input"
              type="text"
              placeholder={t("files.excludePattern")}
              value={excludePattern}
              onChange={(event) => setExcludePattern(event.target.value)}
              aria-label={t("files.excludePattern")}
            />
          </div>
        ) : null}

        <div className="workspace-search-summary">{summaryText}</div>
        {searchResults?.limit_hit ? (
          <div className="workspace-search-limit">{t("files.searchLimitReached")}</div>
        ) : null}

        <div className="workspace-search-results">
          {!workspaceId ? null : !isSearchMode ? null : searchLoading || searchError ? null :
            !searchResults || searchResults.files.length === 0 ? (
              <div className="workspace-search-empty">{t("files.noMatchesFound")}</div>
            ) : (
              searchResults.files.map((result) => renderResult(result))
            )}
        </div>
      </div>
    </section>
  );
}
