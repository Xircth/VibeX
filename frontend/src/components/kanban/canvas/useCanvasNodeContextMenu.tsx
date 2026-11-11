import {
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type MouseEvent,
} from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import { ProductContextMenu } from '@/components/context-menu/ProductContextMenu';
import { useOptionalUserSystem } from '@/components/ConfigProvider';
import { confirmDiscardMergePanel } from '@/components/panels/merge/mergePanelDirty';
import {
  buildWorkspaceTabContextMenu,
  type WorkspaceTabContextMenuKind,
  type WorkspaceTabMenuAgentOption,
  type WorkspaceTabMenuLabels,
} from '@/components/layout/panels/workspaceTabContextMenu';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import { useOptionalWorktree } from '@/contexts/WorktreeContext';
import { isEnabledInstalledAgent } from '@/features/agents/operationalAgent';
import { useSelectableAgents } from '@/features/agents/useSelectableAgents';
import { useOptionalCollaborationSpaceStore } from '@/features/collaboration/space/SpaceContext';
import { findHostBrowserContribution } from '@/features/host-browser/hostBrowserEngine';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import { pluginSurfaceId } from '@/lib/hostSurfaceIds';
import { requestCreateAgentSessionInExecutionArea } from '@/lib/requestCreateSession';
import {
  getDefaultTerminalShell,
  getTerminalShellOptions,
  getTerminalWorkspaceKey,
} from '@/lib/terminalPreferences';
import {
  editorTerminalPanelId,
  isEditorTerminalPanelId,
  tabIdFromEditorTerminalPanelId,
} from '@/lib/workspaceTerminalTabs';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import {
  generateTerminalTabId,
  useTerminalStore,
} from '@/stores/useTerminalStore';
import { terminalHostPlatform } from '@/utils/platform';
import { requestPreviewTabRefresh } from '@/utils/previewTabRefresh';
import { useSessionCanvasView } from './CanvasViewContext';
import { runWithCanvasParentNode } from './canvasWorkspaceBridge';

export interface UseCanvasNodeContextMenuOptions {
  instanceId: string;
  sessionId?: string | null;
  workspaceId?: string | null;
  panelId?: string | null;
  panelComponent?: string | null;
  panelTitle?: string | null;
  panelParams?: Record<string, unknown>;
}

export function resolveCanvasNodeTabKind(
  panelComponent?: string | null,
  panelId?: string | null,
  sessionId?: string | null
): WorkspaceTabContextMenuKind {
  if (
    panelComponent === PANEL_IDS.COLLABORATION_SPACE ||
    panelComponent === 'member-session'
  ) {
    return 'space';
  }
  if (
    panelComponent === PANEL_IDS.TERMINAL ||
    (panelId && isEditorTerminalPanelId(panelId))
  ) {
    return 'terminal';
  }
  if (Boolean(sessionId) || panelComponent === PANEL_IDS.AI_CHAT) {
    return 'session';
  }
  return 'default';
}

