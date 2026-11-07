import { useEffect, useMemo, useState } from 'react';
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

import { BUILTIN_CONNECTOR_CATALOG } from '@/components/connectors/connectorCatalog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { useUserSystem } from '@/components/ConfigProvider';
import { mcpMarketApi, type LocalMcpServer } from '@/lib/api';
import { openSettingsSurface } from '@/lib/api/settingsWindow';
import { HOST_MULTI_AGENT_ID, createPluginControlApi } from '@/lib/api/plugins';
import type {
  PluginMcpPluginStatus,
  PluginMcpStatusReport,
} from '@/lib/api/plugins';
import { getInvokeErrorMessage } from '@/lib/errors';
import { useBackendTransport } from '@/lib/transport';
import { cn } from '@/lib/utils';
import { pluginCatalogQueryKey } from '@/pages/plugins/pluginQueries';

const POLL_MS = 60_000;
export const pluginMcpStatusQueryKey = ['plugin-mcp-status'] as const;
export const localMcpServersQueryKey = ['local-mcp-servers'] as const;
export const LOCAL_MCP_SERVERS_CHANGED_EVENT =
  'vibex:local-mcp-servers-changed';

export function notifyLocalMcpServersChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(LOCAL_MCP_SERVERS_CHANGED_EVENT));
  }
}

const INTERNAL_MCP_SERVER_IDS = new Set([
  'vibex-delegation-mcp',
  'vibex-session-mcp',
  'vibex-workflow-mcp',
]);

const EMPTY_REPORT: PluginMcpStatusReport = {
  state: 'empty',
  listening: false,
  plugins: [],
};

function connectionDot(connection: PluginMcpPluginStatus['connection']) {
  switch (connection) {
    case 'running':
      return 'bg-[hsl(var(--success))]';
    case 'unavailable':
      return 'bg-destructive';
    case 'stopped':
      return 'bg-warning';
    default:
      return 'bg-muted-foreground/40';
  }
}

function connectionLabelKey(connection: PluginMcpPluginStatus['connection']) {
  switch (connection) {
    case 'running':
      return 'mcp.state.running';
    case 'disabled':
      return 'mcp.state.stopped';
    case 'unavailable':
      return 'mcp.state.unavailable';
    default:
      return 'mcp.connection.stopped';
  }
}

function pluginDisplayName(
  plugin: PluginMcpPluginStatus,
  t: (key: string) => string
) {
  if (plugin.pluginId === HOST_MULTI_AGENT_ID) {
    return t('mcp.hostCollaboration');
  }
  return plugin.name;
}

function localServerDisplayName(server: LocalMcpServer): string {
  const lower = server.id.toLowerCase();
  const matched = BUILTIN_CONNECTOR_CATALOG.find(
    (entry) =>
      entry.id.toLowerCase() === lower || entry.serverId.toLowerCase() === lower
  );
  return matched?.name ?? server.id;
}

function localServerSpecSummary(server: LocalMcpServer): string {
  const spec = server.spec ?? {};
  const type = typeof spec.type === 'string' ? spec.type : 'stdio';
  if (type === 'http' || type === 'sse') {
    return typeof spec.url === 'string' ? spec.url : type;
  }
  const command = typeof spec.command === 'string' ? spec.command : '';
  const args = Array.isArray(spec.args)
    ? spec.args.filter((item): item is string => typeof item === 'string')
    : [];
  return [command, ...args].filter(Boolean).join(' ') || type;
}

