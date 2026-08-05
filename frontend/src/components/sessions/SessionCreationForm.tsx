import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronDown, History } from 'lucide-react';
import type { ExecutorConfigs, ExecutorProfileId } from 'shared/types';
import type { RepoBranchConfig } from '@/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TerminalProfileControls } from '@/components/tasks/TerminalProfileControls';
import {
  jsonValueToString,
  presentableSessionConfigOptions,
  resolvedConfigOptionChoices,
  sanitizeDependentConfigValues,
  selectConfigOptionValue,
  visibleSessionConfigOptions,
} from '@/components/tasks/follow-up/SessionConfigOptionSelectors';
import { SessionSettingsSummary } from '@/components/tasks/follow-up/SessionSettingsSummary';
import { agentsApi } from '@/features/agents/api';
import { sessionControlsQueryKey } from '@/features/agents/sessionControlsQuery';
import { useUserSystem } from '@/components/ConfigProvider';
import RepoBranchSelector from '@/components/tasks/RepoBranchSelector';
import { WorkspaceSelector } from './WorkspaceSelector';
import { cn } from '@/lib/utils';
import {
  findWorkspaceBranchOption,
  getWorkspaceBranchCheckoutHint,
  getWorkspaceBranchWarning,
  type WorkspaceBranchOption,
} from '@/lib/workspaceBranchOptions';

export type SessionCreationMode = 'existing_workspace' | 'new_workspace';

/**
 * Agent-advertised control choices made before the conversation's ACP session
 * exists. They are applied while the created conversation initializes its ACP
 * session, with the composer draft retaining them as a recovery fallback.
 */
export interface SessionControlsPreset {
  modeOverride: string | null;
  configOverrides: Record<string, string>;
}

function isLocalHistoryMeta(meta: unknown): boolean {
  return (
    typeof meta === 'object' &&
    meta !== null &&
    !Array.isArray(meta) &&
    'source' in meta &&
    meta.source === 'local_history'
  );
}

function preferredCreationMode(
  executor: ExecutorProfileId['executor'] | null,
  modes: Array<{ id: string }>,
  advertisedCurrentMode: string | null
): string | null {
  if (executor !== 'codex') return advertisedCurrentMode;

  return (
    modes.find(
      (mode) =>
        mode.id.replace(/[^a-z0-9]/gi, '').toLowerCase() === 'agentfullaccess'
    )?.id ?? advertisedCurrentMode
  );
}

interface SessionCreationFormProps {
  mode: SessionCreationMode;
  onModeChange: (mode: SessionCreationMode) => void;
  workspaceBranchOptions: WorkspaceBranchOption[];
  selectedWorkspaceValue: string;
  onSelectedWorkspaceValueChange: (value: string) => void;
  sessionName: string;
  onSessionNameChange: (value: string) => void;
  profiles: ExecutorConfigs['executors'] | null;
  selectedExecutorProfile: ExecutorProfileId | null;
  onSelectedExecutorProfileChange: (value: ExecutorProfileId) => void;
  /** Reports the current ACP control preset (null until controls are ready). */
  onSessionControlsPresetChange?: (
    preset: SessionControlsPreset | null
  ) => void;
  repoBranchConfigs: RepoBranchConfig[];
  onRepoBranchChange: (repoId: string, branch: string) => void;
  isLoadingBranches: boolean;
  canSubmit: boolean;
  isSubmitting: boolean;
  errorMessage?: string | null;
  onSubmit: () => void;
  onCancel?: () => void;
  onRemoteSessionImported?: (conversationId: string) => void;
  submitLabel?: string;
  cancelLabel?: string;
  className?: string;
  compact?: boolean;
  dropdownSide?: 'top' | 'bottom';
}

