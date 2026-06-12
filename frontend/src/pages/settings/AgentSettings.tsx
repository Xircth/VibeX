import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronRight,
  ChevronsUpDown,
  Loader2,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  Wrench,
  XCircle,
} from 'lucide-react';
import { BaseCodingAgent } from 'shared/types';
import { AgentIcon } from '@/components/agents/AgentIcon';
import { agentsApi } from '@/features/agents/api';
import type { AgentRegistryEntry, AgentType } from '@/features/agents/types';
import {
  agentSettingsApi,
  type AgentSettingInfo,
  type PreflightCheck,
  type PreflightFix,
  type PreflightResult,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const DEFAULT_LOAD_ERROR = '无法加载 Agent 设置。';

type AgentSettingsState = {
  registry: AgentRegistryEntry[];
  settings: AgentSettingInfo[];
};

type AgentDraft = {
  enabled: boolean;
  envJson: string;
  configJson: string;
};

type AgentRow = {
  entry: AgentRegistryEntry;
  setting: AgentSettingInfo | null;
};

type RuntimeStatus = 'idle' | 'ready' | 'warning' | 'failed';

type RuntimeSummary = {
  status: RuntimeStatus;
  version: string;
  runtimeMessage: string;
  fixes: PreflightFix[];
};

function getLoadErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return DEFAULT_LOAD_ERROR;
}

function toBaseCodingAgent(agentType: AgentType): BaseCodingAgent | null {
  switch (agentType) {
    case 'claude_code':
      return BaseCodingAgent.CLAUDE_CODE;
    case 'codex':
      return BaseCodingAgent.CODEX;
    case 'open_code':
      return BaseCodingAgent.OPENCODE;
    case 'gemini':
      return BaseCodingAgent.GEMINI;
    default:
      return null;
  }
}

