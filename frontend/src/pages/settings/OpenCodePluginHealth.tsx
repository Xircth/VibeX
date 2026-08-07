import {
  Check,
  CheckCircle2,
  CircleAlert,
  Copy,
  FileCog,
  HardDrive,
  Loader2,
  PackagePlus,
  Puzzle,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { OpenCodePluginSummaryView } from 'shared/types';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';

type Props = {
  onChanged?: () => void | Promise<void>;
};

export function OpenCodePluginHealth({ onChanged }: Props) {
  const { t } = useTranslation(['settings', 'common']);
  const [summary, setSummary] = useState<OpenCodePluginSummaryView | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setSummary(await agentManagementApi.openCodePlugins());
    } catch (error) {
      const message = errorMessage(
        error,
        t('settings:agents.openCodePluginLoadFailed')
      );
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => void load(), [load]);

  const missing = useMemo(
    () =>
      summary?.plugins
        .filter((plugin) => plugin.status === 'missing')
        .map((plugin) => plugin.name) ?? [],
    [summary]
  );

  const install = async (names: string[] | null) => {
    setRunning(names?.[0] ?? 'all');
    try {
      setSummary(await agentManagementApi.installOpenCodePlugins(names));
      toast.success(
        names
          ? t('settings:agents.openCodePluginInstalled', { name: names[0] })
          : t('settings:agents.openCodePluginsInstalled')
      );
      await onChanged?.();
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.openCodePluginInstallFailed'))
      );
    } finally {
      setRunning(null);
    }
  };

  const uninstall = async (name: string) => {
    const result = await ConfirmDialog.show({
      title: t('settings:agents.openCodePluginUninstallTitle', { name }),
      message: t('settings:agents.openCodePluginUninstallMessage'),
      confirmText: t('settings:agents.openCodePluginUninstallConfirm'),
      cancelText: t('common:cancel'),
      variant: 'destructive',
    });
    if (result !== 'confirmed') return;
    setRunning(name);
    try {
      setSummary(await agentManagementApi.uninstallOpenCodePlugin(name));
      toast.success(t('settings:agents.openCodePluginUninstalled', { name }));
      await onChanged?.();
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.openCodePluginUninstallFailed'))
      );
    } finally {
      setRunning(null);
    }
  };

  return (
    <section
      aria-labelledby="opencode-plugin-heading"
      className="settings-surface agent-plugin-surface"
    >
      <div className="agent-section-heading">
        <div className="flex items-center gap-2">
          <Puzzle aria-hidden="true" className="h-4 w-4" />
          <h3 id="opencode-plugin-heading">
            {t('settings:agents.openCodePluginTitle')}
          </h3>
        </div>
        <div className="flex items-center gap-1.5">
          {missing.length > 1 ? (
            <Button
              className="h-8"
              disabled={running !== null}
              size="sm"
              variant="outline"
              onClick={() => void install(null)}
            >
              <PackagePlus aria-hidden="true" className="h-3.5 w-3.5" />
              {t('settings:agents.openCodePluginInstallAll')}
            </Button>
          ) : null}
          <Button
            aria-label={t('settings:agents.openCodePluginRefreshAria')}
            className="h-8"
            disabled={loading || running !== null}
            size="sm"
            variant="ghost"
            onClick={() => void load()}
          >
            {loading ? (
              <Loader2
                aria-hidden="true"
                className="h-3.5 w-3.5 animate-spin"
              />
            ) : (
              <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
            )}
            {t('settings:agents.refresh')}
          </Button>
        </div>
      </div>

      <div aria-live="polite">
        {loading && !summary ? (
          <p className="agent-plugin-empty">
            {t('settings:agents.openCodePluginChecking')}
          </p>
        ) : loadError && !summary ? (
          <div className="agent-inline-error" role="alert">
            <span>{loadError}</span>
            <Button
              className="h-8 shrink-0"
              size="sm"
              variant="outline"
              onClick={() => void load()}
            >
              {t('settings:agents.openCodePluginRecheck')}
            </Button>
          </div>
        ) : summary?.plugins.length ? (
          <ul className="agent-plugin-list">
            {summary.plugins.map((plugin) => {
              const installed = plugin.status === 'installed';
              const floating = plugin.declared_spec.endsWith('@latest');
              return (
                <li key={plugin.name}>
                  <span
                    className={
                      installed
                        ? 'agent-plugin-status is-installed'
                        : 'agent-plugin-status is-missing'
                    }
                  >
                    {installed ? (
                      <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
                    ) : (
                      <CircleAlert aria-hidden="true" className="h-4 w-4" />
                    )}
                  </span>
                  <div className="agent-plugin-copy">
                    <div>
                      <strong>{plugin.name}</strong>
                      <code>{plugin.declared_spec}</code>
                    </div>
                    <p>
                      {installed
                        ? t('settings:agents.installed')
                        : t('settings:agents.missing')}
                      {plugin.installed_version
                        ? ` · ${plugin.installed_version}`
                        : ''}
                      {floating
                        ? ` · ${t('settings:agents.openCodePluginLatestPinned')}`
                        : ''}
                    </p>
                  </div>
                  {installed ? (
                    <Button
                      aria-label={t(
                        'settings:agents.openCodePluginUninstallAria',
                        { name: plugin.name }
                      )}
                      className="h-8 shrink-0"
                      disabled={running !== null}
                      size="sm"
                      variant="ghost"
                      onClick={() => void uninstall(plugin.name)}
                    >
                      {running === plugin.name ? (
                        <Loader2
                          aria-hidden="true"
                          className="h-3.5 w-3.5 animate-spin"
                        />
                      ) : (
                        <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                      )}
                      {t('settings:agents.uninstallConfirm')}
                    </Button>
                  ) : (
                    <Button
                      aria-label={t(
                        'settings:agents.openCodePluginInstallAria',
                        { name: plugin.name }
                      )}
                      className="h-8 shrink-0"
                      disabled={running !== null}
                      size="sm"
                      variant="outline"
                      onClick={() => void install([plugin.name])}
                    >
                      {running === plugin.name ? (
                        <Loader2
                          aria-hidden="true"
                          className="h-3.5 w-3.5 animate-spin"
                        />
                      ) : (
                        <PackagePlus
                          aria-hidden="true"
                          className="h-3.5 w-3.5"
                        />
                      )}
                      {t('settings:agents.fixInstall')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="agent-plugin-empty">
            {t('settings:agents.openCodePluginEmpty')}
          </p>
        )}
      </div>

      {summary ? (
        <dl className="agent-plugin-paths">
          <PluginPathInfo
            icon={<FileCog aria-hidden="true" className="h-4 w-4" />}
            label={t('settings:agents.configTitle')}
            path={summary.config_path}
            copyAriaLabel={t('settings:agents.openCodeCopyConfigPathAria')}
          />
          <PluginPathInfo
            icon={<HardDrive aria-hidden="true" className="h-4 w-4" />}
            label={t('settings:agents.cache')}
            path={summary.cache_dir}
            copyAriaLabel={t('settings:agents.openCodeCopyCacheDirAria')}
          />
        </dl>
      ) : null}
    </section>
  );
}

function PluginPathInfo({
  icon,
  label,
  path,
  copyAriaLabel,
}: {
  icon: ReactNode;
  label: string;
  path: string;
  copyAriaLabel: string;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be unavailable; the row stays readable without it.
    }
  };
  return (
    <div className="agent-plugin-path">
      <span className="agent-plugin-path-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="agent-plugin-path-copy">
        <dt>{label}</dt>
        <dd title={path}>{path}</dd>
      </div>
      <Button
        aria-label={copyAriaLabel}
        className="h-7 shrink-0"
        size="sm"
        variant="ghost"
        onClick={() => void copy()}
      >
        {copied ? (
          <Check aria-hidden="true" className="h-3.5 w-3.5" />
        ) : (
          <Copy aria-hidden="true" className="h-3.5 w-3.5" />
        )}
        {copied
          ? t('settings:agents.openCodePathCopied')
          : t('settings:agents.openCodePathCopy')}
      </Button>
    </div>
  );
}
