import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import type { ExecutorProfileId } from 'shared/types';
import { toast } from '@/components/ui/toast';
import {
  conversationApi,
  isUnimplementedConversationCommandError,
  type ConversationEngineHandoffPreview,
} from '@/features/conversation/conversationApi';
import {
  normalizeAgentGroupKey,
  providerInstancesApi,
  type ProviderInstanceConfig,
} from '@/lib/providerInstancesApi';
import { syncSessionAgentInCaches } from '@/lib/sessionQueryCache';
import { EngineHandoffDialog } from './EngineHandoffDialog';
import { ProviderInstanceSelector } from './ProviderInstanceSelector';

function isUnavailableHandoffPreviewError(error: unknown): boolean {
  if (isUnimplementedConversationCommandError(error)) {
    return true;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return /__tauri_internals__|reading\s+'invoke'|tauri\s+runtime/i.test(msg);
}

export function ComposerProviderInstanceSlot({
  agentId,
  disabled = false,
}: {
  agentId: string | null;
  disabled?: boolean;
}) {
  const [allInstances, setAllInstances] = useState<ProviderInstanceConfig[]>([]);
  const [selectedByAgent, setSelectedByAgent] = useState<Record<string, string>>(
    {}
  );

  useEffect(() => {
    if (!agentId) return;
    let active = true;
    void providerInstancesApi
      .list()
      .then((rows) => {
        if (active) setAllInstances(rows);
      })
      .catch(() => {
        if (active) setAllInstances([]);
      });
    return () => {
      active = false;
    };
  }, [agentId]);

  const agentKey = agentId ? normalizeAgentGroupKey(agentId) : null;
  const instances = useMemo(() => {
    if (!agentKey) return [];
    return allInstances.filter(
      (item) => normalizeAgentGroupKey(item.agentId) === agentKey
    );
  }, [agentKey, allInstances]);

  if (!agentKey || instances.length === 0) {
    return null;
  }

  return (
    <ProviderInstanceSelector
      instances={instances}
      selectedInstanceId={selectedByAgent[agentKey] ?? null}
      disabled={disabled}
      onSelectInstance={(next) => {
        setSelectedByAgent((prev) => ({
          ...prev,
          [agentKey]: next.instanceId,
        }));
      }}
    />
  );
}

export interface ComposerEngineHandoffController {
  pendingPreview: ConversationEngineHandoffPreview | null;
  isSubmitting: boolean;
  handleChangeExecutorProfile: (next: ExecutorProfileId | null) => void;
  confirmHandoff: () => Promise<void>;
  cancelHandoff: () => void;
}

export function useComposerEngineHandoff({
  sessionId,
  hasExistingTurns,
  currentExecutor,
  onApplyExecutorProfile,
}: {
  sessionId: string | null | undefined;
  hasExistingTurns: boolean;
  currentExecutor: string | null | undefined;
  onApplyExecutorProfile: (profile: ExecutorProfileId | null) => void;
}): ComposerEngineHandoffController {
  const queryClient = useContext(QueryClientContext);
  const [pendingState, setPendingState] = useState<{
    targetProfile: ExecutorProfileId;
    preview: ConversationEngineHandoffPreview;
  } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleChangeExecutorProfile = useCallback(
    (nextProfile: ExecutorProfileId | null) => {
      const isDifferentAgent = Boolean(
        nextProfile &&
          (!currentExecutor ||
            normalizeAgentGroupKey(nextProfile.executor) !==
              normalizeAgentGroupKey(currentExecutor))
      );

      if (!nextProfile || !sessionId || !isDifferentAgent) {
        onApplyExecutorProfile(nextProfile);
        return;
      }

      if (!hasExistingTurns) {
        syncSessionAgentInCaches(queryClient, sessionId, nextProfile.executor);
        onApplyExecutorProfile(nextProfile);
        void conversationApi
          .confirmEngineHandoff({
            conversationId: sessionId,
            targetEngine: nextProfile.executor,
          })
          .catch((error: unknown) => {
            if (!isUnavailableHandoffPreviewError(error)) {
              toast.error(
                error instanceof Error ? error.message : String(error)
              );
            }
          });
        return;
      }

      void conversationApi
        .previewEngineHandoff({
          conversationId: sessionId,
          targetEngine: nextProfile.executor,
        })
        .then((preview) => {
          setPendingState({ targetProfile: nextProfile, preview });
        })
        .catch((error: unknown) => {
          if (isUnavailableHandoffPreviewError(error)) {
            syncSessionAgentInCaches(
              queryClient,
              sessionId,
              nextProfile.executor
            );
            onApplyExecutorProfile(nextProfile);
            return;
          }
          toast.error(error instanceof Error ? error.message : String(error));
        });
    },
    [
      currentExecutor,
      hasExistingTurns,
      onApplyExecutorProfile,
      queryClient,
      sessionId,
    ]
  );

  const confirmHandoff = useCallback(async () => {
    if (!pendingState || !sessionId) return;
    setIsSubmitting(true);
    try {
      try {
        await conversationApi.confirmEngineHandoff({
          conversationId: sessionId,
          targetEngine: pendingState.targetProfile.executor,
        });
      } catch (error) {
        if (!isUnavailableHandoffPreviewError(error)) {
          throw error;
        }
      }
      syncSessionAgentInCaches(
        queryClient,
        sessionId,
        pendingState.targetProfile.executor
      );
      onApplyExecutorProfile(pendingState.targetProfile);
      setPendingState(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }, [onApplyExecutorProfile, pendingState, queryClient, sessionId]);

  const cancelHandoff = useCallback(() => {
    if (isSubmitting) return;
    setPendingState(null);
  }, [isSubmitting]);

  return {
    pendingPreview: pendingState?.preview ?? null,
    isSubmitting,
    handleChangeExecutorProfile,
    confirmHandoff,
    cancelHandoff,
  };
}

export function ComposerEngineHandoffModal({
  controller,
}: {
  controller: ComposerEngineHandoffController;
}) {
  return (
    <EngineHandoffDialog
      open={Boolean(controller.pendingPreview)}
      preview={controller.pendingPreview}
      isSubmitting={controller.isSubmitting}
      onConfirm={() => void controller.confirmHandoff()}
      onCancel={controller.cancelHandoff}
    />
  );
}
