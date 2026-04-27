import { useCallback } from 'react';
import { Terminal, List, GitCompareArrows, StickyNote, Globe } from 'lucide-react';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { ExecutionProcessesProvider } from '@/contexts/ExecutionProcessesContext';
import { ViewProcessesDialog } from '@/components/dialogs/tasks/ViewProcessesDialog';
import { useTaskAttemptWithSession } from '@/hooks/useTaskAttempt';
import { useDevServer } from '@/hooks/useDevServer';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { PANEL_IDS } from '@/stores/useLayoutStore';

function RightPanelSidebarContent({
  workspaceId,
  sessionId,
}: {
  workspaceId?: string;
  sessionId?: string;
}) {
  const { openNewTerminal, openDiffPreview, openNotes, openOrFocusPanel } =
    usePanelActionsContext();
  const { runningDevServers, devServerProcesses } = useDevServer(workspaceId);

  const handleOpenPreview = useCallback(() => {
    openOrFocusPanel(PANEL_IDS.DEV_PREVIEW, 'Dev Preview');
  }, [openOrFocusPanel]);

  const hasRunningDevServer = runningDevServers.length > 0;
  const hasFailedDevServer = devServerProcesses.some(
    (process) =>
      process.status === 'failed' ||
      (process.status === 'completed' &&
        process.exit_code !== null &&
        process.exit_code !== 0n)
  );
  const networkButtonClass = hasRunningDevServer
    ? 'text-sky-600 hover:text-sky-700 hover:bg-sky-500/10 bg-sky-500/10 dark:text-sky-400 dark:hover:text-sky-300'
    : hasFailedDevServer
      ? 'text-destructive hover:text-destructive hover:bg-destructive/10 bg-destructive/10'
      : 'text-muted-foreground hover:text-foreground hover:bg-accent';
  const networkTooltipLabel = hasRunningDevServer
    ? '开发服务器运行中，点击打开网络预览'
    : hasFailedDevServer
      ? '开发服务器启动失败，点击查看预览与日志'
      : '打开网络预览';

  const buttons = [
    { icon: Terminal, label: 'Open Terminal', onClick: openNewTerminal },
    {
      icon: List,
      label: 'Processes',
      onClick: () =>
        ViewProcessesDialog.show({
          sessionId,
          initialProcessId: null,
        }),
    },
    { icon: GitCompareArrows, label: 'Git Diff', onClick: openDiffPreview },
    { icon: StickyNote, label: 'Notes', onClick: openNotes },
  ];

  return (
    <TooltipProvider delayDuration={200}>
      <div className="workspace-divider-left relative flex w-9 shrink-0 flex-col items-center gap-0.5 bg-secondary/30 pt-2">
        {buttons.map((button) => {
          const Icon = button.icon;
          return (
            <Tooltip key={button.label}>
              <TooltipTrigger asChild>
                <button
                  onClick={button.onClick}
                  className="h-7 w-7 flex items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">{button.label}</TooltipContent>
            </Tooltip>
          );
        })}

        <div className="my-1 h-px w-5 bg-border" />

        {workspaceId && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleOpenPreview}
                className={`h-7 w-7 flex items-center justify-center rounded transition-colors ${networkButtonClass}`}
              >
                <Globe className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">{networkTooltipLabel}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  );
}

export function RightPanelSidebar() {
  const { activeWorktreeId } = useWorktree();
  const { visibleRightSession } = useKanbanSessionContext();
  const effectiveWorkspaceId =
    visibleRightSession?.workspaceId ?? activeWorktreeId ?? undefined;
  const explicitSessionId = visibleRightSession?.sessionId;
  const { data: attempt } = useTaskAttemptWithSession(effectiveWorkspaceId);
  const effectiveSessionId = explicitSessionId ?? attempt?.session?.id;

  return (
    <ExecutionProcessesProvider
      attemptId={effectiveWorkspaceId}
      sessionId={effectiveSessionId}
    >
      <RightPanelSidebarContent
        workspaceId={effectiveWorkspaceId}
        sessionId={effectiveSessionId}
      />
    </ExecutionProcessesProvider>
  );
}
