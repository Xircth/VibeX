import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { FileText, Quote } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePortalContainer } from '@/contexts/PortalContainerContext';
import { NativeSurfaceOcclusionHold } from '@/contexts/WorkspaceOverlayContext';
import { requestComposerTokenInsert } from '@/lib/composerInsert';
import { writeClipboardViaBridge } from '@/vscode/bridge';
import {
  formatQuoteToken,
  quoteTokenChipLabel,
} from '@/components/tasks/follow-up/sessionComposerStructuredTokens';
import {
  conversationSelectionInRoot,
  conversationSelectionToolbarPosition,
} from './conversationSelection';

export function ConversationSelectionToolbar({
  rootRef,
}: {
  rootRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation('common');
  const portalContainer = usePortalContainer();
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<{
    text: string;
    x: number;
    y: number;
  } | null>(null);

  const hide = useCallback(() => setState(null), []);

  const syncFromSelection = useCallback(() => {
    const next = conversationSelectionInRoot(rootRef.current);
    if (!next) {
      setState(null);
      return;
    }
    const position = conversationSelectionToolbarPosition(next.rect);
    setState({
      text: next.text,
      x: position.x,
      y: position.y,
    });
  }, [rootRef]);

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

  if (!state) return null;

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
      <button
        type="button"
        onClick={() => {
          void writeClipboardViaBridge(state.text);
          window.getSelection()?.removeAllRanges();
          hide();
        }}
      >
        <FileText aria-hidden="true" />
        {t('contextMenu.copyText')}
      </button>
      <button
        type="button"
        onClick={() => {
          requestComposerTokenInsert({
            value: formatQuoteToken(state.text),
            label: quoteTokenChipLabel(state.text),
          });
          window.getSelection()?.removeAllRanges();
          hide();
        }}
      >
        <Quote aria-hidden="true" />
        {t('contextMenu.quote')}
      </button>
    </div>,
    portalContainer ?? document.body
  );
}
