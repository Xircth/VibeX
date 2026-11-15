import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  BookmarkPlus,
  Check,
  FileText,
  MessageSquarePlus,
  Quote,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePortalContainer } from '@/contexts/PortalContainerContext';
import { NativeSurfaceOcclusionHold } from '@/contexts/WorkspaceOverlayContext';
import { requestComposerTokenInsert } from '@/lib/composerInsert';
import { writeClipboardViaBridge } from '@/vscode/bridge';
import {
  formatQuoteToken,
  quoteTokenChipLabel,
  type QuoteTokenInputMetadata,
  type QuoteTokenMetadata,
} from '@/components/tasks/follow-up/sessionComposerStructuredTokens';
import {
  conversationSelectionInRoot,
  conversationSelectionToolbarPosition,
} from './conversationSelection';
import i18n from '@/i18n';

export function ConversationSelectionToolbar({
  rootRef,
  conversationId,
  onQuote,
  onAddToCollection,
}: {
  rootRef: RefObject<HTMLElement | null>;
  conversationId?: string | null;
  onQuote?: (selectedText: string) => void;
  onAddToCollection?: (selectedText: string) => void;
}) {
  const { t } = useTranslation(['common', 'conversation']);
  const portalContainer = usePortalContainer();
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const noteInputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<{
    text: string;
    x: number;
    y: number;
    anchor?: QuoteTokenMetadata;
  } | null>(null);
  const [annotating, setAnnotating] = useState(false);
  const [annotationDraft, setAnnotationDraft] = useState('');

  const hide = useCallback(() => {
    setAnnotating(false);
    setAnnotationDraft('');
    setState(null);
  }, []);

  const syncFromSelection = useCallback(() => {
    const next = conversationSelectionInRoot(rootRef.current);
    if (!next) {
      hide();
      return;
    }
    const position = conversationSelectionToolbarPosition(next.rect);
    setAnnotating(false);
    setAnnotationDraft('');
    setState({
      text: next.text,
      x: position.x,
      y: position.y,
      anchor: next.anchor,
    });
  }, [hide, rootRef]);

  useEffect(() => {
    const onMouseUp = (event: MouseEvent) => {
      if (
        toolbarRef.current &&
        event.target instanceof Node &&
        toolbarRef.current.contains(event.target)
      ) {
        return;
      }
      window.setTimeout(syncFromSelection, 0);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (
        toolbarRef.current &&
        event.target instanceof Node &&
        toolbarRef.current.contains(event.target)
      ) {
        return;
      }
      if (event.key === 'Escape') {
        hide();
        return;
      }
      if (
        event.shiftKey &&
        (event.key === 'ArrowLeft' ||
          event.key === 'ArrowRight' ||
          event.key === 'ArrowUp' ||
          event.key === 'ArrowDown')
      ) {
        syncFromSelection();
      }
    };
    const onScroll = () => hide();
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [hide, syncFromSelection]);

  useEffect(() => {
    if (annotating) {
      noteInputRef.current?.focus();
    }
  }, [annotating]);

  if (!state) return null;

  const insertQuoteWithMetadata = (note?: string) => {
    const trimmedNote = note?.trim() || undefined;
    if (onQuote && !trimmedNote) {
      onQuote(state.text);
    } else {
      const metadata: QuoteTokenInputMetadata | undefined =
        state.anchor || trimmedNote
          ? {
              ...state.anchor,
              ...(state.anchor && conversationId ? { conversationId } : {}),
              ...(trimmedNote ? { annotation: trimmedNote } : {}),
            }
          : undefined;
      const formatted = formatQuoteToken(state.text, metadata);
      if (onQuote && trimmedNote) {
        onQuote(`${state.text} (Note: ${trimmedNote})`);
      } else {
        requestComposerTokenInsert({
          value: formatted,
          label: quoteTokenChipLabel(state.text),
          conversationId,
        });
      }
    }
    window.getSelection()?.removeAllRanges();
    hide();
  };

  const handleQuote = () => {
    insertQuoteWithMetadata();
  };

  const handleOpenAnnotate = () => {
    setAnnotating(true);
  };

  const handleSubmitAnnotation = () => {
    insertQuoteWithMetadata(annotationDraft);
  };

  const handleCopy = () => {
    void writeClipboardViaBridge(state.text);
    window.getSelection()?.removeAllRanges();
    hide();
  };

  return createPortal(
    <div
      ref={toolbarRef}
      role="toolbar"
      className="conversation-selection-toolbar fixed z-[10000] -translate-x-1/2 -translate-y-full"
      style={{ left: state.x, top: state.y }}
      onMouseDown={(event) => event.preventDefault()}
      data-testid="conversation-selection-toolbar"
    >
      <NativeSurfaceOcclusionHold />
      {annotating ? (
        <div
          className="flex items-center gap-1 px-1.5"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <input
            ref={noteInputRef}
            type="text"
            value={annotationDraft}
            onChange={(event) => setAnnotationDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleSubmitAnnotation();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setAnnotating(false);
                setAnnotationDraft('');
              }
            }}
            placeholder={t('conversation:quoteAnchor.annotationPlaceholder')}
            aria-label={t('conversation:quoteAnchor.annotate')}
            className="h-6 w-44 bg-transparent px-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground"
            data-testid="conversation-selection-annotation-input"
          />
          <button
            type="button"
            onClick={handleSubmitAnnotation}
            aria-label={t('conversation:quoteAnchor.saveAnnotation')}
            data-testid="conversation-selection-annotation-submit"
          >
            <Check aria-hidden="true" />
          </button>
        </div>
      ) : onAddToCollection ? (
        <>
          <button
            type="button"
            onClick={handleQuote}
            data-testid="conversation-selection-quote"
          >
            <Quote aria-hidden="true" />
            {t('contextMenu.quote', {
              defaultValue: i18n.t('panels:ui.selection.quote'),
            })}
          </button>
          <button
            type="button"
            onClick={handleOpenAnnotate}
            data-testid="conversation-selection-annotate"
          >
            <MessageSquarePlus aria-hidden="true" />
            {t('conversation:quoteAnchor.annotate')}
          </button>
          <button
            type="button"
            onClick={() => {
              onAddToCollection(state.text);
              window.getSelection()?.removeAllRanges();
              hide();
            }}
            data-testid="conversation-selection-add-to-collection"
          >
            <BookmarkPlus aria-hidden="true" />
            {t('contextMenu.addToCollection', {
              defaultValue: i18n.t('panels:ui.selection.addToGroupSaved'),
            })}
          </button>
          <button
            type="button"
            onClick={handleCopy}
            data-testid="conversation-selection-copy"
          >
            <FileText aria-hidden="true" />
            {t('contextMenu.copyText', {
              defaultValue: i18n.t('panels:ui.selection.copyText'),
            })}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={handleCopy}
            data-testid="conversation-selection-copy"
          >
            <FileText aria-hidden="true" />
            {t('contextMenu.copyText', {
              defaultValue: i18n.t('panels:ui.selection.copyText'),
            })}
          </button>
          <button
            type="button"
            onClick={handleQuote}
            data-testid="conversation-selection-quote"
          >
            <Quote aria-hidden="true" />
            {t('contextMenu.quote', {
              defaultValue: i18n.t('panels:ui.selection.quote'),
            })}
          </button>
          <button
            type="button"
            onClick={handleOpenAnnotate}
            data-testid="conversation-selection-annotate"
          >
            <MessageSquarePlus aria-hidden="true" />
            {t('conversation:quoteAnchor.annotate')}
          </button>
        </>
      )}
    </div>,
    portalContainer ?? document.body
  );
}
