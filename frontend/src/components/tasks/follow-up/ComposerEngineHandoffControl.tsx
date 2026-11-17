import {
  useCallback,
  useContext,
  useRef,
} from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import type { ExecutorProfileId } from 'shared/types';
import { toast } from '@/components/ui/toast';
import {
  conversationApi,
  isUnimplementedConversationCommandError,
} from '@/features/conversation/conversationApi';
import { recordMruProviderInstanceId } from '@/lib/providerInstanceMru';
import {
  LOCAL_PROVIDER_INSTANCE_ID,
  normalizeAgentGroupKey,
  normalizeProviderInstanceIdForApi,
} from '@/lib/providerInstancesApi';
import { syncSessionAgentInCaches } from '@/lib/sessionQueryCache';

function isUnavailableHandoffCommandError(error: unknown): boolean {
  if (isUnimplementedConversationCommandError(error)) {
    return true;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return /__tauri_internals__|reading\s+'invoke'|tauri\s+runtime/i.test(msg);
}

export interface ComposerEngineHandoffController {
  handleChangeExecutorProfile: (next: ExecutorProfileId | null) => void;
  handleChangeProviderInstance: (nextInstanceId: string) => void;
}

export function useComposerEngineHandoff({
  sessionId,
  currentExecutor,
  currentProviderInstanceId = null,
  onApplyExecutorProfile,
  onApplyProviderInstanceId,
  resolveTargetInstanceIdForAgent,
}: {
  sessionId: string | null | undefined;
  currentExecutor: string | null | undefined;
  currentProviderInstanceId?: string | null;
  onApplyExecutorProfile: (profile: ExecutorProfileId | null) => void;
  onApplyProviderInstanceId?: (
    instanceId: string | null,
    targetAgentId?: string | null
  ) => void;
  resolveTargetInstanceIdForAgent?: (agentId: string) => string | null;
}): ComposerEngineHandoffController {
  const queryClient = useContext(QueryClientContext);
  const switchSeqRef = useRef(0);

  const handleChangeExecutorProfile = useCallback(
    (nextProfile: ExecutorProfileId | null) => {
      const isDifferentAgent = Boolean(
        nextProfile &&
          (!currentExecutor ||
            normalizeAgentGroupKey(nextProfile.executor) !==
              normalizeAgentGroupKey(currentExecutor))
      );

      const resolvedTargetInstance =
        nextProfile && resolveTargetInstanceIdForAgent
          ? normalizeProviderInstanceIdForApi(
              resolveTargetInstanceIdForAgent(nextProfile.executor)
            )
          : undefined;

      if (!nextProfile || !sessionId || !isDifferentAgent) {
        if (nextProfile && resolvedTargetInstance !== undefined) {
          onApplyProviderInstanceId?.(
            resolvedTargetInstance,
            nextProfile.executor
          );
        }
        onApplyExecutorProfile(nextProfile);
        return;
      }

      const previousExecutor = currentExecutor ?? null;
      const previousInstance = normalizeProviderInstanceIdForApi(
        currentProviderInstanceId
      );
      const previousProfile: ExecutorProfileId | null = previousExecutor
        ? {
            executor: previousExecutor as ExecutorProfileId['executor'],
            variant: null,
          }
        : null;
      const switchSeq = ++switchSeqRef.current;

      if (resolvedTargetInstance !== undefined) {
        syncSessionAgentInCaches(
          queryClient,
          sessionId,
          nextProfile.executor,
          resolvedTargetInstance
        );
        onApplyProviderInstanceId?.(
          resolvedTargetInstance,
          nextProfile.executor
        );
      } else {
        syncSessionAgentInCaches(queryClient, sessionId, nextProfile.executor);
      }
      onApplyExecutorProfile(nextProfile);
      void conversationApi
        .confirmEngineHandoff({
          conversationId: sessionId,
          targetEngine: nextProfile.executor,
          ...(resolvedTargetInstance
            ? { targetProviderInstanceId: resolvedTargetInstance }
            : {}),
        })
        .catch((error: unknown) => {
          if (isUnavailableHandoffCommandError(error)) {
            return;
          }
          if (switchSeq === switchSeqRef.current) {
            if (previousExecutor) {
              if (resolvedTargetInstance !== undefined) {
                syncSessionAgentInCaches(
                  queryClient,
                  sessionId,
                  previousExecutor,
                  previousInstance
                );
              } else {
                syncSessionAgentInCaches(
                  queryClient,
                  sessionId,
                  previousExecutor
                );
              }
            }
            if (resolvedTargetInstance !== undefined) {
              onApplyProviderInstanceId?.(previousInstance, previousExecutor);
            }
            onApplyExecutorProfile(previousProfile);
          }
          toast.error(error instanceof Error ? error.message : String(error));
        });
    },
    [
      currentExecutor,
      currentProviderInstanceId,
      onApplyExecutorProfile,
      onApplyProviderInstanceId,
      queryClient,
      resolveTargetInstanceIdForAgent,
      sessionId,
    ]
  );

  const handleChangeProviderInstance = useCallback(
    (nextInstanceId: string) => {
      if (!currentExecutor) return;
      const nextStorageInstance =
        normalizeProviderInstanceIdForApi(nextInstanceId);
      const previousInstance = normalizeProviderInstanceIdForApi(
        currentProviderInstanceId
      );
      recordMruProviderInstanceId(currentExecutor, nextInstanceId);
      if (nextStorageInstance === previousInstance) {
        onApplyProviderInstanceId?.(nextStorageInstance, currentExecutor);
        return;
      }

      onApplyProviderInstanceId?.(nextStorageInstance, currentExecutor);
      if (!sessionId) {
        return;
      }

      const nextWireInstance =
        nextStorageInstance ?? LOCAL_PROVIDER_INSTANCE_ID;
      const switchSeq = ++switchSeqRef.current;

      syncSessionAgentInCaches(
        queryClient,
        sessionId,
        currentExecutor,
        nextStorageInstance
      );

      void conversationApi
        .confirmEngineHandoff({
          conversationId: sessionId,
          targetEngine: currentExecutor,
          targetProviderInstanceId: nextWireInstance,
        })
        .catch((error: unknown) => {
          if (isUnavailableHandoffCommandError(error)) {
            return;
          }
          if (switchSeq === switchSeqRef.current) {
            syncSessionAgentInCaches(
              queryClient,
              sessionId,
              currentExecutor,
              previousInstance
            );
            onApplyProviderInstanceId?.(previousInstance, currentExecutor);
          }
          toast.error(error instanceof Error ? error.message : String(error));
        });
    },
    [
      currentExecutor,
      currentProviderInstanceId,
      onApplyProviderInstanceId,
      queryClient,
      sessionId,
    ]
  );

  return {
    handleChangeExecutorProfile,
    handleChangeProviderInstance,
  };
}