function formatJson(value: string | null | undefined): string {
  if (!value?.trim()) return '';

  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function draftFromSetting(setting: AgentSettingInfo | null): AgentDraft {
  return {
    enabled: setting?.enabled ?? true,
    envJson: formatJson(setting?.env_json),
    configJson: formatJson(setting?.config_json),
  };
}

function validateOptionalJson(label: string, value: string): string | null {
  if (!value.trim()) return null;

  try {
    JSON.parse(value);
    return null;
  } catch (error) {
    return `${label} 不是有效的 JSON：${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function compactJson(value: string): string | null {
  if (!value.trim()) return null;
  return JSON.stringify(JSON.parse(value));
}

function checkById(
  result: PreflightResult | null,
  checkId: string
): PreflightCheck | null {
  return result?.checks.find((check) => check.check_id === checkId) ?? null;
}

function runtimeStatusFromChecks(result: PreflightResult | null): RuntimeStatus {
  if (!result) return 'idle';
  if (result.checks.some((check) => check.status === 'fail')) return 'failed';
  if (result.checks.some((check) => check.status === 'warn')) return 'warning';
  return 'ready';
}

function extractVersion(message: string): string | null {
  const trimmed = message.trim();
  if (!trimmed) return null;
  const sourceIndex = trimmed.indexOf(' - Source: ');
  return sourceIndex > 0 ? trimmed.slice(0, sourceIndex) : trimmed;
}

function runtimeSummary(
  result: PreflightResult | null,
  installedVersion: string | null | undefined
): RuntimeSummary {
  const runtimeCheck = checkById(result, 'runtime_launcher');
  const versionCheck = checkById(result, 'adapter_version');
  const version =
    installedVersion ??
    (versionCheck?.status === 'pass' ? extractVersion(versionCheck.message) : null) ??
    '未知';
  const status = runtimeStatusFromChecks(result);

  return {
    status,
    version,
    runtimeMessage:
      status === 'idle'
        ? '还没有运行检查。'
        : runtimeCheck?.status === 'fail'
          ? '运行入口不可用。'
          : '运行入口可用。',
    fixes: [...(runtimeCheck?.fixes ?? []), ...(versionCheck?.fixes ?? [])],
  };
}

function runtimeStatusLabel(status: RuntimeStatus): string {
  if (status === 'ready') return '可用';
  if (status === 'warning') return '需确认';
  if (status === 'failed') return '不可用';
  return '未检查';
}

function runtimeStatusClass(status: RuntimeStatus): string {
  if (status === 'ready') return 'bg-success/10 text-success';
  if (status === 'warning') return 'bg-warning/10 text-warning';
  if (status === 'failed') return 'bg-destructive/10 text-destructive';
  return 'bg-muted text-muted-foreground';
}

function fixLabel(fix: PreflightFix): string {
  if (fix.action === 'install_npm') return '安装';
  if (fix.action === 'upgrade_npm') return '更新';
  if (fix.action === 'uninstall_npm') return '卸载';
  return fix.label;
}

function filterRuntimeFixes(fixes: PreflightFix[]): PreflightFix[] {
  const allowed = new Set(['install_npm', 'upgrade_npm', 'uninstall_npm']);
  const seen = new Set<string>();

  return fixes.filter((fix) => {
    if (!allowed.has(fix.action) || seen.has(fix.action)) return false;
    seen.add(fix.action);
    return true;
  });
}

export function AgentSettings() {
  const [state, setState] = useState<AgentSettingsState>({
    registry: [],
    settings: [],
  });
  const [selectedAgentType, setSelectedAgentType] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, AgentDraft>>({});
  const [expandedSections, setExpandedSections] = useState<
    Record<'preflight' | 'configuration', boolean>
  >({
    preflight: true,
    configuration: true,
  });
  const [preflightByAgent, setPreflightByAgent] = useState<
    Record<string, PreflightResult | null>
  >({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAgent, setSavedAgent] = useState<string | null>(null);

  const loadAgents = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    setSaveError(null);

    try {
      const [registry, settings] = await Promise.all([
        agentsApi.listRegistry(),
        agentSettingsApi.list(),
      ]);

      setState({ registry, settings });
      setDrafts(
        Object.fromEntries(
          settings.map((setting) => [
            setting.agent_type,
            draftFromSetting(setting),
          ])
        )
      );
      setSelectedAgentType((current) => {
        if (current && registry.some((entry) => entry.agent_type === current)) {
          return current;
        }
        return settings[0]?.agent_type ?? registry[0]?.agent_type ?? null;
      });
    } catch (error) {
      setState({ registry: [], settings: [] });
      setDrafts({});
      setLoadError(getLoadErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  const rows = useMemo<AgentRow[]>(() => {
    const configuredOrder = new Map(
      state.settings.map((setting) => [setting.agent_type, setting.sort_order])
    );

    return state.registry
      .map((entry, fallbackOrder) => ({
        entry,
        setting:
          state.settings.find((item) => item.agent_type === entry.agent_type) ??
          null,
        order: configuredOrder.get(entry.agent_type) ?? 1000 + fallbackOrder,
      }))
      .sort((a, b) => a.order - b.order || a.entry.name.localeCompare(b.entry.name))
      .map(({ order: _order, ...row }) => row);
  }, [state]);

  const selectedRow = useMemo(
    () => rows.find((row) => row.entry.agent_type === selectedAgentType) ?? null,
    [rows, selectedAgentType]
  );

  const selectedDraft = selectedRow
    ? drafts[selectedRow.entry.agent_type] ?? draftFromSetting(selectedRow.setting)
    : null;
  const selectedPreflight = selectedAgentType
    ? preflightByAgent[selectedAgentType] ?? null
    : null;
  const selectedRuntime = runtimeSummary(
    selectedPreflight,
    selectedRow?.setting?.installed_version
  );

  const updateSelectedDraft = useCallback(
    (patch: Partial<AgentDraft>) => {
      if (!selectedRow) return;
      setDrafts((current) => ({
        ...current,
        [selectedRow.entry.agent_type]: {
          ...(current[selectedRow.entry.agent_type] ??
            draftFromSetting(selectedRow.setting)),
          ...patch,
        },
      }));
      setSavedAgent(null);
      setSaveError(null);
    },
    [selectedRow]
  );

  const saveSelected = useCallback(async () => {
    if (!selectedRow || !selectedDraft || !selectedRow.setting) return;

    const envError = validateOptionalJson('环境变量 JSON', selectedDraft.envJson);
    const configError = validateOptionalJson(
      '原生配置 JSON',
      selectedDraft.configJson
    );
    if (envError || configError) {
      setSaveError(envError ?? configError);
      return;
    }

    const actionKey = `save:${selectedRow.entry.agent_type}`;
    setBusyAction(actionKey);
    setSaveError(null);

    try {
      const updated = await agentSettingsApi.updatePreferences({
        agentType: selectedRow.entry.agent_type,
        enabled: selectedDraft.enabled,
        envJson: compactJson(selectedDraft.envJson),
        configJson: compactJson(selectedDraft.configJson),
      });

      setState((current) => ({
        ...current,
        settings: current.settings.map((setting) =>
          setting.agent_type === updated.agent_type ? updated : setting
        ),
      }));
      setDrafts((current) => ({
        ...current,
        [updated.agent_type]: draftFromSetting(updated),
      }));
      setSavedAgent(updated.agent_type);
    } catch (error) {
      setSaveError(getLoadErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }, [selectedDraft, selectedRow]);

  const updateDetectedVersion = useCallback(
    (agentType: string, version: string | null) => {
      setState((current) => ({
        ...current,
        settings: current.settings.map((setting) =>
          setting.agent_type === agentType
            ? { ...setting, installed_version: version }
            : setting
        ),
      }));
    },
    []
  );

  const runPreflight = useCallback(
    async (agentType: string) => {
      const actionKey = `preflight:${agentType}`;
      setBusyAction(actionKey);
      setSaveError(null);

      try {
        const result = await agentSettingsApi.preflight(agentType);
        const version = await agentSettingsApi
          .detectVersion(agentType)
          .catch(() => null);
        setPreflightByAgent((current) => ({ ...current, [agentType]: result }));
        if (version !== undefined) {
          updateDetectedVersion(agentType, version);
        }
      } catch (error) {
        setSaveError(getLoadErrorMessage(error));
      } finally {
        setBusyAction(null);
      }
    },
    [updateDetectedVersion]
  );

  const runFix = useCallback(
    async (agentType: string, action: string) => {
      const actionKey = `fix:${agentType}:${action}`;
      setBusyAction(actionKey);
      setSaveError(null);

      try {
        await agentSettingsApi.runFix({ agentType, action });
        const [version, preflight] = await Promise.all([
          agentSettingsApi.detectVersion(agentType),
          agentSettingsApi.preflight(agentType),
        ]);
        updateDetectedVersion(agentType, version);
        setPreflightByAgent((current) => ({ ...current, [agentType]: preflight }));
      } catch (error) {
        setSaveError(getLoadErrorMessage(error));
      } finally {
        setBusyAction(null);
      }
    },
    [updateDetectedVersion]
  );

  const reorderSelected = useCallback(
    async (direction: -1 | 1) => {
      if (!selectedRow?.setting) return;

      const managed = rows.filter((row) => row.setting);
      const index = managed.findIndex(
        (row) => row.entry.agent_type === selectedRow.entry.agent_type
      );
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= managed.length) return;

      const next = [...managed];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      const order = next.map((row) => row.entry.agent_type);
      const actionKey = `reorder:${selectedRow.entry.agent_type}`;
      setBusyAction(actionKey);
      setSaveError(null);

      try {
        const settings = await agentSettingsApi.reorder(order);
        setState((current) => ({ ...current, settings }));
      } catch (error) {
        setSaveError(getLoadErrorMessage(error));
      } finally {
        setBusyAction(null);
      }
    },
    [rows, selectedRow]
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      <div className="flex shrink-0 items-center gap-2 overflow-x-auto rounded-xl bg-muted/45 p-1 [scrollbar-width:none]">
        {rows.map((row) => {
          const isSelected = row.entry.agent_type === selectedAgentType;
          const rowDraft =
            drafts[row.entry.agent_type] ?? draftFromSetting(row.setting);
          const runtimeStatus = runtimeStatusFromChecks(
            preflightByAgent[row.entry.agent_type] ?? null
          );

          return (
            <button
              key={row.entry.registry_id}
              type="button"
              data-testid={`agent-registry-row-${row.entry.agent_type}`}
              onClick={() => setSelectedAgentType(row.entry.agent_type)}
              className={cn(
                'flex h-20 w-24 shrink-0 flex-col items-center justify-center gap-1.5 rounded-lg px-2 transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                isSelected
                  ? 'bg-card text-foreground shadow-[0_2px_7px_hsl(220_36%_8%/0.075)]'
                  : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'
              )}
            >
              <span
                className={cn(
                  'relative flex h-9 w-9 items-center justify-center rounded-md border bg-background/70',
                  isSelected && 'border-primary/35 bg-primary/10'
                )}
              >
                <AgentGlyph agentType={row.entry.agent_type} />
                <span
                  className={cn(
                    'absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border border-card',
                    rowDraft.enabled ? 'bg-success' : 'bg-muted-foreground/50'
                  )}
                />
              </span>
              <span className="w-full truncate text-center text-xs font-medium">
                {row.entry.name}
              </span>
              {runtimeStatus !== 'idle' ? (
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    runtimeStatus === 'ready' && 'bg-success',
                    runtimeStatus === 'warning' && 'bg-warning',
                    runtimeStatus === 'failed' && 'bg-destructive'
                  )}
                />
              ) : null}
            </button>
          );
        })}

        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-9 w-9 shrink-0 p-0"
          onClick={() => void loadAgents()}
          title="刷新"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {loadError ? (
        <InlineMessage tone="error" title="Agent 设置不可用">
          {loadError}
        </InlineMessage>
      ) : selectedRow && selectedDraft ? (
        <div className="min-h-0 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border bg-card">
                <AgentGlyph
                  agentType={selectedRow.entry.agent_type}
                  className="h-7 w-7"
                />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-base font-semibold text-foreground">
                    {selectedRow.entry.name}
                  </h2>
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[10px] font-medium',
                      selectedDraft.enabled
                        ? 'bg-success/10 text-success'
                        : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {selectedDraft.enabled ? '已启用' : '已停用'}
                  </span>
                </div>
                <p className="mt-0.5 max-w-3xl text-xs text-muted-foreground">
                  {selectedRow.entry.description}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={!selectedRow.setting || busyAction !== null}
                onClick={() => void reorderSelected(-1)}
                title="上移"
              >
                <ChevronsUpDown className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={!selectedRow.setting || busyAction !== null}
                onClick={() => void reorderSelected(1)}
                title="下移"
              >
                <ChevronRight className="h-3.5 w-3.5 rotate-90" />
              </Button>
              <div className="flex h-8 items-center gap-2 rounded-md border bg-card px-2">
                <span className="text-xs text-muted-foreground">启用</span>
                <Switch
                  checked={selectedDraft.enabled}
                  disabled={!selectedRow.setting}
                  onCheckedChange={(checked) =>
                    updateSelectedDraft({ enabled: checked })
                  }
                  aria-label="启用 Agent"
                />
              </div>
            </div>
          </div>

          {!selectedRow.setting ? (
            <InlineMessage tone="warning" title="该 Agent 尚未纳管">
              这里只能查看注册表信息。启用、排序和安装修复需要后端先创建持久化设置记录。
            </InlineMessage>
          ) : null}

          {saveError ? (
            <InlineMessage tone="error" title="操作失败">
              {saveError}
            </InlineMessage>
          ) : null}

          {savedAgent === selectedRow.entry.agent_type ? (
            <InlineMessage tone="success" title="已保存">
              Agent 设置已更新。
            </InlineMessage>
          ) : null}

          <SettingsSection
            id="preflight"
            title={`安装与可用性检查 · 版本 ${selectedRuntime.version}`}
            icon={ShieldCheck}
            expanded={expandedSections.preflight}
            onToggle={() =>
              setExpandedSections((current) => ({
                ...current,
                preflight: !current.preflight,
              }))
            }
            action={
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={!selectedRow.setting || busyAction !== null}
                onClick={() => void runPreflight(selectedRow.entry.agent_type)}
              >
                {busyAction === `preflight:${selectedRow.entry.agent_type}` ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                )}
                立即检查
              </Button>
            }
          >
            <RuntimeCard
              summary={selectedRuntime}
              busyAction={busyAction}
              agentType={selectedRow.entry.agent_type}
              onFix={runFix}
            />
            {selectedPreflight ? (
              <PreflightChecklist checks={selectedPreflight.checks} />
            ) : null}
          </SettingsSection>

          <SettingsSection
            id="configuration"
            title="运行配置"
            icon={Settings2}
            expanded={expandedSections.configuration}
            onToggle={() =>
              setExpandedSections((current) => ({
                ...current,
                configuration: !current.configuration,
              }))
            }
            action={
              <Button
                size="sm"
                className="h-8"
                disabled={!selectedRow.setting || busyAction !== null}
                onClick={() => void saveSelected()}
              >
                {busyAction === `save:${selectedRow.entry.agent_type}` ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                )}
                保存
              </Button>
            }
          >
            <div className="grid gap-4 lg:grid-cols-2">
              <ConfigEditor
                id="agent-env-json"
                label="环境变量 JSON"
                value={selectedDraft.envJson}
                disabled={!selectedRow.setting}
                placeholder={`{
  "OPENAI_API_KEY": "sk-...",
  "CUSTOM_ENV": "value"
}`}
                hint="只保存需要覆盖的变量；留空表示不覆盖。"
                onChange={(value) => updateSelectedDraft({ envJson: value })}
              />
              <ConfigEditor
                id="agent-config-json"
                label="原生配置 JSON"
                value={selectedDraft.configJson}
                disabled={!selectedRow.setting}
                placeholder={`{
  "model": "gpt-5",
  "env": {}
}`}
                hint="只放运行偏好；不支持的字段会由后端校验。"
                onChange={(value) => updateSelectedDraft({ configJson: value })}
              />
            </div>
          </SettingsSection>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
          请选择一个 Agent 查看设置。
        </div>
      )}
    </div>
  );
}

function AgentGlyph({
  agentType,
  className = 'h-5 w-5',
}: {
  agentType: AgentType;
  className?: string;
}) {
  const baseAgent = toBaseCodingAgent(agentType);
  if (baseAgent) {
    return <AgentIcon agent={baseAgent} className={className} />;
  }

  return <Bot className={cn('text-muted-foreground', className)} />;
}

function RuntimeCard({
  summary,
  busyAction,
  agentType,
  onFix,
}: {
  summary: RuntimeSummary;
  busyAction: string | null;
  agentType: string;
  onFix: (agentType: string, action: string) => void;
}) {
  const isFailed = summary.status === 'failed';
  const StatusIcon = isFailed ? XCircle : CheckCircle2;
  const fixes = filterRuntimeFixes(summary.fixes);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 p-3">
      <div className="flex min-w-0 items-center gap-3">
        <div
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-md',
            summary.status === 'ready' && 'bg-success/10',
            summary.status === 'warning' && 'bg-warning/10',
            summary.status === 'failed' && 'bg-destructive/10',
            summary.status === 'idle' && 'bg-muted'
          )}
        >
          {summary.status === 'idle' ? (
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          ) : (
            <StatusIcon
              className={cn(
                'h-4 w-4',
                summary.status === 'ready' && 'text-success',
                summary.status === 'warning' && 'text-warning',
                summary.status === 'failed' && 'text-destructive'
              )}
            />
          )}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-foreground">运行状态</span>
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-medium',
                runtimeStatusClass(summary.status)
              )}
            >
              {runtimeStatusLabel(summary.status)}
            </span>
            <span className="text-xs text-muted-foreground">
              版本 {summary.version}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {summary.runtimeMessage}
          </p>
        </div>
      </div>
      {fixes.length > 0 ? (
        <div className="flex shrink-0 flex-wrap gap-2">
          {fixes.map((fix) => (
            <Button
              key={fix.action}
              size="sm"
              variant={fix.action === 'uninstall_npm' ? 'outline' : 'default'}
              className="h-8"
              disabled={busyAction !== null}
              onClick={() => onFix(agentType, fix.action)}
            >
              {busyAction === `fix:${agentType}:${fix.action}` ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wrench className="mr-1.5 h-3.5 w-3.5" />
              )}
              {fixLabel(fix)}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PreflightChecklist({ checks }: { checks: PreflightCheck[] }) {
  if (checks.length === 0) {
    return null;
  }

  return (
    <div className="mt-3 space-y-2">
      {checks.map((check) => {
        const isFail = check.status === 'fail';
        const isWarn = check.status === 'warn';
        const StatusIcon = isFail ? XCircle : isWarn ? AlertCircle : CheckCircle2;

        return (
          <div
            key={check.check_id}
            className="flex gap-3 rounded-md border bg-background/60 p-3"
          >
            <StatusIcon
              className={cn(
                'mt-0.5 h-4 w-4 shrink-0',
                isFail && 'text-destructive',
                isWarn && 'text-warning',
                !isFail && !isWarn && 'text-success'
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-foreground">
                  {check.label}
                </span>
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] font-medium',
                    check.status === 'pass' && 'bg-success/10 text-success',
                    check.status === 'warn' && 'bg-warning/10 text-warning',
                    check.status === 'fail' &&
                      'bg-destructive/10 text-destructive'
                  )}
                >
                  {check.status}
                </span>
              </div>
              <p className="mt-1 break-words text-xs text-muted-foreground">
                {check.message}
              </p>
              {check.fixes.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {check.fixes.map((fix) => (
                    <span
                      key={`${check.check_id}:${fix.action}`}
                      className="rounded border bg-muted/45 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                    >
                      {fix.label}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SettingsSection({
  id,
  title,
  icon: Icon,
  expanded,
  onToggle,
  action,
  children,
}: {
  id: string;
  title: string;
  icon: typeof Bot;
  expanded: boolean;
  onToggle: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 items-center gap-2 text-left"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={`agent-settings-${id}`}
        >
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-90'
            )}
          />
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-medium text-foreground">
            {title}
          </span>
        </button>
        {action}
      </div>
      {expanded ? (
        <div id={`agent-settings-${id}`} className="p-3">
          {children}
        </div>
      ) : null}
    </section>
  );
}

function ConfigEditor({
  id,
  label,
  value,
  placeholder,
  hint,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  hint: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-xs font-medium text-foreground">
        {label}
      </label>
      <Textarea
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        className="min-h-44 font-mono text-xs"
        placeholder={placeholder}
      />
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}

function InlineMessage({
  tone,
  title,
  children,
}: {
  tone: 'error' | 'warning' | 'success';
  title: string;
  children: ReactNode;
}) {
  const Icon = tone === 'success' ? CheckCircle2 : AlertCircle;

  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        tone === 'error' && 'border-destructive/40 bg-destructive/5',
        tone === 'warning' && 'border-warning/40 bg-warning/5',
        tone === 'success' && 'border-success/40 bg-success/5'
      )}
    >
      <div className="flex items-start gap-2">
        <Icon
          className={cn(
            'mt-0.5 h-4 w-4',
            tone === 'error' && 'text-destructive',
            tone === 'warning' && 'text-warning',
            tone === 'success' && 'text-success'
          )}
        />
        <div className="min-w-0">
          <div className="text-xs font-medium text-foreground">{title}</div>
          <div className="mt-1 break-all text-xs text-muted-foreground">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
