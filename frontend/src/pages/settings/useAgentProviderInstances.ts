import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentAuthModeView,
  AgentAuthenticationStatus,
  AgentId,
} from 'shared/types';

import { toast } from '@/components/ui/toast';
import { agentManagementErrorMessage as errorMessage } from '@/features/agent-management';
import {
  canonicalProviderAgentId,
  LOCAL_PROVIDER_INSTANCE_ID,
  PROVIDER_INSTANCES_CHANGED_EVENT,
  type ProviderInstanceConfig,
  providerInstancesApi,
  supportsAgentInstances,
} from '@/lib/providerInstancesApi';

export function deriveCustomInstanceAuthStatus(
  view: AgentAuthModeView | null
): AgentAuthenticationStatus | undefined {
  if (!view) return undefined;
  const selected = view.options.find((option) => option.value === view.mode);
  const kind = selected?.kind;
  if (
    kind === 'subscription' ||
    view.mode === 'official_subscription' ||
    view.mode === 'chatgpt_subscription' ||
    view.mode === 'subscription'
  ) {
    return view.credential_present || view.account_label
      ? 'account'
      : 'not_logged_in';
  }
  return view.credential_present ? 'api_key' : 'not_logged_in';
}

export function useAgentProviderInstances({
  selectedAgentId,
  confirmDiscardConfig,
}: {
  selectedAgentId: AgentId | null;
  confirmDiscardConfig: () => Promise<boolean>;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const [allInstances, setAllInstances] = useState<ProviderInstanceConfig[]>(
    []
  );
  const [selectedByAgent, setSelectedByAgent] = useState<
    Record<string, string>
  >({});
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);

  const supportsInstances = supportsAgentInstances(selectedAgentId);
  const canonicalAgentId = useMemo(
    () =>
      selectedAgentId ? canonicalProviderAgentId(selectedAgentId) : null,
    [selectedAgentId]
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await providerInstancesApi.list();
      setAllInstances(list);
      return list;
    } catch {
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const onChanged = () => {
      void reload();
    };
    window.addEventListener(PROVIDER_INSTANCES_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener(PROVIDER_INSTANCES_CHANGED_EVENT, onChanged);
    };
  }, [reload]);

  const instances = useMemo(() => {
    if (!supportsInstances || !canonicalAgentId) return [];
    return allInstances.filter(
      (item) => canonicalProviderAgentId(item.agentId) === canonicalAgentId
    );
  }, [allInstances, canonicalAgentId, supportsInstances]);

  const rawSelectedId = canonicalAgentId
    ? (selectedByAgent[canonicalAgentId] ?? LOCAL_PROVIDER_INSTANCE_ID)
    : LOCAL_PROVIDER_INSTANCE_ID;

  const selectedCustomInstance = useMemo(
    () =>
      instances.find((item) => item.instanceId === rawSelectedId) ?? null,
    [instances, rawSelectedId]
  );

  const selectedInstanceId =
    supportsInstances && selectedCustomInstance
      ? selectedCustomInstance.instanceId
      : LOCAL_PROVIDER_INSTANCE_ID;
  const isCustomInstance =
    supportsInstances && selectedInstanceId !== LOCAL_PROVIDER_INSTANCE_ID;
  const activeProviderInstanceId = isCustomInstance ? selectedInstanceId : null;

  const selectInstance = useCallback(
    async (instanceId: string) => {
      if (!canonicalAgentId || !supportsInstances) return false;
      if (instanceId === selectedInstanceId) return true;
      if (!(await confirmDiscardConfig())) return false;
      setSelectedByAgent((current) => ({
        ...current,
        [canonicalAgentId]: instanceId,
      }));
      return true;
    },
    [
      canonicalAgentId,
      confirmDiscardConfig,
      selectedInstanceId,
      supportsInstances,
    ]
  );

  const createInstance = useCallback(
    async (displayName: string) => {
      if (!canonicalAgentId || !supportsInstances) return null;
      const trimmed = displayName.trim();
      if (!trimmed) return null;
      if (!(await confirmDiscardConfig())) return null;
      setMutating(true);
      try {
        const created = await providerInstancesApi.create({
          agentId: canonicalAgentId,
          displayName: trimmed,
        });
        await reload();
        setSelectedByAgent((current) => ({
          ...current,
          [canonicalAgentId]: created.instanceId,
        }));
        toast.success(
          t('settings:providerInstances.createdSuccess', {
            name: created.displayName,
            defaultValue: '已创建实例 {{name}}',
          })
        );
        return created;
      } catch (error) {
        toast.error(
          errorMessage(
            error,
            t('settings:providerInstances.createFailed', {
              defaultValue: '创建实例失败',
            })
          )
        );
        return null;
      } finally {
        setMutating(false);
      }
    },
    [
      canonicalAgentId,
      confirmDiscardConfig,
      reload,
      supportsInstances,
      t,
    ]
  );

  const renameInstance = useCallback(
    async (instanceId: string, displayName: string) => {
      if (!canonicalAgentId || !supportsInstances) return null;
      const trimmed = displayName.trim();
      if (!trimmed) return null;
      setMutating(true);
      try {
        const updated = await providerInstancesApi.update(instanceId, {
          agentId: canonicalAgentId,
          displayName: trimmed,
        });
        await reload();
        toast.success(
          t('settings:providerInstances.renamedSuccess', {
            name: updated.displayName,
            defaultValue: '已重命名实例为 {{name}}',
          })
        );
        return updated;
      } catch (error) {
        toast.error(
          errorMessage(
            error,
            t('settings:providerInstances.renameFailed', {
              defaultValue: '重命名实例失败',
            })
          )
        );
        return null;
      } finally {
        setMutating(false);
      }
    },
    [canonicalAgentId, reload, supportsInstances, t]
  );

  const setDefaultInstance = useCallback(
    async (instanceId: string) => {
      if (!canonicalAgentId || !supportsInstances) return false;
      setMutating(true);
      try {
        await providerInstancesApi.setDefault(canonicalAgentId, instanceId);
        await reload();
        toast.success(
          t('settings:providerInstances.setDefaultSuccess', {
            defaultValue: '已设为默认实例',
          })
        );
        return true;
      } catch (error) {
        toast.error(
          errorMessage(
            error,
            t('settings:providerInstances.setDefaultFailed', {
              defaultValue: '设置默认实例失败',
            })
          )
        );
        return false;
      } finally {
        setMutating(false);
      }
    },
    [canonicalAgentId, reload, supportsInstances, t]
  );

  const deleteInstance = useCallback(
    async (instanceId: string) => {
      if (!canonicalAgentId || !supportsInstances) return false;
      setMutating(true);
      try {
        await providerInstancesApi.remove(canonicalAgentId, instanceId);
        await reload();
        setSelectedByAgent((current) =>
          current[canonicalAgentId] === instanceId
            ? {
                ...current,
                [canonicalAgentId]: LOCAL_PROVIDER_INSTANCE_ID,
              }
            : current
        );
        toast.success(
          t('settings:providerInstances.deletedSuccess', {
            defaultValue: '已删除实例',
          })
        );
        return true;
      } catch (error) {
        toast.error(
          errorMessage(
            error,
            t('settings:providerInstances.deleteFailed', {
              defaultValue: '删除实例失败',
            })
          )
        );
        return false;
      } finally {
        setMutating(false);
      }
    },
    [canonicalAgentId, reload, supportsInstances, t]
  );

  return {
    supportsInstances,
    instances,
    selectedInstanceId,
    selectedCustomInstance,
    isCustomInstance,
    activeProviderInstanceId,
    loading,
    mutating,
    reload,
    selectInstance,
    createInstance,
    renameInstance,
    setDefaultInstance,
    deleteInstance,
  };
}
