import { useEffect, useState } from 'react';
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
  sanitizeDependentConfigValues,
  selectConfigOptionValue,
  visibleSessionConfigOptions,
} from '@/components/tasks/follow-up/SessionConfigOptionSelectors';
import { SessionSettingsSummary } from '@/components/tasks/follow-up/SessionSettingsSummary';
import { agentsApi } from '@/features/agents/api';
import { sessionControlsQueryKey } from '@/features/agents/sessionControlsQuery';
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
 * exists. They ride the draft into the composer and are applied to the first
 * turn through the normal mode/config override contract.
 */
export interface SessionControlsPreset {
  modeOverride: string | null;
  configOverrides: Record<string, string>;
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
  const [selectedMode, setSelectedMode] = useState<string | null>(null);
  const [selectedConfigValues, setSelectedConfigValues] = useState<
    Record<string, string>
  >({});
  useEffect(() => {
    setSelectedMode(null);
    setSelectedConfigValues({});
  }, [controlsWorkspaceId, executor]);

  const activeControls = controlsQuery.data ?? null;
  const visibleConfigOptions = visibleSessionConfigOptions(
    activeControls?.config_options ?? []
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
  const configOverrides = sanitizeDependentConfigValues(visibleConfigOptions, {
    ...advertisedConfigValues,
    ...selectedConfigValues,
  });
  const modeOverride = selectedMode ?? activeControls?.current_mode ?? null;
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
      visibleConfigOptions.some(
        (option) =>
          typeof option.value === 'boolean' ||
          resolvedConfigOptionChoices(
            option,
            visibleConfigOptions,
            configOverrides
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
              current: activeControls.current_mode ?? null,
              modes: activeControls.modes,
            }}
            options={visibleConfigOptions}
            selectedMode={selectedMode}
            pending={configOverrides}
            onSelectMode={handleSelectMode}
            onSelectConfigOption={handleSelectConfigValue}
            disabled={isSubmitting}
            dropdownSide={dropdownSide}
          />
        ) : executor && controlsPending ? (
          <p className="text-[11px] text-muted-foreground">
            {t('sessionCreation.controlsLoading')}
          </p>
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
