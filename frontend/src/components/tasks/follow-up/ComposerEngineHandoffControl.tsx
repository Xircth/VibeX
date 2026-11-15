import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
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

export const PROVIDER_INSTANCES_CHANGED_EVENT =
  'vibex:provider-instances-changed';

type ProviderInstancesChangedDetail = {
  agentKey: string;
  instanceId: string;
  sourceId: string;
};

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
  selectedInstanceId,
  onSelectInstance,
}: {
  agentId: string | null;
  disabled?: boolean;
  selectedInstanceId?: string | null;
  onSelectInstance?: (instanceId: string) => void;
}) {
  const queryClient = useContext(QueryClientContext);
  const slotId = useId();
  const [allInstances, setAllInstances] = useState<ProviderInstanceConfig[]>([]);
  const [selectedByAgent, setSelectedByAgent] = useState<Record<string, string>>(
    {}
  );
  const onSelectInstanceRef = useRef(onSelectInstance);
  onSelectInstanceRef.current = onSelectInstance;
  const lastNotifiedRef = useRef<{ agentKey: string; instanceId: string } | null>(
    null
  );
  const prevSelectedPropRef = useRef<string | null | undefined>(
    selectedInstanceId
  );
  const selectSeqRef = useRef(0);

  const agentKey = agentId ? normalizeAgentGroupKey(agentId) : null;
  const agentKeyRef = useRef(agentKey);
  agentKeyRef.current = agentKey;

  useEffect(() => {
    if (!agentId) return;
    let active = true;
    const loadInstances = () => {
      void providerInstancesApi
        .list()
        .then((rows) => {
          if (active) setAllInstances(rows);
        })
        .catch(() => {
          if (active) setAllInstances([]);
        });
    };

    loadInstances();

    const onInstancesChanged = (event: Event) => {
      const detail = (
        event as CustomEvent<ProviderInstancesChangedDetail | undefined>
      ).detail;
      if (!detail || detail.sourceId === slotId) return;
      setSelectedByAgent((prev) => ({
        ...prev,
        [detail.agentKey]: detail.instanceId,
      }));
      setAllInstances((prev) =>
        prev.map((item) =>
          normalizeAgentGroupKey(item.agentId) === detail.agentKey
            ? { ...item, isDefault: item.instanceId === detail.instanceId }
            : item
        )
      );
      if (agentKeyRef.current === detail.agentKey) {
        lastNotifiedRef.current = {
          agentKey: detail.agentKey,
          instanceId: detail.instanceId,
        };
        onSelectInstanceRef.current?.(detail.instanceId);
      }
      loadInstances();
    };

    if (typeof window !== 'undefined') {
      window.addEventListener(
        PROVIDER_INSTANCES_CHANGED_EVENT,
        onInstancesChanged
      );
    }
    return () => {
      active = false;
      if (typeof window !== 'undefined') {
        window.removeEventListener(
          PROVIDER_INSTANCES_CHANGED_EVENT,
          onInstancesChanged
        );
      }
    };
  }, [agentId, slotId]);

  const instances = useMemo(() => {
    if (!agentKey) return [];
    return allInstances.filter(
      (item) => normalizeAgentGroupKey(item.agentId) === agentKey
    );
  }, [agentKey, allInstances]);

  const effectiveSelectedId = useMemo(() => {
    if (!agentKey || instances.length === 0) return null;
    if (
      selectedInstanceId &&
      instances.some((item) => item.instanceId === selectedInstanceId)
    ) {
      return selectedInstanceId;
    }
    const localSelected = selectedByAgent[agentKey];
    if (
      localSelected &&
      instances.some((item) => item.instanceId === localSelected)
    ) {
      return localSelected;
    }
    return (
      instances.find((item) => item.isDefault)?.instanceId ??
      instances[0]?.instanceId ??
      null
    );
  }, [agentKey, instances, selectedByAgent, selectedInstanceId]);

  useEffect(() => {
    const prevProp = prevSelectedPropRef.current;
    prevSelectedPropRef.current = selectedInstanceId;
    if (prevProp != null && selectedInstanceId == null) {
      lastNotifiedRef.current = null;
    }

    if (!agentKey || !effectiveSelectedId) return;
    if (selectedInstanceId === effectiveSelectedId) {
      lastNotifiedRef.current = {
        agentKey,
        instanceId: effectiveSelectedId,
      };
      return;
    }
    if (
      lastNotifiedRef.current?.agentKey === agentKey &&
      lastNotifiedRef.current?.instanceId === effectiveSelectedId
    ) {
      return;
    }
    lastNotifiedRef.current = { agentKey, instanceId: effectiveSelectedId };
    onSelectInstanceRef.current?.(effectiveSelectedId);
  }, [agentKey, effectiveSelectedId, selectedInstanceId]);

  if (!agentKey || instances.length === 0) {
    return null;
  }

  return (
    <ProviderInstanceSelector
      instances={instances}
      selectedInstanceId={effectiveSelectedId}
      disabled={disabled}
      onSelectInstance={(next) => {
        const previousId = effectiveSelectedId;
        const previousSelectedMap = selectedByAgent;
        const previousInstances = allInstances;
        const seq = ++selectSeqRef.current;

        lastNotifiedRef.current = { agentKey, instanceId: next.instanceId };
        setSelectedByAgent((prev) => ({
          ...prev,
          [agentKey]: next.instanceId,
        }));
        setAllInstances((prev) =>
          prev.map((item) =>
            normalizeAgentGroupKey(item.agentId) === agentKey
              ? { ...item, isDefault: item.instanceId === next.instanceId }
              : item
          )
        );
        onSelectInstance?.(next.instanceId);

        void providerInstancesApi
          .setDefault(agentKey, next.instanceId)
          .then(() => {
            if (seq !== selectSeqRef.current) return;
            if (queryClient) {
              void queryClient.invalidateQueries({
                queryKey: ['providerInstances'],
              });
            }
            if (typeof window !== 'undefined') {
              window.dispatchEvent(
                new CustomEvent<ProviderInstancesChangedDetail>(
                  PROVIDER_INSTANCES_CHANGED_EVENT,
                  {
                    detail: {
                      agentKey,
                      instanceId: next.instanceId,
                      sourceId: slotId,
                    },
                  }
                )
              );
            }
          })
          .catch((error: unknown) => {
            if (isUnavailableHandoffPreviewError(error)) {
              return;
            }
            if (seq === selectSeqRef.current) {
              setSelectedByAgent(previousSelectedMap);
              setAllInstances(previousInstances);
              lastNotifiedRef.current = previousId
                ? { agentKey, instanceId: previousId }
                : null;
              if (previousId) {
                onSelectInstanceRef.current?.(previousId);
              }
            }
            toast.error(error instanceof Error ? error.message : String(error));
          });
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
  const emptySwitchSeqRef = useRef(0);

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
        const previousExecutor = currentExecutor ?? null;
        const previousProfile: ExecutorProfileId | null = previousExecutor
          ? {
              executor: previousExecutor as ExecutorProfileId['executor'],
              variant: null,
            }
          : null;
        const switchSeq = ++emptySwitchSeqRef.current;

        syncSessionAgentInCaches(queryClient, sessionId, nextProfile.executor);
        onApplyExecutorProfile(nextProfile);
        void conversationApi
          .confirmEngineHandoff({
            conversationId: sessionId,
            targetEngine: nextProfile.executor,
          })
          .catch((error: unknown) => {
            if (isUnavailableHandoffPreviewError(error)) {
              return;
            }
            if (switchSeq === emptySwitchSeqRef.current) {
              if (previousExecutor) {
                syncSessionAgentInCaches(
                  queryClient,
                  sessionId,
                  previousExecutor
                );
              }
              onApplyExecutorProfile(previousProfile);
            }
            toast.error(
              error instanceof Error ? error.message : String(error)
            );
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
