import { useTranslation } from 'react-i18next';
import type { ExecutorConfigs, ExecutorProfileId } from 'shared/types';
import type { RepoBranchConfig } from '@/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TerminalProfileControls } from '@/components/tasks/TerminalProfileControls';
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
}: SessionCreationFormProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const resolvedSubmitLabel = submitLabel ?? t('sessionCreation.submit');
  const resolvedCancelLabel = cancelLabel ?? t('common:cancel');
  const canUseExistingWorkspace = workspaceBranchOptions.length > 0;
  const selectedWorkspaceOption = findWorkspaceBranchOption(
    workspaceBranchOptions,
    selectedWorkspaceValue
  );
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
          className={cn(
            'flex flex-wrap items-center gap-2',
            compact ? 'grid gap-2 sm:grid-cols-[minmax(0,1.2fr)_auto_auto]' : ''
          )}
        />
      </div>

      {errorMessage ? (
        <p className="text-sm text-destructive">{errorMessage}</p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel}>
            {resolvedCancelLabel}
          </Button>
        ) : null}
        <Button type="submit" disabled={!canSubmit}>
          {isSubmitting
            ? t('sessionCreation.creating')
            : resolvedSubmitLabel}
        </Button>
      </div>
    </form>
  );
}
