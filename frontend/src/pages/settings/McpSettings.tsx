/**
 * MCP Settings — local management + Smithery marketplace.
 *
 * Left panel switches between two views:
 *  - 本地 MCP: servers already installed across the global registry
 *    (~/.vibex/mcp.json) and each agent's native config; editable + removable.
 *  - MCP 市场: search Smithery, inspect a server, and install it.
 *
 * Install targets a set of agents OR "全局" (global). Global writes the
 * server to ~/.vibex/mcp.json and mirrors it into every agent's MCP config.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  CheckCircle2,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  ShieldCheck,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AgentTypeIcon } from '@/components/agents/AgentTypeIcon';
import type { AgentType } from '@/features/agents/types';
import type { JsonValue } from 'shared/types';
import {
  mcpMarketApi,
  type LocalMcpServer,
  type McpAppType,
  type McpMarketplaceInstallOption,
  type McpMarketplaceItem,
  type McpMarketplaceServerDetail,
} from '@/lib/api';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import { cn } from '@/lib/utils';

/* ── constants & helpers ─────────────────────────────────── */

type LeftTab = 'local' | 'market';

type Selection =
  | { kind: 'local'; id: string }
  | { kind: 'market'; id: string }
  | { kind: 'draft' }
  | null;

const APP_OPTIONS: { value: McpAppType; label: string }[] = [
  { value: 'claude_code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex CLI' },
  { value: 'gemini', label: 'Gemini CLI' },
  { value: 'openclaw', label: 'OpenClaw' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'cline', label: 'Cline' },
  { value: 'hermes', label: 'Hermes Agent' },
];

type AppsDraft = Record<McpAppType, boolean>;

function emptyApps(value = false): AppsDraft {
  return {
    claude_code: value,
    codex: value,
    gemini: value,
    openclaw: value,
    opencode: value,
    cline: value,
    hermes: value,
  };
}

function appsToDraft(apps: McpAppType[]): AppsDraft {
  const draft = emptyApps(false);
  for (const app of apps) draft[app] = true;
  return draft;
}

