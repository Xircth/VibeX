import React, { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from 'dockview-react';
import {
  Columns3,
  File,
  FileDiff,
  FolderTree,
  GitBranch,
  Globe2,
  House,
  Image as ImageIcon,
  List,
  MessageSquare,
  NotebookPen,
  ScrollText,
  Search,
  SquareTerminal,
  X,
  type LucideIcon,
} from 'lucide-react';
import FileIcon from '@/components/FileIcon';
import { Loader } from '@/components/ui/loader';
import { PANEL_IDS, type PanelId } from '@/stores/useLayoutStore';

function WorkspacePanelFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <Loader size={24} />
    </div>
  );
}

function lazyPanel(
  loader: () => Promise<{ default: React.ComponentType<IDockviewPanelProps> }>
): React.FC<IDockviewPanelProps> {
  const Panel = lazy(loader);
  return function LazyDockviewPanel(props: IDockviewPanelProps) {
    return (
      <Suspense fallback={<WorkspacePanelFallback />}>
        <Panel {...props} />
      </Suspense>
    );
  };
}

/** Registry mapping panel component IDs to their React components. */
const PANEL_COMPONENT_MAP: Record<PanelId, React.FC<IDockviewPanelProps>> = {
  [PANEL_IDS.KANBAN]: lazyPanel(
    () => import('@/components/panels/DockviewKanbanPanel')
  ),
  [PANEL_IDS.FILE_TREE]: lazyPanel(
    () => import('@/components/panels/DockviewFileTreePanel')
  ),
  [PANEL_IDS.PREVIEW]: lazyPanel(
    () => import('@/components/panels/DockviewPreviewPanel')
  ),
  [PANEL_IDS.WEB_PREVIEW]: lazyPanel(
    () => import('@/components/panels/DockviewWebPreviewPanel')
  ),
  [PANEL_IDS.DIFFS]: lazyPanel(
    () => import('@/components/panels/DockviewDiffsReviewPanel')
  ),
  [PANEL_IDS.TERMINAL]: lazyPanel(
    () => import('@/components/panels/DockviewTerminalPanel')
  ),
  [PANEL_IDS.AI_CHAT]: lazyPanel(
    () => import('@/components/panels/DockviewAIChatPanel')
  ),
  [PANEL_IDS.GIT]: lazyPanel(
    () => import('@/components/panels/DockviewGitPanel')
  ),
  [PANEL_IDS.WELCOME]: lazyPanel(
    () => import('@/components/panels/DockviewWelcomePanel')
  ),
  [PANEL_IDS.LOGS]: lazyPanel(
    () => import('@/components/panels/DockviewLogsPanel')
  ),
  [PANEL_IDS.NOTES]: lazyPanel(
    () => import('@/components/panels/DockviewNotesPanel')
  ),
  [PANEL_IDS.SEARCH]: lazyPanel(
    () => import('@/components/panels/DockviewSearchPanel')
  ),
  [PANEL_IDS.SESSION_LIST]: lazyPanel(
    () =>
      import('@/components/workspace-session-list/WorkspaceSessionListPanel')
  ),
};

/**
 * The dockview component resolver.
 * Returns the appropriate panel component for the given component ID.
 */
export const panelComponents: Record<string, React.FC<IDockviewPanelProps>> = {
  ...PANEL_COMPONENT_MAP,
  // Serialized layouts from before the Web Preview rename still resolve.
  'dev-preview': PANEL_COMPONENT_MAP[PANEL_IDS.WEB_PREVIEW],
};

type WorkspaceDockviewTabProps = IDockviewPanelHeaderProps &
  React.HTMLAttributes<HTMLDivElement> & {
    hideClose?: boolean;
    closeActionOverride?: () => void;
  };

interface WorkspaceTabParams {
  faviconUrl?: string | null;
  filePath?: string | null;
  imagePreviewId?: string | null;
  mode?: 'editor' | 'diff';
}

const PANEL_TAB_ICONS: Partial<Record<PanelId, [LucideIcon, string]>> = {
  [PANEL_IDS.AI_CHAT]: [MessageSquare, 'chat'],
  [PANEL_IDS.DIFFS]: [FileDiff, 'diff'],
  [PANEL_IDS.FILE_TREE]: [FolderTree, 'file-tree'],
  [PANEL_IDS.GIT]: [GitBranch, 'git'],
  [PANEL_IDS.KANBAN]: [Columns3, 'kanban'],
  [PANEL_IDS.LOGS]: [ScrollText, 'logs'],
  [PANEL_IDS.NOTES]: [NotebookPen, 'note'],
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
    component === PANEL_IDS.WEB_PREVIEW &&
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

  const [Icon, iconKind] =
    component === PANEL_IDS.WEB_PREVIEW
      ? ([Globe2, 'browser'] as const)
      : (PANEL_TAB_ICONS[component as PanelId] ?? ([File, 'file'] as const));

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

  const onClose = React.useCallback(
    (event: React.PointerEvent | React.MouseEvent) => {
      event.preventDefault();
      if (closeActionOverride) {
        closeActionOverride();
      } else {
        api.close();
      }
    },
    [api, closeActionOverride]
  );

  return (
    <div
      {...rest}
      data-testid="dockview-dv-default-tab"
      title={title}
      className="dv-default-tab workspace-tab-surface"
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
          className="dv-default-tab-action"
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

/**
 * Panel metadata for display purposes.
 */
export interface PanelMeta {
  id: PanelId;
  title: string;
  defaultPosition: 'left' | 'center' | 'bottom';
}

export function usePanelMeta(): PanelMeta[] {
  const { t } = useTranslation(['panels', 'common']);

  return [
    {
      id: PANEL_IDS.FILE_TREE,
      title: t('panelRegistry.fileExplorer'),
      defaultPosition: 'left',
    },
    { id: PANEL_IDS.KANBAN, title: 'Kanban', defaultPosition: 'center' },
    { id: PANEL_IDS.PREVIEW, title: 'Preview', defaultPosition: 'center' },
    {
      id: PANEL_IDS.WEB_PREVIEW,
      title: 'Web Preview',
      defaultPosition: 'center',
    },
    { id: PANEL_IDS.DIFFS, title: 'Diffs', defaultPosition: 'center' },
    { id: PANEL_IDS.TERMINAL, title: 'Terminal', defaultPosition: 'bottom' },
    {
      id: PANEL_IDS.GIT,
      title: t('panelRegistry.gitManager'),
      defaultPosition: 'left',
    },
    {
      id: PANEL_IDS.WELCOME,
      title: t('panelRegistry.welcome'),
      defaultPosition: 'center',
    },
    { id: PANEL_IDS.LOGS, title: 'Logs', defaultPosition: 'center' },
    {
      id: PANEL_IDS.NOTES,
      title: t('panelRegistry.notes'),
      defaultPosition: 'center',
    },
    {
      id: PANEL_IDS.SEARCH,
      title: t('panelRegistry.search'),
      defaultPosition: 'left',
    },
    {
      id: PANEL_IDS.SESSION_LIST,
      title: t('panelRegistry.sessionList'),
      defaultPosition: 'left',
    },
  ];
}
