import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Loader2, Plug, Puzzle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { BackendTransport } from '@/lib/backendTransport';
import {
  createPluginApi,
  type LegacyPluginMigrationSummary,
  type PluginActionCatalog,
  type PluginComponentStatus,
} from '@/lib/api/plugins';
import { cn } from '@/lib/utils';
import { useBackendTransport } from '@/lib/transport';
import { SettingsPageHeader, SettingsSection } from './SettingsUi';

function StatusMark({ status }: { status: PluginComponentStatus }) {
  const ready = status === 'ready';
  const pending = status === 'installing';
  const Icon = ready ? Check : pending ? Loader2 : AlertTriangle;
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        'h-3.5 w-3.5 shrink-0',
        ready
          ? 'text-[hsl(var(--success))]'
          : pending
            ? 'animate-spin text-[hsl(var(--status-running))]'
            : 'text-[hsl(var(--warning))]'
      )}
    />
  );
}

function ReadinessRow({
  label,
  status,
  detail,
}: {
  label: string;
  status: PluginComponentStatus;
  detail: string;
}) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-border/70 py-2 first:border-t-0">
      <span className="flex min-w-0 items-center gap-2 text-xs font-medium">
        <StatusMark status={status} />
        <span className="truncate">{label}</span>
      </span>
      <span className="text-[11px] text-muted-foreground">{detail}</span>
    </li>
  );
}

function statusLabel(
  status: PluginComponentStatus,
  t: (key: string) => string
) {
  return t(`plugins.readiness.${status}`);
}

export function PluginsSettings({
  transport: transportOverride,
}: {
  transport?: BackendTransport;
}) {
  const contextTransport = useBackendTransport();
  const transport = transportOverride ?? contextTransport;
  const { t } = useTranslation(['settings', 'common']);
  const api = useMemo(() => createPluginApi(transport), [transport]);
  const [catalog, setCatalog] = useState<PluginActionCatalog | null>(null);
  const [legacyPlugins, setLegacyPlugins] = useState<
    LegacyPluginMigrationSummary[]
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isToggling, setIsToggling] = useState(false);
  const installTaskIdRef = useRef<string | null>(null);

  const reload = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const [nextCatalog, nextLegacy] = await Promise.all([
        api.catalog(),
        api.listLegacy(),
      ]);
      setCatalog(nextCatalog);
      setLegacyPlugins(nextLegacy);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggleEnabled = async (enabled: boolean) => {
    if (!catalog) return;
    setIsToggling(true);
    const taskId = crypto.randomUUID();
    installTaskIdRef.current = taskId;
    try {
      await api.setOfficeEnabled(enabled, taskId);
      await reload();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      installTaskIdRef.current = null;
      setIsToggling(false);
    }
  };

  const cancelEnable = async () => {
    const taskId = installTaskIdRef.current;
    if (!taskId) return;
    try {
      await api.cancelOfficeInstall(taskId);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title={t('plugins.pageTitle')}
        description={t('plugins.pageDescriptionV2')}
      />

      <SettingsSection
        icon={Puzzle}
        title={t('plugins.managedTitle')}
        description={t('plugins.sectionDescriptionV2')}
      >
        {isLoading ? (
          <div
            role="status"
            className="flex items-center gap-2 py-4 text-xs text-muted-foreground"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('plugins.loading')}
          </div>
        ) : loadError ? (
          <div
            role="alert"
            className="flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
          >
            <span>{t('plugins.loadFailed', { error: loadError })}</span>
            <Button size="sm" variant="outline" onClick={() => void reload()}>
              {t('common:retry')}
            </Button>
          </div>
        ) : catalog ? (
          <article aria-labelledby="office-plugin-title" className="space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3
                    id="office-plugin-title"
                    className="truncate text-sm font-semibold"
                  >
                    {catalog.plugin.name}
                  </h3>
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    v{catalog.plugin.version}
                  </span>
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {t('plugins.builtinBadge')}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {catalog.readiness.enabled
                    ? t('plugins.enabled')
                    : t('plugins.disabled')}
                </p>
              </div>
              <Switch
                checked={catalog.readiness.enabled}
                disabled={isToggling}
                onCheckedChange={(enabled) => void toggleEnabled(enabled)}
                aria-label={t('plugins.enabledAria', {
                  name: catalog.plugin.name,
                })}
              />
              {isToggling ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void cancelEnable()}
                >
                  {t('plugins.cancelEnable')}
                </Button>
              ) : null}
            </div>

            <ul aria-label={t('plugins.readinessAria')}>
              <ReadinessRow
                label={t('plugins.dependencyLabel', {
                  id: catalog.readiness.dependency.id,
                })}
                status={catalog.readiness.dependency.status}
                detail={[
                  catalog.readiness.dependency.version,
                  statusLabel(catalog.readiness.dependency.status, t),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
              {catalog.readiness.skills.map((skill) => (
                <ReadinessRow
                  key={skill.id}
                  label={t('plugins.skillLabel', { id: skill.id })}
                  status={skill.status}
                  detail={statusLabel(skill.status, t)}
                />
              ))}
              {catalog.readiness.providers.map((provider) => (
                <ReadinessRow
                  key={provider.id}
                  label={t('plugins.providerLabel', { id: provider.id })}
                  status={provider.status}
                  detail={statusLabel(provider.status, t)}
                />
              ))}
            </ul>
          </article>
        ) : (
          <p className="py-4 text-xs text-muted-foreground">
            {t('plugins.emptyV2')}
          </p>
        )}
      </SettingsSection>

      {legacyPlugins.length > 0 ? (
        <SettingsSection
          icon={Plug}
          title={t('plugins.legacyTitle')}
          description={t('plugins.legacyDescription')}
        >
          <ul className="space-y-2">
            {legacyPlugins
              .filter((plugin) => plugin.status === 'migration_required')
              .map((plugin) => (
                <li
                  key={plugin.legacyPluginId}
                  className="flex items-start justify-between gap-4 border-t border-border/70 py-3 first:border-t-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {plugin.name}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('plugins.migrationRequired')}
                    </p>
                  </div>
                  <span className="rounded border border-[hsl(var(--warning)/0.45)] bg-[hsl(var(--warning)/0.1)] px-2 py-1 text-[10px] font-medium text-[hsl(var(--warning))]">
                    migration_required
                  </span>
                </li>
              ))}
          </ul>
        </SettingsSection>
      ) : null}
    </div>
  );
}
