import React from 'react';
import { useTranslation } from 'react-i18next';
import { type IDockviewPanelHeaderProps } from 'dockview-react';
import {
  ClipboardList,
  Columns3,
  File,
  FileDiff,
  FolderTree,
  GitBranch,
  GitMerge,
  House,
  Image as ImageIcon,
  List,
  MessageSquare,
  NotebookPen,
  Puzzle,
  ScrollText,
  Search,
  SquareTerminal,
  X,
  type LucideIcon,
} from 'lucide-react';
import { panelRegistry } from '@vibex/plugin-sdk';
import { contributionIconComponent } from '@/components/plugins/contributionIcon';
import FileIcon from '@/components/FileIcon';
import { PANEL_IDS, type PanelId } from '@/stores/useLayoutStore';
import { confirmDiscardMergePanel } from '@/components/panels/merge/mergePanelDirty';
import { useAppContextMenu } from '@/components/context-menu';
import { useWorkspaceEditorTabMenu } from '@/components/layout/panels/workspaceTabContextMenu';

const PLUGIN_PANEL_COMPONENT = 'plugin-panel';

export type WorkspaceDockviewTabProps = IDockviewPanelHeaderProps &
  React.HTMLAttributes<HTMLDivElement> & {
    hideClose?: boolean;
    closeActionOverride?: () => void;
  };

export interface WorkspaceTabParams {
  faviconUrl?: string | null;
  filePath?: string | null;
  imagePreviewId?: string | null;
  mode?: 'editor' | 'diff';
  icon?: string | null;
}

const PANEL_TAB_ICONS: Partial<Record<PanelId, [LucideIcon, string]>> = {
  [PANEL_IDS.AI_CHAT]: [MessageSquare, 'chat'],
  [PANEL_IDS.DIFFS]: [FileDiff, 'diff'],
  [PANEL_IDS.FILE_TREE]: [FolderTree, 'file-tree'],
  [PANEL_IDS.GIT]: [GitBranch, 'git'],
  [PANEL_IDS.MERGE]: [GitMerge, 'merge'],
  [PANEL_IDS.KANBAN]: [Columns3, 'kanban'],
  [PANEL_IDS.LOGS]: [ScrollText, 'logs'],
  [PANEL_IDS.NOTES]: [NotebookPen, 'note'],
  [PANEL_IDS.SESSION_DETAILS]: [ClipboardList, 'session-details'],
  [PANEL_IDS.PROCESSES]: [List, 'processes'],
  [PANEL_IDS.SEARCH]: [Search, 'search'],
  [PANEL_IDS.SESSION_LIST]: [List, 'session-list'],
  [PANEL_IDS.TERMINAL]: [SquareTerminal, 'terminal'],
  [PANEL_IDS.WELCOME]: [House, 'welcome'],
};

function WorkspaceTabIcon({
  component,
  params,
}: {
  component: string;
  params: WorkspaceTabParams;
}) {
  const faviconUrl = params.faviconUrl?.trim() || null;
  const [failedFaviconUrl, setFailedFaviconUrl] = React.useState<string | null>(
    null
  );
  React.useEffect(() => {
    setFailedFaviconUrl(null);
  }, [faviconUrl]);
  const usableFavicon =
    component === PLUGIN_PANEL_COMPONENT &&
    faviconUrl !== null &&
    failedFaviconUrl !== faviconUrl;

  if (usableFavicon) {
    return (
      <span
        className="workspace-tab-icon"
        data-tab-icon="browser-favicon"
        data-testid="workspace-tab-icon"
      >
        <img
          alt=""
          data-testid="workspace-tab-favicon"
          draggable={false}
          referrerPolicy="no-referrer"
          src={faviconUrl}
          onError={() => setFailedFaviconUrl(faviconUrl)}
        />
      </span>
    );
  }

  if (component === PANEL_IDS.PREVIEW && params.filePath) {
    if (params.mode === 'diff') {
      return (
        <FileDiff
          aria-hidden="true"
          className="workspace-tab-icon"
          data-tab-icon="diff"
          data-testid="workspace-tab-icon"
        />
      );
    }
    return (
      <span
        className="workspace-tab-icon"
        data-tab-icon="file"
        data-testid="workspace-tab-icon"
      >
        <FileIcon filePath={params.filePath} />
      </span>
    );
  }

  if (component === PANEL_IDS.PREVIEW && params.imagePreviewId) {
    return (
      <ImageIcon
        aria-hidden="true"
        className="workspace-tab-icon"
        data-tab-icon="image"
        data-testid="workspace-tab-icon"
      />
    );
  }

  if (
    component === PLUGIN_PANEL_COMPONENT ||
    (!PANEL_TAB_ICONS[component as PanelId] && panelRegistry.has(component))
  ) {
    const registeredIcon = panelRegistry.get(component)?.icon;
    const PluginIcon = contributionIconComponent(
      params.icon ?? registeredIcon,
      Puzzle
    );
    return (
      <PluginIcon
        aria-hidden="true"
        className="workspace-tab-icon"
        data-tab-icon="plugin"
        data-testid="workspace-tab-icon"
      />
    );
  }

  const [Icon, iconKind] =
    PANEL_TAB_ICONS[component as PanelId] ?? ([File, 'file'] as const);

  return (
    <Icon
      aria-hidden="true"
      className="workspace-tab-icon"
      data-tab-icon={iconKind}
      data-testid="workspace-tab-icon"
    />
  );
}

