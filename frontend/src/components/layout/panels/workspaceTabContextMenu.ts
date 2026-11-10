import { createElement, useContext, useMemo } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import { useAppContextMenu } from '@/components/context-menu';
import type { ProductContextMenuItem } from '@/components/context-menu/contextMenuTypes';
import { useOptionalUserSystem } from '@/components/ConfigProvider';
import { confirmDiscardMergePanel } from '@/components/panels/merge/mergePanelDirty';
import { toast } from '@/components/ui/toast';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { isEnabledInstalledAgent } from '@/features/agents/operationalAgent';
import { useSelectableAgents } from '@/features/agents/useSelectableAgents';
import { useOptionalCollaborationSpaceStore } from '@/features/collaboration/space/SpaceContext';
import { findHostBrowserContribution } from '@/features/host-browser/hostBrowserEngine';
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
import { tabIdFromEditorTerminalPanelId } from '@/lib/workspaceTerminalTabs';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import {
  isEditorGroup,
  isLeftGroup,
  isSessionGroup,
} from '@/utils/dockviewGroupPolicy';
import { terminalHostPlatform } from '@/utils/platform';
import { requestPreviewTabRefresh } from '@/utils/previewTabRefresh';
import { openWorkspaceTerminal } from './openWorkspaceTerminal';

export type WorkspaceTabContextMenuKind =
  | 'default'
  | 'session'
  | 'terminal'
  | 'space';

export interface WorkspaceTabMenuLabels {
  basicGroup?: string;
  newGroup?: string;
  refresh?: string;
  duplicateTerminal?: string;
  spaceDetails?: string;
  newAssistant?: string;
  newGroupChat?: string;
  session?: string;
  sessionDetails?: string;
  processes?: string;
  close: string;
  closeCurrent: string;
  closeOthers: string;
  split: string;
  splitDown: string;
  splitLeft: string;
  splitRight: string;
  new: string;
  note: string;
  review: string;
  terminal: string;
  browser?: string;
  sort: string;
  sortByName: string;
}

export interface WorkspaceTabMenuAgentOption {
  id: string;
  label: string;
  iconNode?: React.ReactNode;
}

export interface WorkspaceTabMenuActions {
  tabKind?: WorkspaceTabContextMenuKind;
  refresh?: () => void;
  duplicateTerminal?: () => void;
  openSpaceDetails?: () => void;
  openNewAssistant?: () => void;
  openNewGroupChat?: () => void;
  openSession?: (agentId?: string) => void;
  agents?: ReadonlyArray<WorkspaceTabMenuAgentOption>;
  isSessionTab?: boolean;
  openSessionDetails?: () => void;
  openProcesses?: () => void;
  closeCurrent: () => void;
  closeOthers: () => void;
  canSplit: boolean;
  splitDown: () => void;
  splitLeft: () => void;
  splitRight: () => void;
  openNote: () => void;
  openReview: () => void;
  openTerminal: (shell?: string) => void;
  shells: ReadonlyArray<{ value: string; label: string }>;
  openBrowser?: () => void;
  pluginItems?: ReadonlyArray<{
    id: string;
    label: string;
    onSelect: () => void;
  }>;
  sortByName: () => void;
}

