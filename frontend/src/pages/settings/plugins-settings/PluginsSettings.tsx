import { Bot, PackagePlus, Puzzle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { AgentTypeIcon } from '@/components/agents/AgentTypeIcon';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { BackendTransport } from '@/lib/backendTransport';
import { cn } from '@/lib/utils';
import { SettingsSection } from '../SettingsUi';
import { AgentNativePluginDetail } from './AgentNativePluginDetail';
import { PluginDetail } from './PluginDetail';
import { PluginHubList } from './PluginHubList';
import { PluginImportDialog } from './PluginImportDialog';
import {
  PLUGIN_TABS,
  pluginEcosystem,
  type PluginEcosystem,
} from './pluginConstants';
import { usePluginsSettings } from './usePluginsSettings';

export function PluginsSettings({
  transport: transportOverride,
  ecosystem,
  embedded = false,
}: {
  transport?: BackendTransport;
  /** Fix the control plane to one product surface instead of showing a mixed hub. */
  ecosystem?: PluginEcosystem;
  /** Render inside a parent settings disclosure without repeating its label. */
  embedded?: boolean;
}) {
  const navigate = useNavigate();
  const { t } = useTranslation(['settings', 'common']);
  const {
    transport,
    api,
    appSurfaceTransport,
    catalog,
    contributionCatalog,
    setSelectedId,
    activeTab,
    setActiveTab,
    effectiveTab,
    queries,
    setQueries,
    isLoading,
    busy,
    error,
    importChooserOpen,
    setImportChooserOpen,
    importEcosystem,
    cliCommand,
    setCliCommand,
    cliLogs,
    cliImportStatus,
    cliImportResult,
    cliImportError,
    importPreview,
    setImportPreview,
    capabilitySetup,
    setCapabilitySetup,
    uninstallTarget,
    setUninstallTarget,
    canWrite,
    canSurface,
    canManagePackage,
    canUseLocalPluginFiles,
    canUseCliImport,
    reload,
    visiblePlugins,
    selected,
    selectedRegistryContributions,
    chooseZipImport,
    selectImportEcosystem,
    runCliImport,
    applyImport,
    setEnabled,
    updatePlugin,
    rollbackPlugin,
    configureAllAgents,
    uninstall,
    installRuntime,
  } = usePluginsSettings({ transport: transportOverride, ecosystem });

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Puzzle}
        title={t('plugins.pageTitle')}
        description={t(
          ecosystem === 'vibex'
            ? 'plugins.productDescription'
            : ecosystem
              ? 'plugins.nativeDescription'
              : 'plugins.pageDescription'
        )}
        className={cn('plugin-hub-shell', embedded && 'is-embedded')}
        bare
        headerless={embedded}
        action={
          <div className="plugin-hub-header-actions">
            {!ecosystem ? (
              <div
                className="plugin-ecosystem-tabs"
                role="tablist"
                aria-label={t('plugins.ecosystemTabsAria')}
              >
                {PLUGIN_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-label={tab.label}
                    aria-selected={activeTab === tab.id}
                    className={cn(activeTab === tab.id && 'is-active')}
                    onClick={() => {
                      setActiveTab(tab.id);
                      setSelectedId(null);
                    }}
                  >
                    {tab.id !== 'vibex' ? (
                      <AgentTypeIcon
                        agentType={tab.id}
                        className="plugin-ecosystem-tab-icon"
                      />
                    ) : null}
                    <span>{tab.label}</span>
                    <small aria-hidden="true">
                      {
                        (catalog?.plugins ?? []).filter(
                          (plugin) => pluginEcosystem(plugin) === tab.id
                        ).length
                      }
                    </small>
                  </button>
                ))}
              </div>
            ) : null}
            {canUseLocalPluginFiles ? (
              <Button
                size="sm"
                onClick={() => {
                  selectImportEcosystem(ecosystem ?? 'codex');
                  setImportChooserOpen(true);
                }}
                disabled={busy}
              >
                <PackagePlus className="mr-1.5 h-3.5 w-3.5" />
                {t('plugins.import')}
              </Button>
            ) : null}
          </div>
        }
      >
        <PluginHubList
          transport={transport}
          canWrite={canWrite}
          queries={queries}
          setQueries={setQueries}
          effectiveTab={effectiveTab}
          error={error}
          reload={reload}
          isLoading={isLoading}
          visiblePlugins={visiblePlugins}
          selected={selected}
          setSelectedId={setSelectedId}
        >
          {selected ? (
            effectiveTab === 'vibex' ? (
              <PluginDetail
                key={selected.id}
                plugin={selected}
                busy={busy}
                onEnabledChange={(enabled) =>
                  void setEnabled(selected, enabled)
                }
                onUpdate={() => void updatePlugin(selected)}
                onRollback={() => void rollbackPlugin(selected)}
                onInstallRuntime={(runtimeId) =>
                  void installRuntime(selected, runtimeId)
                }
                onUninstall={() => setUninstallTarget(selected)}
                loadContributions={() => api.contributions(selected)}
                runtimeInventory={catalog?.runtimes ?? []}
                registryGeneration={contributionCatalog?.generation}
                registryContributions={selectedRegistryContributions}
                appSurfaceTransport={appSurfaceTransport}
                canWrite={canWrite}
                canSurface={canSurface}
                canManagePackage={canManagePackage}
              />
            ) : (
              <AgentNativePluginDetail
                key={selected.id}
                plugin={selected}
                busy={busy}
                onEnabledChange={(enabled) =>
                  void setEnabled(selected, enabled)
                }
                onUpdate={() => void updatePlugin(selected)}
                onUninstall={() => setUninstallTarget(selected)}
                canWrite={canWrite}
                canManagePackage={canManagePackage}
              />
            )
          ) : null}
        </PluginHubList>
      </SettingsSection>

      <PluginImportDialog
        ecosystem={ecosystem}
        importChooserOpen={importChooserOpen}
        setImportChooserOpen={setImportChooserOpen}
        importEcosystem={importEcosystem}
        selectImportEcosystem={selectImportEcosystem}
        chooseZipImport={chooseZipImport}
        busy={busy}
        canUseCliImport={canUseCliImport}
        cliCommand={cliCommand}
        setCliCommand={setCliCommand}
        cliImportStatus={cliImportStatus}
        runCliImport={runCliImport}
        cliLogs={cliLogs}
        cliImportResult={cliImportResult}
        cliImportError={cliImportError}
        importPreview={importPreview}
        setImportPreview={setImportPreview}
        applyImport={applyImport}
      />

      <Dialog
        open={Boolean(capabilitySetup)}
        onOpenChange={(open) => !open && setCapabilitySetup(null)}
        aria-labelledby="plugin-capability-setup-title"
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle id="plugin-capability-setup-title">
              {t('plugins.capabilitySetupTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('plugins.capabilitySetupDescription', {
                name: capabilitySetup?.name ?? '',
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="plugin-capability-setup">
            <Bot aria-hidden="true" />
            <div>
              <strong>{t('plugins.allAgentSkills')}</strong>
              <p>{t('plugins.allAgentSkillsDescription')}</p>
              {(capabilitySetup?.mcpCount ?? 0) > 0 ? (
                <p className="mt-2 text-amber-600 dark:text-amber-400">
                  {t('plugins.builtinMcpNotice')}
                </p>
              ) : null}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                const pluginId = capabilitySetup?.id;
                setCapabilitySetup(null);
                if (pluginId) {
                  navigate(
                    `/settings/mcp?plugin=${encodeURIComponent(pluginId)}`
                  );
                }
              }}
            >
              {t('plugins.chooseAgentsAndMcp')}
            </Button>
            <Button onClick={() => void configureAllAgents()} disabled={busy}>
              {t('plugins.enableAllAgents')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(uninstallTarget)}
        onOpenChange={(open) => !open && setUninstallTarget(null)}
        aria-labelledby="plugin-uninstall-title"
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle id="plugin-uninstall-title">
              {t('plugins.uninstallTitle', {
                name: uninstallTarget?.name ?? '',
              })}
            </DialogTitle>
            <DialogDescription>
              {t(
                uninstallTarget?.nativeManaged
                  ? 'plugins.nativeUninstallDescription'
                  : 'plugins.uninstallDescription',
                { name: uninstallTarget?.name ?? '' }
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUninstallTarget(null)}>
              {t('common:cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void uninstall()}
              disabled={busy}
            >
              {t('plugins.confirmUninstall')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
