import { useCallback } from 'react';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import { Check, Copy, FileDiff, GitBranch, Settings } from 'lucide-react';
import { GitActionsDialog } from '@/components/dialogs/tasks/GitActionsDialog';
import { useOpenInEditor } from '@/hooks/useOpenInEditor';
import { useDiffSummary } from '@/hooks/useDiffSummary';
import { Button } from '@/components/ui/button';
import { IdeIcon, getIdeName } from '@/components/ide/IdeIcon';
import { useUserSystem } from '@/components/ConfigProvider';
import { useQuery } from '@tanstack/react-query';
import { attemptsApi, settingsWindowApi } from '@/lib/api';
import { type EditorType, type TaskWithAttemptStatus } from 'shared/types';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import { useNavigateWithSearch } from '@/hooks/useNavigateWithSearch';
import { cn } from '@/lib/utils';

type NextActionCardProps = {
  attemptId?: string;
  sessionId?: string;
  containerRef?: string | null;
  failed: boolean;
  task?: TaskWithAttemptStatus;
  needsSetup?: boolean;
  setupHelpText?: string | null;
};

type NextActionHeaderProps = {
  title: string;
};

function NextActionHeader({ title }: NextActionHeaderProps) {
  return (
    <div className="flex bg-muted/60 px-3 py-1.5 text-sm font-medium text-foreground">
      <span className="flex-1">{title}</span>
    </div>
  );
}

type DiffSummarySectionProps = {
  fileCount: number;
  added: number;
  deleted: number;
  error: string | null;
  onOpenDiffs: () => void;
};

function DiffSummarySection({
  fileCount,
  added,
  deleted,
  error,
  onOpenDiffs,
}: DiffSummarySectionProps) {
  if (error || fileCount <= 0) {
    return null;
  }

  return (
    <button
      onClick={onOpenDiffs}
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm shrink-0 cursor-pointer transition-colors hover:bg-muted/60"
      aria-label={'查看差异'}
    >
      <span>{`${fileCount} 个文件已更改`}</span>
      <span className="opacity-50">•</span>
      <span className="text-[hsl(var(--success))]">+{added}</span>
      <span className="opacity-50">•</span>
      <span className="text-destructive">-{deleted}</span>
    </button>
  );
}

type ActionButtonsSectionProps = {
  attemptId?: string;
  containerRef?: string | null;
  copied: boolean;
  editorName: string;
  editorType: EditorType | null | undefined;
  hasDiffs: boolean;
  onOpenDiffs: () => void;
  onCopy: () => void;
  onOpenInEditor: () => void;
  onGitActions: () => void;
};

