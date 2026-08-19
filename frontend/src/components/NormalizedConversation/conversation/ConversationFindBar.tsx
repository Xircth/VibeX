import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

export function ConversationFindBar({
  query,
  current,
  total,
  onQueryChange,
  onNext,
  onPrevious,
  onClose,
}: {
  query: string;
  current: number;
  total: number;
  onQueryChange: (query: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(['conversation']);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <form
      className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-background px-2"
      onSubmit={(event) => {
        event.preventDefault();
        onNext();
      }}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder={t('find.placeholder')}
        aria-label={t('find.placeholder')}
        className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary/70"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          } else if (event.key === 'Enter' && event.shiftKey) {
            event.preventDefault();
            onPrevious();
          }
        }}
      />
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {query.trim()
          ? total > 0
            ? t('find.matches', { current, total })
            : t('find.none')
          : null}
      </span>
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={t('find.previous')}
        onClick={onPrevious}
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={t('find.next')}
        onClick={onNext}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={t('find.close')}
        onClick={onClose}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </form>
  );
}
