import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  AlertCircle,
  Cable,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Wand2,
  Wrench,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { AgentKind } from 'shared/types';
import { AgentTypeIcon } from '@/components/agents/AgentTypeIcon';
import { AgentConfigManager } from './AgentConfigManager';
import { SettingsSection } from './SettingsSection';
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
import { useTranslation } from 'react-i18next';

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
  version: string | null;
};

type LocalRuntimeComponent = {
  path: string | null;
  version: string | null;
  minimum_supported_version: string | null;
  supported: boolean;
};

type LocalAgentRuntime = {
  cli: LocalRuntimeComponent;
  acp: LocalRuntimeComponent;
};

function getLoadErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  // Tauri command errors are serialized strings (AppError implements
  // Serialize as a string), not JavaScript Error instances. Preserve the
  // backend diagnostic instead of replacing it with the unrelated generic
  // "load settings" fallback.
  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.trim()
  ) {
    return error.message;
  }

  return null;
}

function draftFromSetting(setting: AgentSettingInfo | null): AgentDraft {
  return {
    // 尚未纳管的 Agent（无持久化记录）默认未启用，需先创建设置记录才能启用。
    enabled: setting?.enabled ?? false,
  };
}

/**
 * `local_runtime` was added after agent settings had already been persisted
 * and shipped. Treat it as optional so an older backend can still render this
 * page normally while a current backend supplies direct CLI/ACP facts.
 */
function localRuntimeFor(
  setting: AgentSettingInfo | null | undefined
): LocalAgentRuntime | null {
  const runtime = (
    setting as
      | (AgentSettingInfo & { local_runtime?: LocalAgentRuntime })
      | null
      | undefined
  )?.local_runtime;
  return runtime?.cli && runtime.acp ? runtime : null;
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
  const runtimeDetailIndex = trimmed.indexOf(' - ');
  return runtimeDetailIndex > 0
    ? trimmed.slice(0, runtimeDetailIndex)
    : trimmed;
}

function runtimeSummary(
  result: PreflightResult | null,
  installedVersion: string | null | undefined,
  localRuntime: LocalAgentRuntime | null
): RuntimeSummary {
  const runtimeCheck = checkById(result, 'runtime_launcher');
  const versionCheck = checkById(result, 'adapter_version');
  const version =
    localRuntime?.acp.version ??
    installedVersion ??
    (versionCheck?.status === 'pass'
      ? extractVersion(versionCheck.message)
      : null);

  // The runtime card reflects the runtime entry + version only; auth/network
  // warnings surface as their own checklist rows below. This keeps the badge,
  // version, and message consistent with one another.
  let status: RuntimeStatus;
  if (!result) {
    status = !localRuntime
      ? 'idle'
      : !localRuntime.cli.path || !localRuntime.acp.path
        ? 'failed'
        : localRuntime.cli.supported && localRuntime.acp.supported
          ? 'ready'
          : 'warning';
  } else if (runtimeCheck?.status === 'fail') {
    status = 'failed';
  } else if (version === null) {
    status = 'warning';
  } else {
    status = 'ready';
  }

  return { status, version };
}

function runtimeStatusClass(status: RuntimeStatus): string {
  if (status === 'ready') return 'settings-status-pill-success';
  if (status === 'warning') return 'settings-status-pill-warning';
  if (status === 'failed') return 'settings-status-pill-danger';
  return 'settings-status-pill-neutral';
}

function fixLabelKey(fix: PreflightFix): string | null {
  if (
    fix.action === 'install_cli' ||
    fix.action === 'install_npm' ||
    fix.action === 'manual_install'
  )
    return 'agents.fixInstall';
  if (fix.action === 'upgrade_npm' || fix.action === 'upgrade_cli')
    return 'agents.fixUpdate';
  if (fix.action === 'uninstall_npm') return 'agents.fixUninstall';
  if (fix.action === 'install_uv') return 'agents.fixInstallUv';
  if (fix.action.startsWith('open_url:')) return 'agents.fixDownload';
  return null;
}

/**
 * A local CLI must exist before its ACP adapter can be useful. Keep the
 * ordering explicit rather than relying on the server's checklist order,
 * which also lets future adapters add checks without changing this contract.
 */