function ActionButtonsSection({
  attemptId,
  containerRef,
  copied,
  editorName,
  editorType,
  hasDiffs,
  onOpenDiffs,
  onCopy,
  onOpenInEditor,
  onGitActions,
}: ActionButtonsSectionProps) {
  if (!hasDiffs) {
    return null;
  }

  return (
    <div className="flex items-center gap-1 shrink-0 sm:ml-auto">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={onOpenDiffs}
            aria-label={'查看差异'}
          >
            <FileDiff className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{'查看差异'}</TooltipContent>
      </Tooltip>

      {containerRef && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={onCopy}
              aria-label={'复制工作树路径'}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-[hsl(var(--success))]" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {copied ? '已复制！' : '复制工作树路径'}
          </TooltipContent>
        </Tooltip>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={onOpenInEditor}
            disabled={!attemptId}
            aria-label={`在 ${editorName} 中查看更改`}
          >
            <IdeIcon editorType={editorType} className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{`在 ${editorName} 中查看更改`}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={onGitActions}
            disabled={!attemptId}
            aria-label={'Git 操作'}
          >
            <GitBranch className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{'Git 操作'}</TooltipContent>
      </Tooltip>
    </div>
  );
}

type PrimaryActionsSectionProps = {
  failed: boolean;
  needsSetup?: boolean;
  setupHelpText: string | null;
  attempt: Awaited<ReturnType<typeof attemptsApi.getWithSession>> | undefined;
  onRunSetup: () => void;
};

function PrimaryActionsSection({
  failed,
  needsSetup,
  setupHelpText,
  attempt,
  onRunSetup,
}: PrimaryActionsSectionProps) {
  const showSetupHelp = needsSetup && setupHelpText;
  const showAction = failed && needsSetup;

  if (!showSetupHelp && !showAction) {
    return null;
  }

  return (
    <div className="px-3 py-2">
      {showSetupHelp && (
        <div className="flex items-start gap-2 text-sm text-muted-foreground mb-2">
          <Settings className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{setupHelpText}</span>
        </div>
      )}

      {showAction && (
        <Button
          variant="default"
          size="sm"
          onClick={onRunSetup}
          disabled={!attempt}
          className="text-sm w-full sm:w-auto"
          aria-label={'运行设置'}
        >
          {'运行设置'}
        </Button>
      )}
    </div>
  );
}

export function NextActionCard({
  attemptId,
  containerRef,
  failed,
  task,
  needsSetup,
  setupHelpText: initialSetupHelpText,
}: NextActionCardProps) {
  const { config } = useUserSystem();
  const panelActions = useOptionalPanelActionsContext();
  const navigateWithSearch = useNavigateWithSearch();
  const [copied, triggerCopied] = useTemporaryFlag(2000);

  const { data: attempt } = useQuery({
    queryKey: ['attemptWithSession', attemptId],
    queryFn: () => attemptsApi.getWithSession(attemptId!),
    enabled: !!attemptId && failed,
  });

  const openInEditor = useOpenInEditor(attemptId);
  const { fileCount, added, deleted, error, isInitialized } = useDiffSummary(
    attemptId ?? null
  );

  const handleCopy = useCallback(async () => {
    if (!containerRef) return;

    try {
      await navigator.clipboard.writeText(containerRef);
      triggerCopied();
    } catch (err) {
      console.warn('Copy to clipboard failed:', err);
    }
  }, [containerRef, triggerCopied]);

  const handleOpenInEditor = useCallback(() => {
    openInEditor();
  }, [openInEditor]);

  const handleOpenDiffs = useCallback(() => {
    if (panelActions) {
      panelActions.openDiffPreview();
      return;
    }

    const params = new URLSearchParams();
    params.set('view', 'diffs');
    navigateWithSearch({ search: `?${params.toString()}` });
  }, [navigateWithSearch, panelActions]);

  const handleGitActions = useCallback(() => {
    if (!attemptId) return;
    GitActionsDialog.show({
      attemptId,
      task,
    });
  }, [attemptId, task]);

  const handleRunSetup = useCallback(async () => {
    try {
      await settingsWindowApi.open();
    } catch (error) {
      console.error('Failed to open agent settings:', error);
    }
  }, []);

  const setupHelpText = initialSetupHelpText ?? null;

  const editorName = getIdeName(config?.editor?.editor_type);
  const hasDiffs = fileCount > 0 && !error;
  const showPrimaryActions = !!(
    (failed && needsSetup) ||
    (needsSetup && setupHelpText)
  );
  const shouldShowPlaceholder =
    !isInitialized && !hasDiffs && !showPrimaryActions;

  if (!showPrimaryActions && fileCount === 0 && !shouldShowPlaceholder) {
    return null;
  }

  return (
    <TooltipProvider>
      <div className="pb-8 pt-4">
        <div className="overflow-hidden rounded-md border border-border bg-background">
          <NextActionHeader title={'摘要和操作'} />

          <PrimaryActionsSection
            failed={failed}
            needsSetup={needsSetup}
            setupHelpText={setupHelpText}
            attempt={attempt}
            onRunSetup={handleRunSetup}
          />

          {shouldShowPlaceholder && (
            <div className="px-3 py-2">
              <div className="h-10 rounded-md bg-muted/40" />
            </div>
          )}

          {hasDiffs && (
            <div
              className={cn(
                'flex min-w-0 flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:gap-3',
                showPrimaryActions && 'border-t border-border'
              )}
            >
              <DiffSummarySection
                fileCount={fileCount}
                added={added}
                deleted={deleted}
                error={error}
                onOpenDiffs={handleOpenDiffs}
              />

              <ActionButtonsSection
                attemptId={attemptId}
                containerRef={containerRef}
                copied={copied}
                editorName={editorName}
                editorType={config?.editor?.editor_type}
                hasDiffs={hasDiffs}
                onOpenDiffs={handleOpenDiffs}
                onCopy={handleCopy}
                onOpenInEditor={handleOpenInEditor}
                onGitActions={handleGitActions}
              />
            </div>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
