import { useEffect, useRef } from 'react';
import {
  buildClickedElementData,
  useClickedElements,
} from '@/contexts/ClickedElementsProvider';
import { backendListen } from '@/lib/backendTransport';
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
}) {
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

  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void backendListen(
      DRAFT_INSERT_EVENT,
      (payload: {
        token?: { label?: string; markdown?: string };
      }) => {
        const label = payload.token?.label?.trim();
        const markdown = payload.token?.markdown?.trim();
        if (!label || !markdown) return;
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
          componentName: label,
          filePath: '',
          fullMarkdown: markdown,
        });
        draftMessageRef.current = next.value;
        onChangeRef.current(next.value);
      }
    ).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled]);
}