export function useCanvasNodeContextMenu({
  instanceId,
  sessionId,
  workspaceId,
  panelId,
  panelComponent,
  panelTitle,
  panelParams,
}: UseCanvasNodeContextMenuOptions) {
  const { t } = useTranslation('panels');
  const queryClient = useContext(QueryClientContext);
  const panelActions = useOptionalPanelActionsContext();
  const worktree = useOptionalWorktree();
  const activeWorktreeId = worktree?.activeWorktreeId ?? null;
  const collabStore = useOptionalCollaborationSpaceStore();
  const system = useOptionalUserSystem();
  const pluginPanels = usePluginHostContributions('app_panel');
  const selectableAgents = useSelectableAgents();
  const {
    removeCard,
    closeOtherCanvasNodes,
    duplicateCanvasNode,
    openOrFocusPanelNode,
    sortCanvasNodes,
    onCreateSessionWithExecutor,
    onNewSession,
  } = useSessionCanvasView();

  const [menuPosition, setMenuPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);

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
    const effectiveList =
      list.length > 0
        ? list
        : [{ id: 'CLAUDE_CODE', label: getAgentName('CLAUDE_CODE') }];
    return effectiveList.map((agent) => ({
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

  const labels: WorkspaceTabMenuLabels = useMemo(
    () => ({
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
      close: t('tabCreation.close', '关闭'),
      closeCurrent: t('tabCreation.closeCurrent', '关闭当前'),
      closeOthers: t('tabCreation.closeOthers', '关闭其他'),
      split: t('tabCreation.split', '拆分'),
      splitDown: t('tabCreation.splitDown', '向下拆分'),
      splitLeft: t('tabCreation.splitLeft', '向左拆分'),
      splitRight: t('tabCreation.splitRight', '向右拆分'),
      new: t('tabCreation.new', '新建'),
      note: t('tabCreation.note', '笔记'),
      review: t('tabCreation.review', '审阅'),
      terminal: t('tabCreation.terminal', '终端'),
      browser: t('tabCreation.browser', 'Browser'),
      sort: t('tabCreation.sort', '排序'),
      sortByName: t('tabCreation.sortByName', '按名称排序'),
    }),
    [t]
  );

  const tabKind = resolveCanvasNodeTabKind(panelComponent, panelId, sessionId);

  const spawnTerminalNode = useCallback(
    (shell?: string, cwd?: string | null) => {
      runWithCanvasParentNode(instanceId, () => {
        const resolvedShell = shell || defaultShell;
        const tabId = generateTerminalTabId();
        const shellInfo = shells.find((item) => item.value === resolvedShell);
        const title = shellInfo?.label || resolvedShell || labels.terminal;
        openOrFocusPanelNode?.({
          id: editorTerminalPanelId(tabId),
          component: PANEL_IDS.TERMINAL,
          title,
          params: {
            surface: 'editor',
            tabId,
            shell: resolvedShell,
            ...(cwd ? { cwd } : {}),
          },
          expanded: true,
          parentNodeId: instanceId,
        });
      });
    },
    [
      defaultShell,
      instanceId,
      labels.terminal,
      openOrFocusPanelNode,
      shells,
    ]
  );

  const duplicateTerminal = useCallback(() => {
    const termWsKey = getTerminalWorkspaceKey(workspaceId ?? activeWorktreeId);
    const termState = useTerminalStore.getState();
    const wsSessions = termWsKey
      ? (termState.sessionsByWorkspace[termWsKey] ?? [])
      : [];
    const targetTabId =
      (typeof panelParams?.tabId === 'string' ? panelParams.tabId : null) ||
      (panelId ? tabIdFromEditorTerminalPanelId(panelId) : null) ||
      (termWsKey ? termState.activeTabByWorkspace[termWsKey] : null);
    const sourceSession = wsSessions.find((s) => s.tabId === targetTabId);
    const shellToUse =
      sourceSession?.shell ||
      (typeof panelParams?.shell === 'string' ? panelParams.shell : null) ||
      defaultShell;
    const cwdToUse =
      sourceSession?.cwd ||
      (typeof panelParams?.cwd === 'string' ? panelParams.cwd : null) ||
      null;
    spawnTerminalNode(shellToUse, cwdToUse);
  }, [
    activeWorktreeId,
    defaultShell,
    panelId,
    panelParams?.cwd,
    panelParams?.shell,
    panelParams?.tabId,
    spawnTerminalNode,
    workspaceId,
  ]);

  const openSpaceDetails = useCallback(() => {
    runWithCanvasParentNode(instanceId, () => {
      const runtime = collabStore?.getSnapshot();
      const paramSpaceId =
        typeof panelParams?.spaceId === 'string' &&
        panelParams.spaceId.length > 0
          ? panelParams.spaceId
          : null;
      const paramConversationId =
        typeof panelParams?.conversationId === 'string' &&
        panelParams.conversationId.length > 0
          ? panelParams.conversationId
          : null;
      const spaceId =
        paramSpaceId ||
        runtime?.activeDirectThreadId ||
        runtime?.selected?.space_id ||
        (paramConversationId ? `direct:${paramConversationId}` : null) ||
        'default-space';
      const detailTitle =
        runtime?.activeDirectThreadId || paramConversationId
          ? '助手详情'
          : runtime?.selected?.name
            ? `${runtime.selected.name} · 群组详情`
            : `${panelTitle || '协作空间'} · 详情信息`;
      openOrFocusPanelNode?.({
        id: `space-collection-${spaceId}`,
        component: 'space-collection',
        title: detailTitle,
        params: {
          spaceId,
          ...(paramConversationId
            ? { conversationId: paramConversationId }
            : {}),
        },
        expanded: true,
        parentNodeId: instanceId,
      });
    });
  }, [
    collabStore,
    instanceId,
    openOrFocusPanelNode,
    panelParams?.conversationId,
    panelParams?.spaceId,
    panelTitle,
  ]);

  const openNewAssistant = useCallback(() => {
    runWithCanvasParentNode(instanceId, () => {
      const runtime = collabStore?.getSnapshot();
      runtime?.openCreateMemberDialog();
    });
  }, [collabStore, instanceId]);

  const openNewGroupChat = useCallback(() => {
    runWithCanvasParentNode(instanceId, () => {
      const runtime = collabStore?.getSnapshot();
      runtime?.openCreateSpaceDialog();
    });
  }, [collabStore, instanceId]);

  const openSession = useCallback(
    (agentId?: string) => {
      const chosenAgentId = agentId || enabledAgents[0]?.id;
      runWithCanvasParentNode(instanceId, () => {
        if (chosenAgentId && onCreateSessionWithExecutor) {
          onCreateSessionWithExecutor(chosenAgentId, instanceId);
          return;
        }
        if (onNewSession) {
          onNewSession(instanceId);
          return;
        }
        if (chosenAgentId) {
          requestCreateAgentSessionInExecutionArea(chosenAgentId);
        }
      });
    },
    [enabledAgents, instanceId, onCreateSessionWithExecutor, onNewSession]
  );

  const menuItems = useMemo(() => {
    const nonBrowserPlugins = pluginPanels.filter(
      (item) =>
        !browser ||
        item.pluginId !== browser.pluginId ||
        item.id !== browser.id
    );

    return buildWorkspaceTabContextMenu(labels, {
      tabKind,
      refresh: () =>
        requestPreviewTabRefresh({
          panelId: panelId || instanceId,
          filePath:
            typeof panelParams?.filePath === 'string'
              ? panelParams.filePath
              : null,
          queryClient,
        }),
      duplicateTerminal,
      openSpaceDetails,
      openNewAssistant,
      openNewGroupChat,
      openSession,
      agents: enabledAgents,
      isSessionTab: tabKind === 'session',
      openSessionDetails: () =>
        runWithCanvasParentNode(instanceId, () => {
          openOrFocusPanelNode?.({
            id: sessionId
              ? `${PANEL_IDS.SESSION_DETAILS}-${sessionId}`
              : PANEL_IDS.SESSION_DETAILS,
            component: PANEL_IDS.SESSION_DETAILS,
            title: labels.sessionDetails ?? '会话详情',
            params: {
              sessionId: sessionId ?? null,
              workspaceId: workspaceId ?? activeWorktreeId ?? null,
            },
            expanded: true,
            parentNodeId: instanceId,
          });
        }),
      openProcesses: () =>
        runWithCanvasParentNode(instanceId, () => {
          openOrFocusPanelNode?.({
            id: sessionId
              ? `${PANEL_IDS.PROCESSES}-${sessionId}`
              : PANEL_IDS.PROCESSES,
            component: PANEL_IDS.PROCESSES,
            title: labels.processes ?? '执行进程',
            params: {
              sessionId: sessionId ?? null,
              workspaceId: workspaceId ?? activeWorktreeId ?? null,
            },
            expanded: true,
            parentNodeId: instanceId,
          });
        }),
      closeCurrent: () => {
        if (
          panelComponent === PANEL_IDS.MERGE &&
          !confirmDiscardMergePanel(panelId || instanceId)
        ) {
          return;
        }
        removeCard(instanceId);
      },
      closeOthers: () => {
        closeOtherCanvasNodes?.(instanceId);
      },
      canSplit: true,
      splitDown: () => {
        duplicateCanvasNode?.(instanceId);
      },
      splitLeft: () => {
        duplicateCanvasNode?.(instanceId);
      },
      splitRight: () => {
        duplicateCanvasNode?.(instanceId);
      },
      openNote: () =>
        runWithCanvasParentNode(instanceId, () => {
          openOrFocusPanelNode?.({
            id: PANEL_IDS.NOTES,
            component: PANEL_IDS.NOTES,
            title: labels.note,
            expanded: true,
            parentNodeId: instanceId,
          });
        }),
      openReview: () =>
        runWithCanvasParentNode(instanceId, () => {
          openOrFocusPanelNode?.({
            id: PANEL_IDS.DIFFS,
            component: PANEL_IDS.DIFFS,
            title: labels.review,
            expanded: true,
            parentNodeId: instanceId,
          });
        }),
      openTerminal: (shell?: string) => spawnTerminalNode(shell),
      shells,
      openBrowser: browser
        ? () =>
            runWithCanvasParentNode(instanceId, () => {
              const metadata = contributionMetadata(browser);
              const icon =
                typeof metadata.icon === 'string' ? metadata.icon : 'globe';
              const id = `${pluginSurfaceId(browser.pluginId, browser.id)}:${Date.now().toString(36)}`;
              openOrFocusPanelNode?.({
                id,
                component: 'plugin-panel',
                title: browser.label,
                params: {
                  pluginId: browser.pluginId,
                  contributionId: browser.id,
                  icon,
                },
                expanded: true,
                parentNodeId: instanceId,
              });
            })
        : undefined,
      pluginItems: nonBrowserPlugins.map((item) => {
        const metadata = contributionMetadata(item);
        const icon = typeof metadata.icon === 'string' ? metadata.icon : null;
        return {
          id: `plugin-${item.pluginId}:${item.id}`,
          label: item.label,
          onSelect: () =>
            runWithCanvasParentNode(instanceId, () => {
              const baseId = pluginSurfaceId(item.pluginId, item.id);
              const id =
                metadata.multiInstance === true
                  ? `${baseId}:${Date.now().toString(36)}`
                  : baseId;
              openOrFocusPanelNode?.({
                id,
                component: 'plugin-panel',
                title: item.label,
                params: {
                  pluginId: item.pluginId,
                  contributionId: item.id,
                  icon,
                },
                expanded: true,
                parentNodeId: instanceId,
              });
            }),
        };
      }),
      sortByName: () => {
        sortCanvasNodes?.();
      },
    });
  }, [
    activeWorktreeId,
    browser,
    closeOtherCanvasNodes,
    duplicateCanvasNode,
    duplicateTerminal,
    enabledAgents,
    instanceId,
    labels,
    openNewAssistant,
    openNewGroupChat,
    openOrFocusPanelNode,
    openSession,
    openSpaceDetails,
    panelComponent,
    panelId,
    panelParams?.filePath,
    pluginPanels,
    queryClient,
    removeCard,
    sessionId,
    shells,
    sortCanvasNodes,
    spawnTerminalNode,
    tabKind,
    workspaceId,
  ]);

  const openContextMenu = useCallback((event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setMenuPosition({ x: event.clientX, y: event.clientY });
  }, []);

  const contextMenuElement = menuPosition ? (
    <ProductContextMenu
      x={menuPosition.x}
      y={menuPosition.y}
      items={menuItems}
      onClose={() => setMenuPosition(null)}
    />
  ) : null;

  return {
    openContextMenu,
    contextMenuElement,
    menuItems,
    panelActions,
  };
}
