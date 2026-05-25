import { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import { Search as SearchIcon, File, KanbanSquare } from 'lucide-react';
import { useSearchStore } from '@/stores/useSearchStore';
import { useProject } from '@/contexts/ProjectContext';
import { projectsApi } from '@/lib/api';
import type { SearchResult as FileSearchResult } from 'shared/types';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';

type PaletteResultKind = 'file' | 'directory';

interface PaletteResult {
  id: string;
  kind: PaletteResultKind;
  title: string;
  subtitle?: string;
  filePath?: string;
}

export function SearchPalette() {
  const {
    isSearchPaletteOpen,
    paletteQuery,
    paletteSelectedIndex,
    closeSearchPalette,
    setPaletteQuery,
    movePaletteSelection,
  } = useSearchStore();

  const { openFilePreview } = usePanelActionsContext();
  const { projectId } = useProject();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [fileResults, setFileResults] = useState<FileSearchResult[]>([]);

  // Focus input when opened
  useEffect(() => {
    if (isSearchPaletteOpen) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isSearchPaletteOpen]);

  // Search files when query changes
  useEffect(() => {
    if (!isSearchPaletteOpen || !projectId) {
      setFileResults([]);
      return;
    }

    const trimmed = paletteQuery.trim();
    if (!trimmed) {
      setFileResults([]);
      return;
    }

    let cancelled = false;

    projectsApi
      .searchFiles(projectId, trimmed)
      .then((results: FileSearchResult[]) => {
        if (!cancelled) {
          setFileResults(results);
        }
      })
      .catch(() => {
        if (!cancelled) setFileResults([]);
      });

    return () => {
      cancelled = true;
    };
  }, [paletteQuery, isSearchPaletteOpen, projectId]);

  const results: PaletteResult[] = useMemo(() => {
    return fileResults.map((r) => ({
      id: r.path,
      kind: r.is_file ? ('file' as const) : ('directory' as const),
      title: r.path.split(/[/\\]/).pop() || r.path,
      subtitle: r.path,
      filePath: r.path,
    }));
  }, [fileResults]);

  const handleSelect = useCallback(
    (result: PaletteResult) => {
      if (result.kind === 'file' && result.filePath) {
        openFilePreview(result.filePath);
      }
      closeSearchPalette();
    },
    [openFilePreview, closeSearchPalette]
  );

  // Keyboard navigation
  useEffect(() => {
    if (!isSearchPaletteOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSearchPalette();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        movePaletteSelection('down', results.length - 1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        movePaletteSelection('up', results.length - 1);
        return;
      }
      if (e.key === 'Enter') {
        if (
          results.length > 0 &&
          paletteSelectedIndex >= 0 &&
          paletteSelectedIndex < results.length
        ) {
          e.preventDefault();
          handleSelect(results[paletteSelectedIndex]);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    isSearchPaletteOpen,
    closeSearchPalette,
    movePaletteSelection,
    handleSelect,
    results,
    paletteSelectedIndex,
  ]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const activeEl = listRef.current.querySelector('[data-active="true"]');
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [paletteSelectedIndex]);

  if (!isSearchPaletteOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]"
      onClick={closeSearchPalette}
      role="presentation"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-[hsl(220_42%_4%_/_0.46)] backdrop-blur-sm" />

      {/* Palette */}
      <div
        className="relative w-full max-w-[600px] mx-4 bg-popover border border-border rounded-lg shadow-2xl overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="快速搜索"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input row */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
          <SearchIcon className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            placeholder="搜索文件..."
            value={paletteQuery}
            onChange={(e) => setPaletteQuery(e.target.value)}
          />
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[min(50vh,400px)] overflow-y-auto">
          {results.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {paletteQuery.trim() ? '未找到匹配结果' : '输入文件名开始搜索'}
            </div>
          ) : (
            results.map((result, index) => (
              <button
                key={result.id}
                type="button"
                data-active={index === paletteSelectedIndex}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                  index === paletteSelectedIndex
                    ? 'bg-accent text-accent-foreground'
                    : 'text-foreground hover:bg-accent/50'
                }`}
                onClick={() => handleSelect(result)}
              >
                {result.kind === 'file' ? (
                  <File className="h-4 w-4 text-muted-foreground shrink-0" />
                ) : (
                  <KanbanSquare className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
                <span className="flex-1 min-w-0">
                  <span className="block text-sm truncate">{result.title}</span>
                  {result.subtitle && (
                    <span className="block text-xs text-muted-foreground truncate">
                      {result.subtitle}
                    </span>
                  )}
                </span>
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-4 px-3 py-1.5 border-t border-border text-[10px] text-muted-foreground">
          <span>
            <kbd className="px-1 py-0.5 bg-muted rounded text-[10px]">↑↓</kbd>{' '}
            导航
          </span>
          <span>
            <kbd className="px-1 py-0.5 bg-muted rounded text-[10px]">
              Enter
            </kbd>{' '}
            打开
          </span>
          <span>
            <kbd className="px-1 py-0.5 bg-muted rounded text-[10px]">Esc</kbd>{' '}
            关闭
          </span>
        </div>
      </div>
    </div>
  );
}
