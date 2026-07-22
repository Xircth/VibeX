import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ExecutorConfigs, ExecutorProfileId } from 'shared/types';
import type { RepoBranchConfig } from '@/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TerminalProfileControls } from '@/components/tasks/TerminalProfileControls';
import {
  jsonValueToString,
  resolvedConfigOptionChoices,
  visibleSessionConfigOptions,
} from '@/components/tasks/follow-up/SessionConfigOptionSelectors';
import { SessionSettingsSummary } from '@/components/tasks/follow-up/SessionSettingsSummary';
import { agentsApi } from '@/features/agents/api';
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
 * Identity of the concrete ACP session prepared by this form. The persisted
 * conversation adopts this UUID, so no control values need to be copied into
 * a second session or replayed as first-turn overrides.
 */
export interface SessionControlsPreset {
  preparedSessionId: string;
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
  /** Reports the current ACP control preset (null when nothing was picked). */
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
}: SessionCreationFormProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const resolvedSubmitLabel = submitLabel ?? t('sessionCreation.submit');
  const resolvedCancelLabel = cancelLabel ?? t('common:cancel');
  const executor = selectedExecutorProfile?.executor ?? null;
  const selectedWorkspaceOption = findWorkspaceBranchOption(
    workspaceBranchOptions,
    selectedWorkspaceValue
  );
  const preparedWorkspaceId =
    mode === 'existing_workspace'
      ? (selectedWorkspaceOption?.existingWorkspaceId ?? null)
      : null;
  const preparedSessionKey = `${executor ?? ''}:${preparedWorkspaceId ?? ''}`;
  const preparedSessionIdentityRef = useRef<{
    key: string;
    id: string;
  } | null>(null);
  const scheduledDiscardsRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  );
  if (preparedSessionIdentityRef.current?.key !== preparedSessionKey) {
    preparedSessionIdentityRef.current = {
      key: preparedSessionKey,
      id: crypto.randomUUID(),
    };
  }
  const preparedSessionId = preparedSessionIdentityRef.current.id;
  const wantsPreparedSession = Boolean(executor && preparedWorkspaceId);
  const wantedPreparedSessionIdRef = useRef<string | null>(null);
  wantedPreparedSessionIdRef.current = wantsPreparedSession
    ? preparedSessionId
    : null;
  const preparedSessionQuery = useQuery({
    queryKey: [
      'agent-prepared-session',
      executor,
      preparedWorkspaceId,
      preparedSessionId,
    ],
    queryFn: async ({ signal }) => {
      const prepared = await agentsApi.prepareSession({
        agentType: executor!,
        workspaceId: preparedWorkspaceId!,
        sessionId: preparedSessionId,
      });
      if (
        signal.aborted &&
        wantedPreparedSessionIdRef.current !== preparedSessionId
      ) {
        await agentsApi.discardPreparedSession(preparedSessionId);
        throw new Error('Prepared ACP session was cancelled');
      }
      return prepared;
    },
    enabled: wantsPreparedSession,
    staleTime: Infinity,
    retry: false,
  });
  const [controlsSource, setControlsSource] = useState<{
    sessionId: string;
    modes: NonNullable<typeof preparedSessionQuery.data>['controls']['modes'];
    currentModeId: string | null;
    configOptions: NonNullable<
      typeof preparedSessionQuery.data
    >['controls']['config_options'];
  } | null>(null);
  const [isChangingControl, setIsChangingControl] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  useEffect(() => {
    wantedPreparedSessionIdRef.current = wantsPreparedSession
      ? preparedSessionId
      : null;
    return () => {
      if (wantedPreparedSessionIdRef.current === preparedSessionId) {
        wantedPreparedSessionIdRef.current = null;
      }
    };
  }, [preparedSessionId, wantsPreparedSession]);
  useEffect(() => {
    const controls = preparedSessionQuery.data?.controls;
    if (!controls) {
      setControlsSource(null);
      return;
    }
    setControlsSource({
      sessionId: preparedSessionId,
      modes: controls.modes,
      currentModeId: controls.current_mode ?? null,
      configOptions: controls.config_options,
    });
  }, [preparedSessionId, preparedSessionQuery.data]);
  useEffect(() => {
    onSessionControlsPresetChange?.(
      preparedSessionQuery.data ? { preparedSessionId } : null
    );
  }, [
    onSessionControlsPresetChange,
    preparedSessionId,
    preparedSessionQuery.data,
  ]);
  useEffect(() => {
    if (!preparedSessionQuery.data) return;

    const scheduledDiscards = scheduledDiscardsRef.current;
    // React Strict Mode replays effects by running cleanup and setup again.
    // Delay disposal until the next task so the repeated setup can cancel it;
    // a real executor/workspace change (or unmount) leaves it scheduled.
    const scheduledDiscard = scheduledDiscards.get(preparedSessionId);
    if (scheduledDiscard) {
      clearTimeout(scheduledDiscard);
      scheduledDiscards.delete(preparedSessionId);
    }

    return () => {
      const previousDiscard = scheduledDiscards.get(preparedSessionId);
      if (previousDiscard) clearTimeout(previousDiscard);
      const timeout = setTimeout(() => {
        scheduledDiscards.delete(preparedSessionId);
        void agentsApi
          .discardPreparedSession(preparedSessionId)
          .catch((error) => {
            console.warn('Failed to discard prepared ACP session', error);
          });
      }, 0);
      scheduledDiscards.set(preparedSessionId, timeout);
    };
  }, [preparedSessionId, preparedSessionQuery.data]);
  const replaceControls = (
    controls: NonNullable<typeof preparedSessionQuery.data>['controls']
  ) => {
    setControlsSource({
      sessionId: preparedSessionId,
      modes: controls.modes,
      currentModeId: controls.current_mode ?? null,
      configOptions: controls.config_options,
    });
  };
  const activeControls =
    controlsSource?.sessionId === preparedSessionId ? controlsSource : null;
  const visibleConfigOptions = visibleSessionConfigOptions(
    activeControls?.configOptions ?? []
  );
  const handleSelectMode = async (modeId: string) => {
    setIsChangingControl(true);
    setControlError(null);
    try {
      replaceControls(
        await agentsApi.setPreparedSessionMode(preparedSessionId, modeId)
      );
    } catch (error) {
      setControlError(
        t('sessionCreation.controlsUpdateFailed', {
          agent: executor,
          option: modeId,
          sessionId: preparedSessionId,
          error: String(error),
        })
      );
    } finally {
      setIsChangingControl(false);
    }
  };
  const handleSelectConfigValue = async (key: string, value: string) => {
    const option = activeControls?.configOptions.find(
      (candidate) => candidate.key === key
    );
    const selected = option?.choices?.find(
      (choice) => jsonValueToString(choice.value) === value
    );
    if (!selected) return;
    setIsChangingControl(true);
    setControlError(null);
    try {
      replaceControls(
        await agentsApi.setPreparedSessionConfig(
          preparedSessionId,
          key,
          selected.value
        )
      );
    } catch (error) {
      setControlError(
        t('sessionCreation.controlsUpdateFailed', {
          agent: executor,
          option: key,
          sessionId: preparedSessionId,
          error: String(error),
        })
      );
    } finally {
      setIsChangingControl(false);
    }
  };
  const hasControls =
    activeControls !== null &&
    (activeControls.modes.length > 0 ||
      visibleConfigOptions.some(
        (option) =>
          typeof option.value === 'boolean' ||
          resolvedConfigOptionChoices(option, visibleConfigOptions, {}).length >
            1
      ));
  // Don't flash the "after first session" hint while the backend answer is in
  // flight for an agent we haven't resolved yet.
  const controlsPending =
    Boolean(executor && preparedWorkspaceId) && preparedSessionQuery.isPending;
  const preparationError = preparedSessionQuery.error
    ? t('sessionCreation.controlsPrepareFailed', {
        agent: executor,
        sessionId: preparedSessionId,
        error: String(preparedSessionQuery.error),
      })
    : null;
  const canUseExistingWorkspace = workspaceBranchOptions.length > 0;
  const workspaceWarning = getWorkspaceBranchWarning(selectedWorkspaceOption);
  const workspaceCheckoutHint = getWorkspaceBranchCheckoutHint(
    selectedWorkspaceOption
  );

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
          className={cn(
            'flex flex-wrap items-center gap-2',
            compact ? 'grid gap-2 sm:grid-cols-[minmax(0,1.2fr)_auto_auto]' : ''
          )}
        />
        {hasControls && activeControls ? (
          <SessionSettingsSummary
            sessionModes={{
              current: activeControls.currentModeId,
              modes: activeControls.modes,
            }}
            options={visibleConfigOptions}
            pending={{}}
            onSelectMode={handleSelectMode}
            onSelectConfigOption={handleSelectConfigValue}
            disabled={isSubmitting || isChangingControl}
            dropdownSide={dropdownSide}
          />
        ) : executor && controlsPending ? (
          <p className="text-[11px] text-muted-foreground">
            {t('sessionCreation.controlsLoading')}
          </p>
        ) : executor && !preparationError ? (
          <p className="text-[11px] text-muted-foreground">
            {t('sessionCreation.controlsUnavailable')}
          </p>
        ) : null}
      </div>

      {errorMessage || controlError || preparationError ? (
        <p className="text-sm text-destructive">
          {errorMessage ?? controlError ?? preparationError}
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
            !canSubmit ||
            isSubmitting ||
            isChangingControl ||
            Boolean(executor && preparedWorkspaceId && !activeControls)
          }
        >
          {isSubmitting ? t('sessionCreation.creating') : resolvedSubmitLabel}
        </Button>
      </div>
    </form>
  );
}
