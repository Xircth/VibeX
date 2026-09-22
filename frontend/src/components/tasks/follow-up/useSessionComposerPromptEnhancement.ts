import { useCallback, useEffect, useRef } from 'react';
import type { PromptEnhancementContextMessage } from '@/lib/api/config';
import { configApi } from '@/lib/api';
import {
  promptEnhancementOwnerKey,
  usePromptEnhancementStore,
} from '@/stores/usePromptEnhancementStore';
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
  const ownerKey = promptEnhancementOwnerKey(sessionId, workspaceId);
  const run = usePromptEnhancementStore((state) => state.runs[ownerKey]);
  const isEnhancingPrompt = run?.status === 'running';
  const mountedRef = useRef(true);
  const applyEnhancedPromptRef = useRef(applyEnhancedPrompt);
  const setFollowUpErrorRef = useRef(setFollowUpError);
  applyEnhancedPromptRef.current = applyEnhancedPrompt;
  setFollowUpErrorRef.current = setFollowUpError;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!run || run.status === 'running') return;
    const completed = usePromptEnhancementStore.getState().consume(ownerKey);
    if (!completed) return;
    if (completed.status === 'success' && completed.enhancedPrompt) {
      applyEnhancedPromptRef.current(completed.enhancedPrompt);
      return;
    }
    if (completed.status === 'error' && completed.error) {
      setFollowUpErrorRef.current(completed.error);
    }
  }, [ownerKey, run]);

  const handleEnhancePrompt = useCallback(async () => {
    const action = getPromptEnhancementClickAction({
      isEnhancingPrompt:
        usePromptEnhancementStore.getState().runs[ownerKey]?.status ===
        'running',
      draftPrompt,
    });
    if (action === 'ignore') return;

    if (action === 'cancel') {
      const current = usePromptEnhancementStore.getState().runs[ownerKey];
      usePromptEnhancementStore
        .getState()
        .cancel(ownerKey, current?.generation);
      try {
        await configApi.cancelEnhancePrompt();
      } catch {
        // The in-flight request is already abandoned locally.
      }
      return;
    }

    const generation = usePromptEnhancementStore.getState().begin(ownerKey);
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
      const prompt = normalizeEnhancedPrompt({
        enhancedPrompt: result.enhancedPrompt,
      });
      const current = usePromptEnhancementStore.getState().runs[ownerKey];
      if (!current || current.generation !== generation) return;
      if (mountedRef.current) {
        applyEnhancedPrompt(prompt);
        usePromptEnhancementStore.getState().cancel(ownerKey, generation);
        return;
      }
      usePromptEnhancementStore
        .getState()
        .succeed(ownerKey, generation, prompt);
    } catch (error) {
      const current = usePromptEnhancementStore.getState().runs[ownerKey];
      if (!current || current.generation !== generation) return;
      if (isPromptEnhancementCancelledError(error)) {
        usePromptEnhancementStore.getState().cancel(ownerKey, generation);
        return;
      }
      const message = getPromptEnhancementErrorMessage(error);
      if (mountedRef.current) {
        setFollowUpError(message);
        usePromptEnhancementStore.getState().cancel(ownerKey, generation);
        return;
      }
      usePromptEnhancementStore.getState().fail(ownerKey, generation, message);
    }
  }, [
    draftPrompt,
    sessionId,
    workspaceId,
    contextMessages,
    applyEnhancedPrompt,
    setFollowUpError,
    ownerKey,
  ]);

  return {
    isEnhancingPrompt,
    handleEnhancePrompt,
  };
}