export function buildWorkspaceTabContextMenu(
  labels: WorkspaceTabMenuLabels,
  actions: WorkspaceTabMenuActions
): ProductContextMenuItem[] {
  const closeSubmenu: ProductContextMenuItem = {
    type: 'submenu',
    id: 'close',
    label: labels.close,
    children: [
      {
        id: 'close-current',
        label: labels.closeCurrent,
        onSelect: actions.closeCurrent,
      },
      {
        id: 'close-others',
        label: labels.closeOthers,
        onSelect: actions.closeOthers,
      },
    ],
  };

  const splitSubmenu: ProductContextMenuItem = {
    type: 'submenu',
    id: 'split',
    label: labels.split,
    disabled: !actions.canSplit,
    children: [
      {
        id: 'split-down',
        label: labels.splitDown,
        disabled: !actions.canSplit,
        onSelect: actions.splitDown,
      },
      {
        id: 'split-left',
        label: labels.splitLeft,
        disabled: !actions.canSplit,
        onSelect: actions.splitLeft,
      },
      {
        id: 'split-right',
        label: labels.splitRight,
        disabled: !actions.canSplit,
        onSelect: actions.splitRight,
      },
    ],
  };

  const terminalSubmenu: ProductContextMenuItem = {
    type: 'submenu',
    id: 'new-terminal',
    label: labels.terminal,
    onSelect: () => actions.openTerminal(),
    children: actions.shells.map((shell) => ({
      id: `shell-${shell.value}`,
      label: shell.label,
      onSelect: () => actions.openTerminal(shell.value),
    })),
  };

  const resolvedKind: WorkspaceTabContextMenuKind =
    actions.tabKind ?? (actions.isSessionTab ? 'session' : 'default');

  if (
    resolvedKind === 'session' ||
    resolvedKind === 'terminal' ||
    resolvedKind === 'space'
  ) {
    const basicHeader: ProductContextMenuItem = {
      type: 'label',
      id: 'group-basic',
      label: labels.basicGroup ?? '基础',
    };
    const newHeader: ProductContextMenuItem = {
      type: 'label',
      id: 'group-new',
      label: labels.newGroup ?? labels.new ?? '新建',
    };
    const newSeparator: ProductContextMenuItem = {
      type: 'separator',
      id: 'sep-new',
    };

    const agentList = actions.agents ?? [];
    const newSessionSubmenu: ProductContextMenuItem = {
      type: 'submenu',
      id: 'new-session',
      label: labels.session ?? '会话',
      onSelect: actions.openSession
        ? () => actions.openSession?.(agentList[0]?.id)
        : undefined,
      children: agentList.map((agent) => ({
        id: `agent-${agent.id}`,
        label: agent.label,
        iconNode: agent.iconNode,
        onSelect: () => actions.openSession?.(agent.id),
      })),
    };

    if (resolvedKind === 'session') {
      const items: ProductContextMenuItem[] = [
        basicHeader,
        closeSubmenu,
        splitSubmenu,
        newSeparator,
        newHeader,
        newSessionSubmenu,
      ];
      if (actions.openProcesses) {
        items.push({
          id: 'new-processes',
          label: labels.processes ?? '执行进程',
          onSelect: actions.openProcesses,
        });
      }
      if (actions.openSessionDetails) {
        items.push({
          id: 'new-session-details',
          label: labels.sessionDetails ?? '会话详情',
          onSelect: actions.openSessionDetails,
        });
      }
      items.push(
        terminalSubmenu,
        {
          id: 'new-note',
          label: labels.note,
          onSelect: actions.openNote,
        },
        {
          id: 'new-review',
          label: labels.review,
          onSelect: actions.openReview,
        }
      );
      return items;
    }

    if (resolvedKind === 'terminal') {
      return [
        basicHeader,
        {
          id: 'refresh',
          label: labels.refresh ?? '刷新',
          onSelect: () => actions.refresh?.(),
        },
        closeSubmenu,
        splitSubmenu,
        {
          id: 'duplicate-terminal',
          label: labels.duplicateTerminal ?? '复制Terminal',
          onSelect: () => actions.duplicateTerminal?.(),
        },
        newSeparator,
        newHeader,
        newSessionSubmenu,
        terminalSubmenu,
        {
          id: 'new-note',
          label: labels.note,
          onSelect: actions.openNote,
        },
      ];
    }

    // resolvedKind === 'space'
    return [
      basicHeader,
      {
        id: 'space-details',
        label: labels.spaceDetails ?? '详情信息',
        onSelect: () => actions.openSpaceDetails?.(),
      },
      closeSubmenu,
      splitSubmenu,
      newSeparator,
      newHeader,
      {
        id: 'new-assistant',
        label: labels.newAssistant ?? '新助手',
        onSelect: () => actions.openNewAssistant?.(),
      },
      {
        id: 'new-group-chat',
        label: labels.newGroupChat ?? '新群聊',
        onSelect: () => actions.openNewGroupChat?.(),
      },
      newSessionSubmenu,
      terminalSubmenu,
      {
        id: 'new-note',
        label: labels.note,
        onSelect: actions.openNote,
      },
      {
        id: 'new-review',
        label: labels.review,
        onSelect: actions.openReview,
      },
    ];
  }

  // Default tab menu (unchanged for all other tabs)
  const newItems: ProductContextMenuItem[] = [
    {
      id: 'new-note',
      label: labels.note,
      onSelect: actions.openNote,
    },
    {
      id: 'new-review',
      label: labels.review,
      onSelect: actions.openReview,
    },
  ];

  if (actions.openSessionDetails) {
    newItems.push({
      id: 'new-session-details',
      label: labels.sessionDetails ?? '会话详情',
      onSelect: actions.openSessionDetails,
    });
  }

  if (actions.openProcesses) {
    newItems.push({
      id: 'new-processes',
      label: labels.processes ?? '进程',
      onSelect: actions.openProcesses,
    });
  }

  newItems.push(terminalSubmenu);

  if (actions.openBrowser && labels.browser) {
    newItems.push({
      id: 'new-browser',
      label: labels.browser,
      onSelect: actions.openBrowser,
    });
  }

  if (actions.pluginItems?.length) {
    for (const item of actions.pluginItems) {
      newItems.push({
        id: item.id,
        label: item.label,
        onSelect: item.onSelect,
      });
    }
  }

  return [
    {
      id: 'refresh',
      label: labels.refresh ?? '刷新',
      onSelect: () => actions.refresh?.(),
    },
    closeSubmenu,
    splitSubmenu,
    {
      type: 'submenu',
      id: 'new',
      label: labels.new,
      children: newItems,
    },
    {
      type: 'submenu',
      id: 'sort',
      label: labels.sort,
      children: [
        {
          id: 'sort-name',
          label: labels.sortByName,
          onSelect: actions.sortByName,
        },
      ],
    },
  ];
}

