import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from 'dockview-react';
import {
  Columns2,
  FileDiff,
  FileText,
  GitCompare,
  Globe,
  Image as ImageIcon,
  LayoutGrid,
  MessageSquare,
  Rows2,
  SquareTerminal,
  X,
} from 'lucide-react';
import type { ExecutorProfileId } from 'shared/types';

import { AgentIcon } from '@/components/agents/AgentIcon';
import { useAppContextMenu } from '@/components/context-menu';
import FileIcon from '@/components/FileIcon';
import {
  PLUGIN_PANEL_COMPONENT,
  panelComponents,
} from '@/components/layout/panels/PanelRegistry';
import { Button } from '@/components/ui/button';
import {
  PanelActionsContext,
  useOptionalPanelActionsContext,
  type PanelActions,
} from '@/contexts/PanelActionsContext';
import { registerImagePreviewSource } from '@/lib/imagePreviewRegistry';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import {
  buildPreviewPanelParams,
  type OpenFilePreviewOptions,
  type PreviewPanelParams,
} from '@/types/panels';

import { CollaborationSpaceCollectionDockviewPanel } from './CollaborationSpaceCollectionPanel';
import { type SpaceMember } from './spaceModel';

const SessionPreview = lazy(() =>
  import('@/components/kanban/KanbanSessionConversationView').then(
    (module) => ({
      default: module.KanbanSessionConversationView,
    })
  )
);

const FilePreviewPanel = lazy(
  () => import('@/components/panels/DockviewPreviewPanel')
);

export type MemberSessionPanelParams = {
  workspaceId: string;
  conversationId: string;
  nickname: string;
  agentId?: string;
};

export type PreviewTabItem =
  | {
      id: string;
      kind: 'member';
      title: string;
      workspaceId: string;
      conversationId: string;
      agentId?: string;
      spaceId: string;
    }
  | {
      id: string;
      kind: 'file';
      title: string;
      fileParams: PreviewPanelParams;
    }
  | {
      id: string;
      kind: 'workspace-panel';
      component: string;
      title: string;
      params?: Record<string, unknown>;
    };

export function memberPreviewPanelId(conversationId: string): string {
  return `member:${conversationId}`;
}

export function filePreviewPanelId(params: PreviewPanelParams): string {
  if (params.imagePreviewId) {
    return `image:${params.imagePreviewId}`;
  }
  const normalizedPath = String(params.filePath ?? '').replace(/\\/g, '/');
  return `${params.mode === 'diff' ? 'diff' : 'file'}:${normalizedPath}`;
}

export function filePreviewTitle(params: PreviewPanelParams): string {
  const display = params.displayPath?.trim();
  if (display) return display;
  const rawPath = String(params.filePath ?? '').replace(/\\/g, '/');
  const baseName = rawPath.split('/').filter(Boolean).pop();
  return baseName || '预览';
}

export function collaborationImagePreviewId(imageUrl: string): string {
  let hash = 5381;
  for (let index = 0; index < imageUrl.length; index += 1) {
    hash = ((hash << 5) + hash + imageUrl.charCodeAt(index)) | 0;
  }
  return `collaboration-image:${(hash >>> 0).toString(36)}`;
}

export function previewMemberKey(spaceId: string, member: SpaceMember): string {
  return `${spaceId}:${member.member_id ?? member.conversation_id ?? member.nickname ?? ''}`;
}

export function CollaborationMemberSessionDockviewPanel(
  props: IDockviewPanelProps<MemberSessionPanelParams>
) {
  const { workspaceId, conversationId } = props.params;
  const sessionPreviewProps = useMemo(
    () => ({
      workspaceId,
      sessionId: conversationId,
      interactive: true,
      showSessionSelector: false,
      markViewed: false,
      embedded: true,
      className: 'h-full',
      imagePreviewPresentation: 'dialog' as const,
      conversationWidthMode: 'workspace' as const,
    }),
    [conversationId, workspaceId]
  );

  return (
    <div className="collaboration-preview-frame h-full w-full">
      <Suspense fallback={<p className="collaboration-preview-empty">加载中</p>}>
        <SessionPreview {...sessionPreviewProps} />
      </Suspense>
    </div>
  );
}

export function CollaborationFileDockviewPanel(
  props: IDockviewPanelProps<PreviewPanelParams>
) {
  return (
    <div className="collaboration-preview-frame h-full w-full">
      <Suspense fallback={<p className="collaboration-preview-empty">加载中</p>}>
        <FilePreviewPanel {...props} />
      </Suspense>
    </div>
  );
}

