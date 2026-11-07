import { usePanels } from '@vibex/plugin-sdk';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import {
  Activity,
  Bot,
  FileDiff,
  FolderTree,
  GitBranch,
  Info,
  MessageSquare,
  Plus,
  Puzzle,
  SquareTerminal,
  StickyNote,
} from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import { useOptionalUserSystem } from '@/components/ConfigProvider';
import { contributionIconComponent } from '@/components/plugins/contributionIcon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { useWorkspaceOverlay } from '@/contexts/WorkspaceOverlayContext';
import { useOptionalWorktree } from '@/contexts/WorktreeContext';
import { isEnabledInstalledAgent } from '@/features/agents/operationalAgent';
import { useSelectableAgents } from '@/features/agents/useSelectableAgents';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import { requestCreateAgentSessionInExecutionArea } from '@/lib/requestCreateSession';
import {
  getDefaultTerminalShell,
  getTerminalShellOptions,
  getTerminalWorkspaceKey,
} from '@/lib/terminalPreferences';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { isEditorGroup, isSessionGroup } from '@/utils/dockviewGroupPolicy';
import { terminalHostPlatform } from '@/utils/platform';
import { openWorkspaceTerminal } from './openWorkspaceTerminal';

export function WorkspaceTabAddMenu({
  api,
  group,
}: IDockviewHeaderActionsProps) {
  const { t } = useTranslation('panels');
  const {
    openDiffPreview,
    openNotes,
    openOrFocusPanel,
    openTerminalEditorTab,
    openPluginPanel,
    runInEditorGroup,
  } = usePanelActionsContext();
  const pluginPanels = usePluginHostContributions('app_panel');
  const sdkPanels = usePanels();
  const canOpenNotes =
    sdkPanels.length === 0 ||
    sdkPanels.some(
      (panel) =>
        panel.id === PANEL_IDS.NOTES ||
        panel.id.endsWith(`:${PANEL_IDS.NOTES}`) ||
        panel.id.endsWith(`/${PANEL_IDS.NOTES}`)
    );
  const { setTabCreationMenuOpen } = useWorkspaceOverlay();
  const system = useOptionalUserSystem();
  const worktree = useOptionalWorktree();
  const selectableAgents = useSelectableAgents();
  const enabledAgents = useMemo(() => {
    const installedEnabled = selectableAgents.filter(isEnabledInstalledAgent);
    if (installedEnabled.length > 0) {
      return installedEnabled.map((agent) => ({
        id: agent.agentId,
        name: agent.displayName || getAgentName(agent.agentId),
      }));
    }
    const profileEntries = Object.keys(system?.profiles ?? {});
    return profileEntries.map((agentId) => ({
      id: agentId,
      name: getAgentName(agentId),
    }));
  }, [selectableAgents, system?.profiles]);
  const hostPlatform = terminalHostPlatform(system?.environment?.os_type);
  const shells = getTerminalShellOptions(hostPlatform);
  const defaultShell = getDefaultTerminalShell(
    system?.config,
    system?.environment?.os_type
  );

  if (!isEditorGroup(group) && !isSessionGroup(group)) {
    return null;
  }

  const runInThisGroup = (action: () => void) => {
    runInEditorGroup(group.id, () => {
      api.setActive();
      action();
    });
  };

  return (
    <DropdownMenu modal={false} onOpenChange={setTabCreationMenuOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="workspace-tab-add-button"
          aria-label={t('tabCreation.newTab')}
          title={t('tabCreation.newTab')}
        >
          <Plus aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        className="workspace-tab-add-menu w-52 max-h-[75vh] overflow-y-auto"
      >
        <DropdownMenuLabel className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
          {t('tabCreation.sections.features')}
        </DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={() =>
            runInThisGroup(() =>
              openOrFocusPanel(PANEL_IDS.FILE_TREE, t('tabCreation.fileTree'))
            )
          }
        >
          <FolderTree />
          {t('tabCreation.fileTree')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            runInThisGroup(() =>
              openOrFocusPanel(PANEL_IDS.GIT, t('tabCreation.gitPanel'))
            )
          }
        >
          <GitBranch />
          {t('tabCreation.gitPanel')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            runInThisGroup(() =>
              openOrFocusPanel(
                PANEL_IDS.SESSION_LIST,
                t('tabCreation.sessionList')
              )
            )
          }
        >
          <MessageSquare />
          {t('tabCreation.sessionList')}
        </DropdownMenuItem>
        {canOpenNotes ? (
          <DropdownMenuItem onSelect={() => runInThisGroup(openNotes)}>
            <StickyNote />
            {t('tabCreation.note')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => runInThisGroup(openDiffPreview)}>
          <FileDiff />
          {t('tabCreation.review')}
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
          {t('tabCreation.sections.info')}
        </DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={() =>
            runInThisGroup(() =>
              openOrFocusPanel(PANEL_IDS.PROCESSES, t('tabCreation.processes'))
            )
          }
        >
          <Activity />
          {t('tabCreation.processes')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            runInThisGroup(() =>
              openOrFocusPanel(
                PANEL_IDS.SESSION_DETAILS,
                t('tabCreation.sessionDetails')
              )
            )
          }
        >
          <Info />
          {t('tabCreation.sessionDetails')}
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
          {t('tabCreation.sections.agents')}
        </DropdownMenuLabel>
        {enabledAgents.length > 0 ? (
          enabledAgents.map((agent) => (
            <DropdownMenuItem
              key={agent.id}
              onSelect={() =>
                requestCreateAgentSessionInExecutionArea(agent.id, group.id)
              }
            >
              <span aria-hidden="true" className="inline-flex shrink-0">
                <AgentIcon agent={agent.id} className="size-4 shrink-0" />
              </span>
              <span className="truncate">{agent.name}</span>
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuItem disabled>
            <Bot />
            {t('tabCreation.noEnabledAgents')}
          </DropdownMenuItem>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
          {t('tabCreation.sections.other')}
        </DropdownMenuLabel>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <SquareTerminal />
            {t('tabCreation.terminal')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="workspace-tab-add-menu min-w-[9rem]">
            {shells.map((shell) => (
              <DropdownMenuItem
                key={shell.value}
                onSelect={() =>
                  runInThisGroup(() =>
                    openWorkspaceTerminal({
                      shell: shell.value,
                      defaultShell,
                      workspaceId: getTerminalWorkspaceKey(
                        worktree?.activeWorktreeId ?? null
                      ),
                      openInEditor: openTerminalEditorTab,
                      onExternalError: (error) => {
                        toast.error(t('terminalHeader.openExternalFailed'), {
                          description:
                            error instanceof Error
                              ? error.message
                              : t('terminalHeader.confirmWarpInstalled'),
                        });
                      },
                    })
                  )
                }
              >
                {shell.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {pluginPanels.map((item) => {
          const metadata = contributionMetadata(item);
          const icon = typeof metadata.icon === 'string' ? metadata.icon : null;
          const Icon = contributionIconComponent(icon, Puzzle);
          return (
            <DropdownMenuItem
              key={`${item.pluginId}:${item.id}`}
              onSelect={() =>
                runInThisGroup(() =>
                  openPluginPanel({
                    title: item.label,
                    pluginId: item.pluginId,
                    contributionId: item.id,
                    icon,
                    multiInstance: metadata.multiInstance === true,
                    instance: metadata.multiInstance === true ? 'new' : 'focus',
                  })
                )
              }
            >
              <Icon />
              {item.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
