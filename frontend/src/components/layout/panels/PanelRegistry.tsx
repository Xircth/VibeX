import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from 'dockview-react';
import { X } from 'lucide-react';
import { PANEL_IDS, type PanelId } from '@/stores/useLayoutStore';
import DockviewAIChatPanel from '@/components/panels/DockviewAIChatPanel';
import DockviewDiffsReviewPanel from '@/components/panels/DockviewDiffsReviewPanel';
import DockviewFileTreePanel from '@/components/panels/DockviewFileTreePanel';
import DockviewGitPanel from '@/components/panels/DockviewGitPanel';
import DockviewKanbanPanel from '@/components/panels/DockviewKanbanPanel';
import DockviewLogsPanel from '@/components/panels/DockviewLogsPanel';
import DockviewNotesPanel from '@/components/panels/DockviewNotesPanel';
import DockviewPreviewPanel from '@/components/panels/DockviewPreviewPanel';
import DockviewSearchPanel from '@/components/panels/DockviewSearchPanel';
import DockviewTerminalPanel from '@/components/panels/DockviewTerminalPanel';
import DockviewWebPreviewPanel from '@/components/panels/DockviewWebPreviewPanel';
import DockviewWelcomePanel from '@/components/panels/DockviewWelcomePanel';
import WorkspaceSessionListPanel from '@/components/workspace-session-list/WorkspaceSessionListPanel';

/** Registry mapping panel component IDs to their React components. */
const PANEL_COMPONENT_MAP: Record<
  PanelId,
  React.ComponentType<IDockviewPanelProps>
> = {
  [PANEL_IDS.KANBAN]: DockviewKanbanPanel,
  [PANEL_IDS.FILE_TREE]: DockviewFileTreePanel,
  [PANEL_IDS.PREVIEW]: DockviewPreviewPanel,
  [PANEL_IDS.WEB_PREVIEW]: DockviewWebPreviewPanel,
  [PANEL_IDS.DIFFS]: DockviewDiffsReviewPanel,
  [PANEL_IDS.TERMINAL]: DockviewTerminalPanel,
  [PANEL_IDS.AI_CHAT]: DockviewAIChatPanel,
  [PANEL_IDS.GIT]: DockviewGitPanel,
  [PANEL_IDS.WELCOME]: DockviewWelcomePanel,
  [PANEL_IDS.LOGS]: DockviewLogsPanel,
  [PANEL_IDS.NOTES]: DockviewNotesPanel,
  [PANEL_IDS.SEARCH]: DockviewSearchPanel,
  [PANEL_IDS.SESSION_LIST]: WorkspaceSessionListPanel,
};

/**
 * The dockview component resolver.
 * Returns the appropriate panel component for the given component ID.
 */
export const panelComponents: Record<
  string,
  React.FC<IDockviewPanelProps>
> = Object.fromEntries(
  Object.entries(PANEL_COMPONENT_MAP).map(([id, PanelComponent]) => [
    id,
    function PanelWrapper(props: IDockviewPanelProps) {
      return <PanelComponent {...props} />;
    },
  ])
);

// Safety net for serialized layouts that escaped the v22 store migration
// (e.g. restored from a backup): the Web Preview panel's pre-rename
// component id still resolves.
panelComponents['dev-preview'] = panelComponents[PANEL_IDS.WEB_PREVIEW];

const MAX_WORKSPACE_TAB_TITLE_CHARS = 6;

type WorkspaceDockviewTabProps = IDockviewPanelHeaderProps &
  React.HTMLAttributes<HTMLDivElement> & {
    hideClose?: boolean;
    closeActionOverride?: () => void;
  };

function truncateWorkspaceTabTitle(title: string): string {
  const chars = Array.from(title);
  if (chars.length <= MAX_WORKSPACE_TAB_TITLE_CHARS) {
    return title;
  }

  return `${chars.slice(0, MAX_WORKSPACE_TAB_TITLE_CHARS).join('')}...`;
}

export function WorkspaceDockviewTab({
  api,
  containerApi: _containerApi,
  params: _params,
  tabLocation: _tabLocation,
  hideClose,
  closeActionOverride,
  onPointerDown,
  onPointerUp,
  onPointerLeave,
  ...rest
}: WorkspaceDockviewTabProps) {
  const [title, setTitle] = React.useState(api.title ?? '');
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
      className="dv-default-tab"
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
      <span className="dv-default-tab-content">
        {truncateWorkspaceTabTitle(title)}
      </span>
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