export const COLLABORATION_PREVIEW_COMPONENTS = {
  ...panelComponents,
  'member-session': CollaborationMemberSessionDockviewPanel,
  'file-preview': CollaborationFileDockviewPanel,
  'space-collection': CollaborationSpaceCollectionDockviewPanel,
};

export function CollaborationPreviewDockviewTab(
  props: IDockviewPanelHeaderProps
) {
  const { api, containerApi, params } = props;
  const { openSurfaceMenu } = useAppContextMenu();
  const [title, setTitle] = useState(api.title ?? '');
  const [tabParams, setTabParams] = useState<Record<string, unknown>>(
    (params as Record<string, unknown> | undefined) ?? {}
  );
  const isMiddleMouseButton = useRef(false);

  useEffect(() => {
    const disposable = api.onDidTitleChange((event) => {
      setTitle(event.title ?? '');
    });
    if (title !== (api.title ?? '')) {
      setTitle(api.title ?? '');
    }
    return () => disposable.dispose();
  }, [api, title]);

  useEffect(() => {
    const disposable = api.onDidParametersChange((nextParams) => {
      setTabParams((nextParams as Record<string, unknown>) ?? {});
    });
    return () => disposable.dispose();
  }, [api]);

  const closeTab = useCallback(
    (event?: ReactPointerEvent | ReactMouseEvent) => {
      event?.preventDefault();
      event?.stopPropagation();
      api.close();
    },
    [api]
  );

  const splitTab = useCallback(
    (direction: 'below' | 'left' | 'right') => {
      const currentGroup = api.group;
      if (!currentGroup) return;
      const panel = containerApi.getPanel(api.id);
      if (!panel) return;
      const nextGroup = containerApi.addGroup({
        referenceGroup: currentGroup,
        direction,
      });
      panel.api.moveTo({ group: nextGroup });
      panel.api.setActive();
    },
    [api.group, api.id, containerApi]
  );

  const agentId =
    typeof tabParams.agentId === 'string' ? tabParams.agentId : '';
  const filePath =
    typeof tabParams.filePath === 'string' ? tabParams.filePath : '';
  const imagePreviewId =
    typeof tabParams.imagePreviewId === 'string'
      ? tabParams.imagePreviewId
      : '';
  const mode = typeof tabParams.mode === 'string' ? tabParams.mode : '';

  return (
    <div
      data-testid="dockview-dv-default-tab"
      title={title}
      className="dv-default-tab workspace-tab-surface"
      onContextMenu={(event) => {
        const group = api.group;
        const panels = group?.panels ?? [];
        const index = panels.findIndex((panel) => panel.id === api.id);
        openSurfaceMenu(event.nativeEvent, [
          {
            type: 'submenu',
            id: 'close',
            label: '关闭',
            children: [
              {
                id: 'close-current',
                label: '关闭当前标签页',
                onSelect: () => closeTab(),
              },
              {
                id: 'close-others',
                label: '关闭其他标签页',
                disabled: panels.length <= 1,
                onSelect: () => {
                  panels
                    .filter((panel) => panel.id !== api.id)
                    .forEach((panel) => panel.api.close());
                },
              },
              {
                id: 'close-right',
                label: '关闭右侧标签页',
                disabled: index < 0 || index >= panels.length - 1,
                onSelect: () => {
                  panels.slice(index + 1).forEach((panel) => panel.api.close());
                },
              },
            ],
          },
          {
            type: 'submenu',
            id: 'split',
            label: '拆分',
            children: [
              {
                id: 'split-right',
                label: '向右拆分',
                onSelect: () => splitTab('right'),
              },
              {
                id: 'split-down',
                label: '向下拆分',
                onSelect: () => splitTab('below'),
              },
              {
                id: 'split-left',
                label: '向左拆分',
                onSelect: () => splitTab('left'),
              },
            ],
          },
        ]);
      }}
      onPointerDown={(event) => {
        isMiddleMouseButton.current = event.button === 1;
      }}
      onPointerUp={(event) => {
        if (isMiddleMouseButton.current && event.button === 1) {
          isMiddleMouseButton.current = false;
          closeTab(event);
        }
      }}
      onPointerLeave={() => {
        isMiddleMouseButton.current = false;
      }}
    >
      {api.component === 'member-session' ? (
        <span
          className="workspace-tab-icon"
          data-tab-icon="member"
          data-testid="workspace-tab-icon"
        >
          {agentId ? (
            <AgentIcon
              agent={agentId as ExecutorProfileId['executor']}
              className="h-3.5 w-3.5"
            />
          ) : (
            <MessageSquare className="h-3.5 w-3.5" />
          )}
        </span>
      ) : filePath ? (
        mode === 'diff' ? (
          <FileDiff
            aria-hidden="true"
            className="workspace-tab-icon"
            data-tab-icon="diff"
            data-testid="workspace-tab-icon"
          />
        ) : (
          <span
            className="workspace-tab-icon"
            data-tab-icon="file"
            data-testid="workspace-tab-icon"
          >
            <FileIcon filePath={filePath} />
          </span>
        )
      ) : imagePreviewId ? (
        <ImageIcon
          aria-hidden="true"
          className="workspace-tab-icon"
          data-tab-icon="image"
          data-testid="workspace-tab-icon"
        />
      ) : api.component === PANEL_IDS.DIFFS ? (
        <GitCompare
          aria-hidden="true"
          className="workspace-tab-icon"
          data-tab-icon="diffs"
          data-testid="workspace-tab-icon"
        />
      ) : api.component === PANEL_IDS.NOTES ? (
        <FileText
          aria-hidden="true"
          className="workspace-tab-icon"
          data-tab-icon="notes"
          data-testid="workspace-tab-icon"
        />
      ) : api.component === PANEL_IDS.TERMINAL ? (
        <SquareTerminal
          aria-hidden="true"
          className="workspace-tab-icon"
          data-tab-icon="terminal"
          data-testid="workspace-tab-icon"
        />
      ) : api.component === 'space-collection' ? (
        <LayoutGrid
          aria-hidden="true"
          className="workspace-tab-icon"
          data-tab-icon="collection"
          data-testid="workspace-tab-icon"
        />
      ) : api.component === PLUGIN_PANEL_COMPONENT ? (
        <Globe
          aria-hidden="true"
          className="workspace-tab-icon"
          data-tab-icon="browser"
          data-testid="workspace-tab-icon"
        />
      ) : (
        <MessageSquare
          aria-hidden="true"
          className="workspace-tab-icon"
          data-tab-icon="chat"
          data-testid="workspace-tab-icon"
        />
      )}
      <span className="dv-default-tab-content">{title}</span>
      <div
        className="dv-default-tab-action rounded-full"
        onPointerDown={(event) => event.preventDefault()}
        onClick={closeTab}
        aria-label={`Close ${title}`}
        role="button"
      >
        <X className="h-3 w-3" />
      </div>
    </div>
  );
}

