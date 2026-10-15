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
import { conversationSelectionToolbarPosition } from '@/components/NormalizedConversation/conversationSelection';
import { notesTextareaSelection } from './notesSelection';

export function NotesSelectionToolbar({
  editorRef,
}: {
  editorRef: RefObject<HTMLTextAreaElement | null>;
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
    const next = notesTextareaSelection(editorRef.current);
    if (!next) {
      setState(null);
      return;
    }
    const position = conversationSelectionToolbarPosition(next.rect);
    setState({ text: next.text, x: position.x, y: position.y });
  }, [editorRef]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
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
      syncFromSelection();
    };
    editor.addEventListener('mouseup', onMouseUp);
    editor.addEventListener('keyup', onKeyUp);
    return () => {
      editor.removeEventListener('mouseup', onMouseUp);
      editor.removeEventListener('keyup', onKeyUp);
    };
  }, [editorRef, hide, syncFromSelection]);

  if (!state) return null;

  return createPortal(
    <div
      ref={toolbarRef}
      role="toolbar"
      className="conversation-selection-toolbar fixed z-[10000] -translate-x-1/2 -translate-y-full"
      style={{ left: state.x, top: state.y }}
      onMouseDown={(event) => event.preventDefault()}
      data-testid="notes-selection-toolbar"
    >
      <NativeSurfaceOcclusionHold />
      <button
        type="button"
        onClick={() => {
          void writeClipboardViaBridge(state.text);
          const editor = editorRef.current;
          if (editor)
            editor.setSelectionRange(editor.selectionEnd, editor.selectionEnd);
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
          const editor = editorRef.current;
          if (editor)
            editor.setSelectionRange(editor.selectionEnd, editor.selectionEnd);
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
