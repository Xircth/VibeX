/**
 * MCP Settings — Connectors (Local MCP management + Connector Marketplace).
 *
 * Top header bar:
 *  - Left: "连接器" (Connectors) title
 *  - Right: SegmentedControl switching between "本地 MCP" and "MCP 市场"
 *
 * Views:
 *  - 本地 MCP: left-right split layout (installed servers list + editor/draft)
 *  - MCP 市场: full-width ConnectorMarketplace component
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  Store,
  Trash2,
} from 'lucide-react';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  type ManagedAgentOption,
  useManagedAgentOptions,
} from '@/features/agent-management';
import { AgentTypeIcon } from '@/components/agents/AgentTypeIcon';
import { ConnectorMarketplace } from '@/components/connectors/ConnectorMarketplace';
import { notifyLocalMcpServersChanged } from '@/components/layout/StatusBarMcp';
import type { JsonValue } from 'shared/types';
import {
  mcpMarketApi,
  type LocalMcpServer,
  type McpAppType,
} from '@/lib/api';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import { cn } from '@/lib/utils';
import { pluginControlApi, type PluginControlItem } from '@/lib/api/plugins';
import { Skeleton } from '@/components/ui/skeleton';

/* ── constants & helpers ─────────────────────────────────── */

type LeftTab = 'local' | 'market';

type Selection =
  | { kind: 'local'; id: string }
  | { kind: 'draft' }
  | null;

type AppsDraft = Record<McpAppType, boolean>;

function emptyApps(options: ManagedAgentOption[], value = false): AppsDraft {
  return Object.fromEntries(options.map((option) => [option.value, value]));
}

function appsToDraft(
  options: ManagedAgentOption[],
  apps: McpAppType[]
): AppsDraft {
  const draft = emptyApps(options, false);
  for (const app of apps) draft[app] = true;
  return draft;
}

function selectedApps(
  options: ManagedAgentOption[],
  draft: AppsDraft
): McpAppType[] {
  return options.filter((item) => draft[item.value]).map((item) => item.value);
}

const DRAFT_SPEC_TEMPLATE = `{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "your-mcp-server"]
}`;

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSpecObject(
  text: string,
  invalidMessage: string
): Record<string, JsonValue> {
  const parsed = JSON.parse(text) as unknown;
  if (!isJsonObject(parsed)) {
    throw new Error(invalidMessage);
  }
  return parsed;
}