function selectedApps(draft: AppsDraft): McpAppType[] {
  return APP_OPTIONS.filter((item) => draft[item.value]).map(
    (item) => item.value
  );
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

function protocolLabel(protocol: string): string {
  const lower = protocol.toLowerCase();
  if (lower === 'sse') return 'SSE';
  if (lower === 'stdio') return 'stdio';
  if (lower === 'http' || lower.includes('streamable')) return 'HTTP';
  return protocol;
}

function buildParameterValues(
  option: McpMarketplaceInstallOption | null,
  draft: Record<string, string>
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  if (!option) return out;
  for (const field of option.parameters) {
    const raw = (draft[field.key] ?? '').trim();
    if (!raw) continue;
    if (field.kind === 'boolean') {
      out[field.key] = raw === 'true';
    } else if (field.kind === 'number' || field.kind === 'integer') {
      const num = Number(raw);
      out[field.key] = Number.isFinite(num) ? num : raw;
    } else if (field.kind === 'json') {
      try {
        out[field.key] = JSON.parse(raw) as JsonValue;
      } catch {
        out[field.key] = raw;
      }
    } else {
      out[field.key] = raw;
    }
  }
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ── reusable: target (全局 + agents) selector ───────────── */

function TargetSelector({
  global,
  apps,
  onGlobalChange,
  onToggleApp,
}: {
  global: boolean;
  apps: AppsDraft;
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
        {APP_OPTIONS.map((app) => (
          <label
            key={app.value}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs"
          >
            <input
              type="checkbox"
              checked={global || apps[app.value]}
              disabled={global}
              onChange={(event) => onToggleApp(app.value, event.target.checked)}
            />
            <AgentTypeIcon
              agentType={app.value as AgentType}
              className="h-4 w-4"
            />
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
  const [leftTab, setLeftTab] = useState<LeftTab>('local');
  const [selection, setSelection] = useState<Selection>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, triggerSuccess] = useTemporaryFlag(2500);
  const [runningAction, setRunningAction] = useState<string | null>(null);

  // Local servers
  const [installedServers, setInstalledServers] = useState<LocalMcpServer[]>(
    []
  );
  const [localLoading, setLocalLoading] = useState(false);
  const [localFilter, setLocalFilter] = useState('');

  // Local editor draft (selected local server)
  const [localSpecText, setLocalSpecText] = useState('{}');
  const [localGlobal, setLocalGlobal] = useState(false);
  const [localApps, setLocalApps] = useState<AppsDraft>(emptyApps());

  // New-server draft
  const [draftId, setDraftId] = useState('');
  const [draftSpecText, setDraftSpecText] = useState(DRAFT_SPEC_TEMPLATE);
  const [draftGlobal, setDraftGlobal] = useState(true);
  const [draftApps, setDraftApps] = useState<AppsDraft>(emptyApps(true));

  // Marketplace
  const [selectedProvider, setSelectedProvider] = useState('');
  const [marketQuery, setMarketQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<McpMarketplaceItem[]>([]);

  const [marketDetail, setMarketDetail] =
    useState<McpMarketplaceServerDetail | null>(null);
  const [marketDetailLoading, setMarketDetailLoading] = useState(false);
  const [marketDetailError, setMarketDetailError] = useState<string | null>(
    null
  );
  const [selectedOptionId, setSelectedOptionId] = useState('');
  const [marketSpecText, setMarketSpecText] = useState('{}');
  const [marketSpecDirty, setMarketSpecDirty] = useState(false);

  // Install dialog
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [installGlobal, setInstallGlobal] = useState(true);
  const [installApps, setInstallApps] = useState<AppsDraft>(emptyApps(true));
  const [installParamDraft, setInstallParamDraft] = useState<
    Record<string, string>
  >({});

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

  useEffect(() => {
    void refreshLocal();
    void mcpMarketApi
      .listMarketplaces()
      .then((list) => {
        setSelectedProvider((current) => current || list[0]?.id || '');
      })
      .catch((err) => setError(errorMessage(err)));
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
    setLocalApps(appsToDraft(selectedLocal.apps));
    setError(null);
  }, [selectedLocal]);

  const selectedOption = useMemo<McpMarketplaceInstallOption | null>(() => {
    if (!marketDetail) return null;
    return (
      marketDetail.install_options.find((o) => o.id === selectedOptionId) ??
      marketDetail.install_options[0] ??
      null
    );
  }, [marketDetail, selectedOptionId]);

  /* ── marketplace actions ──────────────────────────────── */

  const executeSearch = useCallback(async () => {
    if (!selectedProvider) return;
    setSearching(true);
    setError(null);
    try {
      const results = await mcpMarketApi.search({
        providerId: selectedProvider,
        query: marketQuery,
      });
      setSearchResults(results);
    } catch (err) {
      setError(errorMessage(err));
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, [selectedProvider, marketQuery]);

  // Auto-search once when the market tab is first opened with a provider set.
  const autoSearchedRef = useRef(false);
  useEffect(() => {
    if (leftTab !== 'market' || !selectedProvider || autoSearchedRef.current) {
      return;
    }
    autoSearchedRef.current = true;
    void executeSearch();
  }, [leftTab, selectedProvider, executeSearch]);

  const openMarketDetail = useCallback(
    async (serverId: string) => {
      if (!selectedProvider) return;
      setSelection({ kind: 'market', id: serverId });
      setMarketDetail(null);
      setMarketDetailError(null);
      setMarketDetailLoading(true);
      try {
        const detail = await mcpMarketApi.detail({
          providerId: selectedProvider,
          serverId,
        });
        setMarketDetail(detail);
        const optionId =
          detail.default_option_id ?? detail.install_options[0]?.id ?? '';
        setSelectedOptionId(optionId);
        const option =
          detail.install_options.find((o) => o.id === optionId) ??
          detail.install_options[0] ??
          null;
        setMarketSpecText(JSON.stringify(option?.spec ?? detail.spec, null, 2));
        setMarketSpecDirty(false);
      } catch (err) {
        setMarketDetailError(errorMessage(err));
      } finally {
        setMarketDetailLoading(false);
      }
    },
    [selectedProvider]
  );

  const switchInstallOption = useCallback(
    (optionId: string) => {
      setSelectedOptionId(optionId);
      const option = marketDetail?.install_options.find(
        (o) => o.id === optionId
      );
      if (option) {
        setMarketSpecText(JSON.stringify(option.spec, null, 2));
        setMarketSpecDirty(false);
      }
    },
    [marketDetail]
  );

  const openInstallDialog = useCallback(() => {
    if (!selectedOption) return;
    setInstallGlobal(true);
    setInstallApps(emptyApps(true));
    const params: Record<string, string> = {};
    for (const field of selectedOption.parameters) {
      if (field.default_value != null && field.kind !== 'json') {
        params[field.key] = String(field.default_value);
      }
    }
    setInstallParamDraft(params);
    setInstallDialogOpen(true);
  }, [selectedOption]);

  const confirmInstall = useCallback(async () => {
    if (!marketDetail) return;
    const apps = installGlobal ? [] : selectedApps(installApps);
    if (!installGlobal && apps.length === 0) {
      setError(t('mcp.selectTargetOrGlobal'));
      return;
    }

    let specOverride: Record<string, JsonValue> | null = null;
    if (marketSpecDirty) {
      try {
        specOverride = parseSpecObject(
          marketSpecText,
          t('mcp.specMustBeObject')
        );
      } catch (err) {
        setError(errorMessage(err));
        return;
      }
    }

    const action = `install:${marketDetail.server_id}`;
    setRunningAction(action);
    setError(null);
    try {
      const list = await mcpMarketApi.install({
        providerId: marketDetail.provider_id,
        serverId: marketDetail.server_id,
        global: installGlobal,
        apps,
        optionId: selectedOption?.id ?? null,
        parameterValues: specOverride
          ? null
          : buildParameterValues(selectedOption, installParamDraft),
        specOverride,
      });
      setInstalledServers(list);
      setInstallDialogOpen(false);
      triggerSuccess();
      setLeftTab('local');
      setSelection({ kind: 'local', id: marketDetail.server_id });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunningAction(null);
    }
  }, [
    marketDetail,
    installGlobal,
    installApps,
    marketSpecDirty,
    marketSpecText,
    selectedOption,
    installParamDraft,
    triggerSuccess,
    t,
  ]);

  /* ── local actions ────────────────────────────────────── */

  const startDraft = useCallback(() => {
    setSelection({ kind: 'draft' });
    setDraftId('');
    setDraftSpecText(DRAFT_SPEC_TEMPLATE);
    setDraftGlobal(true);
    setDraftApps(emptyApps(true));
    setError(null);
  }, []);

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
        apps: localGlobal ? [] : selectedApps(localApps),
      });
      setInstalledServers(list);
      triggerSuccess();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunningAction(null);
    }
  }, [selectedLocal, localSpecText, localGlobal, localApps, triggerSuccess, t]);

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
    if (!draftGlobal && selectedApps(draftApps).length === 0) {
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
        apps: draftGlobal ? [] : selectedApps(draftApps),
      });
      setInstalledServers(list);
      triggerSuccess();
      setSelection({ kind: 'local', id });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunningAction(null);
    }
  }, [draftId, draftSpecText, draftGlobal, draftApps, triggerSuccess, t]);

  const uninstall = useCallback(
    async (serverId: string) => {
      setRunningAction(`uninstall:${serverId}`);
      setError(null);
      try {
        const list = await mcpMarketApi.uninstall(serverId);
        setInstalledServers(list);
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
    <div className="flex h-full min-h-0 gap-4">
      {/* Left panel */}
      <aside className="flex w-[340px] shrink-0 flex-col gap-3">
        <div className="flex items-center gap-1 rounded-lg border bg-muted-foreground/[0.06] p-0.5">
          {(['local', 'market'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setLeftTab(tab)}
              className={cn(
                'flex-1 rounded-md py-1.5 text-xs font-medium transition-colors',
                leftTab === tab
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {tab === 'local' ? t('mcp.localTab') : t('mcp.marketTab')}
            </button>
          ))}
        </div>

        {leftTab === 'local' ? (
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
        ) : (
          <MarketListPanel
            selectedProvider={selectedProvider}
            query={marketQuery}
            onQueryChange={setMarketQuery}
            searching={searching}
            onSearch={() => void executeSearch()}
            results={searchResults}
            activeId={selection?.kind === 'market' ? selection.id : null}
            onSelect={(id) => void openMarketDetail(id)}
          />
        )}
      </aside>

      {/* Right panel */}
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
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
              onGlobalChange={setLocalGlobal}
              onToggleApp={(app, next) =>
                setLocalApps((prev) => ({ ...prev, [app]: next }))
              }
              saving={runningAction === `save:${selectedLocal.id}`}
              removing={runningAction === `uninstall:${selectedLocal.id}`}
              onSave={() => void saveLocal()}
              onUninstall={() => void uninstall(selectedLocal.id)}
            />
          ) : selection?.kind === 'market' ? (
            <MarketDetailPanel
              loading={marketDetailLoading}
              detailError={marketDetailError}
              detail={marketDetail}
              selectedOption={selectedOption}
              onSwitchOption={switchInstallOption}
              specText={marketSpecText}
              onSpecChange={(text) => {
                setMarketSpecText(text);
                setMarketSpecDirty(true);
              }}
              onInstall={openInstallDialog}
            />
          ) : (
            <Placeholder tab={leftTab} />
          )}
        </div>
      </section>

      {/* Install dialog */}
      <Dialog open={installDialogOpen} onOpenChange={setInstallDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('mcp.confirmInstallTitle')}</DialogTitle>
            <DialogDescription>
              {marketDetail
                ? t('mcp.installDescWithName', { name: marketDetail.name })
                : t('mcp.installDesc')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {t('mcp.protocol')}
              </Label>
              <Select
                value={selectedOptionId}
                onValueChange={switchInstallOption}
              >
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue placeholder={t('mcp.selectProtocol')} />
                </SelectTrigger>
                <SelectContent>
                  {(marketDetail?.install_options ?? []).map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {protocolLabel(option.protocol)} · {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedOption && selectedOption.parameters.length > 0 ? (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  {t('mcp.parameters')}
                </Label>
                <div className="max-h-52 space-y-2 overflow-y-auto pr-1">
                  {selectedOption.parameters.map((field) => (
                    <div key={field.key} className="space-y-1">
                      <div className="text-xs font-medium">
                        {field.label}
                        {field.required ? (
                          <span className="ml-1 text-destructive">*</span>
                        ) : null}
                        {field.location ? (
                          <span className="ml-2 text-muted-foreground">
                            {field.location}
                          </span>
                        ) : null}
                      </div>
                      {field.kind === 'boolean' ? (
                        <Select
                          value={installParamDraft[field.key] ?? ''}
                          onValueChange={(value) =>
                            setInstallParamDraft((prev) => ({
                              ...prev,
                              [field.key]: value,
                            }))
                          }
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder="true / false" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="true">true</SelectItem>
                            <SelectItem value="false">false</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : field.enum_values.length > 0 ? (
                        <Select
                          value={installParamDraft[field.key] ?? ''}
                          onValueChange={(value) =>
                            setInstallParamDraft((prev) => ({
                              ...prev,
                              [field.key]: value,
                            }))
                          }
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder={t('mcp.selectValue')} />
                          </SelectTrigger>
                          <SelectContent>
                            {field.enum_values.map((value) => (
                              <SelectItem key={value} value={value}>
                                {value}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          type={field.secret ? 'password' : 'text'}
                          value={installParamDraft[field.key] ?? ''}
                          className="h-8 text-xs"
                          placeholder={field.placeholder ?? ''}
                          onChange={(event) =>
                            setInstallParamDraft((prev) => ({
                              ...prev,
                              [field.key]: event.target.value,
                            }))
                          }
                        />
                      )}
                      {field.description ? (
                        <p className="text-[11px] leading-5 text-muted-foreground">
                          {field.description}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {t('mcp.targetApps')}
              </Label>
              <TargetSelector
                global={installGlobal}
                apps={installApps}
                onGlobalChange={setInstallGlobal}
                onToggleApp={(app, next) =>
                  setInstallApps((prev) => ({ ...prev, [app]: next }))
                }
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setInstallDialogOpen(false)}
              disabled={!!runningAction?.startsWith('install:')}
            >
              {t('common:cancel')}
            </Button>
            <Button
              type="submit"
              onClick={() => void confirmInstall()}
              disabled={!!runningAction?.startsWith('install:')}
            >
              {runningAction?.startsWith('install:') ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : null}
              {t('mcp.confirmInstallButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t('mcp.searchLocalPlaceholder')}
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-1.5">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('mcp.loading')}
          </div>
        ) : servers.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Server className="h-6 w-6 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              {filter ? t('mcp.noMatch') : t('mcp.noLocalServers')}
            </p>
          </div>
        ) : (
          servers.map((server) => {
            const active = server.id === activeId;
            return (
              <div
                key={server.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(server.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(server.id);
                  }
                }}
                className={cn(
                  'w-full cursor-pointer rounded-lg border px-2.5 py-2 text-left transition-colors',
                  active
                    ? 'border-primary/60 bg-primary/5'
                    : 'border-transparent hover:bg-foreground/[0.05]'
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                    {server.id}
                  </span>
                  {server.global ? (
                    <Badge
                      variant="secondary"
                      className="h-5 shrink-0 gap-1 px-1.5 text-[9px]"
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
                <p className="mt-0.5 line-clamp-1 break-all text-[10px] text-muted-foreground">
                  {specSummary(server.spec)}
                </p>
              </div>
            );
          })
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

/* ── left: market list ───────────────────────────────────── */

function MarketListPanel({
  selectedProvider,
  query,
  onQueryChange,
  searching,
  onSearch,
  results,
  activeId,
  onSelect,
}: {
  selectedProvider: string;
  query: string;
  onQueryChange: (value: string) => void;
  searching: boolean;
  onSearch: () => void;
  results: McpMarketplaceItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-xl border bg-card">
      <div className="p-2.5">
        <div className="flex gap-1.5">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t('mcp.searchMarketPlaceholder')}
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onSearch();
              }}
              className="h-8 pl-8 text-xs"
            />
          </div>
          <Button
            size="sm"
            className="h-8 w-8 shrink-0 p-0"
            disabled={searching || !selectedProvider}
            onClick={onSearch}
          >
            {searching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-1.5">
        {searching ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('mcp.searching')}
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Server className="h-6 w-6 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              {t('mcp.noResults')}
            </p>
          </div>
        ) : (
          results.map((item) => {
            const active = item.server_id === activeId;
            return (
              <div
                key={`${item.provider_id}:${item.server_id}`}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(item.server_id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(item.server_id);
                  }
                }}
                className={cn(
                  'w-full cursor-pointer rounded-lg border px-2.5 py-2 text-left transition-colors',
                  active
                    ? 'border-primary/60 bg-primary/5'
                    : 'border-transparent hover:bg-foreground/[0.05]'
                )}
              >
                <div className="flex items-start gap-2">
                  <div className="mt-0.5 h-7 w-7 shrink-0 overflow-hidden rounded-md border bg-muted/40">
                    {item.icon_url ? (
                      <img
                        src={item.icon_url}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-[9px] text-muted-foreground">
                        MCP
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">
                      {item.name}
                    </div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {item.server_id}
                    </div>
                  </div>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {item.protocols.map((protocol) => (
                    <Badge
                      key={protocol}
                      variant="secondary"
                      className="h-4 px-1.5 text-[9px]"
                    >
                      {protocolLabel(protocol)}
                    </Badge>
                  ))}
                  {item.verified ? (
                    <Badge className="h-4 px-1.5 text-[9px]">
                      {t('mcp.verified')}
                    </Badge>
                  ) : null}
                  {typeof item.downloads === 'number' ? (
                    <Badge variant="outline" className="h-4 px-1.5 text-[9px]">
                      {t('mcp.downloadsCount', { count: item.downloads })}
                    </Badge>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ── right: market detail ────────────────────────────────── */

function MarketDetailPanel({
  loading,
  detailError,
  detail,
  selectedOption,
  onSwitchOption,
  specText,
  onSpecChange,
  onInstall,
}: {
  loading: boolean;
  detailError: string | null;
  detail: McpMarketplaceServerDetail | null;
  selectedOption: McpMarketplaceInstallOption | null;
  onSwitchOption: (id: string) => void;
  specText: string;
  onSpecChange: (text: string) => void;
  onInstall: () => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('mcp.loadingDetail')}
      </div>
    );
  }
  if (detailError) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        {t('mcp.loadDetailFailed', { error: detailError })}
      </div>
    );
  }
  if (!detail) {
    return <Placeholder tab="market" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg border bg-muted/40">
            {detail.icon_url ? (
              <img
                src={detail.icon_url}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
                MCP
              </div>
            )}
          </div>
          <div className="min-w-0">
            <h2 className="break-all text-base font-semibold">{detail.name}</h2>
            <p className="mt-0.5 break-all text-xs text-muted-foreground">
              {detail.server_id}
            </p>
          </div>
        </div>
        <Button size="sm" className="shrink-0" onClick={onInstall}>
          {t('mcp.install')}
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {detail.verified ? <Badge>{t('mcp.verified')}</Badge> : null}
        {detail.remote ? (
          <Badge variant="secondary">{t('mcp.remote')}</Badge>
        ) : null}
        {detail.homepage ? (
          <Badge variant="outline">{t('mcp.hasHomepage')}</Badge>
        ) : null}
        {detail.protocols.map((protocol) => (
          <Badge key={protocol} variant="secondary">
            {protocolLabel(protocol)}
          </Badge>
        ))}
        {typeof detail.downloads === 'number' ? (
          <Badge variant="outline">
            {t('mcp.downloadsCount', { count: detail.downloads })}
          </Badge>
        ) : null}
      </div>

      <p className="text-sm leading-6 text-muted-foreground">
        {detail.description}
      </p>

      {detail.homepage ? (
        <a
          href={detail.homepage}
          target="_blank"
          rel="noreferrer"
          className="block break-all text-xs text-primary underline"
        >
          {detail.homepage}
        </a>
      ) : null}

      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        {detail.owner ? (
          <div className="inline-flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" />
            {t('mcp.owner', { owner: detail.owner })}
          </div>
        ) : null}
        {detail.namespace ? (
          <div className="inline-flex items-center gap-1.5">
            <TerminalSquare className="h-3.5 w-3.5" />
            {t('mcp.namespace', { namespace: detail.namespace })}
          </div>
        ) : null}
        {detail.is_deployed != null ? (
          <div className="inline-flex items-center gap-1.5">
            <Globe className="h-3.5 w-3.5" />
            {detail.is_deployed ? t('mcp.deployed') : t('mcp.notDeployed')}
          </div>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          {t('mcp.defaultInstallProtocol')}
        </Label>
        <Select value={selectedOption?.id ?? ''} onValueChange={onSwitchOption}>
          <SelectTrigger className="h-9 text-xs">
            <SelectValue placeholder={t('mcp.selectProtocol')} />
          </SelectTrigger>
          <SelectContent>
            {detail.install_options.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {protocolLabel(option.protocol)} · {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          {t('mcp.currentOptionParamCount', {
            count: selectedOption?.parameters.length ?? 0,
          })}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          {t('mcp.installConfigLabel')}
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

/* ── right: local editor ─────────────────────────────────── */

function LocalEditor({
  server,
  specText,
  onSpecChange,
  global,
  apps,
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
            variant="outline"
            className="text-destructive hover:text-destructive"
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
        <Input
          value={id}
          placeholder={t('mcp.serverIdPlaceholder')}
          className="h-8 text-xs"
          onChange={(event) => onIdChange(event.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          {t('mcp.targetApps')}
        </Label>
        <TargetSelector
          global={global}
          apps={apps}
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

function Placeholder({ tab }: { tab: LeftTab }) {
  const { t } = useTranslation(['settings', 'common']);
  return (
    <div className="flex h-full flex-col items-center justify-center text-center text-muted-foreground">
      <Server className="h-10 w-10 opacity-30" />
      <p className="mt-3 text-sm">
        {tab === 'local'
          ? t('mcp.placeholderLocal')
          : t('mcp.placeholderMarket')}
      </p>
    </div>
  );
}
