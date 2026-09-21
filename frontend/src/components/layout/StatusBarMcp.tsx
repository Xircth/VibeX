import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight,
  Plug,
  Puzzle,
  RotateCw,
  Settings2,
  Unplug,
} from 'lucide-react';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { createPluginControlApi } from '@/lib/api/plugins';
import type {
  PluginMcpHeadline,
  PluginMcpPluginStatus,
  PluginMcpStatusReport,
} from '@/lib/api/plugins';
import { getInvokeErrorMessage } from '@/lib/errors';
import { useBackendTransport } from '@/lib/transport';
import { cn } from '@/lib/utils';
import { pluginCatalogQueryKey } from '@/pages/plugins/pluginQueries';

const POLL_MS = 60_000;
export const pluginMcpStatusQueryKey = ['plugin-mcp-status'] as const;

const EMPTY_REPORT: PluginMcpStatusReport = {
  state: 'empty',
  listening: false,
  plugins: [],
};

function headlineTone(state: PluginMcpHeadline | 'unknown') {
  switch (state) {
    case 'running':
      return 'text-success';
    case 'partial':
      return 'text-warning';
    case 'unavailable':
      return 'text-destructive';
    default:
      return 'text-muted-foreground';
  }
}

export function StatusBarMcp() {
  const { t } = useTranslation('statusbar');
  const navigate = useNavigate();
  const transport = useBackendTransport();
  const api = useMemo(() => createPluginControlApi(transport), [transport]);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const query = useQuery({
    queryKey: pluginMcpStatusQueryKey,
    queryFn: () => api.mcpStatus(),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    meta: { suppressGlobalError: true },
  });

  const report = query.data ?? EMPTY_REPORT;
  const state = query.isError ? 'unknown' : report.state;
  const down = state === 'stopped' || state === 'unavailable';
  const TriggerIcon = down ? Unplug : Plug;

  const handleToggle = async (plugin: PluginMcpPluginStatus, enabled: boolean) => {
    setActionError(null);
    setPending((current) => ({ ...current, [plugin.pluginId]: enabled }));
    try {
      await api.setEnabled(plugin.pluginId, enabled);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: pluginMcpStatusQueryKey }),
        queryClient.invalidateQueries({ queryKey: pluginCatalogQueryKey }),
      ]);
    } catch (error) {
      setActionError(
        t('mcp.actionFailed', { message: getInvokeErrorMessage(error) })
      );
    } finally {
      setPending((current) => {
        const next = { ...current };
        delete next[plugin.pluginId];
        return next;
      });
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          void query.refetch();
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t('mcp.title')}
          aria-label={`${t('mcp.title')} — ${t(`mcp.state.${state}`)}`}
          className="inline-flex h-4 items-center justify-center rounded-sm text-secondary-foreground opacity-80 transition-opacity hover:opacity-100"
        >
          <TriggerIcon className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={6}
        className="w-[22.5rem] p-3"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[0.875rem] font-semibold tracking-[-0.01em] text-foreground">
              {t('mcp.title')}
            </div>
            <p className="mt-1 text-[0.75rem] leading-4 text-muted-foreground">
              {t(`mcp.hint.${report.state}`)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1 pt-0.5">
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[0.75rem] font-medium leading-4',
                headlineTone(state)
              )}
            >
              {t(`mcp.state.${state}`)}
            </span>
            <button
              type="button"
              title={t('mcp.refresh')}
              aria-label={t('mcp.refresh')}
              className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
              onClick={() => void query.refetch()}
            >
              <RotateCw
                className={cn('h-3.5 w-3.5', query.isFetching && 'animate-spin')}
              />
            </button>
          </div>
        </div>

        {query.isError ? (
          <p className="mt-3 text-[0.75rem] text-destructive">
            {t('mcp.loadFailed', {
              message: getInvokeErrorMessage(query.error),
            })}
          </p>
        ) : report.plugins.length === 0 ? (
          <p className="mt-3 text-[0.75rem] text-muted-foreground">
            {t('mcp.hint.empty')}
          </p>
        ) : (
          <div className="settings-surface mt-3 overflow-hidden p-1">
            {report.plugins.map((plugin) => {
              const isOpen = expanded === plugin.pluginId;
              const toolCount = plugin.servers.reduce(
                (sum, server) => sum + server.tools.length,
                0
              );
              const checked = pending[plugin.pluginId] ?? plugin.enabled;
              return (
                <div key={plugin.pluginId}>
                  <div className="flex items-center gap-1.5 rounded-[12px] px-1.5 py-1.5">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-label={plugin.name}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      onClick={() =>
                        setExpanded((current) =>
                          current === plugin.pluginId ? null : plugin.pluginId
                        )
                      }
                    >
                      <ChevronRight
                        className={cn(
                          'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                          isOpen && 'rotate-90'
                        )}
                      />
                      <Puzzle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[0.75rem] font-medium text-foreground">
                          {plugin.name}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-[0.625rem] text-muted-foreground">
                          <span>{t('mcp.mcpCount', { count: plugin.mcpCount })}</span>
                          <span className="opacity-40">·</span>
                          <span>{t(`mcp.connection.${plugin.connection}`)}</span>
                        </span>
                      </span>
                    </button>
                    <Switch
                      checked={checked}
                      disabled={
                        !plugin.enableSupported || plugin.pluginId in pending
                      }
                      aria-label={plugin.name}
                      onCheckedChange={(next) => {
                        void handleToggle(plugin, next);
                      }}
                    />
                  </div>
                  {isOpen ? (
                    <div className="mb-1 ml-7 mr-1 space-y-1 pb-1">
                      {plugin.description ? (
                        <p className="text-[0.625rem] leading-4 text-muted-foreground">
                          {plugin.description}
                        </p>
                      ) : null}
                      {toolCount === 0 ? (
                        <p className="text-[0.625rem] text-muted-foreground">
                          {t('mcp.noTools')}
                        </p>
                      ) : (
                        plugin.servers.flatMap((server) =>
                          server.tools.map((tool) => (
                            <div
                              key={`${server.id}:${tool.name}`}
                              className="rounded-[10px] px-2 py-1.5"
                            >
                              <div className="truncate text-[0.75rem] text-foreground">
                                {t(`mcp.tools.${tool.name}`, {
                                  defaultValue: tool.name,
                                })}
                              </div>
                              <div className="mt-0.5 truncate font-mono text-[0.625rem] text-muted-foreground">
                                {tool.name}
                              </div>
                            </div>
                          ))
                        )
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {actionError ? (
          <p className="mt-2 text-[0.75rem] text-destructive">{actionError}</p>
        ) : null}

        {report.plugins.length > 0 &&
        !report.listening &&
        report.state !== 'unavailable' ? (
          <button
            type="button"
            className="mt-3 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[14px] bg-primary text-[0.75rem] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            disabled={starting}
            onClick={() => {
              setStarting(true);
              setActionError(null);
              void api
                .ensureMcpRunning()
                .then(() =>
                  queryClient.invalidateQueries({
                    queryKey: pluginMcpStatusQueryKey,
                  })
                )
                .catch((error) => {
                  setActionError(
                    t('mcp.actionFailed', {
                      message: getInvokeErrorMessage(error),
                    })
                  );
                })
                .finally(() => setStarting(false));
            }}
          >
            <Plug className="h-3.5 w-3.5" />
            {starting ? t('mcp.starting') : t('mcp.startService')}
          </button>
        ) : null}

        <button
          type="button"
          className="mt-3 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[14px] border border-border bg-[var(--surface-control)] text-[0.75rem] font-medium text-foreground transition-colors hover:bg-accent/70"
          onClick={() => {
            setOpen(false);
            navigate('/plugins');
          }}
        >
          <Settings2 className="h-3.5 w-3.5" />
          {t('mcp.openPlugins')}
        </button>
      </PopoverContent>
    </Popover>
  );
}
