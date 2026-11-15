import React from 'react';
import { useTranslation } from 'react-i18next';
import { resolveBuiltinPanelTitle } from '@/lib/builtinPanelTitles';
import { type IDockviewPanelHeaderProps } from 'dockview-react';
import {
  Bot,
  ClipboardList,
  Columns3,
  File,
  FileDiff,
  FolderOpen,
  FolderTree,
  GitBranch,
  GitMerge,
  House,
  Image as ImageIcon,
  LayoutGrid,
  List,
  MessageSquare,
  MessagesSquare,
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
import { cn } from '@/lib/utils';
import {
  extractSessionIdFromPanelId,
  resolveSessionTabMarker,
  useWorkspaceOpenSessionIds,
} from '@/lib/workspaceSessionTabSlots';
import { isEditorTerminalPanelId } from '@/lib/workspaceTerminalTabs';
import { PANEL_IDS, type PanelId } from '@/stores/useLayoutStore';
import { isSessionPanelId } from '@/utils/dockviewGroupPolicy';
import {
  confirmCloseWorkspacePanel,
  useIsWorkspacePanelDirty,
} from '@/components/panels/previewPanelDirty';
import { QueryClientContext } from '@tanstack/react-query';
import { useAppContextMenu } from '@/components/context-menu';
import {
  useWorkspaceEditorTabMenu,
  type WorkspaceTabContextMenuKind,
} from '@/components/layout/panels/workspaceTabContextMenu';
import { requestPreviewTabRefresh } from '@/utils/previewTabRefresh';

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
  sessionId?: string | null;
  workspaceId?: string | null;
  agentId?: string | null;
  tabId?: string | null;
  shell?: string | null;
  cwd?: string | null;
}

const PANEL_TAB_ICONS: Partial<Record<string, [LucideIcon, string]>> = {
  [PANEL_IDS.AI_CHAT]: [MessageSquare, 'chat'],
  [PANEL_IDS.COLLABORATION_SPACE]: [MessagesSquare, 'collaboration-space'],
  [PANEL_IDS.DIFFS]: [FileDiff, 'diff'],
  [PANEL_IDS.FILE_TREE]: [FolderTree, 'file-tree'],
  [PANEL_IDS.EXTERNAL_DIRECTORY]: [FolderOpen, 'external-directory'],
  [PANEL_IDS.GIT]: [GitBranch, 'git'],
  [PANEL_IDS.MERGE]: [GitMerge, 'merge'],
  [PANEL_IDS.KANBAN]: [Columns3, 'kanban'],
  [PANEL_IDS.LOGS]: [ScrollText, 'logs'],
  [PANEL_IDS.NOTES]: [NotebookPen, 'note'],
  [PANEL_IDS.SESSION_DETAILS]: [ClipboardList, 'session-details'],
  [PANEL_IDS.PROCESSES]: [List, 'processes'],
  [PANEL_IDS.SEARCH]: [Search, 'search'],
  [PANEL_IDS.SESSION_LIST]: [MessagesSquare, 'session-list'],
  [PANEL_IDS.TERMINAL]: [SquareTerminal, 'terminal'],
  [PANEL_IDS.WELCOME]: [House, 'welcome'],
  'space-collection': [LayoutGrid, 'space-collection'],
  'member-session': [Bot, 'member-session'],
};

function SessionTabMarkerBadge({
  marker,
}: {
  marker: { bar: string; hue?: string };
}) {
  return (
    <span
      className={cn(
        'workspace-tab-icon workspace-session-tab-marker h-2 w-2 shrink-0 rounded-full',
        marker.bar
      )}
      data-tab-icon="session-marker"
      data-testid="workspace-session-tab-marker"
      style={marker.hue ? { backgroundColor: `hsl(${marker.hue})` } : undefined}
      aria-hidden="true"
    />
  );
}

function BoundSessionTabMarker({ sessionId }: { sessionId: string }) {
  const openSessionIds = useWorkspaceOpenSessionIds();
  const marker = React.useMemo(
    () => resolveSessionTabMarker(sessionId, openSessionIds),
    [openSessionIds, sessionId]
  );
  if (!marker) {
    return null;
  }
  return <SessionTabMarkerBadge marker={marker} />;
}

