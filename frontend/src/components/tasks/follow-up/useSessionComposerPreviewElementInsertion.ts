import { useCallback, useEffect, useRef } from 'react';
import {
  buildClickedElementData,
  useClickedElements,
} from '@/contexts/ClickedElementsProvider';
import { backendListen } from '@/lib/backendTransport';
import {
  type ComposerDraftTargetHandle,
  type ComposerDraftToken,
  getActiveComposerDraftTargetId,
  registerComposerDraftTarget,
} from '@/lib/composerDraftTargets';
import { insertPreviewElementToken } from './sessionComposerStructuredTokens';

const DRAFT_INSERT_EVENT = 'plugin-conversation-draft-insert';

export function useSessionComposerPreviewElementInsertion({
  enabled,
  getMessage,
  onChange,
}: {
  enabled: boolean;
  getMessage: () => string;
  onChange: (message: string) => void;
}): { markFocused: () => void } {
  const { registerOnElementAdded, workspaceRoot } = useClickedElements();
  const initialMessage = getMessage();
  const getMessageRef = useRef(getMessage);
  const onChangeRef = useRef(onChange);
  const draftMessageRef = useRef(initialMessage);
  const lastExternalMessageRef = useRef(initialMessage);

  getMessageRef.current = getMessage;
  onChangeRef.current = onChange;

  useEffect(() => {
    const externalMessage = getMessage();
    if (externalMessage !== lastExternalMessageRef.current) {
      lastExternalMessageRef.current = externalMessage;
      draftMessageRef.current = externalMessage;
    }
  }, [getMessage]);

  useEffect(() => {
    if (!enabled) return undefined;

    return registerOnElementAdded((entry) => {
      const elementData = buildClickedElementData(entry, workspaceRoot);
      const externalMessage = getMessageRef.current();
      if (externalMessage !== lastExternalMessageRef.current) {
        lastExternalMessageRef.current = externalMessage;
        draftMessageRef.current = externalMessage;
      }

      const currentMessage = draftMessageRef.current;
      const next = insertPreviewElementToken({
        value: currentMessage,
        selectionStart: currentMessage.length,
        selectionEnd: currentMessage.length,
        componentName: elementData.componentName,
        filePath: elementData.filePath,
        fullMarkdown: elementData.fullMarkdown,
      });

      draftMessageRef.current = next.value;
      onChangeRef.current(next.value);
    });
  }, [enabled, registerOnElementAdded, workspaceRoot]);

  const insertDraftToken = useCallback((token: ComposerDraftToken) => {
    const externalMessage = getMessageRef.current();
    if (externalMessage !== lastExternalMessageRef.current) {
      lastExternalMessageRef.current = externalMessage;
      draftMessageRef.current = externalMessage;
    }
    const currentMessage = draftMessageRef.current;
    const plainText = token.text?.trim() ?? '';
    if (plainText && !token.label?.trim()) {
      const needsSpace =
        currentMessage.length > 0 &&
        !/[\s\u3000-\u303f\uff00-\uffef]$/.test(currentMessage) &&
        !/^[\s\u3000-\u303f\uff00-\uffef]/.test(plainText);
      const nextValue = `${currentMessage}${needsSpace ? ' ' : ''}${plainText}`;
      draftMessageRef.current = nextValue;
      onChangeRef.current(nextValue);
      return;
    }
    const next = insertPreviewElementToken({
      value: currentMessage,
      selectionStart: currentMessage.length,
      selectionEnd: currentMessage.length,
      componentName: token.label,
      filePath: '',
      fullMarkdown: token.markdown,
    });
    draftMessageRef.current = next.value;
    onChangeRef.current(next.value);
  }, []);

  const handleRef = useRef<ComposerDraftTargetHandle | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled) return undefined;
    const handle = registerComposerDraftTarget({
      isEditable: () => enabledRef.current,
      insert: insertDraftToken,
    });
    handleRef.current = handle;
    return () => {
      handle.dispose();
      if (handleRef.current === handle) handleRef.current = null;
    };
  }, [enabled, insertDraftToken]);

  // Backend-emitted insertions (e.g. from plugin workers) target only the most
  // recently focused editable composer, so split views insert exactly once.
  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void backendListen(
      DRAFT_INSERT_EVENT,
      (payload: {
        text?: string;
        token?: { label?: string; markdown?: string; text?: string };
      }) => {
        const label = payload.token?.label?.trim() ?? '';
        const markdown = payload.token?.markdown?.trim() ?? '';
        const text = payload.token?.text?.trim() ?? payload.text?.trim() ?? '';
        if ((!label || !markdown) && !text) return;
        const handle = handleRef.current;
        if (!handle || getActiveComposerDraftTargetId() !== handle.id) return;
        insertDraftToken({
          label,
          markdown,
          ...(text ? { text } : {}),
        });
      }
    ).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled, insertDraftToken]);

  const markFocused = useCallback(() => {
    handleRef.current?.markFocused();
  }, []);

  return { markFocused };
}
