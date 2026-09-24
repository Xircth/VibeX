import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, X } from 'lucide-react';

import { cn } from '@/lib/utils';

const ICON_BTN =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-primary/8 hover:text-foreground disabled:pointer-events-none disabled:opacity-40';

export function BrowserFindBar({
  open,
  focusToken,
  onClose,
  onFind,
}: {
  open: boolean;
  focusToken: number;
  onClose: () => void;
  onFind: (query: string, forward: boolean) => Promise<boolean>;
}) {
  const { t } = useTranslation('panels');
  const [query, setQuery] = useState('');
  const [missing, setMissing] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const seq = useRef(0);

  const step = useCallback(
    (text: string, forward: boolean) => {
      seq.current += 1;
      const current = seq.current;
      if (!text) {
        setMissing(false);
        void onFind('', true);
        return;
      }
      void onFind(text, forward).then((found) => {
        if (seq.current === current) setMissing(!found);
      });
    },
    [onFind]
  );

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open, focusToken]);

  useEffect(() => {
    if (open) return;
    seq.current += 1;
    void onFind('', true);
    setMissing(false);
  }, [open, onFind]);

  if (!open) return null;
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 bg-muted/40 px-1.5">
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => {
          const text = event.target.value;
          setQuery(text);
          step(text, true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            step(query, !event.shiftKey);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
        spellCheck={false}
        autoComplete="off"
        placeholder={t('browserPanel.findPlaceholder')}
        aria-label={t('browserPanel.findPlaceholder')}
        className={cn(
          'mx-1 h-7 min-w-0 flex-1 rounded-md border bg-background px-2.5 text-xs outline-none',
          missing
            ? 'border-destructive/60 text-destructive'
            : 'border-transparent focus:border-ring/50'
        )}
      />
      {missing ? (
        <span className="shrink-0 px-1 text-xs text-muted-foreground">
          {t('browserPanel.findNone')}
        </span>
      ) : null}
      <button type="button" className={ICON_BTN} disabled={!query} onClick={() => step(query, false)}>
        <ChevronUp className="h-4 w-4" />
      </button>
      <button type="button" className={ICON_BTN} disabled={!query} onClick={() => step(query, true)}>
        <ChevronDown className="h-4 w-4" />
      </button>
      <button type="button" className={ICON_BTN} onClick={onClose} aria-label={t('browserPanel.findClose')}>
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