export function SessionCreationForm({
  mode,
  onModeChange,
  workspaceBranchOptions,
  selectedWorkspaceValue,
  onSelectedWorkspaceValueChange,
  sessionName,
  onSessionNameChange,
  profiles,
  selectedExecutorProfile,
  onSelectedExecutorProfileChange,
  repoBranchConfigs,
  onRepoBranchChange,
  isLoadingBranches,
  canSubmit,
  isSubmitting,
  errorMessage,
  onSubmit,
  onCancel,
  submitLabel,
  cancelLabel,
  className,
  compact = false,
  dropdownSide = 'bottom',
  onSessionControlsPresetChange,
  onRemoteSessionImported,
}: SessionCreationFormProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const { config } = useUserSystem();
  const queryClient = useQueryClient();
  const resolvedSubmitLabel = submitLabel ?? t('sessionCreation.submit');
  const resolvedCancelLabel = cancelLabel ?? t('common:cancel');
  const executor = selectedExecutorProfile?.executor ?? null;
  const selectedWorkspaceOption = findWorkspaceBranchOption(
    workspaceBranchOptions,
    selectedWorkspaceValue
  );
  const controlsWorkspaceId =
    mode === 'existing_workspace'
      ? (selectedWorkspaceOption?.existingWorkspaceId ?? null)
      : null;
  const controlsQuery = useQuery({
    // Every create surface shares a per-Agent/workspace cache. A live composer
    // can seed the exact workspace entry; a new workspace falls back to the
    // verified global catalog without starting a temporary user session.
    queryKey: sessionControlsQueryKey(executor!, controlsWorkspaceId),
    queryFn: async () => {
      const cached = await agentsApi.capabilityCatalog(executor!);
      if (cached) return cached;

      // First run after install/login: build the verified catalog once. The
      // backend deduplicates concurrent probes and persists the result by the
      // local runtime/config fingerprint.
      const refreshed = await agentsApi.refreshCapabilityCatalog(executor!);
      if (!refreshed) {
        throw new Error('Agent session controls discovery failed');
      }
      const discovered = await agentsApi.capabilityCatalog(executor!);
      if (!discovered) {
        throw new Error('Agent session controls catalog is unavailable');
      }
      return discovered;
    },
    enabled: Boolean(executor),
    // Keep data resident so opening the form is immediate, but periodically
    // re-check the backend fingerprint so install/login/config changes cannot
    // leave a process-lifetime stale catalog.
    staleTime: 60_000,
    gcTime: Infinity,
    retry: false,
  });
  const defaultsQuery = useQuery({
    queryKey: ['agentSessionDefaults', executor],
    queryFn: () => agentsApi.sessionDefaults(executor!),
    enabled: Boolean(executor),
    staleTime: Infinity,
    retry: false,
  });
  const catalogFreshnessQuery = useQuery({
    queryKey: ['agentCapabilityCatalogFreshness', executor],
    queryFn: () => agentsApi.capabilityCatalogFresh(executor!),
    enabled: Boolean(executor && controlsQuery.data),
    staleTime: 0,
    retry: false,
  });
  const backgroundRefreshAgent = useRef<string | null>(null);
  const [selectedMode, setSelectedMode] = useState<string | null>(null);
  const [selectedConfigValues, setSelectedConfigValues] = useState<
    Record<string, string>
  >({});
  const [defaultsSaveState, setDefaultsSaveState] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');
  const [savedDefaultsFingerprint, setSavedDefaultsFingerprint] = useState<
    string | null
  >(null);
  const [defaultsHydratedAgent, setDefaultsHydratedAgent] = useState<
    string | null
  >(null);
  const [catalogRefreshFailed, setCatalogRefreshFailed] = useState(false);
  const [remoteSessionsOpen, setRemoteSessionsOpen] = useState(false);
  const [remoteSessionAction, setRemoteSessionAction] = useState<string | null>(
    null
  );
  const [remoteSessionStatus, setRemoteSessionStatus] = useState<
    'idle' | 'imported' | 'error'
  >('idle');
  useEffect(() => {
    setSelectedMode(null);
    setSelectedConfigValues({});
    setDefaultsSaveState('idle');
    setSavedDefaultsFingerprint(null);
    setDefaultsHydratedAgent(null);
    setCatalogRefreshFailed(false);
    setRemoteSessionsOpen(false);
    setRemoteSessionAction(null);
    setRemoteSessionStatus('idle');
    backgroundRefreshAgent.current = null;
  }, [controlsWorkspaceId, executor]);
  useEffect(() => {
    if (
      !executor ||
      catalogFreshnessQuery.data !== false ||
      backgroundRefreshAgent.current === executor
    ) {
      return;
    }
    backgroundRefreshAgent.current = executor;
    void agentsApi
      .refreshCapabilityCatalog(executor)
      .then(async (refreshed) => {
        if (!refreshed) {
          setCatalogRefreshFailed(true);
          return;
        }
        setCatalogRefreshFailed(false);
        await controlsQuery.refetch();
        await catalogFreshnessQuery.refetch();
      })
      .catch(() => setCatalogRefreshFailed(true));
  }, [catalogFreshnessQuery, controlsQuery, executor]);
  useEffect(() => {
    if (!executor || !defaultsQuery.isFetched) return;
    if (defaultsQuery.data) {
      setSelectedConfigValues(
        Object.fromEntries(
          Object.entries(defaultsQuery.data.values).flatMap(([key, value]) => {
            const serialized =
              value === null
                ? ''
                : typeof value === 'string'
                  ? value
                  : JSON.stringify(value);
            return serialized ? [[key, serialized]] : [];
          })
        )
      );
    }
    setDefaultsHydratedAgent(executor);
  }, [defaultsQuery.data, defaultsQuery.isFetched, executor]);

  const activeControls = controlsQuery.data ?? null;
  const supportsRemoteSessionList =
    activeControls?.capabilities?.list_sessions === true;
  const previousSessionContinuationEnabled =
    config?.previous_session_continuation_enabled === true;
  const remoteSessionsQuery = useQuery({
    queryKey: ['agentRemoteSessions', executor, controlsWorkspaceId],
    queryFn: async () => {
      const [local, remote] = await Promise.all([
        agentsApi.listLocalHistory(executor!).catch(() => null),
        previousSessionContinuationEnabled && supportsRemoteSessionList
          ? agentsApi
              .listRemoteSessions(executor!, controlsWorkspaceId!, null)
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      if (!local && !remote) {
        throw new Error('No Agent history source could be read');
      }
      const seen = new Set<string>();
      const sessions = [
        ...(remote?.sessions ?? []),
        ...(local?.sessions ?? []),
      ].filter((session) => {
        if (seen.has(session.acp_session_id)) return false;
        seen.add(session.acp_session_id);
        return true;
      });
      return { sessions, next_cursor: null, meta: null };
    },
    enabled: Boolean(remoteSessionsOpen && executor && controlsWorkspaceId),
    staleTime: 0,
    retry: false,
  });
  const visibleConfigOptions = visibleSessionConfigOptions(
    activeControls?.config_options ?? []
  );
  const presentableConfigOptions = presentableSessionConfigOptions(
    visibleConfigOptions,
    activeControls?.modes ?? []
  );
  const handleSelectMode = (modeId: string) => {
    setSelectedMode(modeId);
  };
  const handleSelectConfigValue = (key: string, value: string) => {
    setSelectedConfigValues((previous) =>
      selectConfigOptionValue(visibleConfigOptions, previous, key, value)
    );
  };
  const advertisedConfigValues = Object.fromEntries(
    visibleConfigOptions.flatMap((option) => {
      const value = jsonValueToString(option.value ?? null);
      return value ? [[option.key, value]] : [];
    })
  );
  const sanitizedConfigValues = sanitizeDependentConfigValues(
    visibleConfigOptions,
    {
      ...advertisedConfigValues,
      ...selectedConfigValues,
    }
  );
  const presentableConfigKeys = new Set(
    presentableConfigOptions.map((option) => option.key)
  );
  const configOverrides = Object.fromEntries(
    Object.entries(sanitizedConfigValues).filter(([key]) =>
      presentableConfigKeys.has(key)
    )
  );
  const defaultMode = preferredCreationMode(
    executor,
    activeControls?.modes ?? [],
    activeControls?.current_mode ?? null
  );
  const modeOverride = selectedMode ?? defaultMode;
  const currentControlsPreset = activeControls
    ? { modeOverride, configOverrides }
    : null;
  // Legacy Session Modes remain a per-session choice. ADR-0035 requires them
  // to pass through the Config Option adapter before they can participate in
  // the single persisted-defaults data flow.
  const currentDefaultsFingerprint = currentControlsPreset
    ? JSON.stringify(
        Object.entries(currentControlsPreset.configOverrides).sort(
          ([left], [right]) => left.localeCompare(right)
        )
      )
    : null;
  useEffect(() => {
    if (
      !currentDefaultsFingerprint ||
      savedDefaultsFingerprint ||
      defaultsHydratedAgent !== executor
    ) {
      return;
    }
    setSavedDefaultsFingerprint(currentDefaultsFingerprint);
  }, [
    currentDefaultsFingerprint,
    defaultsHydratedAgent,
    executor,
    savedDefaultsFingerprint,
  ]);
  const sessionDefaultsChanged = Boolean(
    currentDefaultsFingerprint &&
      savedDefaultsFingerprint &&
      currentDefaultsFingerprint !== savedDefaultsFingerprint
  );
  const saveAgentDefaults = async () => {
    if (!executor) return;
    const rawDefaults = Object.fromEntries(
      visibleConfigOptions.flatMap((option) => {
        const serialized = configOverrides[option.key];
        if (serialized === undefined) return [];
        const advertisedChoice = (option.choices ?? []).find(
          (choice) => jsonValueToString(choice.value) === serialized
        );
        if (advertisedChoice) {
          return [[option.key, advertisedChoice.value]];
        }
        if (typeof option.value === 'boolean') {
          return [[option.key, serialized === 'true']];
        }
        return [[option.key, serialized]];
      })
    );
    setDefaultsSaveState('saving');
    try {
      await agentsApi.setSessionDefaults(executor, rawDefaults);
      queryClient.setQueryData(['agentSessionDefaults', executor], {
        values: rawDefaults,
        staleIds: [],
      });
      setDefaultsSaveState('saved');
      if (currentDefaultsFingerprint) {
        setSavedDefaultsFingerprint(currentDefaultsFingerprint);
      }
    } catch {
      setDefaultsSaveState('error');
    }
  };
  useEffect(() => {
    onSessionControlsPresetChange?.(
      activeControls
        ? {
            modeOverride,
            configOverrides,
          }
        : null
    );
  }, [
    activeControls,
    configOverrides,
    modeOverride,
    onSessionControlsPresetChange,
  ]);
  const hasControls =
    activeControls !== null &&
    (activeControls.modes.length > 0 ||
      presentableConfigOptions.some(
        (option) =>
          typeof option.value === 'boolean' ||
          resolvedConfigOptionChoices(
            option,
            visibleConfigOptions,
            sanitizedConfigValues
          ).length > 1
      ));
  const controlsPending = Boolean(executor) && controlsQuery.isPending;
  const preparationError = controlsQuery.error
    ? t('sessionCreation.controlsPrepareFailed', {
        agent: executor,
        error: String(controlsQuery.error),
      })
    : null;
  const canUseExistingWorkspace = workspaceBranchOptions.length > 0;
  const workspaceWarning = getWorkspaceBranchWarning(selectedWorkspaceOption);
  const workspaceCheckoutHint = getWorkspaceBranchCheckoutHint(
    selectedWorkspaceOption
  );
  const importPreviousSession = async (
    acpSessionId: string,
    title: string | null,
    localHistory: boolean
  ) => {
    if (!executor || !controlsWorkspaceId) return;
    setRemoteSessionAction(acpSessionId);
    setRemoteSessionStatus('idle');
    try {
      const conversation = localHistory
        ? await agentsApi.importLocalHistory(
            executor,
            controlsWorkspaceId,
            acpSessionId,
            title
          )
        : await agentsApi.importRemoteSession(
            executor,
            controlsWorkspaceId,
            acpSessionId,
            title
          );
      setRemoteSessionStatus('imported');
      onRemoteSessionImported?.(conversation.id);
    } catch {
      setRemoteSessionStatus('error');
    } finally {
      setRemoteSessionAction(null);
    }
  };
  return (
    <form
      className={cn('space-y-4', className)}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="space-y-2">
        <Label>{t('sessionCreation.creationMethod')}</Label>
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant={mode === 'existing_workspace' ? 'default' : 'outline'}
            disabled={!canUseExistingWorkspace || isSubmitting}
            onClick={() => onModeChange('existing_workspace')}
            className="h-8 text-xs"
          >
            {t('sessionCreation.existingWorkspace')}
          </Button>
          <Button
            type="button"
            variant={mode === 'new_workspace' ? 'default' : 'outline'}
            disabled={isSubmitting}
            onClick={() => onModeChange('new_workspace')}
            className="h-8 text-xs"
          >
            {t('sessionCreation.newWorkspace')}
          </Button>
        </div>
      </div>

      {mode === 'existing_workspace' ? (
        <div className="space-y-2">
          <Label htmlFor="session-create-workspace">
            {t('sessionCreation.workspaceBranch')}
          </Label>
          <WorkspaceSelector
            options={workspaceBranchOptions}
            value={selectedWorkspaceValue}
            onChange={onSelectedWorkspaceValueChange}
            disabled={isSubmitting || !canUseExistingWorkspace}
            className="text-sm"
            dropdownSide={dropdownSide}
          />
          {workspaceWarning ? (
            <div className="rounded-md border border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.1)] px-3 py-2 text-[11px] text-[hsl(var(--warning))]">
              <p>{workspaceWarning}</p>
              {workspaceCheckoutHint ? (
                <p className="mt-1 text-[hsl(var(--warning)/0.9)]">
                  {workspaceCheckoutHint}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
          <div className="text-[11px] text-muted-foreground">
            {t('sessionCreation.newWorkspaceHint')}
          </div>
          <RepoBranchSelector
            configs={repoBranchConfigs}
            onBranchChange={onRepoBranchChange}
            isLoading={isLoadingBranches}
            className="space-y-2"
            dropdownSide={dropdownSide}
          />
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="session-create-name">
          {t('sessionCreation.sessionNameLabel')}
        </Label>
        <Input
          id="session-create-name"
          value={sessionName}
          onChange={(event) => onSessionNameChange(event.target.value)}
          placeholder={t('sessionCreation.sessionNamePlaceholder')}
          className="h-9 text-sm"
        />
      </div>

      <div className="space-y-2">
        <Label>{t('sessionCreation.codingAgent')}</Label>
        <TerminalProfileControls
          profiles={profiles}
          selectedProfile={selectedExecutorProfile}
          onChange={onSelectedExecutorProfileChange}
          disabled={isSubmitting}
          dropdownSide={dropdownSide}
          suppressAcpManagedControls={true}
          className={cn('w-full', compact && 'min-w-0')}
        />
        {hasControls && activeControls ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <SessionSettingsSummary
                sessionModes={{
                  current: activeControls.current_mode ?? null,
                  modes: activeControls.modes,
                }}
                options={visibleConfigOptions}
                selectedMode={modeOverride}
                pending={configOverrides}
                onSelectMode={handleSelectMode}
                onSelectConfigOption={handleSelectConfigValue}
                disabled={isSubmitting}
                dropdownSide={dropdownSide}
              />
              {sessionDefaultsChanged ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 rounded-full text-[11px]"
                  disabled={isSubmitting || defaultsSaveState === 'saving'}
                  onClick={() => void saveAgentDefaults()}
                >
                  {defaultsSaveState === 'saving'
                    ? t('sessionCreation.savingAgentDefaults')
                    : t('sessionCreation.saveAgentDefaults')}
                </Button>
              ) : null}
            </div>
            {defaultsSaveState === 'saved' ? (
              <p className="text-[11px] text-muted-foreground" role="status">
                {t('sessionCreation.agentDefaultsSaved')}
              </p>
            ) : defaultsSaveState === 'error' ? (
              <p className="text-[11px] text-destructive" role="alert">
                {t('sessionCreation.agentDefaultsSaveFailed')}
              </p>
            ) : null}
            {catalogFreshnessQuery.data === false ? (
              <p className="text-[11px] text-muted-foreground" role="status">
                {catalogRefreshFailed
                  ? t('sessionCreation.catalogRefreshFailed')
                  : t('sessionCreation.catalogRefreshing')}
              </p>
            ) : null}
          </>
        ) : executor && controlsPending ? (
          <p className="text-[11px] text-muted-foreground">
            {t('sessionCreation.controlsLoading')}
          </p>
        ) : null}
        {controlsWorkspaceId ? (
          <div className="space-y-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-between px-1 text-xs font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
              disabled={isSubmitting}
              aria-expanded={remoteSessionsOpen}
              onClick={() => setRemoteSessionsOpen((open) => !open)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <History className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  {t('sessionCreation.continuePreviousSession')}
                </span>
              </span>
              <ChevronDown
                className={cn(
                  'h-3.5 w-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none',
                  remoteSessionsOpen && 'rotate-180'
                )}
              />
            </Button>
            {remoteSessionsOpen ? (
              remoteSessionsQuery.isPending ? (
                <p className="px-1 py-2 text-[11px] text-muted-foreground">
                  {t('sessionCreation.remoteSessionsLoading')}
                </p>
              ) : remoteSessionsQuery.error ? (
                <p
                  className="px-1 py-2 text-[11px] text-destructive"
                  role="alert"
                >
                  {t('sessionCreation.remoteSessionsLoadFailed')}
                </p>
              ) : remoteSessionsQuery.data?.sessions.length ? (
                <div className="divide-y divide-border/60">
                  {remoteSessionsQuery.data.sessions.map((remote) => (
                    <div
                      key={remote.acp_session_id}
                      className="flex items-center justify-between gap-3 px-1 py-2"
                    >
                      <div className="min-w-0">
                        <p className="line-clamp-2 text-xs leading-5 text-foreground">
                          {remote.title?.trim() ||
                            t('sessionCreation.untitledPreviousSession')}
                        </p>
                        {isLocalHistoryMeta(remote.meta) ? (
                          <p className="text-[10px] leading-4 text-muted-foreground">
                            {t('sessionCreation.localHistoryBadge')}
                          </p>
                        ) : null}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 shrink-0 px-2 text-[11px] text-primary hover:bg-primary/10 hover:text-primary"
                        disabled={remoteSessionAction !== null}
                        onClick={() =>
                          void importPreviousSession(
                            remote.acp_session_id,
                            remote.title ?? null,
                            isLocalHistoryMeta(remote.meta)
                          )
                        }
                      >
                        {isLocalHistoryMeta(remote.meta)
                          ? t('sessionCreation.importThisSession')
                          : t('sessionCreation.connectThisSession')}
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="px-1 py-2 text-[11px] text-muted-foreground">
                  {t('sessionCreation.noRemoteSessions')}
                </p>
              )
            ) : null}
            {remoteSessionStatus === 'imported' ? (
              <p
                className="px-1 pt-1 text-[11px] text-muted-foreground"
                role="status"
              >
                {t('sessionCreation.remoteSessionConnected')}
              </p>
            ) : remoteSessionStatus === 'error' ? (
              <p
                className="px-1 pt-1 text-[11px] text-destructive"
                role="alert"
              >
                {t('sessionCreation.remoteSessionActionFailed')}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {errorMessage || preparationError ? (
        <p className="text-sm text-destructive">
          {errorMessage ?? preparationError}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        {onCancel ? (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            {resolvedCancelLabel}
          </Button>
        ) : null}
        <Button
          type="submit"
          disabled={
            !canSubmit || isSubmitting || Boolean(executor && !activeControls)
          }
        >
          {isSubmitting ? t('sessionCreation.creating') : resolvedSubmitLabel}
        </Button>
      </div>
    </form>
  );
}
