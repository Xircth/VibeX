import { memo, useState } from 'react';
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react';
import { Folder } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CanvasNodeAnchors } from './CanvasNodeAnchors';
import {
  GROUP_COLLAPSED_HEIGHT,
  GROUP_HEADER_HEIGHT,
  groupHeightForRows,
  groupWidthForColumns,
} from './canvasGrouping';
import { DRAG_HANDLE_CLASS } from './canvasModel';
import { useSessionCanvasView } from './CanvasViewContext';
import { cn } from '@/lib/utils';

export interface SessionCanvasGroupData {
  instanceId: string;
  name: string;
  index: number;
  count: number;
  overflow: number;
  showAll: boolean;
  collapsed: boolean;
  isRunning?: boolean;
  isReviewing?: boolean;
  [key: string]: unknown;
}

export type SessionCanvasGroupFlowNode = Node<
  SessionCanvasGroupData,
  'sessionGroup'
>;

export const SessionCanvasGroupNode = memo(function SessionCanvasGroupNode({
  data,
  selected,
}: NodeProps<SessionCanvasGroupFlowNode>) {
  const { t } = useTranslation(['tasks']);
  const { renameGroup, toggleGroupShowAll, previewGroupResize, resizeGroup } =
    useSessionCanvasView();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.name);
  const collapsed = data.collapsed;

  return (
    <div className="relative h-full w-full">
      <CanvasNodeAnchors />
      <div
        className={cn(
          DRAG_HANDLE_CLASS,
          'canvas-board-units canvas-session-group flex h-full w-full flex-col overflow-hidden border bg-[var(--surface-card-strong)]',
          collapsed ? 'rounded-full' : 'rounded-xl',
          selected && 'is-selected',
          data.isRunning === true && 'is-running',
          data.isReviewing === true && 'is-reviewing'
        )}
      >
        <div
          className={cn(
            'flex shrink-0 cursor-grab items-center gap-2 px-2.5 active:cursor-grabbing',
            collapsed ? 'h-full' : undefined
          )}
          style={{
            height: collapsed ? GROUP_COLLAPSED_HEIGHT : GROUP_HEADER_HEIGHT,
          }}
        >
          <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {editing ? (
            <input
              value={draft}
              className="nodrag nopan min-w-0 flex-1 rounded-md border border-border bg-[var(--surface-control)] px-1.5 py-0.5 text-[14px] font-semibold text-[var(--text-strong)]"
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => {
                renameGroup(data.instanceId, draft);
                setEditing(false);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.currentTarget.blur();
                }
                if (event.key === 'Escape') {
                  setDraft(data.name);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="nodrag min-w-0 flex-1 truncate text-left text-[14px] font-semibold text-[var(--text-strong)]"
              onDoubleClick={(event) => {
                event.stopPropagation();
                setDraft(data.name);
                setEditing(true);
              }}
            >
              {data.name}
            </button>
          )}
          <span className="shrink-0 rounded-full bg-[var(--surface-control)] px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {data.index}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {data.count}
          </span>
        </div>
        {data.count === 0 && !collapsed ? (
          <div className="flex flex-1 items-center justify-center p-4">
            <p className="text-[11px] text-muted-foreground">
              {t('hubCanvas.emptyGroup')}
            </p>
          </div>
        ) : (
          <div className="min-h-0 flex-1" />
        )}
        {data.overflow > 0 && !collapsed ? (
          <button
            type="button"
            className="nodrag nopan flex h-8 shrink-0 items-center justify-center text-[11px] text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              toggleGroupShowAll(data.instanceId);
            }}
          >
            {data.showAll
              ? t('hubCanvas.collapseGroup')
              : t('hubCanvas.groupOverflow', { count: data.overflow })}
          </button>
        ) : null}
      </div>
      {!collapsed ? (
        <NodeResizer
          isVisible={selected}
          minWidth={groupWidthForColumns(1)}
          minHeight={groupHeightForRows(1)}
          lineClassName="canvas-node-resize-line"
          handleClassName="canvas-node-resize-handle"
          onResize={(_event, params) =>
            previewGroupResize(data.instanceId, params)
          }
          onResizeEnd={(_event, params) => resizeGroup(data.instanceId, params)}
        />
      ) : null}
    </div>
  );
});
