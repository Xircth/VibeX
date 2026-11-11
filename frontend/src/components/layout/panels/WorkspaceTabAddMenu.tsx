import { usePanels, useSlotContributions } from '@vibex/plugin-sdk';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import {
  Activity,
  Bot,
  FileDiff,
  Info,
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
import { extractSessionIdFromPanelId } from '@/lib/workspaceSessionTabSlots';
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
  const railSections = usePluginHostContributions('app_rail_section');
  const sdkRailSlots = useSlotContributions('rail.sections');
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

  const combinedPluginItems = useMemo(() => {
    const seen = new Set<string>();
    const items: Array<{
      key: string;
      label: string;
      icon: ReturnType<typeof contributionIconComponent>;
      onSelect: () => void;
    }> = [];

    for (const item of pluginPanels) {
      const metadata = contributionMetadata(item);
      const icon = typeof metadata.icon === 'string' ? metadata.icon : null;
      const key = `${item.pluginId}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        key,
        label: item.label,
        icon: contributionIconComponent(icon, Puzzle),
        onSelect: () =>
          openPluginPanel({
            title: item.label,
            pluginId: item.pluginId,
            contributionId: item.id,
            icon,
            multiInstance: metadata.multiInstance === true,
            instance: metadata.multiInstance === true ? 'new' : 'focus',
          }),
      });
    }

    for (const slotItem of sdkRailSlots) {
      if (slotItem.component || slotItem.render) continue;
      const pluginId = slotItem.pluginId ?? 'plugin';
      const rawId = slotItem.id.startsWith(`${pluginId}:`)
        ? slotItem.id.slice(pluginId.length + 1)
        : slotItem.id;
      const key = `${pluginId}:${rawId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const label = slotItem.label ?? slotItem.tooltip ?? rawId;
      const iconName = slotItem.icon ?? null;
      const opens =
        slotItem.metadata?.opens &&
        typeof slotItem.metadata.opens === 'object' &&
        !Array.isArray(slotItem.metadata.opens)
          ? (slotItem.metadata.opens as { id?: string; instance?: string })
          : null;
      const contributionId = typeof opens?.id === 'string' ? opens.id : rawId;
      items.push({
        key,
        label,
        icon: contributionIconComponent(iconName, Puzzle),
        onSelect: () => {
          if (slotItem.onActivate) {
            void Promise.resolve(slotItem.onActivate()).catch(() => undefined);
            return;
          }
          openPluginPanel({
            title: label,
            pluginId,
            contributionId,
            icon: iconName,
            multiInstance: true,
            instance: opens?.instance === 'new' ? 'new' : 'focus',
          });
        },
      });
    }

    for (const panel of sdkPanels) {
      if (panel.builtin || panel.zone === 'left') continue;
      const pluginId = panel.pluginId ?? 'plugin';
      const rawId = panel.id.startsWith(`${pluginId}:`)
        ? panel.id.slice(pluginId.length + 1)
        : panel.id;
      const key = `${pluginId}:${rawId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const iconName = panel.icon ?? null;
      items.push({
        key,
        label: panel.title,
        icon: contributionIconComponent(iconName, Puzzle),
        onSelect: () =>
          openPluginPanel({
            title: panel.title,
            pluginId,
            contributionId: rawId,
            icon: iconName,
            multiInstance: panel.multiInstance !== false,
            instance: 'focus',
          }),
      });
    }

    for (const item of railSections) {
      const metadata = contributionMetadata(item);
      const icon = typeof metadata.icon === 'string' ? metadata.icon : null;
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
      const contributionId = typeof opens?.id === 'string' ? opens.id : item.id;
      const key = `${item.pluginId}:${item.id}`;
      if (seen.has(key) || seen.has(`${item.pluginId}:${contributionId}`)) {
        continue;
      }
      seen.add(key);
      items.push({
        key,
        label: item.label,
        icon: contributionIconComponent(icon, Puzzle),
        onSelect: () =>
          openPluginPanel({
            title: item.label,
            pluginId: item.pluginId,
            contributionId,
            icon,
            multiInstance: true,
            instance: opens?.instance === 'new' ? 'new' : 'focus',
          }),
      });
    }

    return items;
  }, [openPluginPanel, pluginPanels, railSections, sdkPanels, sdkRailSlots]);

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
            runInThisGroup(() => {
              const activePanel = group.activePanel;
              const activeParams = (activePanel?.params ?? {}) as {
                sessionId?: string | null;
                workspaceId?: string | null;
              };
              const targetSessionId =
                activeParams.sessionId?.trim() ||
                (activePanel ? extractSessionIdFromPanelId(activePanel.id) : null);
              const targetWorkspaceId =
                activeParams.workspaceId?.trim() ||
                worktree?.activeWorktreeId ||
                null;
              openOrFocusPanel(
                PANEL_IDS.SESSION_DETAILS,
                t('tabCreation.sessionDetails'),
                {
                  sessionId: targetSessionId ?? null,
                  workspaceId: targetWorkspaceId,
                }
              );
            })
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
        {combinedPluginItems.map((item) => {
          const Icon = item.icon;
          return (
            <DropdownMenuItem
              key={item.key}
              onSelect={() => runInThisGroup(item.onSelect)}
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
