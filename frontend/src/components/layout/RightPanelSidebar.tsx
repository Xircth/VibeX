import { useTranslation } from 'react-i18next';
import {
  Terminal,
  List,
  GitCompareArrows,
  Loader2,
  StickyNote,
  Puzzle,
  ScanSearch,
} from 'lucide-react';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import { contributionIconComponent } from '@/components/plugins/contributionIcon';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { ExecutionProcessesProvider } from '@/contexts/ExecutionProcessesContext';
import { ViewProcessesDialog } from '@/components/dialogs/tasks/ViewProcessesDialog';
import { useTaskAttemptWithSession } from '@/hooks/useTaskAttempt';

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useTauriInspector } from '@/hooks/useTauriInspector';

function RightPanelSidebarContent({
  workspaceId,
  sessionId,
}: {
  workspaceId?: string;
  sessionId?: string;
}) {
  const { t } = useTranslation(['panels', 'common']);
  const {
    openNewTerminal,
    openDiffPreview,
    openNotes,
    openPluginPanel,
  } = usePanelActionsContext();
  const railSections = usePluginHostContributions('app_rail_section');
  const {
    activate: activateTauriInspector,
    isActivating: isTauriInspectorActivating,
    status: tauriInspectorStatus,
  } = useTauriInspector(workspaceId);

  const buttons = [
    {
      icon: Terminal,
      label: t('rightPanelSidebar.openTerminal'),
      onClick: openNewTerminal,
    },
    {
      icon: List,
      label: t('rightPanelSidebar.processes'),
      onClick: () =>
        ViewProcessesDialog.show({
          workspaceId,
          sessionId,
          initialProcessId: null,
        }),
    },
    {
      icon: GitCompareArrows,
      label: t('rightPanelSidebar.gitDiff'),
      onClick: openDiffPreview,
    },
    {
      icon: StickyNote,
      label: t('rightPanelSidebar.notes'),
      onClick: openNotes,
    },
  ];

  return (
    <TooltipProvider delayDuration={200}>
      <div className="workspace-chrome workspace-divider-left relative flex w-9 shrink-0 flex-col items-center gap-0.5 pt-2">
        {buttons.map((button) => {
          const Icon = button.icon;
          return (
            <Tooltip key={button.label}>
              <TooltipTrigger asChild>
                <button
                  onClick={button.onClick}
                  className="workspace-side-rail-button flex h-7 w-7 items-center justify-center"
                  aria-label={button.label}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">{button.label}</TooltipContent>
            </Tooltip>
          );
        })}

        <div className="my-1 h-px w-5 bg-border" />

        {railSections.map((item) => {
          const metadata = contributionMetadata(item);
          const icon =
            typeof metadata.icon === 'string' ? metadata.icon : null;
          const Icon = contributionIconComponent(icon, Puzzle);
          const opens =
            metadata.opens &&
            typeof metadata.opens === 'object' &&
            !Array.isArray(metadata.opens)
              ? (metadata.opens as {
                  kind?: string;
                  id?: string;
                  instance?: string;
                })
              : null;
          const contributionId =
            typeof opens?.id === 'string' ? opens.id : item.id;
          return (
            <Tooltip key={`${item.pluginId}:${item.id}`}>
              <TooltipTrigger asChild>
                <button
                  onClick={() =>
                    openPluginPanel({
                      title: item.label,
                      pluginId: item.pluginId,
                      contributionId,
                      icon,
                      multiInstance: true,
                      instance:
                        opens?.instance === 'new' ? 'new' : 'focus',
                    })
                  }
                  className="workspace-side-rail-button flex h-7 w-7 items-center justify-center"
                  aria-label={item.label}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">{item.label}</TooltipContent>
            </Tooltip>
          );
        })}

        {workspaceId && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => void activateTauriInspector()}
                disabled={isTauriInspectorActivating}
                className="workspace-side-rail-button flex h-7 w-7 items-center justify-center disabled:cursor-not-allowed disabled:opacity-40"
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