function orderAutoFixActions(actions: string[]): string[] {
  const prerequisiteActions = actions.filter(
    (action) => action === 'install_uv' || action.startsWith('open_url:')
  );
  // A package-manager prerequisite needs a user-visible installer first. Do
  // not immediately run npm/CLI install actions against the still-broken
  // environment after opening that prerequisite page.
  if (prerequisiteActions.length > 0) return prerequisiteActions;

  const priority = (action: string): number => {
    if (action === 'install_cli' || action === 'upgrade_cli') return 0;
    if (action === 'install_npm' || action === 'upgrade_npm') return 1;
    return 2;
  };

  return actions
    .map((action, index) => ({ action, index }))
    .sort((left, right) => {
      const priorityDifference = priority(left.action) - priority(right.action);
      return priorityDifference || left.index - right.index;
    })
    .map(({ action }) => action);
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
  const { t } = useTranslation(['settings', 'common']);
  const queryClient = useQueryClient();
  const [state, setState] = useState<AgentSettingsState>({
    registry: [],
    settings: [],
  });
  const [selectedAgentType, setSelectedAgentType] = useState<AgentKind | null>(
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
      setLoadError(getLoadErrorMessage(error) ?? t('agents.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

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
  const selectedLocalRuntime = localRuntimeFor(selectedRow?.setting);
  const selectedRuntime = runtimeSummary(
    selectedPreflight,
    selectedRow?.setting?.installed_version,
    selectedLocalRuntime
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
        setSaveError(getLoadErrorMessage(error) ?? t('agents.loadFailed'));
      } finally {
        setBusyAction(null);
      }
    },
    [selectedRow, t]
  );

  const updateDetectedVersion = useCallback(
    (agentType: AgentKind, version: string | null) => {
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
    async (agentType: AgentKind) => {
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
        setSaveError(getLoadErrorMessage(error) ?? t('agents.loadFailed'));
      } finally {
        setBusyAction(null);
      }
    },
    [updateDetectedVersion, t]
  );

  const runFix = useCallback(
    async (agentType: AgentKind, action: string): Promise<boolean> => {
      const actionKey = `fix:${agentType}:${action}`;
      setBusyAction(actionKey);
      setSaveError(null);

      try {
        await agentSettingsApi.runFix({ agentType, action });
      } catch (error) {
        setSaveError(getLoadErrorMessage(error) ?? t('agents.loadFailed'));
        setBusyAction(null);
        return false;
      }

      // The mutation command performs its own final CLI + ACP verification.
      // From this point the fix succeeded; UI refreshes are best-effort and
      // must never relabel that successful operation as an install failure.
      void queryClient
        .invalidateQueries({
          queryKey: ['agent-settings'],
          refetchType: 'active',
        })
        .catch(() => undefined);
      void refreshSettings();

      const [versionResult, preflightResult] = await Promise.allSettled([
        agentSettingsApi.detectVersion(agentType),
        agentSettingsApi.preflight(agentType),
      ]);
      if (versionResult.status === 'fulfilled') {
        updateDetectedVersion(agentType, versionResult.value);
      }
      setPreflightByAgent((current) => ({
        ...current,
        [agentType]:
          preflightResult.status === 'fulfilled' ? preflightResult.value : null,
      }));
      setBusyAction(null);
      return true;
    },
    [queryClient, refreshSettings, updateDetectedVersion, t]
  );

  // Apply a single preflight fix. npm actions run on the backend; download /
  // uv-install actions open the relevant page (VibeX does not auto-download
  // binaries), so the button is always actionable.
  const handleFix = useCallback(
    async (agentType: AgentKind, action: string): Promise<boolean> => {
      if (action.startsWith('open_url:')) {
        await openExternalUrl(action.slice('open_url:'.length));
        return true;
      }
      if (action === 'install_uv') {
        await openExternalUrl(
          'https://docs.astral.sh/uv/getting-started/installation/'
        );
        return true;
      }
      return runFix(agentType, action);
    },
    [runFix]
  );

  // Run every distinct fix surfaced by the latest preflight in sequence.
  const autoFix = useCallback(
    async (agentType: AgentKind) => {
      const checks = preflightByAgent[agentType]?.checks ?? [];
      const actions = Array.from(
        new Set(
          checks
            .filter((check) => check.status !== 'pass')
            .flatMap((check) => check.fixes.map((fix) => fix.action))
        )
      );
      const orderedActions = orderAutoFixActions(actions);
      if (orderedActions.length === 0) return;

      setAutoFixing(true);
      setSaveError(null);
      try {
        let localRuntimeChanged = false;
        for (const action of orderedActions) {
          // Installing/upgrading a local CLI automatically installs its
          // missing dedicated ACP bridge on the backend. Do not immediately
          // run the stale preflight's redundant install_npm action afterward.
          if (localRuntimeChanged && action === 'install_npm') continue;

          const applied = await handleFix(agentType, action);
          if (!applied) break;
          if (action === 'install_cli' || action === 'upgrade_cli') {
            localRuntimeChanged = true;
          }
        }
      } catch (error) {
        setSaveError(getLoadErrorMessage(error) ?? t('agents.loadFailed'));
      } finally {
        setAutoFixing(false);
      }
    },
    [preflightByAgent, handleFix, t]
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
        setSaveError(getLoadErrorMessage(error) ?? t('agents.loadFailed'));
      } finally {
        setBusyAction(null);
      }
    },
    [rows, selectedRow, t]
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
            title={t('agents.refresh')}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </TooltipProvider>

      {loadError ? (
        <InlineMessage tone="error" title={t('agents.settingsUnavailable')}>
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
                    {selectedDraft.enabled
                      ? t('agents.enabled')
                      : t('agents.disabled')}
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
                title={t('agents.moveUp')}
              >
                <ChevronUp className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 w-8 p-0"
                disabled={!selectedRow.setting || busyAction !== null}
                onClick={() => void reorderSelected(1)}
                title={t('agents.moveDown')}
              >
                <ChevronDown className="h-4 w-4" />
              </Button>
              <div className="ml-1 flex h-8 items-center gap-2 rounded-md border bg-card px-2.5">
                <span className="text-xs text-muted-foreground">
                  {t('agents.enable')}
                </span>
                <Switch
                  checked={selectedDraft.enabled}
                  disabled={!selectedRow.setting || busyAction !== null}
                  onCheckedChange={(checked) => void toggleEnabled(checked)}
                  aria-label={t('agents.enableAgent')}
                />
              </div>
            </div>
          </div>

          {!selectedRow.setting ? (
            <InlineMessage tone="warning" title={t('agents.notManagedTitle')}>
              {t('agents.notManagedDescription')}
            </InlineMessage>
          ) : null}

          {saveError ? (
            <InlineMessage tone="error" title={t('agents.actionFailed')}>
              {saveError}
            </InlineMessage>
          ) : null}

          <SettingsSection
            id="preflight"
            title={t('agents.preflightTitle')}
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
                  title={t('agents.autoFixTooltip')}
                >
                  {autoFixing ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {t('agents.autoFix')}
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
                  {t('agents.checkNow')}
                </Button>
              </div>
            }
          >
            <RuntimeCard
              summary={selectedRuntime}
              localRuntime={selectedLocalRuntime}
            />
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
          {t('agents.selectAgentPrompt')}
        </div>
      )}
    </div>
  );
}

