import { memo, useState } from 'react';
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react';
import { Scaling, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SessionMonitorCard } from '@/components/kanban/session-hub/SessionMonitorCard';
import {
  WorkspaceTabIcon,
  type WorkspaceTabParams,
} from '@/components/layout/panels/WorkspaceDockviewTab';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { resolveBuiltinPanelTitle } from '@/lib/builtinPanelTitles';
import { cn } from '@/lib/utils';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { CanvasNodeHandles } from './CanvasNodeHandles';
import { CanvasPanelHeaderSlotContext } from './CanvasPanelHeaderSlotContext';
import { CanvasPanelNodeBody } from './CanvasPanelNodeBody';
import {
  DETAIL_MIN_HEIGHT,
  DETAIL_MIN_WIDTH,
  DRAG_HANDLE_CLASS,
} from './canvasModel';
import { useCanvasSession, useSessionCanvasView } from './CanvasViewContext';
import { setPendingCanvasParentNode } from './canvasWorkspaceBridge';
import { useCanvasNodeContextMenu } from './useCanvasNodeContextMenu';

export interface SessionCanvasDetailData {
  sessionId: string;
  instanceId?: string;
  slotIndex?: number | null;
  panelId?: string;
  panelComponent?: string;
  panelTitle?: string;
  panelParams?: Record<string, unknown>;
  [key: string]: unknown;
}

export type SessionCanvasDetailFlowNode = Node<
  SessionCanvasDetailData,
  'sessionDetail'
>;

