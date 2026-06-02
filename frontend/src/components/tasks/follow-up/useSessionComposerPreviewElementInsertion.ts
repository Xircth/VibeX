import { useEffect, useRef } from 'react';
import {
  buildClickedElementData,
  useClickedElements,
} from '@/contexts/ClickedElementsProvider';
import { insertPreviewElementToken } from './sessionComposerStructuredTokens';

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
}