export function WorkspaceTabIcon({
  component,
  params,
  isBoundSessionTab,
  sessionId,
  sessionMarker,
}: {
  component: string;
  params: WorkspaceTabParams;
  isBoundSessionTab?: boolean;
  sessionId?: string | null;
  sessionMarker?: { bar: string; hue?: string } | null;
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

  if (isBoundSessionTab) {
    if (sessionMarker) {
      return <SessionTabMarkerBadge marker={sessionMarker} />;
    }
    if (sessionId) {
      return <BoundSessionTabMarker sessionId={sessionId} />;
    }
  }

  if (
    (component === PANEL_IDS.PREVIEW || component === 'file-preview') &&
    params.filePath
  ) {
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
  const { t } = useTranslation(['common', 'panels']);
  const { openSurfaceMenu } = useAppContextMenu();
  const [storedTitle, setTitle] = React.useState(api.title ?? '');
  // Builtin tab titles are persisted in the layout; resolve them per render so
  // a language switch also relabels tabs restored from an earlier session.
  const title = resolveBuiltinPanelTitle(api.id, storedTitle, t);
  const [tabParams, setTabParams] = React.useState<WorkspaceTabParams>(
    params ?? {}
  );
  const isMiddleMouseButton = React.useRef(false);
  const isPreviewDirty = useIsWorkspacePanelDirty(api.id, api.component);

  React.useEffect(() => {
    const disposable = api.onDidTitleChange((event) => {
      setTitle(event.title ?? '');
    });

    if (storedTitle !== (api.title ?? '')) {
      setTitle(api.title ?? '');
    }

    return () => disposable.dispose();
  }, [api, storedTitle]);

  React.useEffect(() => {
    const disposable = api.onDidParametersChange((nextParams) => {
      setTabParams(nextParams as WorkspaceTabParams);
    });
    return () => disposable.dispose();
  }, [api]);

  const sessionId =
    tabParams.sessionId?.trim() || extractSessionIdFromPanelId(api.id);
  const isSpaceTab =
    api.component === PANEL_IDS.COLLABORATION_SPACE ||
    api.component === 'member-session';
  const isTerminalTab =
    api.component === PANEL_IDS.TERMINAL || isEditorTerminalPanelId(api.id);
  const isSessionTab =
    !isSpaceTab &&
    !isTerminalTab &&
    (Boolean(sessionId) ||
      isSessionPanelId(api.id) ||
      api.component === PANEL_IDS.AI_CHAT);
  const tabKind: WorkspaceTabContextMenuKind = isSpaceTab
    ? 'space'
    : isTerminalTab
      ? 'terminal'
      : isSessionTab
        ? 'session'
        : 'default';
  const isBoundSessionTab = Boolean(sessionId);

  const effectiveHideClose = Boolean(hideClose);

  const queryClient = React.useContext(QueryClientContext);
  const refreshTab = React.useCallback(() => {
    if (!confirmCloseWorkspacePanel(api.id, api.component)) {
      return;
    }
    requestPreviewTabRefresh({
      panelId: api.id,
      filePath: tabParams?.filePath ?? null,
      queryClient,
    });
  }, [api.component, api.id, queryClient, tabParams?.filePath]);

  const closeTab = React.useCallback(() => {
    if (!confirmCloseWorkspacePanel(api.id, api.component)) {
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
  const editorTabMenu = useWorkspaceEditorTabMenu(api, closeTab, refreshTab, {
    tabKind,
    sessionId,
    workspaceId: tabParams.workspaceId ?? null,
    isSessionTab,
    terminalTabId: tabParams.tabId ?? null,
    terminalShell: tabParams.shell ?? null,
    terminalCwd: tabParams.cwd ?? null,
  });

  return (
    <div
      {...rest}
      data-testid="dockview-dv-default-tab"
      data-session-tab={isSessionTab ? 'true' : undefined}
      title={title}
      aria-label={title}
      className={cn(
        'dv-default-tab workspace-tab-surface',
        isSessionTab && 'workspace-session-tab'
      )}
      onContextMenu={(event) => {
        if (editorTabMenu) {
          editorTabMenu.open(event.nativeEvent);
          return;
        }
        const group = api.group;
        const panels = group?.panels ?? [];
        const index = panels.findIndex((panel) => panel.id === api.id);
        const closeSiblingPanel = (panel: (typeof panels)[number]) => {
          if (!confirmCloseWorkspacePanel(panel.id, panel.api.component)) {
            return;
          }
          panel.api.close();
        };
        openSurfaceMenu(event, [
          {
            id: 'refresh',
            label: t('panels:tabCreation.refresh', '刷新'),
            onSelect: refreshTab,
          },
          {
            id: 'close',
            label: t('contextMenu.closeTab'),
            disabled: effectiveHideClose,
            onSelect: () => onClose(event),
          },
          {
            id: 'close-others',
            label: t('contextMenu.closeOtherTabs'),
            disabled: effectiveHideClose || panels.length <= 1,
            onSelect: () => {
              panels
                .filter((panel) => panel.id !== api.id)
                .forEach(closeSiblingPanel);
            },
          },
          {
            id: 'close-right',
            label: t('contextMenu.closeTabsToRight'),
            disabled:
              effectiveHideClose || index < 0 || index >= panels.length - 1,
            onSelect: () => {
              panels.slice(index + 1).forEach(closeSiblingPanel);
            },
          },
        ]);
      }}
      onPointerDown={(event) => {
        isMiddleMouseButton.current = event.button === 1;
        onPointerDown?.(event);
      }}
      onPointerUp={(event) => {
        if (
          isMiddleMouseButton.current &&
          event.button === 1 &&
          !effectiveHideClose
        ) {
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
      <WorkspaceTabIcon
        component={api.component}
        params={tabParams}
        isBoundSessionTab={isBoundSessionTab}
        sessionId={sessionId}
      />
      <span className="dv-default-tab-content">{title}</span>
      {isPreviewDirty && (
        <span
          data-testid="workspace-tab-dirty-indicator"
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--warning))]"
        />
      )}
      {!effectiveHideClose && (
        <div
          className="dv-default-tab-action rounded-full"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onClose}
          aria-label={t('panels:shellA11y.closeTab', {
            title,
            defaultValue: `Close ${title}`,
          })}
          role="button"
        >
          <X className="h-3 w-3" />
        </div>
      )}
    </div>
  );
}
