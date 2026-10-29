import { useTranslation } from 'react-i18next';
import type {
  AgentId,
  AgentModelProviderImportSource,
  AgentModelProviderView,
} from 'shared/types';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';
import { contributionMetadata } from '@/hooks/usePluginHostContributions';
import type { PluginContributionCatalogItem } from '@/lib/api/plugins';

import { pluginImportCandidates } from './pluginImportCandidates';
import { parseCopiedModel } from './providerModelParse';
import type { ProviderFormState } from './useProviderFormState';

export function useProviderActions(
  state: ProviderFormState,
  {
    agentId,
    signedIn,
    onChanged,
  }: {
    agentId: AgentId;
    signedIn: boolean;
    onChanged?: () => void | Promise<void>;
  }
) {
  const { t } = useTranslation(['settings', 'common']);
  const {
    view,
    setView,
    setSaving,
    setError,
    id,
    resetForm,
    setProbes,
    setImportOpen,
    setImportPreview,
    setImportSelected,
    pluginApi,
    importPreview,
    importSelected,
  } = state;

  const bind = async (providerId: string) => {
    if (signedIn) {
      const result = await ConfirmDialog.show({
        title: t('settings:agents.authEnableProviderSignsOutTitle'),
        message: t('settings:agents.authEnableProviderSignsOutMessage'),
        confirmText: t('settings:agents.authEnableProviderSignsOutConfirm'),
        cancelText: t('common:cancel'),
        variant: 'destructive',
      });
      if (result !== 'confirmed') return;
    }
    setSaving(true);
    setError(null);
    try {
      setView(await agentManagementApi.bindModelProvider(agentId, providerId));
      toast.success(t('settings:agents.providerBound'));
      await onChanged?.();
    } catch (cause) {
      const message = errorMessage(
        cause,
        t('settings:agents.providerActionFailed')
      );
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (provider: AgentModelProviderView) => {
    const result = await ConfirmDialog.show({
      title: t('settings:agents.providerDeleteTitle', {
        name: provider.name,
      }),
      message: t('settings:agents.providerDeleteMessage'),
      confirmText: t('settings:agents.providerDeleteConfirm'),
      cancelText: t('common:cancel'),
      variant: 'destructive',
    });
    if (result !== 'confirmed') return;
    setSaving(true);
    try {
      setView(
        await agentManagementApi.deleteModelProvider(agentId, provider.id)
      );
      if (id === provider.id) resetForm();
      toast.success(t('settings:agents.providerDeleted'));
      await onChanged?.();
    } catch (cause) {
      const message = errorMessage(
        cause,
        t('settings:agents.providerActionFailed')
      );
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const copyConfig = async (provider: AgentModelProviderView) => {
    const payload = JSON.stringify(
      {
        agent_id: provider.agent_id,
        name: provider.name,
        api_url: provider.api_url,
        model: parseCopiedModel(provider.model),
      },
      null,
      2
    );
    try {
      await navigator.clipboard.writeText(payload);
      toast.success(t('settings:agents.providerCopied'));
    } catch {
      toast.error(t('settings:agents.providerCopyFailed'));
    }
  };

  const testConnection = async (provider: AgentModelProviderView) => {
    setProbes((current) => ({ ...current, [provider.id]: 'loading' }));
    try {
      const result = await agentManagementApi.probeModelProvider(
        agentId,
        provider.id
      );
      setProbes((current) => ({ ...current, [provider.id]: result }));
      if (result.ok) {
        toast.success(
          t('settings:agents.providerTestOk', { ms: result.latency_ms })
        );
      } else {
        toast.error(
          result.error ??
            t('settings:agents.providerTestFailed', { ms: result.latency_ms })
        );
      }
    } catch (cause) {
      const message = errorMessage(
        cause,
        t('settings:agents.providerActionFailed')
      );
      setProbes((current) => ({
        ...current,
        [provider.id]: { ok: false, latency_ms: 0, error: message },
      }));
      toast.error(message);
    }
  };

  const loadImport = async (source: AgentModelProviderImportSource) => {
    setImportOpen(false);
    setSaving(true);
    setError(null);
    try {
      const preview = await agentManagementApi.previewModelProviderImport(
        agentId,
        source
      );
      setImportPreview({ ...preview, origin: { kind: 'builtin', source } });
      setImportSelected(
        preview.candidates
          .filter((candidate) => !candidate.skip_reason)
          .map((candidate) => candidate.source_id)
      );
      if (preview.error) setError(preview.error);
    } catch (cause) {
      const message = errorMessage(
        cause,
        t('settings:agents.providerActionFailed')
      );
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  /**
   * Runs a plugin-contributed import source. The plugin only discovers
   * candidates; nothing is written until the user picks from the same preview
   * the built-in sources use.
   */
  const loadPluginImport = async (item: PluginContributionCatalogItem) => {
    setImportOpen(false);
    setSaving(true);
    setError(null);
    try {
      const metadata = contributionMetadata(item);
      const handler =
        typeof metadata.handler === 'string' ? metadata.handler : item.id;
      const candidates = pluginImportCandidates(
        await pluginApi.invokeContribution(item.pluginId, handler, { agentId }),
        t('settings:agents.providerImportNoKey')
      );
      setImportPreview({
        candidates: candidates.map((candidate) => candidate.view),
        error: candidates.length
          ? null
          : t('settings:agents.providerImportEmpty'),
        origin: {
          kind: 'plugin',
          label: item.label,
          drafts: new Map(
            candidates.map((candidate) => [
              candidate.view.source_id,
              candidate.draft,
            ])
          ),
        },
      });
      setImportSelected(
        candidates
          .filter((candidate) => !candidate.view.skip_reason)
          .map((candidate) => candidate.view.source_id)
      );
    } catch (cause) {
      const message = errorMessage(
        cause,
        t('settings:agents.providerActionFailed')
      );
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const applyImport = async () => {
    if (!importPreview) return;
    setSaving(true);
    setError(null);
    try {
      if (importPreview.origin.kind === 'plugin') {
        const { drafts } = importPreview.origin;
        let latest = view;
        // Saved one at a time through the normal save path, so a plugin's
        // candidates get the same validation as anything typed by hand.
        for (const sourceId of importSelected) {
          const draft = drafts.get(sourceId);
          if (!draft) continue;
          latest = await agentManagementApi.saveModelProvider({
            id: null,
            agent_id: agentId,
            name: draft.name,
            api_url: draft.api_url,
            api_key: draft.api_key,
            model: draft.model,
          });
        }
        setView(latest);
      } else {
        setView(
          await agentManagementApi.importModelProviders({
            agent_id: agentId,
            source: importPreview.origin.source,
            source_ids: importSelected,
          })
        );
      }
      setImportPreview(null);
      setImportSelected([]);
      toast.success(t('settings:agents.providerImported'));
    } catch (cause) {
      const message = errorMessage(
        cause,
        t('settings:agents.providerActionFailed')
      );
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return {
    bind,
    remove,
    copyConfig,
    testConnection,
    loadImport,
    loadPluginImport,
    applyImport,
  };
}
