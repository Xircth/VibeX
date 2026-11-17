import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAgentProviderInstanceOptions } from '@/hooks/useAgentProviderInstanceOptions';
import { resolvePreferredProviderInstanceId } from '@/lib/providerInstanceMru';
import {
  canonicalProviderAgentId,
  LOCAL_PROVIDER_INSTANCE_ID,
  normalizeProviderInstanceIdForApi,
} from '@/lib/providerInstancesApi';
import {
  SESSION_AGENT_SWITCHED_EVENT,
  type SessionAgentSwitchedDetail,
} from '@/lib/sessionQueryCache';
import type { SessionProviderInstanceConfig } from './SessionSettingsSummary';

export function useComposerProviderInstances({
  sessionId,
  agentId,
  persistedInstanceId,
  isChangingAgent = false,
  disabled = false,
  onSelectInstance,
}: {
  sessionId: string | null | undefined;
  agentId: string | null | undefined;
  persistedInstanceId?: string | null;
  isChangingAgent?: boolean;
  disabled?: boolean;
  onSelectInstance?: (instanceId: string) => void;
}) {
  const instanceOptions = useAgentProviderInstanceOptions(agentId);
  const canonicalAgent = instanceOptions.canonicalAgentId;
  const currentScopeKey = `${sessionId ?? '__new__'}::${canonicalAgent ?? agentId ?? ''}`;

  const [overrideByScope, setOverrideByScope] = useState<
    Record<string, string>
  >({});

  useEffect(() => {
    if (!sessionId || typeof window === 'undefined') return;
    const onSwitched = (event: Event) => {
      const detail = (
        event as CustomEvent<SessionAgentSwitchedDetail | undefined>
      ).detail;
      if (!detail || detail.sessionId !== sessionId) return;
      if (!('providerInstanceId' in detail)) return;
      const targetCanonical =
        canonicalProviderAgentId(detail.agentId) ?? detail.agentId;
      const key = `${sessionId}::${targetCanonical}`;
      const nextValue =
        normalizeProviderInstanceIdForApi(detail.providerInstanceId) ??
        LOCAL_PROVIDER_INSTANCE_ID;
      setOverrideByScope((prev) =>
        prev[key] === nextValue ? prev : { ...prev, [key]: nextValue }
      );
    };
    window.addEventListener(SESSION_AGENT_SWITCHED_EVENT, onSwitched);
    return () => {
      window.removeEventListener(SESSION_AGENT_SWITCHED_EVENT, onSwitched);
    };
  }, [sessionId]);

  const setSelectedInstanceOverride = useCallback(
    (nextInstanceId: string | null, targetAgentId?: string | null) => {
      const targetCanonical =
        canonicalProviderAgentId(targetAgentId ?? agentId) ??
        targetAgentId ??
        agentId ??
        '';
      if (!targetCanonical) return;
      const key = `${sessionId ?? '__new__'}::${targetCanonical}`;
      const normalized =
        normalizeProviderInstanceIdForApi(nextInstanceId) ??
        LOCAL_PROVIDER_INSTANCE_ID;
      setOverrideByScope((prev) =>
        prev[key] === normalized ? prev : { ...prev, [key]: normalized }
      );
    },
    [agentId, sessionId]
  );

  const selectedInstanceId = useMemo(() => {
    if (!instanceOptions.supported) {
      return LOCAL_PROVIDER_INSTANCE_ID;
    }
    const isValidOption = (candidate: string) =>
      candidate === LOCAL_PROVIDER_INSTANCE_ID ||
      instanceOptions.options.some((item) => item.instanceId === candidate) ||
      instanceOptions.allInstances.length === 0;

    const override = overrideByScope[currentScopeKey];
    if (override && isValidOption(override)) {
      return override;
    }

    if (sessionId && !isChangingAgent && persistedInstanceId !== undefined) {
      const persisted =
        normalizeProviderInstanceIdForApi(persistedInstanceId) ??
        LOCAL_PROVIDER_INSTANCE_ID;
      if (isValidOption(persisted)) {
        return persisted;
      }
    }

    return resolvePreferredProviderInstanceId(
      agentId,
      instanceOptions.allInstances
    );
  }, [
    agentId,
    currentScopeKey,
    instanceOptions.allInstances,
    instanceOptions.options,
    instanceOptions.supported,
    isChangingAgent,
    overrideByScope,
    persistedInstanceId,
    sessionId,
  ]);

  const scopedProviderInstanceId =
    normalizeProviderInstanceIdForApi(selectedInstanceId);

  const resolveTargetInstanceIdForAgent = useCallback(
    (targetAgentId: string): string | null =>
      normalizeProviderInstanceIdForApi(
        resolvePreferredProviderInstanceId(
          targetAgentId,
          instanceOptions.allInstances
        )
      ),
    [instanceOptions.allInstances]
  );

  const providerInstanceConfig = useMemo<SessionProviderInstanceConfig | null>(
    () =>
      instanceOptions.hasMultipleInstances && onSelectInstance
        ? {
            options: instanceOptions.options,
            selectedInstanceId,
            disabled,
            onSelectInstance,
          }
        : null,
    [
      disabled,
      instanceOptions.hasMultipleInstances,
      instanceOptions.options,
      onSelectInstance,
      selectedInstanceId,
    ]
  );

  return {
    ...instanceOptions,
    selectedInstanceId,
    scopedProviderInstanceId,
    setSelectedInstanceOverride,
    resolveTargetInstanceIdForAgent,
    providerInstanceConfig,
  };
}
