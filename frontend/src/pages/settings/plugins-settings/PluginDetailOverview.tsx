import {
  AlertTriangle,
  Bot,
  ChevronRight,
  Command,
  FileSearch,
  Link2,
  Puzzle,
  TerminalSquare,
  Trash2,
  Workflow,
} from 'lucide-react';
import { type Dispatch, type SetStateAction, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { AppSurfaceHost } from '@/components/plugins/AppSurfaceHost';
import { PluginRuntimeDiagnostics } from '@/components/plugins/PluginRuntimeDiagnostics';
import { Button } from '@/components/ui/button';
import {
  appSurfaceDescriptors,
  createBackendAppSurfaceTransport,
} from '@/lib/api/appSurfaceTransport';
import type {
  PluginContributionCatalogItem,
  PluginControlItem,
  PluginRuntimeInventoryItem,
} from '@/lib/api/plugins';
import {
  fileExtensions,
  runtimeLockIsReady,
  type PluginDetailMode,
} from './pluginConstants';

export function PluginDetailOverview({
  plugin,
  busy,
  openContributions,
  showDeveloperDetails,
  setShowDeveloperDetails,
  onInstallRuntime,
  onUninstall,
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
  openContributions: (nextMode: PluginDetailMode) => void;
  showDeveloperDetails: boolean;
  setShowDeveloperDetails: Dispatch<SetStateAction<boolean>>;
  onInstallRuntime: (runtimeId: string) => void;
  onUninstall: () => void;
  runtimeInventory: PluginRuntimeInventoryItem[];
  registryGeneration?: number;
  registryContributions?: PluginContributionCatalogItem[];
  appSurfaceTransport: ReturnType<typeof createBackendAppSurfaceTransport>;
  canWrite: boolean;
  canSurface: boolean;
  canManagePackage: boolean;
}) {
  const { t } = useTranslation('settings');
  const registryItems = registryContributions ?? [];
  const platformExtensions =
    plugin.appContributions ??
    registryItems.filter((item) =>
      ['file_opener', 'preview_provider', 'app_surface'].includes(item.kind)
    );
  const extensions = fileExtensions(
    platformExtensions.filter((item) => item.kind === 'file_opener')
  );
  const hasFilePreview = platformExtensions.some(
    (item) => item.kind === 'file_opener' || item.kind === 'preview_provider'
  );
  const uniqueInvocations = [
    ...new Map(
      (plugin.invocations ?? []).map((invocation) => [
        invocation.id,
        invocation,
      ])
    ).values(),
  ];
  const appSurfaces = useMemo(
    () => appSurfaceDescriptors(plugin, registryContributions ?? []),
    [plugin, registryContributions]
  );

  return (
    <>
      <div className="plugin-product-capabilities">
        <section>
          <header>
            <FileSearch aria-hidden="true" />
            <div>
              <h4>{t('plugins.extendsVibexTitle')}</h4>
              <p>{t('plugins.extendsVibexDescription')}</p>
            </div>
          </header>
          {hasFilePreview ? (
            <div className="plugin-product-capability-row">
              <span>
                <strong>{t('plugins.filePreviewTitle')}</strong>
                <small>{t('plugins.filePreviewDescription')}</small>
              </span>
              {extensions.length ? (
                <code>
                  {extensions.map((item) => item.toUpperCase()).join(' · ')}
                </code>
              ) : null}
            </div>
          ) : (
            <p className="plugin-detail-empty-copy">
              {t('plugins.noAppExtensions')}
            </p>
          )}
        </section>
        <section>
          <header>
            <Workflow aria-hidden="true" />
            <div>
              <h4>{t('plugins.extendsAgentsTitle')}</h4>
              <p>{t('plugins.extendsAgentsDescription')}</p>
            </div>
          </header>
          <div className="plugin-product-capability-actions">
            {plugin.skills.length ? (
              <button
                type="button"
                onClick={() => void openContributions('skills')}
              >
                {t('plugins.skillsCount', { count: plugin.skills.length })}
                <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            ) : null}
            {uniqueInvocations.length ? (
              <span>
                {t('plugins.workflowsCount', {
                  count: uniqueInvocations.length,
                })}
              </span>
            ) : null}
            {(plugin.mcpCount ?? 0) > 0 ? (
              <button
                type="button"
                onClick={() => void openContributions('mcp')}
              >
                {t('plugins.mcpCount', { count: plugin.mcpCount })}
                <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </section>
      </div>

      {registryContributions ? (
        <div className="plugin-developer-disclosure">
          <button
            type="button"
            aria-expanded={showDeveloperDetails}
            onClick={() => setShowDeveloperDetails((current) => !current)}
          >
            {t('plugins.developerDetails')}
            <ChevronRight aria-hidden="true" />
          </button>
          {showDeveloperDetails ? (
            <div
              className="plugin-registry-snapshot"
              role="status"
              aria-label={t('plugins.registrySnapshotAria', {
                name: plugin.name,
              })}
            >
              <span>
                {t('plugins.registryGeneration', {
                  generation: registryGeneration ?? 0,
                })}
              </span>
              <span>
                {t('plugins.registryContributionCount', {
                  count: registryContributions.length,
                })}
              </span>
              <p>{t('plugins.registryExplanation')}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {canSurface
        ? appSurfaces.map((surface) => (
            <AppSurfaceHost
              key={`${surface.surfaceId}:${surface.generation}`}
              descriptor={surface}
              enabled={plugin.enabled}
              transport={appSurfaceTransport}
            />
          ))
        : appSurfaces.length > 0 && (
            <p className="plugin-surface-unavailable" role="status">
              {t('plugins.surfaceCapabilityUnavailable')}
            </p>
          )}
      {plugin.warnings.length ? (
        <div className="plugin-warning-stack" role="status">
          {plugin.warnings.map((warning) => (
            <p key={`${warning.code}:${warning.contribution ?? ''}`}>
              <AlertTriangle aria-hidden="true" />
              <span>{warning.message}</span>
            </p>
          ))}
        </div>
      ) : null}

      <div className="plugin-overview-sections">
        <PluginRuntimeDiagnostics pluginId={plugin.id} />

        {plugin.skills.length ? (
          <div className="plugin-detail-section">
            <h4>
              <Puzzle aria-hidden="true" />
              {t('plugins.skillsTitle')}
            </h4>
            <ul className="plugin-contribution-list">
              {plugin.skills.map((skill) => (
                <li key={skill.id}>
                  <span>{skill.id}</span>
                  <code>{skill.path}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {plugin.runtimes.length ? (
          <div className="plugin-detail-section">
            <h4>
              <TerminalSquare aria-hidden="true" />
              {t('plugins.runtimeTitle')}
            </h4>
            {plugin.runtimes.length ? (
              <ul className="plugin-contribution-list">
                {plugin.runtimes.map((runtime) => (
                  <li
                    key={`${runtime.id}:${runtime.version}:${runtime.target ?? 'unknown'}:${runtime.contentDigest ?? 'unknown'}`}
                  >
                    <span>
                      {runtime.id}
                      <small>{runtime.installer}</small>
                    </span>
                    <div className="flex min-w-0 items-center gap-2">
                      <code>{runtime.installCommand ?? runtime.command}</code>
                      {runtimeInventory.some((installed) =>
                        runtimeLockIsReady(runtime, installed)
                      ) ? (
                        <span className="plugin-runtime-ready">
                          {t('plugins.runtimeReady')}
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || !canWrite}
                          onClick={() => onInstallRuntime(runtime.id)}
                          aria-label={t('plugins.installRuntimeAria', {
                            id: runtime.id,
                          })}
                        >
                          {t('plugins.installRuntime')}
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="plugin-detail-empty-copy">
                {t('plugins.noRuntime')}
              </p>
            )}
          </div>
        ) : null}

        {(plugin.mcpCount ?? 0) > 0 ? (
          <div className="plugin-detail-section">
            <h4>
              <Bot aria-hidden="true" />
              {t('plugins.mcpTitle')}
            </h4>
            {plugin.mcpServers?.length ? (
              <ul className="plugin-contribution-list plugin-name-only-list">
                {plugin.mcpServers.map((server) => (
                  <li key={server}>
                    <span>{server}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="plugin-detail-empty-copy">
                {t(
                  (plugin.mcpCount ?? 0) > 0
                    ? 'plugins.mcpSummary'
                    : 'plugins.noMcp',
                  { count: plugin.mcpCount ?? 0 }
                )}
              </p>
            )}
          </div>
        ) : null}

        {uniqueInvocations.length ? (
          <div className="plugin-detail-section">
            <h4>
              <Command aria-hidden="true" />
              {t('plugins.invocationsTitle')}
            </h4>
            {plugin.invocations?.length ? (
              <ul className="plugin-contribution-list">
                {uniqueInvocations.map((invocation) => (
                  <li key={invocation.id}>
                    <span>{invocation.label}</span>
                    <code>{invocation.id}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="plugin-detail-empty-copy">
                {t('plugins.noInvocations')}
              </p>
            )}
          </div>
        ) : null}

        <div className="plugin-detail-section">
          <h4>
            <Link2 aria-hidden="true" />
            {t('plugins.sourceTitle')}
          </h4>
          <ul className="plugin-contribution-list">
            <li>
              <span>{t(`plugins.sourceKind.${plugin.sourceKind}`)}</span>
              <code title={plugin.sourcePath}>{plugin.sourcePath}</code>
            </li>
          </ul>
        </div>
      </div>

      {!plugin.builtin &&
      plugin.uninstallSupported !== false &&
      canManagePackage ? (
        <div className="flex justify-end border-t border-border/70 pt-3">
          <Button
            size="sm"
            variant="outline"
            className="text-destructive"
            disabled={busy || !canWrite}
            onClick={onUninstall}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            {t('plugins.uninstall')}
          </Button>
        </div>
      ) : null}
    </>
  );
}
