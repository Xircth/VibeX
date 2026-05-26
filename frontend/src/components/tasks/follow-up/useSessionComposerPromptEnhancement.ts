import { useCallback, useState } from 'react';
import type { PromptEnhancementContextMessage } from '@/lib/api/config';
import { configApi } from '@/lib/api';
import {
  buildPromptEnhancementRequest,
  getPromptEnhancementErrorMessage,
  getPromptEnhancementStartDecision,
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

  const handleEnhancePrompt = useCallback(async () => {
    const startDecision = getPromptEnhancementStartDecision({
      isEnhancingPrompt,
      draftPrompt,
    });
    if (!startDecision.shouldStartEnhancement) return;

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

      applyEnhancedPrompt(
        normalizeEnhancedPrompt({ enhancedPrompt: result.enhancedPrompt })
      );
    } catch (error) {
      setFollowUpError(getPromptEnhancementErrorMessage(error));
    } finally {
      setIsEnhancingPrompt(false);
    }
  }, [
    isEnhancingPrompt,
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
