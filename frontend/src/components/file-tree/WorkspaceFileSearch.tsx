import {
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  CaseSensitive,
  ChevronRight,
  MoreVertical,
  Regex,
  WholeWord,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useAppContextMenu } from '@/components/context-menu';
import { writeClipboardViaBridge } from '@/vscode/bridge';
import {
  fileTreeApi,
  type FileTreeEntry,
  type TextSearchFileResult,
  type TextSearchResponse,
} from '@/lib/api';

export type WorkspaceSearchMode = 'content' | 'filename';

export interface WorkspaceTextSearchController {
  mode: WorkspaceSearchMode;
  setMode: (mode: WorkspaceSearchMode) => void;
  query: string;
  setQuery: (value: string) => void;
  caseSensitive: boolean;
  setCaseSensitive: (value: boolean) => void;
  wholeWord: boolean;
  setWholeWord: (value: boolean) => void;
  isRegex: boolean;
  setIsRegex: (value: boolean) => void;
  searchResults: TextSearchResponse | null;
  isLoading: boolean;
  error: string | null;
  isSearchMode: boolean;
  expandedFiles: Set<string>;
  toggleExpanded: (path: string) => void;
}

function collectFilesFromTreeEntries(
  entries: readonly FileTreeEntry[],
  rootPath: string
): string[] {
  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const collected: string[] = [];
  const visit = (nodes: readonly FileTreeEntry[]) => {
    for (const node of nodes) {
      if (node.is_dir) {
        if (node.children && node.children.length > 0) {
          visit(node.children);
        }
        continue;
      }
      const normalizedPath = node.path.replace(/\\/g, '/');
      const relativePath =
        normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)
          ? normalizedPath.slice(normalizedRoot.length + 1)
          : normalizedPath.replace(/^\/+/, '');
      if (relativePath) {
        collected.push(relativePath);
      }
    }
  };
  visit(entries);
  return collected;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildFileNameMatcher(
  query: string,
  options: {
    caseSensitive: boolean;
    wholeWord: boolean;
    isRegex: boolean;
  }
): { test: (filePath: string) => boolean } | { error: string } {
  const { caseSensitive, wholeWord, isRegex } = options;
  if (isRegex || wholeWord) {
    try {
      const pattern = isRegex ? query : `\\b${escapeRegExp(query)}\\b`;
      const regex = new RegExp(pattern, caseSensitive ? '' : 'i');
      return {
        test: (filePath: string) => {
          const baseName = filePath.split('/').pop() ?? filePath;
          return regex.test(baseName) || regex.test(filePath);
        },
      };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const needle = caseSensitive ? query : query.toLowerCase();
  return {
    test: (filePath: string) => {
      const candidate = caseSensitive ? filePath : filePath.toLowerCase();
      return candidate.includes(needle);
    },
  };
}

const MAX_FILENAME_SEARCH_RESULTS = 200;

export function useWorkspaceTextSearch(
  rootPath: string | null,
  fallbackFiles: readonly string[] = []
): WorkspaceTextSearchController {
  const [mode, setMode] = useState<WorkspaceSearchMode>('content');
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [searchResults, setSearchResults] = useState<TextSearchResponse | null>(
    null
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const cachedTreeFilesRef = useRef<{
    rootPath: string;
    files: string[];
  } | null>(null);
  const fallbackFilesRef = useRef<readonly string[]>(fallbackFiles);
  fallbackFilesRef.current = fallbackFiles;

  const liveQuery = query.trim();
  const deferredQuery = useDeferredValue(liveQuery);
  const isSearchMode = liveQuery.length > 0;

  useEffect(() => {
    setQuery('');
    setCaseSensitive(false);
    setWholeWord(false);
    setIsRegex(false);
    setSearchResults(null);
    setIsLoading(false);
    setError(null);
    setExpandedFiles((current) => (current.size === 0 ? current : new Set()));
    cachedTreeFilesRef.current = null;
  }, [rootPath]);

  useEffect(() => {
    if (!rootPath || !isSearchMode) {
      setSearchResults(null);
      setIsLoading(false);
      setError(null);
      setExpandedFiles((current) => (current.size === 0 ? current : new Set()));
      return;
    }
    if (!deferredQuery) return;

    let cancelled = false;

    if (mode === 'filename') {
      const matcher = buildFileNameMatcher(deferredQuery, {
        caseSensitive,
        wholeWord,
        isRegex,
      });
      if ('error' in matcher) {
        setSearchResults(null);
        setIsLoading(false);
        setError(matcher.error);
        return;
      }

      const applyFileFilter = (treeFiles: readonly string[]) => {
        if (cancelled) return;
        const allFiles = Array.from(
          new Set([...fallbackFilesRef.current, ...treeFiles])
        ).sort((a, b) => a.localeCompare(b));
        const matched = allFiles.filter((filePath) => matcher.test(filePath));
        const truncated = matched.length > MAX_FILENAME_SEARCH_RESULTS;
        const visibleFiles = truncated
          ? matched.slice(0, MAX_FILENAME_SEARCH_RESULTS)
          : matched;
        setSearchResults({
          files: visibleFiles.map((path) => ({
            path,
            match_count: 1,
            matches: [],
          })),
          file_count: matched.length,
          total_matches: matched.length,
          truncated,
        });
        setExpandedFiles(new Set());
        setError(null);
        setIsLoading(false);
      };

      if (cachedTreeFilesRef.current?.rootPath === rootPath) {
        applyFileFilter(cachedTreeFilesRef.current.files);
        return;
      }

      if (typeof fileTreeApi.getTree === 'function') {
        setIsLoading(true);
        setError(null);
        Promise.resolve(fileTreeApi.getTree(rootPath))
          .then((entries) => {
            const treeFiles = Array.isArray(entries)
              ? collectFilesFromTreeEntries(entries, rootPath)
              : [];
            cachedTreeFilesRef.current = { rootPath, files: treeFiles };
            applyFileFilter(treeFiles);
          })
          .catch(() => {
            cachedTreeFilesRef.current = { rootPath, files: [] };
            applyFileFilter([]);
          });
      } else {
        cachedTreeFilesRef.current = { rootPath, files: [] };
        applyFileFilter([]);
      }

      return () => {
        cancelled = true;
      };
    }

    setIsLoading(true);
    setError(null);

    fileTreeApi
      .searchText(rootPath, {
        query: deferredQuery,
        case_sensitive: caseSensitive,
        whole_word: wholeWord,
        is_regex: isRegex,
      })
      .then((response) => {
        if (cancelled) return;
        setSearchResults(response);
        setExpandedFiles(new Set(response.files.map((file) => file.path)));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSearchResults(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    caseSensitive,
    isRegex,
    deferredQuery,
    isSearchMode,
    mode,
    rootPath,
    wholeWord,
  ]);

  const toggleExpanded = useCallback((path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  return {
    mode,
    setMode,
    query,
    setQuery,
    caseSensitive,
    setCaseSensitive,
    wholeWord,
    setWholeWord,
    isRegex,
    setIsRegex,
    searchResults,
    isLoading,
    error,
    isSearchMode,
    expandedFiles,
    toggleExpanded,
  };
}

function SearchOptionIcon({
  icon: OptionIcon,
  active,
}: {
  icon: LucideIcon;
  active: boolean;
}) {
  return (
    <OptionIcon
      className={`h-3.5 w-3.5${active ? ' text-primary' : ''}`}
      aria-hidden
    />
  );
}

export function WorkspaceFileSearchField({
  search,
  autoFocus = false,
  focusNonce = 0,
}: {
  search: WorkspaceTextSearchController;
  autoFocus?: boolean;
  focusNonce?: number;
}) {
  const { t } = useTranslation('panels');
  const { openSurfaceMenu } = useAppContextMenu();
  const inputRef = useRef<HTMLInputElement>(null);
  const placeholder =
    search.mode === 'filename'
      ? t('searchPanel.searchFileNamePlaceholder')
      : t('searchPanel.searchPlaceholder');

  useEffect(() => {
    if (focusNonce === 0) return;
    inputRef.current?.focus();
  }, [focusNonce]);

  const openOptionsMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    openSurfaceMenu(event, [
      {
        id: 'match-case',
        label: t('searchPanel.matchCase'),
        iconNode: (
          <SearchOptionIcon
            icon={CaseSensitive}
            active={search.caseSensitive}
          />
        ),
        onSelect: () => search.setCaseSensitive(!search.caseSensitive),
      },
      {
        id: 'match-whole-word',
        label: t('searchPanel.matchWholeWord'),
        iconNode: (
          <SearchOptionIcon icon={WholeWord} active={search.wholeWord} />
        ),
        onSelect: () => search.setWholeWord(!search.wholeWord),
      },
      {
        id: 'regex',
        label: t('searchPanel.regex'),
        iconNode: <SearchOptionIcon icon={Regex} active={search.isRegex} />,
        onSelect: () => search.setIsRegex(!search.isRegex),
      },
    ]);
  };

  return (
    <div className="file-tree-search-field">
      <TextInput
        ref={inputRef}
        className="file-tree-search-input"
        label={placeholder}
        isLabelHidden
        size="sm"
        placeholder={placeholder}
        value={search.query}
        onChange={search.setQuery}
        hasAutoFocus={autoFocus}
        hasClear
        startIcon={<Icon icon="search" size="sm" />}
      />
      <Button
        className="file-tree-search-options"
        label={t('searchPanel.searchOptions')}
        variant="ghost"
        size="sm"
        isIconOnly
        icon={<MoreVertical size={14} />}
        aria-haspopup="menu"
        onClick={openOptionsMenu}
      />
    </div>
  );
}

export function SearchResultSummary({
  fileCount,
  matchCount,
}: {
  fileCount: number;
  matchCount: number;
}) {
  const { t } = useTranslation('panels');
  return (
    <div
      className="file-tree-search-summary"
      role="status"
      data-testid="search-result-summary"
      data-file-tree-search-chrome=""
      aria-label={t('searchPanel.resultSummary', { fileCount, matchCount })}
    >
      <span className="file-tree-search-summary-count">
        {t('searchPanel.fileCountLabel', { count: fileCount })}
      </span>
      <span className="file-tree-search-summary-count">
        {t('searchPanel.matchCountLabel', { count: matchCount })}
      </span>
    </div>
  );
}

export function SearchResultLimitNotice() {
  const { t } = useTranslation('panels');
  return (
    <div
      className="file-tree-search-limit"
      role="status"
      data-testid="search-result-limit"
      data-file-tree-search-chrome=""
    >
      <span className="file-tree-search-limit-mark" aria-hidden="true" />
      <span>{t('searchPanel.truncated')}</span>
    </div>
  );
}

export function WorkspaceFileSearchResults({
  search,
  onOpenFile,
}: {
  search: WorkspaceTextSearchController;
  onOpenFile: (
    path: string,
    location?: { line: number; column: number }
  ) => void;
}) {
  const { t } = useTranslation(['panels', 'common']);
  const { openSurfaceMenu } = useAppContextMenu();

  if (!search.isSearchMode) return null;

  const renderFileResult = (result: TextSearchFileResult) => {
    const isFileNameMode = search.mode === 'filename';
    const isExpanded = !isFileNameMode && search.expandedFiles.has(result.path);
    return (
      <div key={result.path} data-file-tree-search-result="">
        <button
          type="button"
          className="file-tree-search-file"
          data-file-tree-search-result=""
          aria-expanded={isFileNameMode ? undefined : isExpanded}
          onClick={() => {
            if (isFileNameMode) {
              onOpenFile(result.path);
              return;
            }
            search.toggleExpanded(result.path);
          }}
          onContextMenu={(event) => {
            event.stopPropagation();
            openSurfaceMenu(event, [
              {
                id: 'open',
                label: t('common:contextMenu.open'),
                onSelect: () => onOpenFile(result.path),
              },
              {
                id: 'copy-path',
                label: t('common:contextMenu.copyPath'),
                onSelect: () => {
                  void writeClipboardViaBridge(result.path);
                },
              },
            ]);
          }}
        >
          {!isFileNameMode ? (
            <ChevronRight
              className={`file-tree-search-chevron${
                isExpanded ? ' is-expanded' : ''
              }`}
              size={14}
              aria-hidden
            />
          ) : null}
          <span className="file-tree-search-path">{result.path}</span>
          {!isFileNameMode ? (
            <span className="file-tree-search-summary-count">
              {result.match_count}
            </span>
          ) : null}
        </button>
        {isExpanded
          ? result.matches.map((match, index) => (
              <button
                key={`${result.path}-${match.line}-${match.column}-${index}`}
                type="button"
                className="file-tree-search-match"
                data-file-tree-search-result=""
                onClick={() =>
                  onOpenFile(result.path, {
                    line: match.line,
                    column: match.column,
                  })
                }
                onContextMenu={(event) => {
                  event.stopPropagation();
                  openSurfaceMenu(event, [
                    {
                      id: 'open',
                      label: t('common:contextMenu.open'),
                      onSelect: () =>
                        onOpenFile(result.path, {
                          line: match.line,
                          column: match.column,
                        }),
                    },
                    {
                      id: 'copy-line',
                      label: t('common:contextMenu.copy'),
                      onSelect: () => {
                        void writeClipboardViaBridge(match.preview);
                      },
                    },
                  ]);
                }}
              >
                <span className="file-tree-search-match-location">
                  {match.line}:{match.column}
                </span>
                <span className="file-tree-search-match-preview">
                  {match.preview}
                </span>
              </button>
            ))
          : null}
      </div>
    );
  };

  let body = null;
  if (search.isLoading) {
    body = (
      <div className="file-tree-search-status" role="status">
        {t('searchPanel.searching')}
      </div>
    );
  } else if (search.error) {
    body = (
      <div className="file-tree-search-status is-error" role="alert">
        {search.error}
      </div>
    );
  } else if (!search.searchResults || search.searchResults.files.length === 0) {
    body = (
      <div className="file-tree-search-status" role="status">
        {t('searchPanel.noResults')}
      </div>
    );
  } else {
    body = (
      <>
        <SearchResultSummary
          fileCount={search.searchResults.file_count}
          matchCount={search.searchResults.total_matches}
        />
        {search.searchResults.truncated ? <SearchResultLimitNotice /> : null}
        {search.searchResults.files.map((result) => renderFileResult(result))}
      </>
    );
  }

  return <div className="file-tree-search-results">{body}</div>;
}
