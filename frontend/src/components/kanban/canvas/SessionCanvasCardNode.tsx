import { memo } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import { Folder, Maximize2, SquareTerminal, Unlink, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SessionHubListItem } from '@/components/kanban/session-hub/SessionHubListItem';
import {
  INFO_TEXT_CLASS,
  sessionAttentionKind,
  sessionSlotClasses,
  sessionSlotHue,
} from '@/components/kanban/session-hub/utils';
import {
  WorkspaceTabIcon,
  type WorkspaceTabParams,
} from '@/components/layout/panels/WorkspaceDockviewTab';
import {
  builtinPanelTitle,
  resolveBuiltinPanelTitle,
} from '@/lib/builtinPanelTitles';
import { sessionTitleIsCjk } from '@/lib/sessionTitle';
import { cn } from '@/lib/utils';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { CanvasNodeHandles } from './CanvasNodeHandles';
import { useCanvasSession, useSessionCanvasView } from './CanvasViewContext';
import { setPendingCanvasParentNode } from './canvasWorkspaceBridge';
import { useCanvasNodeContextMenu } from './useCanvasNodeContextMenu';

export interface SessionCanvasCardData {
  sessionId: string;
  instanceId?: string;
  unresolved?: boolean;
  slotIndex?: number | null;
  panelId?: string;
  panelComponent?: string;
  panelTitle?: string;
  panelParams?: Record<string, unknown>;
  [key: string]: unknown;
}

export type SessionCanvasCardFlowNode = Node<
  SessionCanvasCardData,
  'sessionCard'
>;

interface PanelCardMeta {
  kindLabel: string;
  contextLabel: string | null;
  contextTooltip?: string;
  contextIcon?: 'folder' | 'terminal';
}

function extractParentFolderName(rawPath: string): string | null {
  const segments = rawPath
    .trim()
    .split(/[/\\]+/)
    .filter((part) => part.length > 0 && !/^[a-zA-Z]:$/.test(part));
  if (segments.length < 2) {
    return null;
  }
  return segments[segments.length - 2] ?? null;
}

function extractLeafName(rawPath: string): string | null {
  const segments = rawPath
    .trim()
    .split(/[/\\]+/)
    .filter((part) => part.length > 0 && !/^[a-zA-Z]:$/.test(part));
  return segments[segments.length - 1] ?? null;
}

function formatShellName(rawShell: string): string | null {
  const leaf = extractLeafName(rawShell);
  if (!leaf) return null;
  return leaf.replace(/\.(exe|cmd|bat)$/i, '');
}

function resolvePanelCardMeta(
  panelComponent: string,
  resolvedTitle: string,
  panelParams: Record<string, unknown> | undefined,
  t: (key: string, options?: Record<string, unknown>) => string
): PanelCardMeta {
  if (
    panelComponent === PANEL_IDS.PREVIEW ||
    panelComponent === 'file-preview'
  ) {
    const filePath =
      typeof panelParams?.filePath === 'string' ? panelParams.filePath : '';
    if (filePath) {
      const kindLabel =
        panelParams?.mode === 'diff'
          ? t('panels:panelRegistry.diffs')
          : t('panels:panelRegistry.preview');
      const parentFolder = extractParentFolderName(filePath);
      return {
        kindLabel,
        contextLabel: parentFolder,
        contextTooltip: filePath,
        contextIcon: parentFolder ? 'folder' : undefined,
      };
    }
    const rawUrl = typeof panelParams?.url === 'string' ? panelParams.url : '';
    if (rawUrl) {
      try {
        const parsed = new URL(rawUrl);
        return {
          kindLabel: t('panels:browserPanel.title'),
          contextLabel: parsed.host || null,
          contextTooltip: rawUrl,
        };
      } catch {
        return {
          kindLabel: t('panels:browserPanel.title'),
          contextLabel: null,
        };
      }
    }
    return {
      kindLabel: t('panels:panelRegistry.preview'),
      contextLabel: null,
    };
  }

  if (panelComponent === PANEL_IDS.COLLABORATION_SPACE) {
    const targetType = panelParams?.targetType;
    const threadId =
      typeof panelParams?.threadId === 'string' ? panelParams.threadId : '';
    const spaceId =
      typeof panelParams?.spaceId === 'string' ? panelParams.spaceId : '';
    const isDirect =
      targetType === 'direct' ||
      threadId.startsWith('direct:') ||
      spaceId.startsWith('direct:');
    return {
      kindLabel: t('panels:panelRegistry.collaborationSpace'),
      contextLabel: isDirect
        ? t('tasks:hubCanvas.panelDirectChat')
        : t('tasks:hubCanvas.panelGroupSpace'),
    };
  }

  if (panelComponent === 'member-session') {
    return {
      kindLabel: t('panels:panelRegistry.bots'),
      contextLabel: t('tasks:hubCanvas.panelBotSession'),
    };
  }

  if (panelComponent === 'space-collection') {
    return {
      kindLabel: t('panels:panelRegistry.collaborationSpace'),
      contextLabel: t('tasks:hubCanvas.panelSharedFiles'),
    };
  }

  if (panelComponent === PANEL_IDS.TERMINAL) {
    const shell =
      typeof panelParams?.shell === 'string'
        ? formatShellName(panelParams.shell)
        : null;
    const cwd =
      typeof panelParams?.cwd === 'string' ? panelParams.cwd.trim() : '';
    const cwdLeaf = cwd ? extractLeafName(cwd) : null;
    return {
      kindLabel: t('panels:panelRegistry.terminal'),
      contextLabel: shell ?? cwdLeaf,
      contextTooltip: cwd || undefined,
      contextIcon: shell ? 'terminal' : cwdLeaf ? 'folder' : undefined,
    };
  }

  if (panelComponent === PANEL_IDS.EXTERNAL_DIRECTORY) {
    const dirPath =
      typeof panelParams?.dirPath === 'string' ? panelParams.dirPath : '';
    const parentFolder = dirPath ? extractParentFolderName(dirPath) : null;
    return {
      kindLabel: t('panels:panelRegistry.externalDirectory'),
      contextLabel:
        parentFolder && parentFolder !== resolvedTitle ? parentFolder : null,
      contextTooltip: dirPath || undefined,
      contextIcon: parentFolder ? 'folder' : undefined,
    };
  }

  if (panelComponent === 'plugin-panel') {
    return {
      kindLabel: t('tasks:hubCanvas.panelPlugin'),
      contextLabel: null,
    };
  }

  const builtinLabel = builtinPanelTitle(panelComponent);
  return {
    kindLabel:
      builtinLabel && builtinLabel !== panelComponent
        ? builtinLabel
        : resolvedTitle,
    contextLabel: null,
  };
}

