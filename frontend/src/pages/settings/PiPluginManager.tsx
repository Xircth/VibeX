import {
  CheckCircle2,
  Loader2,
  PackagePlus,
  Puzzle,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { PiPluginSummaryView, PiPluginView } from 'shared/types';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';

type Props = {
  onChanged?: () => void | Promise<void>;
  onCount?: (count: number) => void;
};

export function PiPluginManager({ onChanged, onCount }: Props) {
  const { t } = useTranslation(['settings', 'common']);
  const [summary, setSummary] = useState<PiPluginSummaryView | null>(null);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [spec, setSpec] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await agentManagementApi.piPlugins();
      setSummary(next);
      setSelectedSource((current) => {
        if (
          current &&
          next.plugins.some((plugin) => plugin.source === current)
        ) {
          return current;
        }
        return next.plugins[0]?.source ?? null;
      });
    } catch (error) {
      const message = errorMessage(
        error,
        t('settings:agents.piPluginLoadFailed')
      );
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    onCount?.(summary?.plugins.length ?? 0);
  }, [onCount, summary]);

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = spec.trim();
    if (!next) return;
    setRunning(next);
    try {
      const result = await agentManagementApi.addPiPlugin(next);
      setSummary(result);
      setSelectedSource(result.plugins[0]?.source ?? null);
      setSpec('');
      toast.success(t('settings:agents.piPluginAdded', { name: next }));
      await onChanged?.();
    } catch (error) {
      toast.error(errorMessage(error, t('settings:agents.piPluginAddFailed')));
    } finally {
      setRunning(null);
    }
  };

  const remove = async (plugin: PiPluginView) => {
    const result = await ConfirmDialog.show({
      title: t('settings:agents.piPluginRemoveTitle', { name: plugin.name }),
      message: t('settings:agents.piPluginRemoveMessage'),
      confirmText: t('settings:agents.piPluginRemoveConfirm'),
      cancelText: t('common:cancel'),
      variant: 'destructive',
    });
    if (result !== 'confirmed') return;
    setRunning(plugin.source);
    try {
      const next = await agentManagementApi.removePiPlugin(plugin.source);
      setSummary(next);
      setSelectedSource(next.plugins[0]?.source ?? null);
      toast.success(
        t('settings:agents.piPluginRemoved', { name: plugin.name })
      );
      await onChanged?.();
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.piPluginRemoveFailed'))
      );
    } finally {
      setRunning(null);
    }
  };

  const selected = summary?.plugins.find(
    (plugin) => plugin.source === selectedSource
  );

  return (
    <div>
      <form
        className="flex flex-wrap items-end gap-2 px-4 pb-3"
        onSubmit={(event) => void add(event)}
      >
        <label className="min-w-56 flex-1 space-y-1 text-xs">
          <span>{t('settings:agents.piPluginSpec')}</span>
          <input
            autoComplete="off"
            className="raised-control h-9 w-full px-3"
            disabled={running !== null}
            name="pi_plugin_spec"
            placeholder={t('settings:agents.piPluginSpecPlaceholder')}
            value={spec}
            onChange={(event) => setSpec(event.target.value)}
          />
        </label>
        <Button
          className="h-9"
          disabled={running !== null || !spec.trim()}
          size="sm"
          type="submit"
        >
          {running && running === spec.trim() ? (
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <PackagePlus aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          {t('settings:agents.piPluginAdd')}
        </Button>
        <Button
          aria-label={t('settings:agents.piPluginRefreshAria')}
          className="h-9"
          disabled={loading || running !== null}
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => void load()}
        >
          {loading ? (
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          {t('settings:agents.refresh')}
        </Button>
      </form>

      {loading && !summary ? (
        <p className="agent-plugin-empty">
          {t('settings:agents.piPluginChecking')}
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
            {t('settings:agents.retryRead')}
          </Button>
        </div>
      ) : summary?.plugins.length ? (
        <div className="agent-native-plugin-split">
          <ul aria-label={t('settings:agents.piPluginTitle')}>
            {summary.plugins.map((plugin) => {
              const active = plugin.source === selectedSource;
              return (
                <li key={plugin.source}>
                  <button
                    className={`plugin-hub-row${active ? ' is-selected' : ''}`}
                    type="button"
                    onClick={() => setSelectedSource(plugin.source)}
                  >
                    <span className="agent-plugin-status is-installed">
                      <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
                    </span>
                    <strong>{plugin.name}</strong>
                  </button>
                </li>
              );
            })}
          </ul>
          {selected ? (
            <article>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Puzzle aria-hidden="true" className="h-4 w-4" />
                    <h4 className="truncate text-sm font-semibold">
                      {selected.name}
                    </h4>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {selected.kind}
                    {selected.version ? ` · ${selected.version}` : ''}
                  </p>
                </div>
                <Button
                  aria-label={t('settings:agents.piPluginRemoveAria', {
                    name: selected.name,
                  })}
                  className="h-8 shrink-0"
                  disabled={running !== null}
                  size="sm"
                  variant="ghost"
                  onClick={() => void remove(selected)}
                >
                  {running === selected.source ? (
                    <Loader2
                      aria-hidden="true"
                      className="h-3.5 w-3.5 animate-spin"
                    />
                  ) : (
                    <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                  {t('common:delete')}
                </Button>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                {selected.source}
              </p>
              {selected.path ? (
                <p className="mt-2 truncate font-mono text-xs text-muted-foreground">
                  {selected.path}
                </p>
              ) : null}
            </article>
          ) : null}
        </div>
      ) : (
        <p className="agent-plugin-empty">
          {t('settings:agents.piPluginEmpty')}
        </p>
      )}
    </div>
  );
}
