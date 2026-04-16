import type {
  ExecutorConfigs,
  ExecutorProfileId,
  Workspace,
} from 'shared/types';
import type { RepoBranchConfig } from '@/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TerminalProfileControls } from '@/components/tasks/TerminalProfileControls';
import RepoBranchSelector from '@/components/tasks/RepoBranchSelector';
import { WorkspaceSelector } from './WorkspaceSelector';
import { cn } from '@/lib/utils';

export type SessionCreationMode = 'existing_workspace' | 'new_workspace';

interface SessionCreationFormProps {
  mode: SessionCreationMode;
  onModeChange: (mode: SessionCreationMode) => void;
  createWorkspaceOptions: Workspace[];
  selectedWorkspaceId: string;
  onSelectedWorkspaceIdChange: (value: string) => void;
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
  createWorkspaceOptions,
  selectedWorkspaceId,
  onSelectedWorkspaceIdChange,
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
  submitLabel = '创建会话',
  cancelLabel = '取消',
  className,
  compact = false,
  dropdownSide = 'bottom',
}: SessionCreationFormProps) {
  const canUseExistingWorkspace = createWorkspaceOptions.length > 0;

  return (
    <form
      className={cn('space-y-4', className)}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="space-y-2">
        <Label>创建方式</Label>
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant={mode === 'existing_workspace' ? 'default' : 'outline'}
            disabled={!canUseExistingWorkspace || isSubmitting}
            onClick={() => onModeChange('existing_workspace')}
            className="h-8 text-xs"
          >
            现有工作区
          </Button>
          <Button
            type="button"
            variant={mode === 'new_workspace' ? 'default' : 'outline'}
            disabled={isSubmitting}
            onClick={() => onModeChange('new_workspace')}
            className="h-8 text-xs"
          >
            新工作区
          </Button>
        </div>
      </div>

      {mode === 'existing_workspace' ? (
        <div className="space-y-2">
          <Label htmlFor="session-create-workspace">工作区</Label>
          <WorkspaceSelector
            workspaces={createWorkspaceOptions}
            value={selectedWorkspaceId}
            onChange={onSelectedWorkspaceIdChange}
            disabled={isSubmitting || !canUseExistingWorkspace}
            className="text-sm"
            dropdownSide={dropdownSide}
          />
        </div>
      ) : (
        <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
          <div className="text-[11px] text-muted-foreground">
            基于 target branch 创建新的 worktree 工作区，然后在其中创建会话。
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
        <Label htmlFor="session-create-name">会话名称（可选）</Label>
        <Input
          id="session-create-name"
          value={sessionName}
          onChange={(event) => onSessionNameChange(event.target.value)}
          placeholder="不填则使用首条消息自动命名"
          className="h-9 text-sm"
        />
      </div>

      <div className="space-y-2">
        <Label>编程代理</Label>
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
            {cancelLabel}
          </Button>
        ) : null}
        <Button type="submit" disabled={!canSubmit}>
          {isSubmitting ? '创建中...' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
