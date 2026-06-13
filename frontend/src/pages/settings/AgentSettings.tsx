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
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Wand2,
  Wrench,
  XCircle,
} from 'lucide-react';
import { AgentTypeIcon } from '@/components/agents/AgentTypeIcon';
import { AgentConfigManager } from './AgentConfigManager';
import { agentsApi } from '@/features/agents/api';
import type { AgentRegistryEntry } from '@/features/agents/types';
import {
  agentSettingsApi,
  type AgentSettingInfo,
  type PreflightCheck,
  type PreflightFix,
  type PreflightResult,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const DEFAULT_LOAD_ERROR = '无法加载 Agent 设置。';

type AgentSettingsState = {
  registry: AgentRegistryEntry[];
  settings: AgentSettingInfo[];
};

type AgentDraft = {
  enabled: boolean;
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
};

function getLoadErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return DEFAULT_LOAD_ERROR;
}

function draftFromSetting(setting: AgentSettingInfo | null): AgentDraft {
  return {
    // 尚未纳管的 Agent（无持久化记录）默认未启用，需先创建设置记录才能启用。
    enabled: setting?.enabled ?? false,
  };
}

function checkById(
  result: PreflightResult | null,
  checkId: string
): PreflightCheck | null {
  return result?.checks.find((check) => check.check_id === checkId) ?? null;
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
    (versionCheck?.status === 'pass'
      ? extractVersion(versionCheck.message)
      : null) ??
    '未知';

  // The runtime card reflects the runtime entry + version only; auth/network
  // warnings surface as their own checklist rows below. This keeps the badge,
  // version, and message consistent with one another.
  let status: RuntimeStatus;
  let runtimeMessage: string;
  if (!result) {
    status = 'idle';
    runtimeMessage = '还没有运行检查。';
  } else if (runtimeCheck?.status === 'fail') {
    status = 'failed';
    runtimeMessage = '运行入口不可用。';
  } else if (version === '未知') {
    status = 'warning';
    runtimeMessage = '运行入口可用，但未能确认版本。';
  } else {
    status = 'ready';
    runtimeMessage = '运行入口可用。';
  }

  return { status, version, runtimeMessage };
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
  if (fix.action === 'install_npm' || fix.action === 'manual_install')
    return '安装';
  if (fix.action === 'upgrade_npm') return '更新';
  if (fix.action === 'uninstall_npm') return '卸载';
  if (fix.action === 'install_uv') return '安装 uv';
  if (fix.action.startsWith('open_url:')) return '下载';
  return fix.label;
}

