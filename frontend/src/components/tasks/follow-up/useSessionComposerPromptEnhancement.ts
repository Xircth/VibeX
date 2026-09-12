import { useCallback, useRef, useState } from 'react';
import type { PromptEnhancementContextMessage } from '@/lib/api/config';
import { configApi } from '@/lib/api';
import {
  buildPromptEnhancementRequest,
  getPromptEnhancementClickAction,
  getPromptEnhancementErrorMessage,
  isPromptEnhancementCancelledError,
  normalizeEnhancedPrompt,
} from './sessionComposerPromptEnhancement';

export function useSessionComposerPromptEnhancement({
  draftPrompt,
  sessionId,
  workspaceId,
  contextMessages,
  applyEnhancedPrompt,
  setFollowUpError,
}: {
  draftPrompt: string;
  sessionId: string | null | undefined;
  workspaceId: string | null | undefined;
  contextMessages: PromptEnhancementContextMessage[];
  applyEnhancedPrompt: (prompt: string) => void;
  setFollowUpError: (message: string | null) => void;
}) {
  const [isEnhancingPrompt, setIsEnhancingPrompt] = useState(false);
  const enhancementGenerationRef = useRef(0);
  const isEnhancingPromptRef = useRef(false);

  const handleEnhancePrompt = useCallback(async () => {
    const action = getPromptEnhancementClickAction({
      isEnhancingPrompt: isEnhancingPromptRef.current,
      draftPrompt,
    });
    if (action === 'ignore') return;

    if (action === 'cancel') {
      enhancementGenerationRef.current += 1;
      isEnhancingPromptRef.current = false;
      setIsEnhancingPrompt(false);
      try {
        await configApi.cancelEnhancePrompt();
      } catch {
        // The in-flight request is already abandoned locally.
      }
      return;
    }

    const generation = ++enhancementGenerationRef.current;
    isEnhancingPromptRef.current = true;
    setIsEnhancingPrompt(true);
    setFollowUpError(null);

    try {
      const result = await configApi.enhancePrompt(
        buildPromptEnhancementRequest({
          draftPrompt,
          sessionId,
          workspaceId,
          contextMessages,
        })
      );
      if (generation !== enhancementGenerationRef.current) return;

      applyEnhancedPrompt(
        normalizeEnhancedPrompt({ enhancedPrompt: result.enhancedPrompt })
      );
    } catch (error) {
      if (generation !== enhancementGenerationRef.current) return;
      if (isPromptEnhancementCancelledError(error)) return;
      setFollowUpError(getPromptEnhancementErrorMessage(error));
    } finally {
      if (generation === enhancementGenerationRef.current) {
        isEnhancingPromptRef.current = false;
        setIsEnhancingPrompt(false);
      }
    }
  }, [
    draftPrompt,
    sessionId,
    workspaceId,
    contextMessages,
    applyEnhancedPrompt,
    setFollowUpError,
  ]);

  return {
    isEnhancingPrompt,
    handleEnhancePrompt,
  };
}