function RuntimeCard({
  summary,
  localRuntime,
}: {
  summary: RuntimeSummary;
  localRuntime: LocalAgentRuntime | null;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const StatusIcon =
    summary.status === 'failed'
      ? XCircle
      : summary.status === 'warning'
        ? AlertCircle
        : summary.status === 'ready'
          ? CheckCircle2
          : ShieldCheck;

  const statusLabel =
    summary.status === 'ready'
      ? t('agents.statusReady')
      : summary.status === 'warning'
        ? t('agents.statusNeedsConfirm')
        : summary.status === 'failed'
          ? t('agents.statusUnavailable')
          : t('agents.statusNotChecked');

  const runtimeMessage =
    summary.status === 'idle'
      ? t('agents.runtimeNotChecked')
      : summary.status === 'failed'
        ? t('agents.runtimeEntryUnavailable')
        : summary.status === 'warning'
          ? t('agents.runtimeVersionUnconfirmed')
          : t('agents.runtimeEntryAvailable');

  return (
    <div
      className={cn(
        'grid gap-2.5',
        localRuntime ? 'lg:grid-cols-3' : 'grid-cols-1'
      )}
    >
      <RuntimeComponentCard
        label={t('agents.runtimeStatus')}
        status={summary.status}
        statusLabel={statusLabel}
        icon={StatusIcon}
        testId="runtime-detail-entry"
      >
        <p className="text-xs text-muted-foreground">
          {t('agents.versionLabel', {
            version: summary.version ?? t('agents.versionUnknown'),
          })}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{runtimeMessage}</p>
      </RuntimeComponentCard>
      {localRuntime ? (
        <>
          <LocalRuntimeDetail
            label={t('agents.runtimeCli')}
            runtime={localRuntime.cli}
            icon={Terminal}
            testId="runtime-detail-cli"
          />
          <LocalRuntimeDetail
            label={t('agents.runtimeAcp')}
            runtime={localRuntime.acp}
            icon={Cable}
            testId="runtime-detail-acp"
          />
        </>
      ) : null}
    </div>
  );
}

function RuntimeComponentCard({
  label,
  status,
  statusLabel,
  icon: Icon,
  testId,
  children,
}: {
  label: string;
  status: RuntimeStatus;
  statusLabel: string;
  icon: LucideIcon;
  testId: string;
  children: ReactNode;
}) {
  return (
    <article
      className="min-w-0 rounded-lg bg-muted/40 p-3.5"
      data-testid={testId}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
              status === 'ready' && 'settings-status-swatch-success',
              status === 'warning' && 'settings-status-swatch-warning',
              status === 'failed' && 'settings-status-swatch-danger',
              status === 'idle' && 'settings-status-swatch-neutral'
            )}
          >
            <Icon
              className={cn(
                'h-4 w-4',
                status === 'ready' && 'text-success',
                status === 'warning' && 'text-warning',
                status === 'failed' && 'text-destructive',
                status === 'idle' && 'text-muted-foreground'
              )}
            />
          </div>
          <h3 className="truncate text-xs font-medium text-foreground">
            {label}
          </h3>
        </div>
        <span
          className={cn(
            'shrink-0 px-1.5 py-0.5 text-[10px] font-medium',
            runtimeStatusClass(status)
          )}
        >
          {statusLabel}
        </span>
      </div>
      {children}
    </article>
  );
}

