import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Terminal,
  List,
  GitCompareArrows,
  Loader2,
  Puzzle,
  StickyNote,
  Globe,
  ScanSearch,
} from 'lucide-react';
import type { Plugin } from 'shared/types';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { ExecutionProcessesProvider } from '@/contexts/ExecutionProcessesContext';
import { ViewProcessesDialog } from '@/components/dialogs/tasks/ViewProcessesDialog';
import { useTaskAttemptWithSession } from '@/hooks/useTaskAttempt';
import { useDevServer } from '@/hooks/useDevServer';
import {
  isPluginExpired,
  usePluginLauncher,
  usePlugins,
} from '@/hooks/usePluginLauncher';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { useTauriInspector } from '@/hooks/useTauriInspector';

function RightPanelSidebarContent({
  workspaceId,
  sessionId,
}: {
  workspaceId?: string;
  sessionId?: string;
}) {
  const { t } = useTranslation(['panels', 'common']);
  const { openNewTerminal, openDiffPreview, openNotes, openOrFocusPanel } =
    usePanelActionsContext();
  const { runningDevServers, devServerProcesses } = useDevServer(workspaceId);
  const { data: plugins = [] } = usePlugins();
  const { launch: launchPlugin, launchingPluginId } =
    usePluginLauncher(workspaceId);
  const {
    activate: activateTauriInspector,
    isActivating: isTauriInspectorActivating,
    status: tauriInspectorStatus,
  } = useTauriInspector(workspaceId);

  const handleOpenPreview = useCallback(() => {
    openOrFocusPanel(PANEL_IDS.WEB_PREVIEW, 'Web Preview');
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
    ? 'bg-[hsl(var(--primary)/0.1)] text-primary hover:bg-[hsl(var(--primary)/0.14)] hover:text-primary'
    : hasFailedDevServer
      ? 'text-destructive hover:text-destructive hover:bg-destructive/10 bg-destructive/10'
      : 'text-muted-foreground hover:text-foreground hover:bg-accent';
  const networkTooltipLabel = hasRunningDevServer
    ? t('rightPanelSidebar.devServerRunningTooltip')
    : hasFailedDevServer
      ? t('rightPanelSidebar.devServerFailedTooltip')
      : t('rightPanelSidebar.openNetworkPreview');

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

        {workspaceId && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => void activateTauriInspector()}
                disabled={isTauriInspectorActivating}
                className="h-7 w-7 flex items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                aria-label={t('rightPanelSidebar.tauriInspectorTooltip')}
              >
                {isTauriInspectorActivating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ScanSearch className="h-3.5 w-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">
              {tauriInspectorStatus?.installed
                ? t('rightPanelSidebar.tauriInspectorTooltip')
                : t('rightPanelSidebar.tauriInspectorSetupTooltip')}
            </TooltipContent>
          </Tooltip>
        )}

        {workspaceId &&
          plugins
            .filter((plugin) => plugin.enabled)
            .map((plugin) => {
              const expired = isPluginExpired(plugin);
              const launching = launchingPluginId === plugin.id;
              return (
                <Tooltip key={plugin.id}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => void launchPlugin(plugin)}
                      disabled={expired || launching}
                      className="h-7 w-7 flex items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {launching ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <PluginIcon plugin={plugin} />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    {expired
                      ? t('rightPanelSidebar.pluginExpired', {
                          name: plugin.name,
                        })
                      : plugin.name}
                  </TooltipContent>
                </Tooltip>
              );
            })}
      </div>
    </TooltipProvider>
  );
}

function PluginIcon({ plugin }: { plugin: Plugin }) {
  if (plugin.icon?.startsWith('data:')) {
    return (
      <img
        src={plugin.icon}
        alt={plugin.name}
        className="h-3.5 w-3.5 rounded-[3px] object-cover"
      />
    );
  }
  if (plugin.icon?.trim()) {
    return <span className="text-[11px] leading-none">{plugin.icon}</span>;
  }
  return <Puzzle className="h-3.5 w-3.5" />;
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