export function StatusBarMcp() {
  const { t } = useTranslation('statusbar');
  const navigate = useNavigate();
  const transport = useBackendTransport();
  const { updateAndSaveConfig } = useUserSystem();
  const api = useMemo(() => createPluginControlApi(transport), [transport]);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [descriptionOpen, setDescriptionOpen] = useState<string | null>(null);
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

  const localQuery = useQuery({
    queryKey: localMcpServersQueryKey,
    queryFn: async () => {
      try {
        return (await mcpMarketApi.scanLocal()) ?? [];
      } catch {
        return [];
      }
    },
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    meta: { suppressGlobalError: true },
  });

  useEffect(() => {
    const handleLocalChanged = () => {
      void queryClient.invalidateQueries({ queryKey: localMcpServersQueryKey });
    };
    window.addEventListener(LOCAL_MCP_SERVERS_CHANGED_EVENT, handleLocalChanged);
    return () => {
      window.removeEventListener(
        LOCAL_MCP_SERVERS_CHANGED_EVENT,
        handleLocalChanged
      );
    };
  }, [queryClient]);

  const report = query.data ?? EMPTY_REPORT;
  const connectedLocalServers = useMemo(() => {
    const pluginServerIds = new Set(
      report.plugins.flatMap((plugin) =>
        plugin.servers.map((server) => server.id.toLowerCase())
      )
    );
    return (localQuery.data ?? []).filter((server) => {
      const lower = server.id.toLowerCase();
      if (INTERNAL_MCP_SERVER_IDS.has(lower)) return false;
      if (pluginServerIds.has(lower)) return false;
      if (lower.startsWith('vibex-plugin-')) return false;
      return true;
    });
  }, [localQuery.data, report.plugins]);

  const rawState = query.isError ? 'unknown' : report.state;
  const state =
    rawState === 'empty' && connectedLocalServers.length > 0
      ? 'running'
      : rawState;
  const down = state === 'stopped' || state === 'unavailable';
  const TriggerIcon = down ? Unplug : Plug;

  const handleToggle = async (
    plugin: PluginMcpPluginStatus,
    enabled: boolean
  ) => {
    setActionError(null);
    setPending((current) => ({ ...current, [plugin.pluginId]: enabled }));
    try {
      if (plugin.pluginId === HOST_MULTI_AGENT_ID) {
        const saved = await updateAndSaveConfig({
          multi_agent_enabled: enabled,
        });
        if (!saved) {
          throw new Error(t('mcp.saveFailed'));
        }
      } else {
        await api.setEnabled(plugin.pluginId, enabled);
      }
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

  const handleDisconnectLocal = async (server: LocalMcpServer) => {
    const pendingKey = `local:${server.id}`;
    setActionError(null);
    setPending((current) => ({ ...current, [pendingKey]: false }));
    try {
      await mcpMarketApi.uninstall(server.id);
      notifyLocalMcpServersChanged();
      await queryClient.invalidateQueries({ queryKey: localMcpServersQueryKey });
    } catch (error) {
      setActionError(
        t('mcp.actionFailed', { message: getInvokeErrorMessage(error) })
      );
    } finally {
      setPending((current) => {
        const next = { ...current };
        delete next[pendingKey];
        return next;
      });
    }
  };

  const isFetchingAny = query.isFetching || localQuery.isFetching;
  const hasAnyItems =
    report.plugins.length > 0 || connectedLocalServers.length > 0;
  const totalTools = useMemo(
    () =>
      report.plugins.reduce(
        (sum, plugin) =>
          sum +
          plugin.servers.reduce(
            (serverSum, server) => serverSum + server.tools.length,
            0
          ),
        0
      ) +
      connectedLocalServers.reduce(
        (sum, server) => sum + (server.tools?.length ?? 0),
        0
      ),
    [connectedLocalServers, report.plugins]
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          void query.refetch();
          void localQuery.refetch();
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
        data-total-tools={totalTools}
        className="flex w-[22.5rem] max-h-[min(32rem,calc(100vh-3.5rem))] flex-col gap-2.5 overflow-hidden border border-border bg-background p-3 shadow-md backdrop-blur-none"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 text-[0.8125rem] font-semibold tracking-[-0.01em] text-foreground">
            {t('mcp.title')}
          </div>
          <button
            type="button"
            title={t('mcp.refresh')}
            aria-label={t('mcp.refresh')}
            className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
            onClick={() => {
              void query.refetch();
              void localQuery.refetch();
            }}
          >
            <RotateCw
              className={cn('h-3.5 w-3.5', isFetchingAny && 'animate-spin')}
            />
          </button>
        </div>
        {query.isError ? (
          <p className="text-[0.75rem] text-destructive">
            {t('mcp.loadFailed', {
              message: getInvokeErrorMessage(query.error),
            })}
          </p>
        ) : null}

        {query.isError ? null : !hasAnyItems ? (
          <p className="text-[0.75rem] text-muted-foreground">
            {t('mcp.hint.empty')}
          </p>
        ) : (
          <div className="min-h-0 overflow-y-auto overflow-x-hidden rounded-lg border border-border bg-background">
            {report.plugins.map((plugin, index) => {
              const isOpen = expanded === plugin.pluginId;
              const toolCount = plugin.servers.reduce(
                (sum, server) => sum + server.tools.length,
                0
              );
              const checked = pending[plugin.pluginId] ?? plugin.enabled;
              const name = pluginDisplayName(plugin, t);
              const description =
                plugin.pluginId === HOST_MULTI_AGENT_ID
                  ? t('mcp.hostCollaborationDescription')
                  : plugin.description;
              return (
                <div
                  key={plugin.pluginId}
                  className={cn(index > 0 && 'border-t border-border')}
                >
                  <div className="flex items-center gap-2 px-2 py-1.5">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-label={name}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => {
                        setExpanded((current) =>
                          current === plugin.pluginId ? null : plugin.pluginId
                        );
                        setDescriptionOpen((current) =>
                          current === plugin.pluginId ? null : current
                        );
                      }}
                    >
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Puzzle className="size-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[0.75rem] font-medium text-foreground">
                          {name}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span>
                            {t('mcp.mcpCount', { count: plugin.mcpCount })}
                          </span>
                          <span
                            className="inline-flex items-center gap-1"
                            data-testid={`mcp-plugin-status-${plugin.pluginId}`}
                          >
                            <span
                              aria-hidden="true"
                              className={cn(
                                'size-1.5 rounded-full',
                                connectionDot(plugin.connection)
                              )}
                            />
                            {t(connectionLabelKey(plugin.connection))}
                          </span>
                        </span>
                      </span>
                      <ChevronRight
                        className={cn(
                          'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                          isOpen && 'rotate-90'
                        )}
                      />
                    </button>
                    <Switch
                      checked={checked}
                      disabled={
                        !plugin.enableSupported || plugin.pluginId in pending
                      }
                      aria-label={name}
                      onCheckedChange={(next) => {
                        void handleToggle(plugin, next);
                      }}
                    />
                  </div>
                  {isOpen ? (
                    <div className="space-y-1.5 border-t border-border bg-background px-2 py-1.5">
                      {description ? (
                        <div>
                          <button
                            type="button"
                            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                            aria-expanded={descriptionOpen === plugin.pluginId}
                            onClick={() =>
                              setDescriptionOpen((current) =>
                                current === plugin.pluginId
                                  ? null
                                  : plugin.pluginId
                              )
                            }
                          >
                            {t('mcp.viewDescription')}
                          </button>
                          {descriptionOpen === plugin.pluginId ? (
                            <div className="mt-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs leading-4 text-muted-foreground">
                              {description}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      {toolCount === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {t('mcp.noTools')}
                        </p>
                      ) : (
                        <div
                          data-testid="mcp-plugin-tools"
                          className="max-h-64 space-y-1.5 overflow-y-auto overscroll-contain"
                        >
                          {plugin.servers.flatMap((server) =>
                            server.tools.map((tool) => (
                              <div
                                key={`${server.id}:${tool.name}`}
                                className="flex items-center gap-2 px-1 py-1"
                              >
                                <div className="min-w-0 flex-1 truncate text-[0.75rem] text-foreground">
                                  {t(`mcp.tools.${tool.name}`, {
                                    defaultValue: tool.name,
                                  })}
                                </div>
                                <span className="max-w-[9.5rem] shrink-0 truncate rounded-full border border-border bg-background px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                                  {tool.name}
                                </span>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {connectedLocalServers.map((server, index) => {
              const itemKey = `local:${server.id}`;
              const isOpen = expanded === itemKey;
              const name = localServerDisplayName(server);
              const checked = pending[itemKey] ?? true;
              const summary = localServerSpecSummary(server);
              const tools = server.tools ?? [];
              const hasTopBorder = report.plugins.length > 0 || index > 0;
              return (
                <div
                  key={itemKey}
                  className={cn(hasTopBorder && 'border-t border-border')}
                >
                  <div className="flex items-center gap-2 px-2 py-1.5">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-label={name}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => {
                        setExpanded((current) =>
                          current === itemKey ? null : itemKey
                        );
                      }}
                    >
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Plug className="size-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[0.75rem] font-medium text-foreground">
                          {name}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span>{t('mcp.mcpCount', { count: 1 })}</span>
                          {tools.length > 0 ? (
                            <span>
                              {t('mcp.toolCount', { count: tools.length })}
                            </span>
                          ) : null}
                          <span
                            className="inline-flex items-center gap-1"
                            data-testid={`mcp-local-status-${server.id}`}
                          >
                            <span
                              aria-hidden="true"
                              className="size-1.5 rounded-full bg-[hsl(var(--success))]"
                            />
                            {t('mcp.state.running')}
                          </span>
                        </span>
                      </span>
                      <ChevronRight
                        className={cn(
                          'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                          isOpen && 'rotate-90'
                        )}
                      />
                    </button>
                    <Switch
                      checked={checked}
                      disabled={itemKey in pending}
                      aria-label={name}
                      onCheckedChange={(next) => {
                        if (!next) {
                          void handleDisconnectLocal(server);
                        }
                      }}
                    />
                  </div>
                  {isOpen ? (
                    <div className="space-y-1.5 border-t border-border bg-background px-2 py-1.5">
                      {tools.length > 0 ? (
                        <div
                          data-testid="mcp-plugin-tools"
                          className="max-h-64 space-y-1.5 overflow-y-auto overscroll-contain"
                        >
                          {tools.map((toolName) => (
                            <div
                              key={`${server.id}:${toolName}`}
                              className="flex items-center gap-2 px-1 py-1"
                            >
                              <div className="min-w-0 flex-1 truncate text-[0.75rem] text-foreground">
                                {t(`mcp.tools.${toolName}`, {
                                  defaultValue: toolName,
                                })}
                              </div>
                              <span className="max-w-[9.5rem] shrink-0 truncate rounded-full border border-border bg-background px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                                {toolName}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="rounded-md border border-border bg-muted/30 px-2 py-1 font-mono text-[11px] break-all text-muted-foreground">
                          {summary}
                        </div>
                      )}
                      <button
                        type="button"
                        className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        onClick={() => {
                          setOpen(false);
                          openSettingsSurface(navigate, '/settings/mcp');
                        }}
                      >
                        {t('mcp.manageConnector', {
                          defaultValue: '管理连接器配置',
                        })}
                      </button>
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
            className="mt-3 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-xl bg-primary text-[0.75rem] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
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
          className="mt-3 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-xl border border-border bg-[var(--surface-control)] text-[0.75rem] font-medium text-foreground transition-colors hover:bg-accent/70"
          onClick={() => {
            setOpen(false);
            openSettingsSurface(navigate, '/plugins');
          }}
        >
          <Settings2 className="h-3.5 w-3.5" />
          {t('mcp.openPlugins')}
        </button>
      </PopoverContent>
    </Popover>
  );
}