function specSummary(spec: Record<string, JsonValue>): string {
  const type = typeof spec.type === 'string' ? spec.type : 'stdio';
  if (type === 'http' || type === 'sse') {
    return typeof spec.url === 'string' ? spec.url : type;
  }
  return typeof spec.command === 'string' ? spec.command : type;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ── reusable: target (全局 + agents) selector ───────────── */

function TargetSelector({
  global,
  apps,
  options,
  onGlobalChange,
  onToggleApp,
}: {
  global: boolean;
  apps: AppsDraft;
  options: ManagedAgentOption[];
  onGlobalChange: (next: boolean) => void;
  onToggleApp: (app: McpAppType, next: boolean) => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  return (
    <div className="space-y-1.5">
      <label className="flex w-full cursor-pointer items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-2 text-xs">
        <input
          type="checkbox"
          checked={global}
          onChange={(event) => onGlobalChange(event.target.checked)}
        />
        <Globe className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium">{t('mcp.global')}</span>
        <span className="text-muted-foreground">{t('mcp.globalHint')}</span>
      </label>
      <div
        className={cn(
          'grid grid-cols-1 gap-1 sm:grid-cols-2',
          global && 'pointer-events-none opacity-50'
        )}
      >
        {options.map((app) => (
          <label
            key={app.value}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs"
          >
            <input
              type="checkbox"
              aria-label={app.label}
              checked={global || Boolean(apps[app.value])}
              disabled={global}
              onChange={(event) => onToggleApp(app.value, event.target.checked)}
            />
            <AgentTypeIcon agentType={app.value} className="h-4 w-4" />
            <span>{app.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/* ── main component ──────────────────────────────────────── */

export function McpSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const [searchParams, setSearchParams] = useSearchParams();
  const pluginId = searchParams.get('plugin');
  const agentOptions = useManagedAgentOptions('native_mcp');
  const [leftTab, setLeftTab] = useState<LeftTab>(
    pluginId ? 'local' : 'market'
  );
  const [selection, setSelection] = useState<Selection>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, triggerSuccess] = useTemporaryFlag(2500);
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [pluginContext, setPluginContext] = useState<PluginControlItem | null>(
    null
  );
  const [pluginMcpGlobal, setPluginMcpGlobal] = useState(false);
  const [pluginMcpApps, setPluginMcpApps] = useState<AppsDraft>({});
  const [pluginMcpLoading, setPluginMcpLoading] = useState(false);

  useEffect(() => {
    if (!pluginId) {
      setPluginContext(null);
      return;
    }
    setLeftTab('local');
    let active = true;
    setPluginMcpLoading(true);
    void pluginControlApi
      .catalog()
      .then((catalog) => {
        if (!active) return;
        const plugin = catalog.plugins.find((item) => item.id === pluginId);
        if (!plugin) {
          throw new Error(t('mcp.pluginNotFound', { id: pluginId }));
        }
        setPluginContext(plugin);
        setPluginMcpApps(emptyApps(agentOptions));
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setPluginMcpLoading(false);
      });
    return () => {
      active = false;
    };
  }, [agentOptions, pluginId, t]);

  // Local servers
  const [installedServers, setInstalledServers] = useState<LocalMcpServer[]>(
    []
  );
  const [localLoading, setLocalLoading] = useState(false);
  const [localFilter, setLocalFilter] = useState('');

  // Local editor draft (selected local server)
  const [localSpecText, setLocalSpecText] = useState('{}');
  const [localGlobal, setLocalGlobal] = useState(false);
  const [localApps, setLocalApps] = useState<AppsDraft>({});

  // New-server draft
  const [draftId, setDraftId] = useState('');
  const [draftSpecText, setDraftSpecText] = useState(DRAFT_SPEC_TEMPLATE);
  const [draftGlobal, setDraftGlobal] = useState(true);
  const [draftApps, setDraftApps] = useState<AppsDraft>({});

  /* ── data loaders ─────────────────────────────────────── */

  const refreshLocal = useCallback(async (): Promise<LocalMcpServer[]> => {
    setLocalLoading(true);
    try {
      const list = await mcpMarketApi.scanLocal();
      setInstalledServers(list);
      return list;
    } catch (err) {
      setError(errorMessage(err));
      return [];
    } finally {
      setLocalLoading(false);
    }
  }, []);

  const savePluginMcpTargets = useCallback(async () => {
    if (!pluginContext) return;
    setRunningAction('plugin-mcp');
    setError(null);
    try {
      const result = await pluginControlApi.configureMcp(
        pluginContext.id,
        pluginMcpGlobal,
        selectedApps(agentOptions, pluginMcpApps)
      );
      if (result.mcpErrors.length) {
        throw new Error(result.mcpErrors.join('\n'));
      }
      triggerSuccess();
      const next = new URLSearchParams(searchParams);
      next.delete('plugin');
      setSearchParams(next, { replace: true });
      setPluginContext(null);
      await refreshLocal();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRunningAction(null);
    }
  }, [
    agentOptions,
    pluginContext,
    pluginMcpApps,
    pluginMcpGlobal,
    refreshLocal,
    searchParams,
    setSearchParams,
    triggerSuccess,
  ]);

  useEffect(() => {
    void refreshLocal();
  }, [refreshLocal]);

  const filteredLocal = useMemo(() => {
    const query = localFilter.trim().toLowerCase();
    if (!query) return installedServers;
    return installedServers.filter((server) => {
      if (server.id.toLowerCase().includes(query)) return true;
      return specSummary(server.spec).toLowerCase().includes(query);
    });
  }, [installedServers, localFilter]);

  const selectedLocal = useMemo(() => {
    if (selection?.kind !== 'local') return null;
    return installedServers.find((s) => s.id === selection.id) ?? null;
  }, [selection, installedServers]);

  // Sync the local editor whenever the selected local server changes.
  useEffect(() => {
    if (!selectedLocal) return;
    setLocalSpecText(JSON.stringify(selectedLocal.spec, null, 2));
    setLocalGlobal(selectedLocal.global);
    setLocalApps(appsToDraft(agentOptions, selectedLocal.apps));
    setError(null);
  }, [agentOptions, selectedLocal]);

  /* ── local actions ────────────────────────────────────── */

  const startDraft = useCallback(() => {
    setSelection({ kind: 'draft' });
    setDraftId('');
    setDraftSpecText(DRAFT_SPEC_TEMPLATE);
    setDraftGlobal(true);
    setDraftApps(emptyApps(agentOptions, true));
    setError(null);
  }, [agentOptions]);

  const saveLocal = useCallback(async () => {
    if (!selectedLocal) return;
    let spec: Record<string, JsonValue>;
    try {
      spec = parseSpecObject(localSpecText, t('mcp.specMustBeObject'));
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    const action = `save:${selectedLocal.id}`;
    setRunningAction(action);
    setError(null);
    try {
      const list = await mcpMarketApi.upsertLocal({
        serverId: selectedLocal.id,
        spec,
        global: localGlobal,
        apps: localGlobal ? [] : selectedApps(agentOptions, localApps),
      });
      setInstalledServers(list);
      notifyLocalMcpServersChanged();
      triggerSuccess();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunningAction(null);
    }
  }, [
    selectedLocal,
    localSpecText,
    localGlobal,
    localApps,
    agentOptions,
    triggerSuccess,
    t,
  ]);

  const createDraft = useCallback(async () => {
    const id = draftId.trim();
    if (!id) {
      setError(t('mcp.enterServerId'));
      return;
    }
    let spec: Record<string, JsonValue>;
    try {
      spec = parseSpecObject(draftSpecText, t('mcp.specMustBeObject'));
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    if (!draftGlobal && selectedApps(agentOptions, draftApps).length === 0) {
      setError(t('mcp.selectTargetOrGlobal'));
      return;
    }
    setRunningAction('create');
    setError(null);
    try {
      const list = await mcpMarketApi.upsertLocal({
        serverId: id,
        spec,
        global: draftGlobal,
        apps: draftGlobal ? [] : selectedApps(agentOptions, draftApps),
      });
      setInstalledServers(list);
      notifyLocalMcpServersChanged();
      triggerSuccess();
      setSelection({ kind: 'local', id });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunningAction(null);
    }
  }, [
    draftId,
    draftSpecText,
    draftGlobal,
    draftApps,
    agentOptions,
    triggerSuccess,
    t,
  ]);

  const uninstall = useCallback(
    async (serverId: string) => {
      setRunningAction(`uninstall:${serverId}`);
      setError(null);
      try {
        const list = await mcpMarketApi.uninstall(serverId);
        setInstalledServers(list);
        notifyLocalMcpServersChanged();
        if (selection?.kind === 'local' && selection.id === serverId) {
          setSelection(null);
        }
        triggerSuccess();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setRunningAction(null);
      }
    },
    [selection, triggerSuccess]
  );

  /* ── render ───────────────────────────────────────────── */

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Top Header: left "连接器" title, right SegmentedControl */}
      <div className="chat-channel-heading shrink-0">
        <div className="chat-channel-heading__copy">
          <h2>
            <Server aria-hidden="true" />
            <span>{t('mcp.connectorsTitle', '连接器')}</span>
          </h2>
        </div>
        <div className="chat-channel-heading__actions">
          <SegmentedControl
            value={leftTab}
            onChange={(value) => setLeftTab(value as LeftTab)}
            label={t('mcp.connectorsTitle', '连接器')}
            size="sm"
            layout="hug"
            className="dsh-plugin-mode-segmented"
          >
            <SegmentedControlItem
              value="local"
              label={t('mcp.localTab')}
              icon={<Server aria-hidden="true" />}
            />
            <SegmentedControlItem
              value="market"
              label={t('mcp.marketTab')}
              icon={<Store aria-hidden="true" />}
            />
          </SegmentedControl>
        </div>
      </div>

      {leftTab === 'market' ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <ConnectorMarketplace
            mode="page"
            installedServers={installedServers}
            onInstalledServersChange={setInstalledServers}
            onSelectLocalServer={(serverId) => {
              setLeftTab('local');
              setSelection({ kind: 'local', id: serverId });
            }}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-4">
          {/* Left panel */}
          <aside className="flex w-[340px] shrink-0 flex-col gap-3">
            <LocalListPanel
              servers={filteredLocal}
              loading={localLoading}
              filter={localFilter}
              onFilterChange={setLocalFilter}
              activeId={selection?.kind === 'local' ? selection.id : null}
              onSelect={(id) => setSelection({ kind: 'local', id })}
              onRefresh={() => void refreshLocal()}
              onNew={startDraft}
            />
          </aside>

          {/* Right panel */}
          <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
            {pluginId ? (
              <div className="shrink-0 space-y-3 border-b bg-muted/20 px-4 py-3">
                <div>
                  <strong className="text-sm">
                    {t('mcp.pluginTargetsTitle', {
                      name: pluginContext?.name ?? pluginId,
                    })}
                  </strong>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('mcp.pluginTargetsDescription')}
                  </p>
                </div>
                {pluginMcpLoading ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('mcp.pluginTargetsLoading')}
                  </div>
                ) : pluginContext ? (
                  <>
                    <TargetSelector
                      global={pluginMcpGlobal}
                      apps={pluginMcpApps}
                      options={agentOptions}
                      onGlobalChange={setPluginMcpGlobal}
                      onToggleApp={(app, next) =>
                        setPluginMcpApps((current) => ({
                          ...current,
                          [app]: next,
                        }))
                      }
                    />
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        disabled={runningAction === 'plugin-mcp'}
                        onClick={() => void savePluginMcpTargets()}
                      >
                        {runningAction === 'plugin-mcp' ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : null}
                        {t('mcp.savePluginTargets')}
                      </Button>
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}
            {error ? (
              <div className="shrink-0 px-4 pt-4">
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              </div>
            ) : null}
            {success ? (
              <div className="shrink-0 px-4 pt-4">
                <Alert variant="success">
                  <CheckCircle2 className="h-4 w-4" />
                  <AlertDescription className="font-medium">
                    {t('mcp.operationSuccess')}
                  </AlertDescription>
                </Alert>
              </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {selection?.kind === 'draft' ? (
                <DraftEditor
                  id={draftId}
                  onIdChange={setDraftId}
                  specText={draftSpecText}
                  onSpecChange={setDraftSpecText}
                  global={draftGlobal}
                  apps={draftApps}
                  options={agentOptions}
                  onGlobalChange={setDraftGlobal}
                  onToggleApp={(app, next) =>
                    setDraftApps((prev) => ({ ...prev, [app]: next }))
                  }
                  busy={runningAction === 'create'}
                  onCancel={() => setSelection(null)}
                  onCreate={() => void createDraft()}
                />
              ) : selection?.kind === 'local' && selectedLocal ? (
                <LocalEditor
                  server={selectedLocal}
                  specText={localSpecText}
                  onSpecChange={setLocalSpecText}
                  global={localGlobal}
                  apps={localApps}
                  options={agentOptions}
                  onGlobalChange={setLocalGlobal}
                  onToggleApp={(app, next) =>
                    setLocalApps((prev) => ({ ...prev, [app]: next }))
                  }
                  saving={runningAction === `save:${selectedLocal.id}`}
                  removing={runningAction === `uninstall:${selectedLocal.id}`}
                  onSave={() => void saveLocal()}
                  onUninstall={() => void uninstall(selectedLocal.id)}
                />
              ) : (
                <Placeholder />
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

/* ── left: local list ────────────────────────────────────── */

function LocalListPanel({
  servers,
  loading,
  filter,
  onFilterChange,
  activeId,
  onSelect,
  onRefresh,
  onNew,
}: {
  servers: LocalMcpServer[];
  loading: boolean;
  filter: string;
  onFilterChange: (value: string) => void;
  activeId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  onNew: () => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-xl border bg-card">
      <div className="p-2.5">
        <div className="settings-list-search relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            placeholder={t('mcp.searchLocalPlaceholder')}
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {loading ? (
          <div
            role="status"
            aria-busy="true"
            aria-label={t('mcp.loading')}
            className="flex flex-col gap-1.5 p-1"
          >
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton
                key={index}
                className="h-11 w-full rounded-[var(--radius)]"
              />
            ))}
          </div>
        ) : servers.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Server className="h-6 w-6 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              {filter ? t('mcp.noMatch') : t('mcp.noLocalServers')}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {servers.map((server) => {
              const active = server.id === activeId;
              return (
                <button
                  key={server.id}
                  type="button"
                  aria-current={active ? 'true' : undefined}
                  data-active={active ? 'true' : undefined}
                  onClick={() => onSelect(server.id)}
                  className={cn(
                    '!my-0 !h-auto !min-h-0 relative block w-full cursor-pointer rounded-lg border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-0',
                    active
                      ? 'border-primary/60 bg-primary/5 pr-7'
                      : 'border-transparent hover:bg-foreground/[0.05]'
                  )}
                >
                  {active ? (
                    <Check
                      aria-hidden="true"
                      className="absolute right-2 top-2.5 h-3.5 w-3.5 text-foreground"
                    />
                  ) : null}
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                      {server.id}
                    </span>
                    {server.global ? (
                      <Badge
                        variant="secondary"
                        className="h-5 shrink-0 gap-1 px-1.5 text-[10px]"
                      >
                        <Globe className="h-2.5 w-2.5" />
                        {t('mcp.global')}
                      </Badge>
                    ) : (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {t('mcp.agentCount', { count: server.apps.length })}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 truncate text-[10px] leading-4 text-muted-foreground">
                    {specSummary(server.spec)}
                  </p>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t p-2">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          title={t('mcp.refresh')}
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" className="h-7 flex-1 text-xs" onClick={onNew}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          {t('mcp.newMcp')}
        </Button>
      </div>
    </div>
  );
}

/* ── right: local editor ─────────────────────────────────── */

function LocalEditor({
  server,
  specText,
  onSpecChange,
  global,
  apps,
  options,
  onGlobalChange,
  onToggleApp,
  saving,
  removing,
  onSave,
  onUninstall,
}: {
  server: LocalMcpServer;
  specText: string;
  onSpecChange: (text: string) => void;
  global: boolean;
  apps: AppsDraft;
  options: ManagedAgentOption[];
  onGlobalChange: (next: boolean) => void;
  onToggleApp: (app: McpAppType, next: boolean) => void;
  saving: boolean;
  removing: boolean;
  onSave: () => void;
  onUninstall: () => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-all text-base font-semibold">{server.id}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('mcp.localEditorDesc')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="destructive"
            disabled={removing}
            onClick={onUninstall}
          >
            {removing ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            )}
            {t('mcp.uninstall')}
          </Button>
          <Button size="sm" disabled={saving} onClick={onSave}>
            {saving ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="mr-1.5 h-3.5 w-3.5" />
            )}
            {t('common:save')}
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          {t('mcp.targetApps')}
        </Label>
        <TargetSelector
          global={global}
          apps={apps}
          options={options}
          onGlobalChange={onGlobalChange}
          onToggleApp={onToggleApp}
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          {t('mcp.configJson')}
        </Label>
        <Textarea
          value={specText}
          spellCheck={false}
          className="min-h-60 font-mono text-xs"
          onChange={(event) => onSpecChange(event.target.value)}
        />
      </div>
    </div>
  );
}

/* ── right: new-server draft ─────────────────────────────── */

function DraftEditor({
  id,
  onIdChange,
  specText,
  onSpecChange,
  global,
  apps,
  options,
  onGlobalChange,
  onToggleApp,
  busy,
  onCancel,
  onCreate,
}: {
  id: string;
  onIdChange: (value: string) => void;
  specText: string;
  onSpecChange: (text: string) => void;
  global: boolean;
  apps: AppsDraft;
  options: ManagedAgentOption[];
  onGlobalChange: (next: boolean) => void;
  onToggleApp: (app: McpAppType, next: boolean) => void;
  busy: boolean;
  onCancel: () => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">{t('mcp.newMcpServer')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t('mcp.draftDesc')}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          {t('mcp.serverId')}
        </Label>
        <TextInput
          label={t('mcp.serverId')}
          isLabelHidden
          value={id}
          placeholder={t('mcp.serverIdPlaceholder')}
          onChange={onIdChange}
          width="100%"
          size="sm"
          className="[&_input]:text-xs"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          {t('mcp.targetApps')}
        </Label>
        <TargetSelector
          global={global}
          apps={apps}
          options={options}
          onGlobalChange={onGlobalChange}
          onToggleApp={onToggleApp}
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          {t('mcp.configJson')}
        </Label>
        <Textarea
          value={specText}
          spellCheck={false}
          className="min-h-60 font-mono text-xs"
          onChange={(event) => onSpecChange(event.target.value)}
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={onCancel}
        >
          {t('common:cancel')}
        </Button>
        <Button type="button" disabled={busy} onClick={onCreate}>
          {busy ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : null}
          {t('common:create')}
        </Button>
      </div>
    </div>
  );
}

/* ── right: placeholder ──────────────────────────────────── */

function Placeholder() {
  const { t } = useTranslation(['settings', 'common']);
  return (
    <div className="flex h-full flex-col items-center justify-center text-center text-muted-foreground">
      <Server className="h-10 w-10 opacity-30" />
      <p className="mt-3 text-sm">{t('mcp.placeholderLocal')}</p>
    </div>
  );
}
