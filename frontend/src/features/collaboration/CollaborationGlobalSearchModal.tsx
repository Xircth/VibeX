import { Search, X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { COPY } from './spaceModel';

export function CollaborationGlobalSearchModal({
  query,
  onQueryChange,
  onClose,
  children,
  empty,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  onClose: () => void;
  children: ReactNode;
  empty: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="collaboration-global-search-backdrop"
      data-testid="collaboration-global-search-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="搜索协作空间或助手"
        data-testid="collaboration-global-search-modal"
        className="collaboration-global-search-modal dialog-surface"
      >
        <div className="collaboration-global-search-header">
          <Search
            className="collaboration-global-search-icon"
            aria-hidden="true"
          />
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
              }
            }}
            placeholder={COPY.globalSearchPlaceholder}
            aria-label="搜索协作空间或助手输入框"
            data-testid="collaboration-global-search-input"
            className="collaboration-global-search-input"
          />
          {query ? (
            <button
              type="button"
              aria-label="清空搜索"
              className="collaboration-global-search-clear"
              onClick={() => onQueryChange('')}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <div className="collaboration-global-search-divider" />
        <div
          className="collaboration-global-search-list"
          data-testid="collaboration-global-search-results"
        >
          {empty ? (
            <p className="collaboration-global-search-empty">
              未找到匹配的助手或群聊
            </p>
          ) : (
            children
          )}
        </div>
      </div>
    </div>
  );
}
