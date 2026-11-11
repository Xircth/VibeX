import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Layers, Pencil, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { worldRect } from './canvasGrouping';
import type { SessionCanvasNode } from './canvasModel';
import type {
  SessionCanvasBoardEntry,
  SessionCanvasDocument,
} from './canvasStorage';

const PREVIEW_VIEWBOX_W = 160;
const PREVIEW_VIEWBOX_H = 100;
const PREVIEW_PAD = 12;

interface BirdseyeShape {
  id: string;
  kind: 'group' | 'expanded' | 'card';
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BirdseyeLine {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function buildBirdseyeGeometry(document: SessionCanvasDocument): {
  shapes: BirdseyeShape[];
  lines: BirdseyeLine[];
} {
  const nodes = document.nodes;
  if (nodes.length === 0) return { shapes: [], lines: [] };

  const collapsedGroupIds = new Set(
    nodes
      .filter((node) => node.kind === 'group' && node.collapsed)
      .map((node) => node.id)
  );

  const visibleNodes = nodes.filter(
    (node) =>
      !(node.parentId && !node.expanded && collapsedGroupIds.has(node.parentId))
  );
  if (visibleNodes.length === 0) return { shapes: [], lines: [] };

  const rects = new Map<
    string,
    {
      node: SessionCanvasNode;
      x: number;
      y: number;
      width: number;
      height: number;
    }
  >();
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const node of visibleNodes) {
    const rect = worldRect(nodes, node);
    rects.set(node.id, {
      node,
      x: rect.x,
      y: rect.y,
      width: Math.max(rect.width, 24),
      height: Math.max(rect.height, 16),
    });
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }

  const worldW = Math.max(maxX - minX, 320);
  const worldH = Math.max(maxY - minY, 200);
  const usableW = PREVIEW_VIEWBOX_W - PREVIEW_PAD * 2;
  const usableH = PREVIEW_VIEWBOX_H - PREVIEW_PAD * 2;
  const scale = Math.min(usableW / worldW, usableH / worldH);
  const offsetX = PREVIEW_PAD + (usableW - worldW * scale) / 2;
  const offsetY = PREVIEW_PAD + (usableH - worldH * scale) / 2;

  const projectX = (wx: number) => offsetX + (wx - minX) * scale;
  const projectY = (wy: number) => offsetY + (wy - minY) * scale;

  const ordered = [...rects.values()].sort((a, b) => {
    const rank = (item: SessionCanvasNode) =>
      item.kind === 'group' ? 0 : item.expanded ? 2 : 1;
    return rank(a.node) - rank(b.node);
  });

  const shapes: BirdseyeShape[] = ordered.map((item) => ({
    id: item.node.id,
    kind:
      item.node.kind === 'group'
        ? 'group'
        : item.node.expanded
          ? 'expanded'
          : 'card',
    x: projectX(item.x),
    y: projectY(item.y),
    width: Math.max(item.width * scale, item.node.expanded ? 12 : 7),
    height: Math.max(item.height * scale, item.node.expanded ? 9 : 4.5),
  }));

  const shapeById = new Map(shapes.map((shape) => [shape.id, shape]));
  const lines: BirdseyeLine[] = [];
  for (const link of document.links ?? []) {
    const from = shapeById.get(link.sourceId);
    const to = shapeById.get(link.targetId);
    if (!from || !to) continue;
    lines.push({
      id: link.id,
      x1: from.x + from.width / 2,
      y1: from.y + from.height / 2,
      x2: to.x + to.width / 2,
      y2: to.y + to.height / 2,
    });
  }

  return { shapes, lines };
}

function CanvasBirdseyeThumbnail({
  document,
  emptyLabel,
}: {
  document: SessionCanvasDocument;
  emptyLabel: string;
}) {
  const patternId = useId();
  const { shapes, lines } = useMemo(
    () => buildBirdseyeGeometry(document),
    [document]
  );

  return (
    <div
      className={cn(
        'relative aspect-[16/10] w-full overflow-hidden rounded-lg border transition-colors',
        'border-border/80 bg-muted/40 group-hover/stage:border-border group-hover/stage:bg-muted/55'
      )}
    >
      <svg
        viewBox={`0 0 ${PREVIEW_VIEWBOX_W} ${PREVIEW_VIEWBOX_H}`}
        className="h-full w-full"
        aria-hidden="true"
      >
        <defs>
          <pattern
            id={patternId}
            width="12"
            height="12"
            patternUnits="userSpaceOnUse"
          >
            <circle
              cx="2"
              cy="2"
              r="0.7"
              fill="hsl(var(--muted-foreground) / 0.24)"
            />
          </pattern>
        </defs>
        <rect
          width={PREVIEW_VIEWBOX_W}
          height={PREVIEW_VIEWBOX_H}
          fill={`url(#${patternId})`}
        />
        {lines.map((line) => (
          <line
            key={line.id}
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
            stroke="hsl(var(--primary) / 0.5)"
            strokeWidth="1.1"
            strokeDasharray="2.5 2"
          />
        ))}
        {shapes.map((shape) => {
          if (shape.kind === 'group') {
            return (
              <rect
                key={shape.id}
                x={shape.x}
                y={shape.y}
                width={shape.width}
                height={shape.height}
                rx="3"
                fill="hsl(var(--primary) / 0.06)"
                stroke="hsl(var(--muted-foreground) / 0.45)"
                strokeWidth="0.9"
                strokeDasharray="2.5 1.8"
              />
            );
          }
          if (shape.kind === 'expanded') {
            const headerH = Math.min(3.2, shape.height * 0.28);
            return (
              <g key={shape.id}>
                <rect
                  x={shape.x}
                  y={shape.y}
                  width={shape.width}
                  height={shape.height}
                  rx="2.5"
                  fill="hsl(var(--card))"
                  stroke="hsl(var(--foreground) / 0.3)"
                  strokeWidth="0.9"
                />
                <rect
                  x={shape.x + 0.6}
                  y={shape.y + 0.6}
                  width={Math.max(shape.width - 1.2, 0)}
                  height={headerH}
                  rx="1.6"
                  fill="hsl(var(--primary) / 0.28)"
                />
              </g>
            );
          }
          return (
            <rect
              key={shape.id}
              x={shape.x}
              y={shape.y}
              width={shape.width}
              height={shape.height}
              rx="1.8"
              fill="hsl(var(--foreground) / 0.24)"
              stroke="hsl(var(--card))"
              strokeWidth="0.5"
            />
          );
        })}
      </svg>
      {shapes.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="text-[10px] text-muted-foreground/75">
            {emptyLabel}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function SessionCanvasStageTriggerButton({
  open,
  canvasCount,
  onClick,
}: {
  open: boolean;
  canvasCount: number;
  onClick: () => void;
}) {
  const { t } = useTranslation(['tasks']);
  const label = open
    ? t('hubCanvas.hideStageDock')
    : t('hubCanvas.showStageDock');

  return (
    <button
      type="button"
      data-testid="canvas-stage-dock-trigger"
      className={cn(
        'relative inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors',
        open
          ? 'bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:bg-[var(--surface-control-hover)] hover:text-foreground'
      )}
      onClick={onClick}
      aria-label={label}
      aria-expanded={open}
      aria-pressed={open}
      title={label}
    >
      <Layers className="size-4" />
      {canvasCount > 1 ? (
        <span
          className={cn(
            'pointer-events-none absolute -top-0.5 -right-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] font-semibold tabular-nums leading-none',
            open
              ? 'bg-background text-foreground shadow-sm'
              : 'bg-primary text-primary-foreground'
          )}
        >
          {canvasCount}
        </span>
      ) : null}
    </button>
  );
}

export function SessionCanvasStageDock({
  canvases,
  activeCanvasId,
  align = 'right',
  onSelectCanvas,
  onCreateCanvas,
  onRenameCanvas,
  onDeleteCanvas,
  onClose,
}: {
  canvases: readonly SessionCanvasBoardEntry[];
  activeCanvasId: string;
  align?: 'left' | 'right';
  onSelectCanvas: (canvasId: string) => void;
  onCreateCanvas: () => void;
  onRenameCanvas: (canvasId: string, name: string) => void;
  onDeleteCanvas: (canvasId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(['tasks']);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const inactiveCanvases = useMemo(
    () =>
      canvases
        .map((entry, index) => ({ entry, originalIndex: index }))
        .filter(({ entry }) => entry.id !== activeCanvasId),
    [activeCanvasId, canvases]
  );

  useEffect(() => {
    if (!editingId) return;
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editingId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (editingId) {
        event.stopPropagation();
        setEditingId(null);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editingId, onClose]);

  const startRename = (entry: SessionCanvasBoardEntry, fallback: string) => {
    setEditingId(entry.id);
    setDraftName(entry.name || fallback);
  };

  const commitRename = (canvasId: string) => {
    onRenameCanvas(canvasId, draftName);
    setEditingId(null);
  };

  const canDelete = canvases.length > 1;
  const stageManagerFoldTransform =
    align === 'left'
      ? 'perspective(480px) rotateY(16deg) rotateX(3deg) scale(0.965)'
      : 'perspective(480px) rotateY(-16deg) rotateX(3deg) scale(0.965)';
  const stageManagerOrigin = align === 'left' ? 'left center' : 'right center';

  return (
    <div
      role="region"
      aria-label={t('hubCanvas.stageDock')}
      data-testid="canvas-stage-dock"
      className={cn(
        'pointer-events-none flex max-w-[calc(100vw-4rem)] flex-col gap-2.5 py-1',
        align === 'left' ? 'items-start' : 'items-end'
      )}
    >
      {inactiveCanvases.length > 0 ? (
        <div
          data-testid="canvas-stage-list"
          className="flex items-center gap-3.5"
        >
          {inactiveCanvases.map(({ entry, originalIndex }) => {
            const isHovered = entry.id === hoveredId;
            const isEditing = entry.id === editingId;
            const fallbackName = t('hubCanvas.defaultCanvasName', {
              index: originalIndex + 1,
            });
            const displayName = entry.name.trim() || fallbackName;
            const nodeCount = entry.document.nodes.length;

            return (
              <div
                key={entry.id}
                data-testid={`canvas-stage-item-${entry.id}`}
                data-stage-fold={align === 'left' ? 'inward-right' : 'inward-left'}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
                onMouseEnter={() => setHoveredId(entry.id)}
                onMouseLeave={() =>
                  setHoveredId((prev) => (prev === entry.id ? null : prev))
                }
                style={{
                  transform:
                    isHovered || isEditing
                      ? 'perspective(480px) rotateY(0deg) rotateX(0deg) translateY(-3px) scale(1.02)'
                      : stageManagerFoldTransform,
                  transformOrigin: stageManagerOrigin,
                  transformStyle: 'preserve-3d',
                }}
                className={cn(
                  'group/stage pointer-events-auto relative w-[184px] shrink-0 rounded-xl border border-border/85 p-1.5',
                  'bg-[var(--surface-card-strong)] shadow-[var(--shadow-popover)] backdrop-blur-md',
                  'transition-all duration-200 ease-out will-change-transform hover:border-primary/50 motion-reduce:!transform-none'
                )}
              >
                <button
                  type="button"
                  className="block w-full text-left focus-visible:outline-none"
                  onClick={() => onSelectCanvas(entry.id)}
                  aria-label={displayName}
                >
                  <CanvasBirdseyeThumbnail
                    document={entry.document}
                    emptyLabel={t('hubCanvas.canvasEmptyPreview')}
                  />
                </button>

                <div className="mt-1.5 flex min-h-6 items-center justify-between gap-1 px-0.5">
                  {isEditing ? (
                    <input
                      ref={inputRef}
                      type="text"
                      value={draftName}
                      onChange={(event) => setDraftName(event.target.value)}
                      onBlur={() => commitRename(entry.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          commitRename(entry.id);
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          event.stopPropagation();
                          setEditingId(null);
                        }
                      }}
                      aria-label={t('hubCanvas.renameCanvas')}
                      className="h-6 min-w-0 flex-1 rounded border border-primary/60 bg-background px-1.5 text-xs font-medium text-foreground focus:outline-none"
                    />
                  ) : (
                    <span
                      className="min-w-0 flex-1 cursor-pointer truncate text-left text-xs font-medium text-foreground select-none"
                      onClick={() => onSelectCanvas(entry.id)}
                      onDoubleClick={(event) => {
                        event.stopPropagation();
                        startRename(entry, fallbackName);
                      }}
                      title={displayName}
                    >
                      {displayName}
                    </span>
                  )}

                  {!isEditing ? (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <span className="px-1 text-[10px] tabular-nums text-muted-foreground group-hover/stage:hidden">
                        {t('hubCanvas.canvasNodeCount', { count: nodeCount })}
                      </span>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          startRename(entry, fallbackName);
                        }}
                        className="hidden size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-[var(--surface-control-hover)] hover:text-foreground group-hover/stage:inline-flex focus-visible:inline-flex"
                        aria-label={t('hubCanvas.renameCanvas')}
                        title={t('hubCanvas.renameCanvas')}
                      >
                        <Pencil className="size-3" />
                      </button>
                      {canDelete ? (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onDeleteCanvas(entry.id);
                          }}
                          className="hidden size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive group-hover/stage:inline-flex focus-visible:inline-flex"
                          aria-label={t('hubCanvas.deleteCanvas')}
                          title={t('hubCanvas.deleteCanvas')}
                        >
                          <Trash2 className="size-3" />
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      <button
        type="button"
        data-testid="canvas-stage-create"
        onClick={onCreateCanvas}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        className={cn(
          'pointer-events-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-foreground bg-foreground px-3.5',
          'text-xs font-medium text-background shadow-[var(--shadow-popover)]',
          'transition-all duration-200 hover:-translate-y-0.5 hover:bg-foreground/90 active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
        )}
        aria-label={t('hubCanvas.createCanvas')}
        title={t('hubCanvas.createCanvas')}
      >
        <Plus className="size-3.5 stroke-[2.25]" />
        <span>{t('hubCanvas.createCanvas')}</span>
      </button>
    </div>
  );
}
