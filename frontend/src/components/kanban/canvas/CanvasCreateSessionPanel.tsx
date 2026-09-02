import { useTranslation } from 'react-i18next';
import type { ExecutorConfigs, ExecutorProfileId } from 'shared/types';
import type { RepoBranchConfig } from '@/hooks';
import {
  SessionCreationForm,
  type SessionControlsPreset,
  type SessionCreationMode,
} from '@/components/sessions/SessionCreationForm';
import { getSessionUiErrorMessage } from '@/lib/sessionUiErrors';
import type { WorkspaceBranchOption } from '@/lib/workspaceBranchOptions';
import { cn } from '@/lib/utils';

interface CanvasCreateSessionPanelProps {
  createMode: SessionCreationMode;
  onCreateModeChange: (mode: SessionCreationMode) => void;
  workspaceBranchOptions: WorkspaceBranchOption[];
  createWorkspaceValue: string;
  onCreateWorkspaceValueChange: (value: string) => void;
  createSessionName: string;
  onCreateSessionNameChange: (value: string) => void;
  profiles: ExecutorConfigs['executors'] | null;
  selectedExecutorProfile: ExecutorProfileId | null;
  onSelectedExecutorProfileChange: (value: ExecutorProfileId) => void;
  repoBranchConfigs: RepoBranchConfig[];
  onRepoBranchChange: (repoId: string, branch: string) => void;
  isLoadingRepoBranches: boolean;
  canCreateSession: boolean;
  isCreatePending: boolean;
  createError: unknown;
  onSubmit: () => void;
  onClose: () => void;
  onSessionControlsPresetChange?: (
    preset: SessionControlsPreset | null
  ) => void;
}

export function CanvasCreateSessionPanel({
  createMode,
  onCreateModeChange,
  workspaceBranchOptions,
  createWorkspaceValue,
  onCreateWorkspaceValueChange,
  createSessionName,
  onCreateSessionNameChange,
  profiles,
  selectedExecutorProfile,
  onSelectedExecutorProfileChange,
  repoBranchConfigs,
  onRepoBranchChange,
  isLoadingRepoBranches,
  canCreateSession,
  isCreatePending,
  createError,
  onSubmit,
  onClose,
  onSessionControlsPresetChange,
}: CanvasCreateSessionPanelProps) {
  const { t } = useTranslation(['tasks', 'common']);

  return (
    <div
      className={cn(
        'session-canvas-create-panel flex max-h-[calc(100%-1.5rem)] w-[360px] flex-col',
        'overflow-hidden rounded-xl border border-border p-4',
        'shadow-[var(--shadow-popover)]'
      )}
    >
      <div className="mb-3 text-sm font-semibold text-foreground">
        {t('hubSidebar.newSession')}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
        <SessionCreationForm
          mode={createMode}
          onModeChange={onCreateModeChange}
          workspaceBranchOptions={workspaceBranchOptions}
          selectedWorkspaceValue={createWorkspaceValue}
          onSelectedWorkspaceValueChange={onCreateWorkspaceValueChange}
          sessionName={createSessionName}
          onSessionNameChange={onCreateSessionNameChange}
          profiles={profiles}
          selectedExecutorProfile={selectedExecutorProfile}
          onSelectedExecutorProfileChange={onSelectedExecutorProfileChange}
          repoBranchConfigs={repoBranchConfigs}
          onRepoBranchChange={onRepoBranchChange}
          isLoadingBranches={isLoadingRepoBranches}
          onSessionControlsPresetChange={onSessionControlsPresetChange}
          canSubmit={canCreateSession}
          isSubmitting={isCreatePending}
          errorMessage={
            createError
              ? getSessionUiErrorMessage(
                  createError,
                  t('sessionHub.createFailed')
                )
              : null
          }
          onSubmit={onSubmit}
          onCancel={onClose}
        />
      </div>
    </div>
  );
}
