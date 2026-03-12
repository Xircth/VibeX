import { useDeferredValue, useEffect, useMemo, useState, useCallback } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { Search, ChevronRight } from 'lucide-react';
import { useFileTreeStore } from '@/stores/useFileTreeStore';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import {
  fileTreeApi,
  type TextSearchResponse,
  type TextSearchFileResult,
} from '@/lib/api';

function DockviewSearchPanel(_props: IDockviewPanelProps) {
  const { rootPath } = useFileTreeStore();
  const { openFilePreview } = usePanelActionsContext();

  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [includePattern, setIncludePattern] = useState('');
  const [excludePattern, setExcludePattern] = useState('');
  const [searchResults, setSearchResults] = useState<TextSearchResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  const deferredQuery = useDeferredValue(query);
  const normalizedQuery = deferredQuery.trim();
  const isSearchMode = normalizedQuery.length > 0;

  // Reset state when rootPath changes
  useEffect(() => {
    setQuery('');
    setCaseSensitive(false);
    setWholeWord(false);
    setIsRegex(false);
    setShowDetails(false);
    setIncludePattern('');
    setExcludePattern('');
    setSearchResults(null);
    setIsLoading(false);
    setError(null);
    setExpandedFiles(new Set());
  }, [rootPath]);

  // Execute search
  useEffect(() => {
    if (!rootPath || !isSearchMode) {
      setSearchResults(null);
      setIsLoading(false);
      setError(null);
      setExpandedFiles(new Set());
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    fileTreeApi
      .searchText(rootPath, {
        query: normalizedQuery,
        case_sensitive: caseSensitive,
        whole_word: wholeWord,
        is_regex: isRegex,
        include_pattern: includePattern.trim() || undefined,
        exclude_pattern: excludePattern.trim() || undefined,
      })
      .then((response) => {
        if (cancelled) return;
        setSearchResults(response);
        setExpandedFiles(new Set(response.files.map((f) => f.path)));
      })
      .catch((err) => {
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
  }, [normalizedQuery, caseSensitive, wholeWord, isRegex, includePattern, excludePattern, rootPath, isSearchMode]);

  const summaryText = useMemo(() => {
    if (!rootPath) return '请先选择工作区';
    if (!isSearchMode) return '输入关键词开始搜索';
    if (isLoading) return '搜索中...';
    if (error) return error;
    if (!searchResults) return '输入关键词开始搜索';
    return `${searchResults.file_count} 个文件，${searchResults.total_matches} 个匹配`;
  }, [rootPath, isSearchMode, isLoading, error, searchResults]);

  const toggleExpanded = useCallback((path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleOpenFile = useCallback(
    (filePath: string) => {
      if (!rootPath) return;
      const usesBackslash = rootPath.includes('\\');
      const separator = usesBackslash ? '\\' : '/';
      const base = rootPath.replace(/[\\/]+$/, '');
      const normalizedRel = usesBackslash
        ? filePath.replaceAll('/', '\\')
        : filePath;
      const absolutePath = `${base}${separator}${normalizedRel}`;
      openFilePreview(absolutePath);
    },
    [rootPath, openFilePreview],
  );

  const renderFileResult = useCallback(
    (result: TextSearchFileResult) => {
      const isExpanded = expandedFiles.has(result.path);
      return (
        <div key={result.path} className="border-b border-border/50 last:border-b-0">
          <button
            type="button"
            className="w-full flex items-center gap-1 px-2 py-1 text-left text-xs hover:bg-accent/50 transition-colors"
            onClick={() => toggleExpanded(result.path)}
          >
            <ChevronRight
              className={`h-3 w-3 shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            />
            <span className="truncate text-foreground font-medium">{result.path}</span>
            <span className="ml-auto shrink-0 text-muted-foreground text-[10px] bg-muted px-1 rounded">
              {result.match_count}
            </span>
          </button>
          {isExpanded && (
            <div className="ml-4">
              {result.matches.map((match, idx) => (
                <button
                  key={`${result.path}-${match.line}-${match.column}-${idx}`}
                  type="button"
                  className="w-full flex items-center gap-2 px-2 py-0.5 text-left text-xs hover:bg-accent/50 transition-colors"
                  onClick={() => handleOpenFile(result.path)}
                >
                  <span className="shrink-0 text-muted-foreground w-12 text-right tabular-nums">
                    {match.line}:{match.column}
                  </span>
                  <span className="truncate text-foreground/80">{match.preview}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      );
    },
    [expandedFiles, toggleExpanded, handleOpenFile],
  );

  return (
    <div className="h-full w-full flex flex-col overflow-hidden bg-background" data-panel="search">
      {/* Search input bar */}
      <div className="shrink-0 px-2 pt-2 pb-1 border-b border-border">
        <div className="flex items-center gap-1 bg-input rounded px-2 py-1">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input
            className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none"
            type="search"
            placeholder="搜索文件内容..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={!rootPath}
            autoFocus
          />
          <button
            type="button"
            className={`px-1 py-0.5 text-[10px] font-mono rounded transition-colors ${
              caseSensitive
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            }`}
            onClick={() => setCaseSensitive((prev) => !prev)}
            title="区分大小写"
          >
            Aa
          </button>
          <button
            type="button"
            className={`px-1 py-0.5 text-[10px] font-mono rounded transition-colors ${
              wholeWord
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            }`}
            onClick={() => setWholeWord((prev) => !prev)}
            title="全词匹配"
          >
            ab
          </button>
          <button
            type="button"
            className={`px-1 py-0.5 text-[10px] font-mono rounded transition-colors ${
              isRegex
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            }`}
            onClick={() => setIsRegex((prev) => !prev)}
            title="正则表达式"
          >
            .*
          </button>
          <button
            type="button"
            className={`px-1 py-0.5 text-[10px] rounded transition-colors ${
              showDetails
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            }`}
            onClick={() => setShowDetails((prev) => !prev)}
            title="更多选项"
          >
            ...
          </button>
        </div>

        {/* Include/Exclude patterns */}
        {showDetails && (
          <div className="flex flex-col gap-1 mt-1">
            <input
              className="bg-input rounded px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground outline-none"
              type="text"
              placeholder="包含的文件 (如: *.ts, src/**)"
              value={includePattern}
              onChange={(e) => setIncludePattern(e.target.value)}
            />
            <input
              className="bg-input rounded px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground outline-none"
              type="text"
              placeholder="排除的文件 (如: node_modules, dist)"
              value={excludePattern}
              onChange={(e) => setExcludePattern(e.target.value)}
            />
          </div>
        )}

        {/* Summary */}
        <div className="text-[10px] text-muted-foreground mt-1 px-0.5">{summaryText}</div>
        {searchResults?.truncated && (
          <div className="text-[10px] text-yellow-500 px-0.5">结果过多，仅显示部分匹配</div>
        )}
      </div>

      {/* Search results */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {!rootPath ? null : !isSearchMode ? null : isLoading ? (
          <div className="flex items-center justify-center h-20 text-xs text-muted-foreground">
            搜索中...
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-20 text-xs text-destructive px-2 text-center">
            {error}
          </div>
        ) : !searchResults || searchResults.files.length === 0 ? (
          <div className="flex items-center justify-center h-20 text-xs text-muted-foreground">
            未找到匹配结果
          </div>
        ) : (
          searchResults.files.map((result) => renderFileResult(result))
        )}
      </div>
    </div>
  );
}

export default DockviewSearchPanel;