function LocalRuntimeDetail({
  label,
  runtime,
  icon,
  testId,
}: {
  label: string;
  runtime: LocalRuntimeComponent;
  icon: LucideIcon;
  testId: string;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const status: RuntimeStatus = runtime.supported
    ? 'ready'
    : runtime.path
      ? 'warning'
      : 'failed';
  const statusLabel = runtime.supported
    ? t('agents.runtimeSupported')
    : runtime.path
      ? t('agents.runtimeUnsupported')
      : t('agents.runtimeNotFound');

  return (
    <RuntimeComponentCard
      label={label}
      status={status}
      statusLabel={statusLabel}
      icon={icon}
      testId={testId}
    >
      <p className="break-all font-mono text-[11px] text-muted-foreground">
        {runtime.path ?? t('agents.runtimeNotFound')}
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {t('agents.versionLabel', {
          version: runtime.version ?? t('agents.versionUnknown'),
        })}
        {!runtime.supported && runtime.minimum_supported_version ? (
          <span>
            {' · '}
            {t('agents.minimumVersionLabel', {
              version: runtime.minimum_supported_version,
            })}
          </span>
        ) : null}
      </p>
    </RuntimeComponentCard>
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
  agentType: AgentKind;
  busyAction: string | null;
  disabled: boolean;
  onFix: (agentType: AgentKind, action: string) => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
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
            className="settings-inline-group flex gap-3 p-3"
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
                    {check.fixes.map((fix) => {
                      const labelKey = fixLabelKey(fix);
                      return (
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
                          {labelKey ? t(labelKey) : fix.label}
                        </Button>
                      );
                    })}
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
        'settings-message p-3',
        tone === 'error' && 'settings-message-error',
        tone === 'warning' && 'settings-message-warning',
        tone === 'success' && 'settings-message-success'
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