export function WorkspaceDockviewTab({
  api,
  containerApi: _containerApi,
  params,
  tabLocation: _tabLocation,
  hideClose,
  closeActionOverride,
  onPointerDown,
  onPointerUp,
  onPointerLeave,
  ...rest
}: WorkspaceDockviewTabProps) {
  const { t } = useTranslation(['common']);
  const { openSurfaceMenu } = useAppContextMenu();
  const [title, setTitle] = React.useState(api.title ?? '');
  const [tabParams, setTabParams] = React.useState<WorkspaceTabParams>(
    params ?? {}
  );
  const isMiddleMouseButton = React.useRef(false);

  React.useEffect(() => {
    const disposable = api.onDidTitleChange((event) => {
      setTitle(event.title ?? '');
    });

    if (title !== (api.title ?? '')) {
      setTitle(api.title ?? '');
    }

    return () => disposable.dispose();
  }, [api, title]);

  React.useEffect(() => {
    const disposable = api.onDidParametersChange((nextParams) => {
      setTabParams(nextParams as WorkspaceTabParams);
    });
    return () => disposable.dispose();
  }, [api]);

  const closeTab = React.useCallback(() => {
    if (
      api.component === PANEL_IDS.MERGE &&
      !confirmDiscardMergePanel(api.id)
    ) {
      return;
    }
    if (closeActionOverride) {
      closeActionOverride();
    } else {
      api.close();
    }
  }, [api, closeActionOverride]);
  const onClose = React.useCallback(
    (event: React.PointerEvent | React.MouseEvent) => {
      event.preventDefault();
      closeTab();
    },
    [closeTab]
  );
  const editorTabMenu = useWorkspaceEditorTabMenu(api, closeTab);

  return (
    <div
      {...rest}
      data-testid="dockview-dv-default-tab"
      title={title}
      className="dv-default-tab workspace-tab-surface"
      onContextMenu={(event) => {
        if (editorTabMenu) {
          editorTabMenu.open(event.nativeEvent);
          return;
        }
        const group = api.group;
        const panels = group?.panels ?? [];
        const index = panels.findIndex((panel) => panel.id === api.id);
        openSurfaceMenu(event, [
          {
            id: 'close',
            label: t('contextMenu.closeTab'),
            disabled: hideClose,
            onSelect: () => onClose(event),
          },
          {
            id: 'close-others',
            label: t('contextMenu.closeOtherTabs'),
            disabled: panels.length <= 1,
            onSelect: () => {
              panels
                .filter((panel) => panel.id !== api.id)
                .forEach((panel) => panel.api.close());
            },
          },
          {
            id: 'close-right',
            label: t('contextMenu.closeTabsToRight'),
            disabled: index < 0 || index >= panels.length - 1,
            onSelect: () => {
              panels.slice(index + 1).forEach((panel) => panel.api.close());
            },
          },
        ]);
      }}
      onPointerDown={(event) => {
        isMiddleMouseButton.current = event.button === 1;
        onPointerDown?.(event);
      }}
      onPointerUp={(event) => {
        if (isMiddleMouseButton.current && event.button === 1 && !hideClose) {
          isMiddleMouseButton.current = false;
          onClose(event);
        }
        onPointerUp?.(event);
      }}
      onPointerLeave={(event) => {
        isMiddleMouseButton.current = false;
        onPointerLeave?.(event);
      }}
    >
      <WorkspaceTabIcon component={api.component} params={tabParams} />
      <span className="dv-default-tab-content">{title}</span>
      {!hideClose && (
        <div
          className="dv-default-tab-action rounded-full"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onClose}
          aria-label={`Close ${title}`}
          role="button"
        >
          <X className="h-3 w-3" />
        </div>
      )}
    </div>
  );
}
