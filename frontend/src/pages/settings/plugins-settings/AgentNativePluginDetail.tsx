import {
  AlertTriangle,
  Bot,
  Link2,
  Puzzle,
  RefreshCw,
  TerminalSquare,
  Trash2,
  Workflow,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import type { PluginControlItem } from '@/lib/api/plugins';
import { AgentNativeResourceSection } from './AgentNativeResourceSection';

export function AgentNativePluginDetail({
  plugin,
  busy,
  onEnabledChange,
  onUpdate,
  onUninstall,
  canWrite,
  canManagePackage,
}: {
  plugin: PluginControlItem;
  busy: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onUpdate: () => void;
  onUninstall: () => void;
  canWrite: boolean;
  canManagePackage: boolean;
}) {
  const { t } = useTranslation('settings');
  const skillItems = plugin.skills.map((skill) => ({
    id: skill.id,
    detail: skill.path,
  }));
  const mcpItems = (plugin.mcpServers ?? []).map((id) => ({ id }));
  const runtimeItems = plugin.runtimes.map((runtime) => ({
    id: runtime.id,
    detail: runtime.version
      ? `${runtime.command} · v${runtime.version}`
      : runtime.command,
  }));

  return (
    <section
      className="plugin-hub-detail plugin-agent-native-detail"
      role="region"
      aria-label={plugin.name}
    >
      <header className="plugin-detail-header">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-semibold text-foreground">
              {plugin.name}
            </h3>
            <span className="plugin-version">v{plugin.version}</span>
          </div>
          {plugin.description ? (
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
              {plugin.description}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {plugin.enableSupported ? (
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
      </header>

      <div className="plugin-overview-sections">
        <AgentNativeResourceSection
          icon={<Puzzle aria-hidden="true" />}
          title={t('plugins.skillsTitle')}
          items={skillItems}
          empty={t('plugins.noSkills')}
        />
        <AgentNativeResourceSection
          icon={<Bot aria-hidden="true" />}
          title={t('plugins.mcpTitle')}
          items={mcpItems}
          empty={t('plugins.noMcp')}
        />
        <AgentNativeResourceSection
          icon={<TerminalSquare aria-hidden="true" />}
          title={t('plugins.runtimeTitle')}
          items={runtimeItems}
          empty={t('plugins.noRuntime')}
        />
        <AgentNativeResourceSection
          icon={<Link2 aria-hidden="true" />}
          title={t('plugins.hooksTitle')}
          items={(plugin.hooks ?? []).map((hook) => ({
            id: hook.id,
            detail: hook.path,
          }))}
          empty={t('plugins.noHooks')}
        />
        <AgentNativeResourceSection
          icon={<Workflow aria-hidden="true" />}
          title={t('plugins.workflowsTitle')}
          items={(plugin.workflows ?? []).map((workflow) => ({
            id: workflow.id,
            detail: workflow.path,
          }))}
          empty={t('plugins.noWorkflows')}
        />
      </div>

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

      {plugin.uninstallSupported !== false && canManagePackage ? (
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
    </section>
  );
}
