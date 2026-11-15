import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, Check, MessageSquarePlus, Pencil, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Markdown } from '@astryxdesign/core/Markdown';
import { usePortalContainer } from '@/contexts/PortalContainerContext';
import {
  hasQuoteSourceAnchor,
  type QuoteTokenMetadata,
} from './quoteTokenMetadata';

export function QuoteTokenPreview({
  anchor,
  id,
  text,
  quoteMeta,
  onJumpToSource,
  onUpdateAnnotation,
  onEditingChange,
  onPointerEnter,
  onPointerLeave,
}: {
  anchor: HTMLElement;
  id?: string;
  text: string;
  quoteMeta?: QuoteTokenMetadata;
  onJumpToSource?: () => void;
  onUpdateAnnotation?: (annotation: string) => void;
  onEditingChange?: (editing: boolean) => void;
  onPointerEnter?: () => void;
  onPointerLeave?: (event: PointerEvent<HTMLDivElement>) => void;
}) {
  const { t } = useTranslation('conversation');
  const portalContainer = usePortalContainer();
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const noteInputRef = useRef<HTMLInputElement | null>(null);
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(quoteMeta?.annotation ?? '');
  const [position, setPosition] = useState<CSSProperties>({
    left: 0,
    top: 0,
    visibility: 'hidden',
  });

  useEffect(() => {
    if (!editingNote) {
      setNoteDraft(quoteMeta?.annotation ?? '');
    }
  }, [editingNote, quoteMeta?.annotation]);

  useEffect(() => {
    if (editingNote) {
      noteInputRef.current?.focus();
      noteInputRef.current?.select();
    }
  }, [editingNote]);

  const setEditing = (next: boolean) => {
    setEditingNote(next);
    onEditingChange?.(next);
  };

  const canJump = Boolean(hasQuoteSourceAnchor(quoteMeta) && onJumpToSource);
  const canAnnotate = Boolean(onUpdateAnnotation);
  const showFooter = canJump || canAnnotate;

  useLayoutEffect(() => {
    const updatePosition = () => {
      const tooltip = tooltipRef.current;
      if (!tooltip || !anchor.isConnected) return;

      const anchorRect = anchor.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const margin = 8;
      const gap = 7;
      const width = tooltipRect.width || 280;
      const height = tooltipRect.height || 160;
      const centeredLeft = anchorRect.left + anchorRect.width / 2 - width / 2;
      const left = Math.min(
        Math.max(margin, centeredLeft),
        Math.max(margin, viewportWidth - width - margin)
      );
      const preferredTop = anchorRect.top - height - gap;
      const top =
        preferredTop >= margin
          ? preferredTop
          : Math.min(
              anchorRect.bottom + gap,
              Math.max(margin, viewportHeight - height - margin)
            );

      setPosition({ left, top, visibility: 'visible' });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchor, editingNote, quoteMeta?.annotation, showFooter, text]);

  const commitAnnotation = (nextValue: string) => {
    onUpdateAnnotation?.(nextValue.trim());
    setEditing(false);
  };

  return createPortal(
    <div
      ref={tooltipRef}
      id={id}
      role="tooltip"
      className="quote-token-preview fixed z-[2147483646] w-[min(22rem,calc(100vw-1rem))] max-h-64 overflow-y-auto overscroll-contain rounded-lg p-3 text-xs leading-5 text-foreground"
      style={position}
      onPointerEnter={onPointerEnter}
      onPointerLeave={(event) => {
        if (editingNote) return;
        onPointerLeave?.(event);
      }}
    >
      <div className="conv-markdown quote-token-preview-markdown break-words text-xs leading-5 text-foreground">
        <Markdown display="block" density="compact" autolink="gfm">
          {text}
        </Markdown>
      </div>
      {quoteMeta?.annotation && !editingNote ? (
        <div
          className="mt-2 rounded border border-border/60 bg-muted/40 px-2 py-1 text-[11px] leading-4 text-muted-foreground break-words"
          data-testid="quote-token-preview-annotation"
        >
          {quoteMeta.annotation}
        </div>
      ) : null}
      {editingNote && canAnnotate ? (
        <div
          className="mt-2 flex items-center gap-1 border-t border-border/60 pt-2"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <input
            ref={noteInputRef}
            type="text"
            value={noteDraft}
            onChange={(event) => setNoteDraft(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                event.preventDefault();
                commitAnnotation(noteDraft);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setNoteDraft(quoteMeta?.annotation ?? '');
                setEditing(false);
              }
            }}
            placeholder={t('quoteAnchor.annotationPlaceholder')}
            aria-label={t('quoteAnchor.annotate')}
            className="h-6 min-w-0 flex-1 rounded border border-border/70 bg-background px-1.5 text-xs text-foreground outline-none focus:border-primary"
            data-testid="quote-token-note-input"
          />
          <button
            type="button"
            onClick={() => commitAnnotation(noteDraft)}
            aria-label={t('quoteAnchor.saveAnnotation')}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            data-testid="quote-token-note-save"
          >
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          {quoteMeta?.annotation ? (
            <button
              type="button"
              onClick={() => commitAnnotation('')}
              aria-label={t('quoteAnchor.clearAnnotation')}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              data-testid="quote-token-note-clear"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : showFooter ? (
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/50 pt-1.5 text-[11px]">
          {canJump ? (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                onJumpToSource?.();
              }}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              data-testid="quote-token-jump-source"
            >
              <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
              <span>{t('quoteAnchor.jumpToSource')}</span>
            </button>
          ) : (
            <span />
          )}
          {canAnnotate ? (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                onPointerEnter?.();
                setEditing(true);
              }}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              data-testid="quote-token-edit-note"
            >
              {quoteMeta?.annotation ? (
                <Pencil className="h-3 w-3" aria-hidden="true" />
              ) : (
                <MessageSquarePlus className="h-3 w-3" aria-hidden="true" />
              )}
              <span>
                {quoteMeta?.annotation
                  ? t('quoteAnchor.editAnnotation')
                  : t('quoteAnchor.annotate')}
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>,
    portalContainer ?? document.body
  );
}
