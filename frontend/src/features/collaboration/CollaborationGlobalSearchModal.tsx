import { Search, X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { COPY } from './spaceModel';
import i18n from '@/i18n';

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
        aria-label={i18n.t('panels:ui.globalSearch.searchSpacesOrBots')}
        data-testid="collaboration-global-search-modal"
        className="collaboration-global-search-modal dialog-surface"
      >
        <div className="collaboration-global-search-header">
          <div className="collaboration-global-search-field">
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
              aria-label={i18n.t('panels:ui.globalSearch.searchSpacesOrBotsInput')}
              data-testid="collaboration-global-search-input"
              className="collaboration-global-search-input"
            />
          </div>
          {query ? (
            <button
              type="button"
              aria-label={i18n.t('panels:ui.globalSearch.clearSearch')}
              className="collaboration-global-search-clear"
              onClick={() => onQueryChange('')}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <div
          className="collaboration-global-search-list"
          data-testid="collaboration-global-search-results"
        >
          {empty ? (
            <p className="collaboration-global-search-empty">
              {i18n.t('panels:ui.globalSearch.noMatchingBotsOrGroups')}
            </p>
          ) : (
            children
          )}
        </div>
      </div>
    </div>
  );
}
