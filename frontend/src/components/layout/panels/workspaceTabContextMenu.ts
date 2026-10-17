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
import { isEditorGroup } from '@/utils/dockviewGroupPolicy';
import { terminalHostPlatform } from '@/utils/platform';
import { useTranslation } from 'react-i18next';
import { openWorkspaceTerminal } from './openWorkspaceTerminal';

export interface WorkspaceTabMenuLabels {
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
    {
      type: 'submenu',
      id: 'new-terminal',
      label: labels.terminal,
      onSelect: () => actions.openTerminal(),
      children: actions.shells.map((shell) => ({
        id: `shell-${shell.value}`,
        label: shell.label,
        onSelect: () => actions.openTerminal(shell.value),
      })),
    },
  ];

  if (actions.openBrowser) {
    newItems.push({
      id: 'new-browser',
      label: labels.browser,
      onSelect: actions.openBrowser,
    });
  }

  return [
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
    },
  ];
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

export function useWorkspaceEditorTabMenu(
  api: EditorTabApi,
  closeCurrent: () => void
): { open: (event: MouseEvent) => void } | null {
  const { t } = useTranslation('panels');
  const { openSurfaceMenu } = useAppContextMenu();
  const {
    runInEditorGroup,
    splitEditorPanel,
    canOpenPanelInNewEditorGroup,
    openNotes,
    openDiffPreview,
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
  if (!group || !isEditorGroup(group)) return null;

  const labels: WorkspaceTabMenuLabels = {
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
      if (!current || !isEditorGroup(current)) return;
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

      openSurfaceMenu(
        event,
        buildWorkspaceTabContextMenu(labels, {
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
          sortByName: () => sortEditorGroupByName(current.id),
        })
      );
    },
  };
}
