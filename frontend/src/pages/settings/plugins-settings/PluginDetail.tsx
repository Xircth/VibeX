import { RefreshCw, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { createBackendAppSurfaceTransport } from '@/lib/api/appSurfaceTransport';
import type {
  PluginContributionCatalogItem,
  PluginControlContributions,
  PluginControlItem,
  PluginRuntimeInventoryItem,
} from '@/lib/api/plugins';
import { FORMAT_LABELS, type PluginDetailMode } from './pluginConstants';
import { PluginDetailContributions } from './PluginDetailContributions';
import { PluginDetailOverview } from './PluginDetailOverview';

export function PluginDetail({
  plugin,
  busy,
  onEnabledChange,
  onUpdate,
  onRollback,
  onInstallRuntime,
  onUninstall,
  loadContributions,
  runtimeInventory,
  registryGeneration,
  registryContributions,
  appSurfaceTransport,
  canWrite,
  canSurface,
  canManagePackage,
}: {
  plugin: PluginControlItem;
  busy: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onUpdate: () => void;
  onRollback: () => void;
  onInstallRuntime: (runtimeId: string) => void;
  onUninstall: () => void;
  loadContributions: () => Promise<PluginControlContributions>;
  runtimeInventory: PluginRuntimeInventoryItem[];
  registryGeneration?: number;
  registryContributions?: PluginContributionCatalogItem[];
  appSurfaceTransport: ReturnType<typeof createBackendAppSurfaceTransport>;
  canWrite: boolean;
  canSurface: boolean;
  canManagePackage: boolean;
}) {
  const { t } = useTranslation('settings');
  const [mode, setMode] = useState<PluginDetailMode>('overview');
  const [contributions, setContributions] =
    useState<PluginControlContributions | null>(null);
  const [contributionsLoading, setContributionsLoading] = useState(false);
  const [contributionsError, setContributionsError] = useState<string | null>(
    null
  );
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [selectedMcpId, setSelectedMcpId] = useState<string | null>(null);
  const [showDeveloperDetails, setShowDeveloperDetails] = useState(false);
  const openContributions = async (nextMode: PluginDetailMode) => {
    setMode(nextMode);
    if (contributions || contributionsLoading) return;
    setContributionsLoading(true);
    setContributionsError(null);
    try {
      const loaded = await loadContributions();
      setContributions(loaded);
      setSelectedSkillId(loaded.skills[0]?.id ?? null);
      setSelectedMcpId(loaded.mcpServers[0]?.id ?? null);
    } catch (cause) {
      setContributionsError(
        cause instanceof Error ? cause.message : String(cause)
      );
    } finally {
      setContributionsLoading(false);
    }
  };
  return (
    <section
      className="plugin-hub-detail"
      role="region"
      aria-label={plugin.name}
    >
      <header className="plugin-detail-header">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-semibold text-foreground">
              {plugin.name}
            </h3>
            {plugin.formats.map((format) => (
              <span className="plugin-format-badge" key={format}>
                {FORMAT_LABELS[format] ?? format}
              </span>
            ))}
            <span className="plugin-version">v{plugin.version}</span>
            {plugin.builtin ? (
              <span className="plugin-format-badge">
                {t('plugins.builtinBadge')}
              </span>
            ) : null}
          </div>
          {plugin.description ? (
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
              {plugin.description}
            </p>
          ) : null}
        </div>
        {plugin.nativeManaged ? (
          <div className="flex shrink-0 items-center gap-2">
            {plugin.enableSupported ? (
              <>
                <span className="text-xs text-muted-foreground">
                  {plugin.enabled
                    ? t('plugins.enabled')
                    : t('plugins.disabled')}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !canWrite}
                  onClick={() => onEnabledChange(!plugin.enabled)}
                  aria-label={t(
                    plugin.enabled
                      ? 'plugins.disableNativeAria'
                      : 'plugins.enableNativeAria',
                    { name: plugin.name }
                  )}
                >
                  {plugin.enabled
                    ? t('plugins.disableNative')
                    : t('plugins.enableNative')}
                </Button>
              </>
            ) : null}
            {plugin.updateSupported && canManagePackage ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !canWrite}
                onClick={onUpdate}
                aria-label={t('plugins.updateNativeAria', {
                  name: plugin.name,
                })}
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                {t('plugins.updateNative')}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {plugin.enabled ? t('plugins.enabled') : t('plugins.disabled')}
            </span>
            <Switch
              checked={plugin.enabled}
              disabled={busy || !canWrite}
              onCheckedChange={onEnabledChange}
              aria-label={t('plugins.enabledAria', { name: plugin.name })}
            />
            {plugin.updateSupported && canManagePackage ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !canWrite}
                onClick={onUpdate}
                aria-label={t('plugins.updateNativeAria', {
                  name: plugin.name,
                })}
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                {t('plugins.updateNative')}
              </Button>
            ) : null}
            {plugin.rollbackSupported && canManagePackage ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !canWrite}
                onClick={onRollback}
                aria-label={t('plugins.rollbackAria', { name: plugin.name })}
              >
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                {t('plugins.rollback')}
              </Button>
            ) : null}
          </div>
        )}
      </header>

      {mode === 'overview' ? (
        <PluginDetailOverview
          plugin={plugin}
          busy={busy}
          openContributions={openContributions}
          showDeveloperDetails={showDeveloperDetails}
          setShowDeveloperDetails={setShowDeveloperDetails}
          onInstallRuntime={onInstallRuntime}
          onUninstall={onUninstall}
          runtimeInventory={runtimeInventory}
          registryGeneration={registryGeneration}
          registryContributions={registryContributions}
          appSurfaceTransport={appSurfaceTransport}
          canWrite={canWrite}
          canSurface={canSurface}
          canManagePackage={canManagePackage}
        />
      ) : null}

      {mode !== 'overview' ? (
        <PluginDetailContributions
          plugin={plugin}
          mode={mode}
          openContributions={openContributions}
          setMode={setMode}
          contributions={contributions}
          contributionsLoading={contributionsLoading}
          contributionsError={contributionsError}
          selectedSkillId={selectedSkillId}
          selectedMcpId={selectedMcpId}
          setSelectedSkillId={setSelectedSkillId}
          setSelectedMcpId={setSelectedMcpId}
        />
      ) : null}
    </section>
  );
}