export function CollaborationPreviewHeaderActions(
  props: IDockviewHeaderActionsProps
) {
  const { containerApi, group } = props;
  const activePanel = group.activePanel;

  const handleSplit = (direction: 'right' | 'below') => {
    const targetPanel = group.activePanel;
    if (!targetPanel) return;
    const panel = containerApi.getPanel(targetPanel.id);
    if (!panel) return;
    const nextGroup = containerApi.addGroup({
      referenceGroup: group,
      direction,
    });
    panel.api.moveTo({ group: nextGroup });
    panel.api.setActive();
  };

  if (!activePanel) return null;

  return (
    <div className="flex h-full items-center gap-0.5 pr-1.5">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
        aria-label="向右拆分"
        title="向右拆分"
        onClick={() => handleSplit('right')}
      >
        <Columns2 className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
        aria-label="向下拆分"
        title="向下拆分"
        onClick={() => handleSplit('below')}
      >
        <Rows2 className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}

export function CollaborationPreviewScope({
  children,
  onOpenFile,
  onOpenWorkspacePanel,
  onRunInEditorGroup,
}: {
  children: ReactNode;
  onOpenFile: (params: PreviewPanelParams) => void;
  onOpenWorkspacePanel: (item: {
    id: string;
    component: string;
    title: string;
    params?: Record<string, unknown>;
  }) => void;
  onRunInEditorGroup: (groupId: string, action: () => void) => void;
}) {
  const parent = useOptionalPanelActionsContext();
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const onOpenWorkspacePanelRef = useRef(onOpenWorkspacePanel);
  onOpenWorkspacePanelRef.current = onOpenWorkspacePanel;
  const onRunInEditorGroupRef = useRef(onRunInEditorGroup);
  onRunInEditorGroupRef.current = onRunInEditorGroup;
  const value = useMemo<PanelActions>(() => {
    const noop = () => {};
    const noopFalse = () => false;
    const base: PanelActions = parent ?? {
      openOrFocusPanel: noop,
      openFilePreview: () => 'opened' as const,
      renameFilePreviews: noop,
      openImagePreview: noop,
      openWebPreview: noop,
      revealInFileTree: noop,
      openDiffPreview: noop,
      openDiffPreviewAtPath: noop,
      openMergePanel: noop,
      openCommitDiff: noop,
      openNewTerminal: noop,
      openTerminalEditorTab: noop,
      showTerminal: noop,
      toggleEditorArea: noop,
      runInEditorGroup: (_groupId, action) => action(),
      splitEditorPanel: noopFalse,
      sortEditorGroupByName: noop,
      openPanelInNewEditorGroup: noopFalse,
      canOpenPanelInNewEditorGroup: noopFalse,
      splitActiveEditor: noopFalse,
      canSplitActiveEditor: noopFalse,
      closePanel: noop,
      toggleFileTree: noop,
      showFileTree: noop,
      toggleGitPanel: noop,
      toggleSearchPanel: noop,
      toggleSessionList: noop,
      placeLeftDockPanel: noop,
      measureLeftDock: () => null,
      isLeftDockSplit: noopFalse,
      unsplitLeftDock: noop,
      isPanelOpen: noopFalse,
      focusKanban: noop,
      openLogs: noop,
      openNotes: noop,
      openPluginPanel: noop,
      setDockviewApi: noop,
    };
    return {
      ...base,
      openFilePreview: (filePath: string, options?: OpenFilePreviewOptions) => {
        onOpenFileRef.current(buildPreviewPanelParams(filePath, options));
        return 'opened' as const;
      },
      openDiffPreview: () => {
        onOpenWorkspacePanelRef.current({
          id: PANEL_IDS.DIFFS,
          component: PANEL_IDS.DIFFS,
          title: '变更',
        });
      },
      openDiffPreviewAtPath: (
        path: string,
        options?: OpenFilePreviewOptions & { title?: string }
      ) => {
        onOpenFileRef.current(
          buildPreviewPanelParams(path, { ...options, mode: 'diff' })
        );
      },
      openImagePreview: (
        imageUrl: string,
        options?: { title?: string | null }
      ) => {
        const imagePreviewId = collaborationImagePreviewId(imageUrl);
        registerImagePreviewSource(imagePreviewId, imageUrl);
        onOpenFileRef.current({
          ...buildPreviewPanelParams('', {
            displayPath: options?.title ?? null,
          }),
          imagePreviewId,
        });
      },
      openNotes: () => {
        onOpenWorkspacePanelRef.current({
          id: PANEL_IDS.NOTES,
          component: PANEL_IDS.NOTES,
          title: '笔记',
        });
      },
      openTerminalEditorTab: (shell?: string) => {
        const suffix = Date.now().toString(36);
        onOpenWorkspacePanelRef.current({
          id: `${PANEL_IDS.TERMINAL}-editor-${suffix}`,
          component: PANEL_IDS.TERMINAL,
          title: '终端',
          params: {
            surface: 'editor',
            tabId: suffix,
            ...(shell ? { shell } : {}),
          },
        });
      },
      openNewTerminal: () => {
        const suffix = Date.now().toString(36);
        onOpenWorkspacePanelRef.current({
          id: `${PANEL_IDS.TERMINAL}-editor-${suffix}`,
          component: PANEL_IDS.TERMINAL,
          title: '终端',
          params: {
            surface: 'editor',
            tabId: suffix,
          },
        });
      },
      openPluginPanel: (options) => {
        const id =
          options.panelId ||
          `plugin:${options.pluginId}:${options.contributionId}`;
        onOpenWorkspacePanelRef.current({
          id,
          component: PLUGIN_PANEL_COMPONENT,
          title: options.title || '插件',
          params: options as unknown as Record<string, unknown>,
        });
      },
      openWebPreview: (url?: string | null) => {
        onOpenWorkspacePanelRef.current({
          id: 'plugin:vibex.browser:browser',
          component: PLUGIN_PANEL_COMPONENT,
          title: 'Browser',
          params: {
            pluginId: 'vibex.browser',
            contributionId: 'browser',
            title: 'Browser',
            requestedUrl: url ?? null,
          },
        });
      },
      runInEditorGroup: (groupId: string, action: () => void) => {
        onRunInEditorGroupRef.current(groupId, action);
      },
    };
  }, [parent]);

  return (
    <PanelActionsContext.Provider value={value}>
      {children}
    </PanelActionsContext.Provider>
  );
}
