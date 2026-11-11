import { Loader2, Plus, Upload } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import type { TFunction } from 'i18next';
import type {
  AgentModelProviderImportSource,
  AgentModelProviderProbeView,
  AgentModelProviderView,
} from 'shared/types';

import { contributionIconComponent } from '@/components/plugins/contributionIcon';
import { Button } from '@/components/ui/button';
import {
  ModelRouterEntry,
  type RouterProvision,
} from '@/features/model-router';
import { contributionMetadata } from '@/hooks/usePluginHostContributions';
import type { PluginContributionCatalogItem } from '@/lib/api/plugins';

import { ImportPreview } from './ImportPreview';
import { ProviderCard } from './ProviderCard';
import type { ImportPreviewModel } from './types';

export function ProviderToolbar({
  t,
  agentId,
  busy,
  importOpen,
  setImportOpen,
  pluginImportSources,
  openCreate,
  loadImport,
  loadPluginImport,
  applyModelRouter,
}: {
  t: TFunction;
  agentId: string;
  busy: boolean;
  importOpen: boolean;
  setImportOpen: Dispatch<SetStateAction<boolean>>;
  pluginImportSources: PluginContributionCatalogItem[];
  openCreate: () => void;
  loadImport: (source: AgentModelProviderImportSource) => Promise<void>;
  loadPluginImport: (item: PluginContributionCatalogItem) => Promise<void>;
  applyModelRouter: (provision: RouterProvision) => Promise<void>;
}) {
  return (
    <div className="agent-model-provider-toolbar">
      <ModelRouterEntry
        agentId={agentId}
        disabled={busy}
        onApply={applyModelRouter}
      />
      <Button size="sm" className="h-8" disabled={busy} onClick={openCreate}>
        <Plus aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
        {t('settings:agents.providerCreateButton')}
      </Button>
      <div className="agent-model-provider-import">
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          disabled={busy}
          aria-expanded={importOpen}
          onClick={() => setImportOpen((open) => !open)}
        >
          <Upload aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          {t('settings:agents.providerImport')}
        </Button>
        {importOpen ? (
          <div className="agent-model-provider-import-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => void loadImport('native')}
            >
              {t('settings:agents.providerImportNative')}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => void loadImport('cc_switch')}
            >
              {t('settings:agents.providerImportCcSwitch')}
            </button>
            {pluginImportSources.map((item) => {
              const metadata = contributionMetadata(item);
              const Icon = contributionIconComponent(metadata.icon, Upload);
              return (
                <button
                  key={`${item.pluginId}:${item.id}`}
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  title={
                    typeof metadata.description === 'string'
                      ? metadata.description
                      : undefined
                  }
                  onClick={() => void loadPluginImport(item)}
                >
                  <Icon aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                  {item.label}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ProviderList({
  t,
  busy,
  loading,
  providers,
  probes,
  importPreview,
  importSelected,
  setImportSelected,
  setImportPreview,
  openCreate,
  bind,
  openEdit,
  testConnection,
  copyConfig,
  remove,
  applyImport,
}: {
  t: TFunction;
  busy: boolean;
  loading: boolean;
  providers: AgentModelProviderView[];
  probes: Record<string, AgentModelProviderProbeView | 'loading'>;
  importPreview: ImportPreviewModel | null;
  importSelected: string[];
  setImportSelected: Dispatch<SetStateAction<string[]>>;
  setImportPreview: Dispatch<SetStateAction<ImportPreviewModel | null>>;
  openCreate: () => void;
  bind: (providerId: string) => Promise<void>;
  openEdit: (provider: AgentModelProviderView) => void;
  testConnection: (provider: AgentModelProviderView) => Promise<void>;
  copyConfig: (provider: AgentModelProviderView) => Promise<void>;
  remove: (provider: AgentModelProviderView) => Promise<void>;
  applyImport: () => Promise<void>;
}) {
  return (
    <div className="agent-model-provider-body">
      {importPreview ? (
        <ImportPreview
          preview={importPreview}
          selected={importSelected}
          saving={busy}
          onToggle={(sourceId, checked) => {
            setImportSelected((current) =>
              checked
                ? [...current, sourceId]
                : current.filter((id) => id !== sourceId)
            );
          }}
          onCancel={() => {
            setImportPreview(null);
            setImportSelected([]);
          }}
          onApply={() => void applyImport()}
        />
      ) : null}

      {loading ? (
        <p className="agent-model-provider-state" aria-live="polite">
          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          {t('settings:agents.providerLoading')}
        </p>
      ) : providers.length === 0 ? (
        <div className="agent-model-provider-empty">
          <p>{t('settings:agents.providerNoneDetected')}</p>
          <Button
            size="sm"
            className="h-8"
            disabled={busy}
            onClick={openCreate}
          >
            <Plus aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
            {t('settings:agents.providerCreateButton')}
          </Button>
        </div>
      ) : (
        <ul className="agent-model-provider-list">
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              busy={busy}
              canDelete={!provider.bound && providers.length > 1}
              probe={probes[provider.id]}
              onEnable={() => void bind(provider.id)}
              onEdit={() => openEdit(provider)}
              onTest={() => void testConnection(provider)}
              onCopy={() => void copyConfig(provider)}
              onDelete={() => void remove(provider)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
