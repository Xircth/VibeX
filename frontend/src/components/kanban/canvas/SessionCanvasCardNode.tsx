import { memo } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import { Maximize2, Unlink, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SessionHubListItem } from '@/components/kanban/session-hub/SessionHubListItem';
import {
  sessionAttentionKind,
  sessionSlotClasses,
  sessionSlotHue,
} from '@/components/kanban/session-hub/utils';
import {
  WorkspaceTabIcon,
  type WorkspaceTabParams,
} from '@/components/layout/panels/WorkspaceDockviewTab';
import { resolveBuiltinPanelTitle } from '@/lib/builtinPanelTitles';
import { cn } from '@/lib/utils';
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

function resolvePanelCardSubtitle(
  panelComponent: string,
  panelParams?: Record<string, unknown>
): string {
  if (typeof panelParams?.filePath === 'string' && panelParams.filePath) {
    return panelParams.filePath;
  }
  if (typeof panelParams?.shell === 'string' && panelParams.shell) {
    return panelParams.shell;
  }
  if (typeof panelParams?.dirPath === 'string' && panelParams.dirPath) {
    return panelParams.dirPath;
  }
  if (typeof panelParams?.spaceId === 'string' && panelParams.spaceId) {
    return panelParams.spaceId;
  }
  return panelComponent;
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
    const subtitle = resolvePanelCardSubtitle(
      data.panelComponent,
      data.panelParams
    );

    return (
      <div
        className="group/canvas-node relative h-full w-full"
        data-canvas-node-id={instanceId}
        onPointerDownCapture={() => setPendingCanvasParentNode(instanceId, 1500)}
      >
        <CanvasNodeHandles instanceId={instanceId} />
        <div
          role="button"
          tabIndex={0}
          data-testid={`canvas-panel-card-${data.panelComponent}`}
          onContextMenu={openContextMenu}
          onDoubleClick={(event) => {
            event.stopPropagation();
            expandCard(instanceId);
          }}
          className={cn(
            'canvas-board-units canvas-session-card session-hub-card group/session-card relative box-border flex h-full w-full max-w-full min-w-0 flex-col justify-between overflow-hidden rounded-lg px-3 py-2 text-left transition-colors duration-150',
            selected && 'is-selected'
          )}
        >
          <div className="absolute inset-y-2 left-0 w-1 rounded-r-full bg-primary/50" />
          <div className="flex min-w-0 items-center justify-between gap-1.5 pl-2">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <WorkspaceTabIcon
                component={data.panelComponent}
                params={(data.panelParams ?? {}) as WorkspaceTabParams}
              />
              <span
                className="session-hub-card-title min-w-0 flex-1 truncate text-[13px] font-medium text-foreground"
                title={resolvedTitle}
              >
                {resolvedTitle}
              </span>
            </div>
            <div className="nodrag flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/session-card:opacity-100">
              <button
                type="button"
                aria-label="展开节点"
                className="session-hub-card-action"
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
                onClick={(event) => {
                  event.stopPropagation();
                  removeCard(instanceId);
                }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center justify-between gap-1 pl-2 text-[10px] text-muted-foreground">
            <span className="min-w-0 flex-1 truncate" title={subtitle}>
              {subtitle}
            </span>
          </div>
        </div>
        {contextMenuElement}
      </div>
    );
  }

  if (!session) {
    if (!sessionsReady) {
      return (
        <div className="h-full w-full rounded-lg bg-[var(--surface-control)]" />
      );
    }
    return (
      <div
        className="group/canvas-node canvas-board-units relative flex h-full w-full flex-col items-start justify-between overflow-hidden rounded-lg border border-dashed border-border bg-[var(--surface-card-strong)] px-3 py-2 opacity-70"
        data-canvas-node-id={instanceId}
        onContextMenu={openContextMenu}
      >
        <CanvasNodeHandles instanceId={instanceId} />
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Unlink className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="text-xs">{t('hubCanvas.missingSession')}</span>
        </div>
        <button
          type="button"
          className="nodrag text-xs text-muted-foreground hover:text-destructive"
          onClick={() => removeCard(instanceId)}
        >
          {t('hubCanvas.removeCard')}
        </button>
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
          'canvas-board-units canvas-session-card h-full w-full overflow-hidden rounded-lg',
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