/** Open an external URL via the OS, falling back to a new browser tab. */
async function openExternalUrl(url: string): Promise<void> {
  try {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(url);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export function AgentSettings() {
  const [state, setState] = useState<AgentSettingsState>({
    registry: [],
    settings: [],
  });
  const [selectedAgentType, setSelectedAgentType] = useState<string | null>(
    null
  );
  const [drafts, setDrafts] = useState<Record<string, AgentDraft>>({});
  const [expandedSections, setExpandedSections] = useState<
    Record<'preflight', boolean>
  >({
    preflight: true,
  });
  const [preflightByAgent, setPreflightByAgent] = useState<
    Record<string, PreflightResult | null>
  >({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [autoFixing, setAutoFixing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

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
      .sort(
        (a, b) => a.order - b.order || a.entry.name.localeCompare(b.entry.name)
      )
      .map(({ order: _order, ...row }) => row);
  }, [state]);

  const selectedRow = useMemo(
    () =>
      rows.find((row) => row.entry.agent_type === selectedAgentType) ?? null,
    [rows, selectedAgentType]
  );

  const selectedDraft = selectedRow
    ? (drafts[selectedRow.entry.agent_type] ??
      draftFromSetting(selectedRow.setting))
    : null;
  const selectedPreflight = selectedAgentType
    ? (preflightByAgent[selectedAgentType] ?? null)
    : null;
  const selectedRuntime = runtimeSummary(
    selectedPreflight,
    selectedRow?.setting?.installed_version
  );

  // Lightweight settings refresh (no full-screen spinner) after a config save.
  const refreshSettings = useCallback(async () => {
    try {
      const settings = await agentSettingsApi.list();
      setState((current) => ({ ...current, settings }));
      setDrafts((current) => {
        const next = { ...current };
        for (const setting of settings) {
          next[setting.agent_type] = draftFromSetting(setting);
        }
        return next;
      });
    } catch {
      // A refresh failure is non-fatal; the save itself already succeeded.
    }
  }, []);

  const toggleEnabled = useCallback(
    async (enabled: boolean) => {
      if (!selectedRow?.setting) return;
      const agentType = selectedRow.entry.agent_type;
      const setting = selectedRow.setting;

      setBusyAction(`enable:${agentType}`);
      setSaveError(null);
      setDrafts((current) => ({ ...current, [agentType]: { enabled } }));

      try {
        const updated = await agentSettingsApi.updatePreferences({
          agentType,
          enabled,
        });
        setState((current) => ({
          ...current,
          settings: current.settings.map((item) =>
            item.agent_type === updated.agent_type ? updated : item
          ),
        }));
        setDrafts((current) => ({
          ...current,
          [updated.agent_type]: draftFromSetting(updated),
        }));
      } catch (error) {
        setDrafts((current) => ({
          ...current,
          [agentType]: draftFromSetting(setting),
        }));
        setSaveError(getLoadErrorMessage(error));
      } finally {
        setBusyAction(null);
      }
    },
    [selectedRow]
  );

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
        setPreflightByAgent((current) => ({
          ...current,
          [agentType]: preflight,
        }));
      } catch (error) {
        setSaveError(getLoadErrorMessage(error));
      } finally {
        setBusyAction(null);
      }
    },
    [updateDetectedVersion]
  );

  // Apply a single preflight fix. npm actions run on the backend; download /
  // uv-install actions open the relevant page (VibeX does not auto-download
  // binaries), so the button is always actionable.
  const handleFix = useCallback(
    async (agentType: string, action: string) => {
      if (action.startsWith('open_url:')) {
        await openExternalUrl(action.slice('open_url:'.length));
        return;
      }
      if (action === 'install_uv') {
        await openExternalUrl(
          'https://docs.astral.sh/uv/getting-started/installation/'
        );
        return;
      }
      await runFix(agentType, action);
    },
    [runFix]
  );

  // Run every distinct fix surfaced by the latest preflight in sequence.
  const autoFix = useCallback(
    async (agentType: string) => {
      const checks = preflightByAgent[agentType]?.checks ?? [];
      const actions = Array.from(
        new Set(checks.flatMap((check) => check.fixes.map((fix) => fix.action)))
      );
      if (actions.length === 0) return;

      setAutoFixing(true);
      setSaveError(null);
      try {
        for (const action of actions) {
          await handleFix(agentType, action);
        }
      } catch (error) {
        setSaveError(getLoadErrorMessage(error));
      } finally {
        setAutoFixing(false);
      }
    },
    [preflightByAgent, handleFix]
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
      <TooltipProvider delayDuration={200}>
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center justify-between gap-1 overflow-x-auto rounded-xl border bg-muted-foreground/[0.06] p-1 [scrollbar-width:none]">
            {rows.map((row) => {
              const isSelected = row.entry.agent_type === selectedAgentType;
              const rowDraft =
                drafts[row.entry.agent_type] ?? draftFromSetting(row.setting);

              return (
                <Tooltip key={row.entry.registry_id}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      data-testid={`agent-registry-row-${row.entry.agent_type}`}
                      onClick={() => setSelectedAgentType(row.entry.agent_type)}
                      aria-label={row.entry.name}
                      aria-current={isSelected ? 'true' : undefined}
                      className={cn(
                        'relative flex h-11 w-11 shrink-0 items-center justify-center rounded-lg transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                        isSelected
                          ? 'settings-surface'
                          : 'hover:bg-foreground/[0.06]'
                      )}
                    >
                      <AgentTypeIcon
                        agentType={row.entry.agent_type}
                        className="h-6 w-6"
                      />
                      <span
                        className={cn(
                          'absolute right-1 top-1 h-1.5 w-1.5 rounded-full ring-2 ring-card',
                          rowDraft.enabled
                            ? 'bg-success'
                            : 'bg-muted-foreground/40'
                        )}
                      />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{row.entry.name}</TooltipContent>
                </Tooltip>
              );
            })}
          </div>

          <Button
            size="sm"
            variant="ghost"
            className="h-9 w-9 shrink-0 p-0"
            onClick={() => void loadAgents()}
            title="刷新"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </TooltipProvider>

      {loadError ? (
        <InlineMessage tone="error" title="Agent 设置不可用">
          {loadError}
        </InlineMessage>
      ) : selectedRow && selectedDraft ? (
        <div className="min-h-0 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border bg-card">
                <AgentTypeIcon
                  agentType={selectedRow.entry.agent_type}
                  className="h-7 w-7"
                />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-[15px] font-semibold text-foreground">
                    {selectedRow.entry.name}
                  </h2>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[10px] font-medium',
                      selectedDraft.enabled
                        ? 'bg-success/15 text-success'
                        : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {selectedDraft.enabled ? '已启用' : '已停用'}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {selectedRow.entry.description}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="h-8 w-8 p-0"
                disabled={!selectedRow.setting || busyAction !== null}
                onClick={() => void reorderSelected(-1)}
                title="上移"
              >
                <ChevronUp className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 w-8 p-0"
                disabled={!selectedRow.setting || busyAction !== null}
                onClick={() => void reorderSelected(1)}
                title="下移"
              >
                <ChevronDown className="h-4 w-4" />
              </Button>
              <div className="ml-1 flex h-8 items-center gap-2 rounded-md border bg-card px-2.5">
                <span className="text-xs text-muted-foreground">启用</span>
                <Switch
                  checked={selectedDraft.enabled}
                  disabled={!selectedRow.setting || busyAction !== null}
                  onCheckedChange={(checked) => void toggleEnabled(checked)}
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

          <SettingsSection
            id="preflight"
            title="预检查"
            icon={ShieldCheck}
            expanded={expandedSections.preflight}
            onToggle={() =>
              setExpandedSections((current) => ({
                ...current,
                preflight: !current.preflight,
              }))
            }
            action={
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  disabled={
                    !selectedRow.setting ||
                    busyAction !== null ||
                    autoFixing ||
                    !(selectedPreflight?.checks ?? []).some(
                      (check) => check.fixes.length > 0
                    )
                  }
                  onClick={() => void autoFix(selectedRow.entry.agent_type)}
                  title="自动安装/修复所有缺失项"
                >
                  {autoFixing ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  自动补全
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  disabled={
                    !selectedRow.setting || busyAction !== null || autoFixing
                  }
                  onClick={() =>
                    void runPreflight(selectedRow.entry.agent_type)
                  }
                >
                  {busyAction ===
                  `preflight:${selectedRow.entry.agent_type}` ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  立即检查
                </Button>
              </div>
            }
          >
            <RuntimeCard summary={selectedRuntime} />
            {selectedPreflight ? (
              <PreflightChecklist
                checks={selectedPreflight.checks}
                agentType={selectedRow.entry.agent_type}
                busyAction={busyAction}
                disabled={busyAction !== null || autoFixing}
                onFix={handleFix}
              />
            ) : null}
          </SettingsSection>

          <AgentConfigManager
            agentType={selectedRow.entry.agent_type}
            setting={selectedRow.setting}
            onSaved={() => void refreshSettings()}
          />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
          请选择一个 Agent 查看设置。
        </div>
      )}
    </div>
  );
}

function RuntimeCard({ summary }: { summary: RuntimeSummary }) {
  const isFailed = summary.status === 'failed';
  const StatusIcon = isFailed ? XCircle : CheckCircle2;

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
            <span className="text-xs font-medium text-foreground">
              运行状态
            </span>
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
    </div>
  );
}

function PreflightChecklist({
  checks,
  agentType,
  busyAction,
  disabled,
  onFix,
}: {
  checks: PreflightCheck[];
  agentType: string;
  busyAction: string | null;
  disabled: boolean;
  onFix: (agentType: string, action: string) => void;
}) {
  if (checks.length === 0) {
    return null;
  }

  return (
    <div className="mt-3 space-y-2">
      {checks.map((check) => {
        const isFail = check.status === 'fail';
        const isWarn = check.status === 'warn';
        const StatusIcon = isFail
          ? XCircle
          : isWarn
            ? AlertCircle
            : CheckCircle2;

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
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
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
                {check.status !== 'pass' && check.fixes.length > 0 ? (
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    {check.fixes.map((fix) => (
                      <Button
                        key={`${check.check_id}:${fix.action}`}
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={disabled}
                        onClick={() => onFix(agentType, fix.action)}
                      >
                        {busyAction === `fix:${agentType}:${fix.action}` ? (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        ) : (
                          <Wrench className="mr-1 h-3 w-3" />
                        )}
                        {fixLabel(fix)}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>
              <p className="mt-1 break-words text-xs text-muted-foreground">
                {check.message}
              </p>
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
    <section className="settings-surface overflow-hidden rounded-xl">
      <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
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
          <span className="truncate text-[13px] font-semibold text-foreground">
            {title}
          </span>
        </button>
        {action}
      </div>
      {expanded ? (
        <div id={`agent-settings-${id}`} className="px-3.5 pb-3.5 pt-1">
          {children}
        </div>
      ) : null}
    </section>
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