interface EditorTabApi {
  id: string;
  component?: string;
  setActive?: () => void;
  group?: {
    id: string;
    panels: ReadonlyArray<{
      id: string;
      api: { close: () => void; component?: string };
    }>;
  };
}

export interface WorkspaceTabSessionContext {
  tabKind?: WorkspaceTabContextMenuKind;
  sessionId?: string | null;
  workspaceId?: string | null;
  isSessionTab?: boolean;
  terminalTabId?: string | null;
  terminalShell?: string | null;
  terminalCwd?: string | null;
}

export function useWorkspaceEditorTabMenu(
  api: EditorTabApi,
  closeCurrent: () => void,
  refreshCurrent?: () => void,
  sessionContext?: WorkspaceTabSessionContext
): { open: (event: MouseEvent) => void } | null {
  const { t } = useTranslation('panels');
  const { openSurfaceMenu } = useAppContextMenu();
  const queryClient = useContext(QueryClientContext);
  const {
    runInEditorGroup,
    splitEditorPanel,
    canOpenPanelInNewEditorGroup,
    openNotes,
    openDiffPreview,
    openOrFocusPanel,
    openTerminalEditorTab,
    openPluginPanel,
    sortEditorGroupByName,
  } = usePanelActionsContext();
  const pluginPanels = usePluginHostContributions('app_panel');
  const system = useOptionalUserSystem();
  const { activeWorktreeId } = useWorktree();
  const collabStore = useOptionalCollaborationSpaceStore();
  const selectableAgents = useSelectableAgents();
  const enabledAgents = useMemo<WorkspaceTabMenuAgentOption[]>(() => {
    const installedEnabled = selectableAgents.filter(isEnabledInstalledAgent);
    const list =
      installedEnabled.length > 0
        ? installedEnabled.map((agent) => ({
            id: agent.agentId,
            label: agent.displayName || getAgentName(agent.agentId),
          }))
        : Object.keys(system?.profiles ?? {}).map((agentId) => ({
            id: agentId,
            label: getAgentName(agentId),
          }));
    return list.map((agent) => ({
      id: agent.id,
      label: agent.label,
      iconNode: createElement(AgentIcon, {
        agent: agent.id,
        className: 'h-3.5 w-3.5 shrink-0',
      }),
    }));
  }, [selectableAgents, system?.profiles]);

  const hostPlatform = terminalHostPlatform(system?.environment?.os_type);
  const shells = getTerminalShellOptions(hostPlatform);
  const defaultShell = getDefaultTerminalShell(
    system?.config,
    system?.environment?.os_type
  );
  const browser = findHostBrowserContribution(pluginPanels);

  const group = api.group;
  if (
    !group ||
    (!isEditorGroup(group) && !isLeftGroup(group) && !isSessionGroup(group))
  ) {
    return null;
  }

  const labels: WorkspaceTabMenuLabels = {
    basicGroup: t('tabCreation.basicGroup', '基础'),
    newGroup: t('tabCreation.new', '新建'),
    refresh: t('tabCreation.refresh', '刷新'),
    duplicateTerminal: t('tabCreation.duplicateTerminal', '复制Terminal'),
    spaceDetails: t('tabCreation.spaceDetails', '详情信息'),
    newAssistant: t('tabCreation.newAssistant', '新助手'),
    newGroupChat: t('tabCreation.newGroupChat', '新群聊'),
    session: t('tabCreation.session', '会话'),
    sessionDetails: t('tabCreation.sessionDetails', '会话详情'),
    processes: t('tabCreation.processes', '执行进程'),
    close: t('tabCreation.close'),
    closeCurrent: t('tabCreation.closeCurrent'),
    closeOthers: t('tabCreation.closeOthers'),
    split: t('tabCreation.split'),
    splitDown: t('tabCreation.splitDown'),
    splitLeft: t('tabCreation.splitLeft'),
    splitRight: t('tabCreation.splitRight'),
    new: t('tabCreation.new'),
    note: t('tabCreation.note'),
    review: t('tabCreation.review'),
    terminal: t('tabCreation.terminal'),
    browser: t('tabCreation.browser'),
    sort: t('tabCreation.sort'),
    sortByName: t('tabCreation.sortByName'),
  };

  return {
    open(event) {
      const current = api.group;
      if (
        !current ||
        (!isEditorGroup(current) &&
          !isLeftGroup(current) &&
          !isSessionGroup(current))
      ) {
        return;
      }
      const panels = current.panels;
      const closePanel = (panel: (typeof panels)[number]) => {
        if (
          panel.api.component === PANEL_IDS.MERGE &&
          !confirmDiscardMergePanel(panel.id)
        ) {
          return;
        }
        panel.api.close();
      };
      const openTerminal = (shell?: string) => {
        runInEditorGroup(current.id, () => {
          openWorkspaceTerminal({
            shell,
            defaultShell,
            workspaceId: getTerminalWorkspaceKey(activeWorktreeId),
            openInEditor: openTerminalEditorTab,
            onExternalError: (error) => {
              toast.error(t('terminalHeader.openExternalFailed'), {
                description:
                  error instanceof Error
                    ? error.message
                    : t('terminalHeader.confirmWarpInstalled'),
              });
            },
          });
        });
      };

      const duplicateTerminal = () => {
        const termWsKey = getTerminalWorkspaceKey(activeWorktreeId);
        const termState = useTerminalStore.getState();
        const wsSessions = termWsKey
          ? (termState.sessionsByWorkspace[termWsKey] ?? [])
          : [];
        const targetTabId =
          sessionContext?.terminalTabId ||
          tabIdFromEditorTerminalPanelId(api.id) ||
          (termWsKey ? termState.activeTabByWorkspace[termWsKey] : null);
        const sourceSession = wsSessions.find((s) => s.tabId === targetTabId);
        const shellToUse =
          sourceSession?.shell ||
          sessionContext?.terminalShell ||
          defaultShell;
        const cwdToUse =
          sourceSession?.cwd || sessionContext?.terminalCwd || null;
        runInEditorGroup(current.id, () => {
          openTerminalEditorTab(shellToUse, { cwd: cwdToUse });
        });
      };

      const openSpaceDetails = () => {
        const runtime = collabStore?.getSnapshot();
        if (!runtime) return;
        runInEditorGroup(current.id, () => {
          if (runtime.activeDirectThreadId) {
            runtime.openAssistantDetailsTab();
          } else if (runtime.selected) {
            runtime.openSpaceCollectionTab(
              runtime.selected.space_id,
              runtime.selected.name
            );
          }
        });
      };

      const openNewAssistant = () => {
        const runtime = collabStore?.getSnapshot();
        if (!runtime) return;
        api.setActive?.();
        if (api.component !== PANEL_IDS.COLLABORATION_SPACE) {
          runInEditorGroup(current.id, () => {
            openOrFocusPanel(
              PANEL_IDS.COLLABORATION_SPACE,
              runtime.selected?.name ?? '协作空间'
            );
          });
        }
        runtime.openCreateMemberDialog();
      };

      const openNewGroupChat = () => {
        const runtime = collabStore?.getSnapshot();
        if (!runtime) return;
        api.setActive?.();
        if (api.component !== PANEL_IDS.COLLABORATION_SPACE) {
          runInEditorGroup(current.id, () => {
            openOrFocusPanel(
              PANEL_IDS.COLLABORATION_SPACE,
              runtime.selected?.name ?? '协作空间'
            );
          });
        }
        runtime.openCreateSpaceDialog();
      };

      const openSession = (agentId?: string) => {
        const chosenAgentId = agentId || enabledAgents[0]?.id;
        if (!chosenAgentId) return;
        requestCreateAgentSessionInExecutionArea(chosenAgentId, current.id);
      };

      const nonBrowserPlugins = pluginPanels.filter(
        (item) =>
          !browser ||
          item.pluginId !== browser.pluginId ||
          item.id !== browser.id
      );

      openSurfaceMenu(
        event,
        buildWorkspaceTabContextMenu(labels, {
          tabKind: sessionContext?.tabKind,
          refresh:
            refreshCurrent ??
            (() =>
              requestPreviewTabRefresh({
                panelId: api.id,
                queryClient,
              })),
          duplicateTerminal,
          openSpaceDetails,
          openNewAssistant,
          openNewGroupChat,
          openSession,
          agents: enabledAgents,
          isSessionTab: Boolean(sessionContext?.isSessionTab),
          openSessionDetails: () =>
            runInEditorGroup(current.id, () =>
              openOrFocusPanel(
                PANEL_IDS.SESSION_DETAILS,
                t('tabCreation.sessionDetails', '会话详情'),
                {
                  sessionId: sessionContext?.sessionId ?? null,
                  workspaceId:
                    sessionContext?.workspaceId ?? activeWorktreeId ?? null,
                }
              )
            ),
          openProcesses: () =>
            runInEditorGroup(current.id, () =>
              openOrFocusPanel(
                PANEL_IDS.PROCESSES,
                t('tabCreation.processes', '执行进程')
              )
            ),
          closeCurrent,
          closeOthers: () => {
            panels.filter((panel) => panel.id !== api.id).forEach(closePanel);
          },
          canSplit: canOpenPanelInNewEditorGroup(api.id),
          splitDown: () => splitEditorPanel(api.id, 'below'),
          splitLeft: () => splitEditorPanel(api.id, 'left'),
          splitRight: () => splitEditorPanel(api.id, 'right'),
          openNote: () => runInEditorGroup(current.id, openNotes),
          openReview: () => runInEditorGroup(current.id, openDiffPreview),
          openTerminal,
          shells,
          openBrowser: browser
            ? () => {
                const metadata = contributionMetadata(browser);
                runInEditorGroup(current.id, () =>
                  openPluginPanel({
                    title: browser.label,
                    pluginId: browser.pluginId,
                    contributionId: browser.id,
                    icon:
                      typeof metadata.icon === 'string'
                        ? metadata.icon
                        : 'globe',
                    multiInstance: true,
                    instance: 'new',
                  })
                );
              }
            : undefined,
          pluginItems: nonBrowserPlugins.map((item) => {
            const metadata = contributionMetadata(item);
            const icon =
              typeof metadata.icon === 'string' ? metadata.icon : null;
            return {
              id: `plugin-${item.pluginId}:${item.id}`,
              label: item.label,
              onSelect: () =>
                runInEditorGroup(current.id, () =>
                  openPluginPanel({
                    title: item.label,
                    pluginId: item.pluginId,
                    contributionId: item.id,
                    icon,
                    multiInstance: metadata.multiInstance === true,
                    instance: metadata.multiInstance === true ? 'new' : 'focus',
                  })
                ),
            };
          }),
          sortByName: () => sortEditorGroupByName(current.id),
        })
      );
    },
  };
}