export const SessionCanvasDetailNode = memo(
  function SessionCanvasDetailNode({
    data,
    selected,
  }: NodeProps<SessionCanvasDetailFlowNode>) {
    const { t } = useTranslation(['tasks', 'common', 'panels']);
    const [headerSlotEl, setHeaderSlotEl] = useState<HTMLDivElement | null>(
      null
    );
    const {
      sessionsReady,
      collapseCard,
      previewResize,
      resizeCard,
      resetCardSize,
    } = useSessionCanvasView();
    const instanceId =
      data.instanceId ?? data.sessionId ?? data.panelId ?? 'detail';
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
      const isCollaborationSpacePanel =
        data.panelComponent === PANEL_IDS.COLLABORATION_SPACE;
      const resolvedTitle = resolveBuiltinPanelTitle(
        data.panelId ?? data.panelComponent,
        data.panelTitle ?? data.panelComponent,
        t
      );
      const resetSizeLabel = t('hubCanvas.resetCardSize');
      const collapseLabel = t('hubCanvas.collapseCard');

      return (
        <div
          className="group/canvas-node canvas-board-units relative h-full w-full cursor-auto select-text"
          data-canvas-node-id={instanceId}
          data-testid={`canvas-panel-window-${data.panelComponent}`}
          onPointerDownCapture={() =>
            setPendingCanvasParentNode(instanceId, 4000)
          }
        >
          <CanvasNodeHandles instanceId={instanceId} />
          <NodeResizer
            isVisible
            minWidth={DETAIL_MIN_WIDTH}
            minHeight={DETAIL_MIN_HEIGHT}
            lineClassName="canvas-node-resize-line"
            handleClassName="canvas-node-resize-handle"
            onResize={(_event, params) => previewResize(instanceId, params)}
            onResizeEnd={(_event, params) => resizeCard(instanceId, params)}
          />
          <div
            className={cn(
              'canvas-session-window flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border bg-[var(--surface-card-strong)] transition-colors',
              selected && 'is-selected'
            )}
          >
            <div
              data-testid="canvas-node-header"
              className={cn(
                'flex shrink-0 items-center justify-between gap-2 px-2.5',
                isCollaborationSpacePanel ? 'min-h-9 py-1' : 'h-8',
                `${DRAG_HANDLE_CLASS} cursor-grab active:cursor-grabbing`
              )}
              onContextMenu={openContextMenu}
              onDoubleClick={(event) => {
                if ((event.target as HTMLElement | null)?.closest('.nodrag')) {
                  return;
                }
                event.stopPropagation();
                collapseCard(instanceId);
              }}
            >
              {isCollaborationSpacePanel ? (
                <div
                  ref={setHeaderSlotEl}
                  data-testid="canvas-space-header-slot"
                  className="flex min-w-0 flex-1 items-center overflow-hidden"
                />
              ) : (
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <WorkspaceTabIcon
                    component={data.panelComponent}
                    params={(data.panelParams ?? {}) as WorkspaceTabParams}
                  />
                  <Badge
                    variant="secondary"
                    className="h-5 min-w-0 max-w-full shrink rounded-lg border-transparent bg-[var(--surface-control)] px-2 text-xs font-semibold text-[var(--text-strong)] hover:bg-[var(--surface-control)]"
                    title={resolvedTitle}
                  >
                    <span className="truncate">{resolvedTitle}</span>
                  </Badge>
                </div>
              )}
              <div className="flex shrink-0 items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="nodrag nopan h-7 w-7 text-[var(--text-strong)]"
                      aria-label={resetSizeLabel}
                      onClick={(event) => {
                        event.stopPropagation();
                        resetCardSize(instanceId);
                      }}
                      onDoubleClick={(event) => event.stopPropagation()}
                    >
                      <Scaling className="h-3.5 w-3.5" strokeWidth={2.25} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{resetSizeLabel}</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="nodrag nopan h-6 w-6 rounded-full text-muted-foreground hover:bg-background/40 hover:text-foreground"
                      aria-label={collapseLabel}
                      onClick={(event) => {
                        event.stopPropagation();
                        collapseCard(instanceId);
                      }}
                      onDoubleClick={(event) => event.stopPropagation()}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{collapseLabel}</TooltipContent>
                </Tooltip>
              </div>
            </div>

            <div className="nowheel nopan canvas-session-thread min-h-0 flex-1 w-full overflow-hidden rounded-t-xl bg-background">
              <CanvasPanelHeaderSlotContext.Provider
                value={isCollaborationSpacePanel ? headerSlotEl : null}
              >
                <CanvasPanelNodeBody
                  instanceId={instanceId}
                  panelId={data.panelId ?? instanceId}
                  panelComponent={data.panelComponent}
                  panelTitle={resolvedTitle}
                  panelParams={data.panelParams}
                  selected={selected}
                />
              </CanvasPanelHeaderSlotContext.Provider>
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
      return null;
    }

    return (
      <div
        className="group/canvas-node canvas-board-units relative h-full w-full cursor-auto select-text"
        data-canvas-node-id={instanceId}
        onPointerDownCapture={() =>
          setPendingCanvasParentNode(instanceId, 1500)
        }
      >
        <CanvasNodeHandles instanceId={instanceId} />
        <NodeResizer
          isVisible
          minWidth={DETAIL_MIN_WIDTH}
          minHeight={DETAIL_MIN_HEIGHT}
          lineClassName="canvas-node-resize-line"
          handleClassName="canvas-node-resize-handle"
          onResize={(_event, params) => previewResize(instanceId, params)}
          onResizeEnd={(_event, params) => resizeCard(instanceId, params)}
        />
        <SessionMonitorCard
          session={session}
          variant="canvas"
          selected={selected}
          slotIndex={typeof data.slotIndex === 'number' ? data.slotIndex : null}
          onZoom={() => resetCardSize(instanceId)}
          onClose={() => collapseCard(instanceId)}
          onHeaderContextMenu={openContextMenu}
        />
        {contextMenuElement}
      </div>
    );
  },
  (previous, next) =>
    previous.data.sessionId === next.data.sessionId &&
    previous.data.instanceId === next.data.instanceId &&
    previous.data.slotIndex === next.data.slotIndex &&
    previous.data.panelId === next.data.panelId &&
    previous.data.panelComponent === next.data.panelComponent &&
    previous.data.panelTitle === next.data.panelTitle &&
    previous.data.panelParams === next.data.panelParams &&
    previous.selected === next.selected
);