export const SessionCanvasCardNode = memo(function SessionCanvasCardNode({
  data,
  selected,
}: NodeProps<SessionCanvasCardFlowNode>) {
  const { t } = useTranslation(['tasks', 'common', 'panels']);
  const {
    sessionsReady,
    expandCard,
    removeCard,
    onRenameSession,
    onArchiveSession,
    onDeleteSession,
  } = useSessionCanvasView();
  const instanceId =
    data.instanceId ?? data.sessionId ?? data.panelId ?? 'card';
  const session = useCanvasSession(data.sessionId);
  const { openContextMenu, contextMenuElement } = useCanvasNodeContextMenu({
    instanceId,
    sessionId:
      data.sessionId ||
      (typeof data.panelParams?.sessionId === 'string'
        ? data.panelParams.sessionId
        : null),
    workspaceId:
      session?.workspace?.id ??
      (typeof data.panelParams?.workspaceId === 'string'
        ? data.panelParams.workspaceId
        : null),
    panelId: data.panelId ?? null,
    panelComponent: data.panelComponent ?? null,
    panelTitle: data.panelTitle ?? null,
    panelParams: data.panelParams,
  });

  if (data.panelComponent) {
    const resolvedTitle = resolveBuiltinPanelTitle(
      data.panelId ?? data.panelComponent,
      data.panelTitle ?? data.panelComponent,
      t
    );
    const meta = resolvePanelCardMeta(
      data.panelComponent,
      resolvedTitle,
      data.panelParams,
      t
    );

    return (
      <div
        className="group/canvas-node relative h-full w-full"
        data-canvas-node-id={instanceId}
        onPointerDownCapture={() =>
          setPendingCanvasParentNode(instanceId, 1500)
        }
      >
        <CanvasNodeHandles instanceId={instanceId} />
        <div
          className={cn(
            'canvas-node-context-menu canvas-board-units canvas-session-card h-full w-full rounded-lg',
            selected && 'is-selected'
          )}
        >
          <div
            role="button"
            tabIndex={0}
            data-testid={`canvas-panel-card-${data.panelComponent}`}
            onContextMenu={openContextMenu}
            onDoubleClick={(event) => {
              event.stopPropagation();
              expandCard(instanceId);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                expandCard(instanceId);
              }
            }}
            className={cn(
              'session-hub-card group/session-card relative box-border flex w-full max-w-full min-w-0 items-start gap-2 overflow-hidden rounded-lg px-3 py-2 text-left transition-colors duration-150',
              selected && 'is-selected'
            )}
          >
            <div className="absolute inset-y-3 left-0 w-[3px] rounded-r-full bg-muted-foreground/35" />
            <div className="min-w-0 w-0 flex-1 overflow-hidden pl-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <div
                  className={cn(
                    'session-hub-card-title min-w-0 flex-1 truncate text-[13px] text-foreground',
                    sessionTitleIsCjk(resolvedTitle)
                      ? 'font-normal'
                      : 'font-semibold'
                  )}
                  title={resolvedTitle}
                >
                  {resolvedTitle}
                </div>
                <div className="session-hub-card-agent pointer-events-none flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground [&_img]:h-4 [&_img]:w-4 [&_svg]:h-4 [&_svg]:w-4">
                  <WorkspaceTabIcon
                    component={data.panelComponent}
                    params={(data.panelParams ?? {}) as WorkspaceTabParams}
                  />
                </div>
              </div>
              <div className="mt-0.5 flex min-w-0 max-w-full items-center gap-1 text-[10px] text-muted-foreground">
                <span
                  className={cn(
                    meta.contextLabel
                      ? 'shrink-0 font-medium'
                      : 'min-w-0 flex-1 truncate font-medium',
                    INFO_TEXT_CLASS
                  )}
                  title={meta.kindLabel}
                >
                  {meta.kindLabel}
                </span>
                {meta.contextLabel ? (
                  <>
                    <span className="shrink-0 text-muted-foreground/50">·</span>
                    <span
                      className="flex min-w-0 flex-1 items-center gap-1"
                      title={meta.contextTooltip ?? meta.contextLabel}
                    >
                      {meta.contextIcon === 'folder' ? (
                        <Folder className="h-3 w-3 shrink-0 opacity-80" />
                      ) : meta.contextIcon === 'terminal' ? (
                        <SquareTerminal className="h-3 w-3 shrink-0 opacity-80" />
                      ) : null}
                      <span className="min-w-0 truncate">
                        {meta.contextLabel}
                      </span>
                    </span>
                  </>
                ) : null}
                <div className="nodrag pointer-events-none z-[1] ml-auto flex w-0 shrink-0 items-center gap-0.5 overflow-hidden opacity-0 transition-opacity group-hover/session-card:pointer-events-auto group-hover/session-card:w-auto group-hover/session-card:overflow-visible group-hover/session-card:opacity-100 focus-within:pointer-events-auto focus-within:w-auto focus-within:overflow-visible focus-within:opacity-100">
                  <button
                    type="button"
                    aria-label={t('hubCanvas.expandPanelCard')}
                    className="session-hub-card-action"
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      event.stopPropagation();
                      expandCard(instanceId);
                    }}
                  >
                    <Maximize2 className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    aria-label={t('hubCanvas.removeCard')}
                    className="session-hub-card-action"
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      event.stopPropagation();
                      removeCard(instanceId);
                    }}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
        {contextMenuElement}
      </div>
    );
  }

  if (!session) {
    if (!sessionsReady) {
      return (
        <div className="h-full w-full rounded-lg bg-[var(--surface-tabbar)]" />
      );
    }
    return (
      <div
        className="canvas-node-context-menu group/canvas-node canvas-board-units canvas-session-card-missing relative flex h-full w-full items-center overflow-hidden rounded-lg px-2.5 py-1.5 opacity-85"
        data-canvas-node-id={instanceId}
        onContextMenu={openContextMenu}
      >
        <CanvasNodeHandles instanceId={instanceId} />
        <div className="min-w-0 w-0 flex-1 overflow-hidden pl-1">
          <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <Unlink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-[13px]">
              {t('hubCanvas.missingSession')}
            </span>
          </div>
          <div className="mt-0.5 flex items-center">
            <button
              type="button"
              className="nodrag text-[10px] text-muted-foreground transition-colors hover:text-destructive"
              onClick={() => removeCard(instanceId)}
            >
              {t('hubCanvas.removeCard')}
            </button>
          </div>
        </div>
        {contextMenuElement}
      </div>
    );
  }

  const slotIndex = typeof data.slotIndex === 'number' ? data.slotIndex : null;
  const attention = sessionAttentionKind(session);

  return (
    <div
      className="group/canvas-node relative h-full w-full"
      data-canvas-node-id={instanceId}
      onPointerDownCapture={() => setPendingCanvasParentNode(instanceId, 1500)}
    >
      <CanvasNodeHandles instanceId={instanceId} />
      <div
        className={cn(
          'canvas-node-context-menu canvas-board-units canvas-session-card h-full w-full rounded-lg',
          selected && 'is-selected',
          attention === 'running' && 'is-running',
          attention === 'review' && 'is-reviewing'
        )}
      >
        <SessionHubListItem
          session={session}
          marker={
            slotIndex == null
              ? null
              : {
                  bar: sessionSlotClasses(slotIndex).bar,
                  hue: sessionSlotHue(slotIndex),
                }
          }
          isDeleteMode={false}
          isSelected={selected}
          displayMode="canvas"
          onClick={() => undefined}
          onToggleSelect={() => undefined}
          onContextMenuOverride={openContextMenu}
          onRenameSession={
            onRenameSession
              ? (name) => onRenameSession(session, name)
              : undefined
          }
          onArchiveSession={
            onArchiveSession ? () => onArchiveSession(session) : undefined
          }
          onDeleteSession={
            onDeleteSession ? () => onDeleteSession(session) : undefined
          }
        />
      </div>
      {contextMenuElement}
    </div>
  );
});
