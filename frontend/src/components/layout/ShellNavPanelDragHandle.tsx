import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { GripVertical } from 'lucide-react';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import {
  ACTIVITY_RAIL_PANEL_TITLES,
  type ActivityRailItemId,
} from '@/lib/activityRailOrder';
import type { ShellNavDropTarget } from '@/lib/leftDockPlacement';
import {
  boxAxisOverlapRatios,
  boxContains,
  ghostBoxForZone,
  hasHalfBoxOverlap,
  resolveLeftPanelDropZone,
  type Box,
  type Point,
} from '@/lib/leftPanelSplit';
import { cn } from '@/lib/utils';

const DRAG_ACTIVATION_DISTANCE = 4;

export function ShellNavPanelDragHandle({
  panelId,
  className,
}: {
  panelId: ActivityRailItemId;
  className?: string;
}) {
  const { t } = useTranslation('panels');
  const {
    placeLeftDockPanel,
    swapLeftDockPanels,
    resolveShellNavDropTarget,
    measureShellNavPanels,
    measureLeftDock,
  } = usePanelActionsContext();

  const [dragging, setDragging] = useState(false);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [draggedBox, setDraggedBox] = useState<Box | null>(null);
  const [target, setTarget] = useState<ShellNavDropTarget | null>(null);

  const actionsRef = useRef({
    placeLeftDockPanel,
    swapLeftDockPanels,
    resolveShellNavDropTarget,
    measureShellNavPanels,
    measureLeftDock,
  });
  actionsRef.current = {
    placeLeftDockPanel,
    swapLeftDockPanels,
    resolveShellNavDropTarget,
    measureShellNavPanels,
    measureLeftDock,
  };

  const cleanupDragRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      cleanupDragRef.current?.();
    },
    []
  );

  const handlePointerDown = (
    event: React.PointerEvent<HTMLButtonElement>
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    cleanupDragRef.current?.();

    const initialPoint: Point = { x: event.clientX, y: event.clientY };
    const measuredPanels = actionsRef.current.measureShellNavPanels();
    const ownMeasurement = measuredPanels.find(
      (item) => item.panelId === panelId
    );
    const groupEl = event.currentTarget.closest<HTMLElement>('.dv-groupview');
    const groupRect = groupEl?.getBoundingClientRect();
    const fallbackDock = actionsRef.current.measureLeftDock();

    let currentSourceBox: Box =
      ownMeasurement?.box ??
      (groupRect && groupRect.width >= 1 && groupRect.height >= 1
        ? {
            x: groupRect.left,
            y: groupRect.top,
            width: groupRect.width,
            height: groupRect.height,
          }
        : fallbackDock ?? {
            x: Math.max(0, initialPoint.x - 180),
            y: Math.max(0, initialPoint.y - 18),
            width: 200,
            height: 480,
          });

    let anchorPoint: Point = initialPoint;
    let isDraggingNow = false;
    let currentTarget: ShellNavDropTarget | null = null;
    let didAutoSwap = false;
    let pendingCommitSplit = false;
    let lastSwappedWith: ActivityRailItemId | null = null;
    let lastSwapDirectionX = 0;
    let lastSwapDirectionY = 0;

    setPointer(initialPoint);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const current: Point = {
        x: moveEvent.clientX,
        y: moveEvent.clientY,
      };

      if (!isDraggingNow) {
        const dist = Math.hypot(
          current.x - initialPoint.x,
          current.y - initialPoint.y
        );
        if (dist < DRAG_ACTIVATION_DISTANCE) return;
        isDraggingNow = true;
        setDragging(true);
      }

      setPointer(current);

      const dx = current.x - anchorPoint.x;
      const dy = current.y - anchorPoint.y;
      const translatedBox: Box = {
        x: currentSourceBox.x + dx,
        y: currentSourceBox.y + dy,
        width: currentSourceBox.width,
        height: currentSourceBox.height,
      };
      setDraggedBox(translatedBox);

      const openPanels = actionsRef.current.measureShellNavPanels();
      const others = openPanels.filter((item) => item.panelId !== panelId);

      // 1. Check 50% width & height overlap for automatic live swap (自动移位)
      let bestSwapCandidate: {
        panelId: ActivityRailItemId;
        box: Box;
        area: number;
      } | null = null;

      for (const candidate of others) {
        const pointerCenteredBox: Box = {
          x: current.x - currentSourceBox.width / 2,
          y: currentSourceBox.y + dy,
          width: currentSourceBox.width,
          height: currentSourceBox.height,
        };
        const directOverlap = hasHalfBoxOverlap(
          translatedBox,
          candidate.box,
          0.5
        );
        const pointerOverlap =
          boxContains(candidate.box, current) &&
          hasHalfBoxOverlap(translatedBox, candidate.box, 0.5) &&
          hasHalfBoxOverlap(pointerCenteredBox, candidate.box, 0.5);

        if (directOverlap || pointerOverlap) {
          if (lastSwappedWith === candidate.panelId) {
            const reversingX =
              lastSwapDirectionX !== 0 &&
              Math.sign(dx) !== 0 &&
              Math.sign(dx) === -lastSwapDirectionX;
            const reversingY =
              lastSwapDirectionY !== 0 &&
              Math.sign(dy) !== 0 &&
              Math.sign(dy) === -lastSwapDirectionY;
            if (!reversingX && !reversingY) {
              continue;
            }
          }
          const { area } = boxAxisOverlapRatios(translatedBox, candidate.box);
          if (!bestSwapCandidate || area > bestSwapCandidate.area) {
            bestSwapCandidate = {
              panelId: candidate.panelId,
              box: candidate.box,
              area,
            };
          }
        }
      }

      if (bestSwapCandidate) {
        const swapped = actionsRef.current.swapLeftDockPanels(
          panelId,
          bestSwapCandidate.panelId
        );
        if (swapped) {
          didAutoSwap = true;
          pendingCommitSplit = false;
          lastSwappedWith = bestSwapCandidate.panelId;
          lastSwapDirectionX = Math.sign(dx);
          lastSwapDirectionY = Math.sign(dy);

          const updatedPanels = actionsRef.current.measureShellNavPanels();
          const updatedSelf = updatedPanels.find(
            (item) => item.panelId === panelId
          );
          const nextSlotBox = updatedSelf?.box ?? bestSwapCandidate.box;
          currentSourceBox = nextSlotBox;
          anchorPoint = current;

          const swapGhostTarget: ShellNavDropTarget = {
            side: updatedSelf?.side ?? 'left',
            zone: dx >= 0 ? 'right' : 'left',
            targetPanelId: bestSwapCandidate.panelId,
            containerBox: nextSlotBox,
            ghostBox: nextSlotBox,
          };
          currentTarget = swapGhostTarget;
          setTarget(swapGhostTarget);
          return;
        }
      }

      // 2. Resolve drop / split preview ghost (虚影作为位置预览)
      let resolved = actionsRef.current.resolveShellNavDropTarget(
        current,
        panelId
      );
      if (!resolved) {
        const fallbackBox = actionsRef.current.measureLeftDock();
        const zone = fallbackBox
          ? resolveLeftPanelDropZone(current, fallbackBox)
          : null;
        if (fallbackBox && zone) {
          resolved = {
            side: 'left',
            zone,
            containerBox: fallbackBox,
            ghostBox: ghostBoxForZone(fallbackBox, zone),
          };
        }
      }

      // When dragging toward another open panel horizontally/vertically before 50%
      // threshold, preview the swap slot if overlap is already >= 20% on one axis
      // and > 50% on the perpendicular axis.
      if (others.length > 0) {
        for (const candidate of others) {
          const ratios = boxAxisOverlapRatios(translatedBox, candidate.box);
          const approachingHorizontalSwap =
            ratios.heightRatio > 0.5 && ratios.widthRatio >= 0.2;
          const approachingVerticalSwap =
            ratios.widthRatio > 0.5 && ratios.heightRatio >= 0.2;
          if (approachingHorizontalSwap || approachingVerticalSwap) {
            const swapPreview: ShellNavDropTarget = {
              side: candidate.side,
              zone:
                candidate.box.x >= currentSourceBox.x ? 'right' : 'left',
              targetPanelId: candidate.panelId,
              containerBox: candidate.box,
              ghostBox: candidate.box,
            };
            currentTarget = swapPreview;
            pendingCommitSplit = false;
            setTarget(swapPreview);
            return;
          }
        }
      }

      if (resolved) {
        // If we already auto-swapped and pointer is still inside our own new slot,
        // keep showing the current slot ghost without triggering a redundant split on release.
        if (didAutoSwap && resolved.targetPanelId === panelId) {
          const selfPreview: ShellNavDropTarget = {
            ...resolved,
            containerBox: currentSourceBox,
            ghostBox: currentSourceBox,
          };
          currentTarget = selfPreview;
          pendingCommitSplit = false;
          setTarget(selfPreview);
          return;
        }
        pendingCommitSplit = true;
      } else {
        pendingCommitSplit = false;
      }

      currentTarget = resolved;
      setTarget(resolved);
    };

    const finishDrag = (commit: boolean) => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
      window.removeEventListener('keydown', handleKeyDown);
      cleanupDragRef.current = null;

      const finalTarget = currentTarget;
      const wasDragging = isDraggingNow;
      const shouldCommitPlace =
        commit &&
        wasDragging &&
        finalTarget &&
        (!didAutoSwap || pendingCommitSplit) &&
        finalTarget.targetPanelId !== panelId;

      setDragging(false);
      setPointer(null);
      setDraggedBox(null);
      setTarget(null);

      if (shouldCommitPlace && finalTarget) {
        if (finalTarget.side === 'right' || finalTarget.targetPanelId) {
          actionsRef.current.placeLeftDockPanel(panelId, finalTarget.zone, {
            side: finalTarget.side,
            targetPanelId: finalTarget.targetPanelId,
          });
        } else {
          actionsRef.current.placeLeftDockPanel(panelId, finalTarget.zone);
        }
      }
    };

    const handlePointerUp = () => finishDrag(true);
    const handlePointerCancel = () => finishDrag(false);
    const handleKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape') {
        finishDrag(false);
      }
    };

    cleanupDragRef.current = () => finishDrag(false);

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    window.addEventListener('keydown', handleKeyDown);
  };

  const title = t(
    'ideLayout.dragPanelHandle',
    '按住拖拽面板换位，或拖至页面右侧'
  );
  const panelTitle = ACTIVITY_RAIL_PANEL_TITLES[panelId] ?? panelId;

  return (
    <>
      <button
        type="button"
        data-testid={`shell-nav-drag-handle-${panelId}`}
        aria-label={title}
        title={title}
        onPointerDown={handlePointerDown}
        onClick={(event) => {
          event.stopPropagation();
        }}
        className={cn(
          'shell-nav-panel-drag-handle inline-flex h-5 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-low transition-colors hover:bg-secondary/60 hover:text-high active:cursor-grabbing',
          dragging && 'bg-secondary/80 text-high',
          className
        )}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      {dragging && target && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="left-panel-split-overlay"
              data-testid="shell-nav-drop-overlay"
              style={{
                top: target.containerBox.y,
                left: target.containerBox.x,
                width: target.containerBox.width,
                height: target.containerBox.height,
              }}
            >
              <div
                className="left-panel-split-ghost"
                data-testid="shell-nav-drop-ghost"
                style={{
                  top: target.ghostBox.y - target.containerBox.y,
                  left: target.ghostBox.x - target.containerBox.x,
                  width: target.ghostBox.width,
                  height: target.ghostBox.height,
                }}
              />
            </div>,
            document.body
          )
        : null}
      {dragging && draggedBox && pointer && typeof document !== 'undefined'
        ? createPortal(
            <div
              aria-hidden="true"
              data-testid={`shell-nav-floating-preview-${panelId}`}
              className="shell-nav-drag-floating-panel pointer-events-none fixed z-[9999] flex flex-col overflow-hidden rounded-lg border border-primary/50 bg-secondary/75 shadow-lg backdrop-blur-sm"
              style={{
                left: draggedBox.x,
                top: draggedBox.y,
                width: draggedBox.width,
                height: draggedBox.height,
                opacity: 0.72,
              }}
            >
              <div className="flex h-8 shrink-0 items-center justify-between border-b border-border/60 bg-secondary/90 px-2.5 text-xs font-medium text-high">
                <span className="truncate">{panelTitle}</span>
                <GripVertical className="h-3.5 w-3.5 text-low" />
              </div>
              <div className="flex-1 bg-background/30" />
            </div>,
            document.body
          )
        : null}
    </>
  );
}
