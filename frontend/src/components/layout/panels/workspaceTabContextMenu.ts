import { useAppContextMenu } from '@/components/context-menu';
import type { ProductContextMenuItem } from '@/components/context-menu/contextMenuTypes';
import { useOptionalUserSystem } from '@/components/ConfigProvider';
import { confirmDiscardMergePanel } from '@/components/panels/merge/mergePanelDirty';
import { toast } from '@/components/ui/toast';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { findHostBrowserContribution } from '@/features/host-browser/hostBrowserEngine';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import {
  getDefaultTerminalShell,
  getTerminalShellOptions,
  getTerminalWorkspaceKey,
} from '@/lib/terminalPreferences';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import {
  isEditorGroup,
  isLeftGroup,
  isSessionGroup,
} from '@/utils/dockviewGroupPolicy';
import { useContext } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { terminalHostPlatform } from '@/utils/platform';
import { requestPreviewTabRefresh } from '@/utils/previewTabRefresh';
import { useTranslation } from 'react-i18next';
import { openWorkspaceTerminal } from './openWorkspaceTerminal';

export interface WorkspaceTabMenuLabels {
  refresh?: string;
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
  browser: string;
  sort: string;
  sortByName: string;
}

export interface WorkspaceTabMenuActions {
  refresh?: () => void;
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

  newItems.push({
    type: 'submenu',
    id: 'new-terminal',
    label: labels.terminal,
    onSelect: () => actions.openTerminal(),
    children: actions.shells.map((shell) => ({
      id: `shell-${shell.value}`,
      label: shell.label,
      onSelect: () => actions.openTerminal(shell.value),
    })),
  });

  if (actions.openBrowser) {
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

  const topLevelItems: ProductContextMenuItem[] = [
    {
      id: 'refresh',
      label: labels.refresh ?? '刷新',
      onSelect: () => actions.refresh?.(),
    },
  ];

  if (actions.isSessionTab && actions.openSessionDetails) {
    topLevelItems.push({
      id: 'session-details',
      label: labels.sessionDetails ?? '会话详情',
      onSelect: actions.openSessionDetails,
    });
  }

  topLevelItems.push(
    {
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
    },
    {
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
    },
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
    }
  );

  return topLevelItems;
}

interface EditorTabApi {
  id: string;
  group?: {
    id: string;
    panels: ReadonlyArray<{
      id: string;
      api: { close: () => void; component?: string };
    }>;
  };
}

export interface WorkspaceTabSessionContext {
  sessionId?: string | null;
  workspaceId?: string | null;
  isSessionTab?: boolean;
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
    refresh: t('tabCreation.refresh', '刷新'),
    sessionDetails: t('tabCreation.sessionDetails', '会话详情'),
    processes: t('tabCreation.processes', '进程'),
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

      const nonBrowserPlugins = pluginPanels.filter(
        (item) =>
          !browser ||
          item.pluginId !== browser.pluginId ||
          item.id !== browser.id
      );

      openSurfaceMenu(
        event,
        buildWorkspaceTabContextMenu(labels, {
          refresh:
            refreshCurrent ??
            (() =>
              requestPreviewTabRefresh({
                panelId: api.id,
                queryClient,
              })),
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
                t('tabCreation.processes', '进程')
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
