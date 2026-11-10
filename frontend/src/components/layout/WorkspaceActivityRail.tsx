import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  BarChart3,
  Bot,
  Code2,
  FolderOpen,
  GitBranch,
  GitFork,
  KanbanSquare,
  MessagesSquare,
  Search,
  Combine,
  type LucideIcon,
} from 'lucide-react';

import { useOptionalKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { cn } from '@/lib/utils';
import {
  type ActivityRailItemId,
  moveActivityRailItem,
  setActivityRailOrder,
  useActivityRailOrder,
} from '@/lib/activityRailOrder';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import {
  boxContains,
  ghostBoxForZone,
  resolveLeftPanelDropZone,
  type Box,
  type LeftPanelDropZone,
  type Point,
} from '@/lib/leftPanelSplit';

const RAIL_ICONS: Record<ActivityRailItemId, LucideIcon> = {
  [PANEL_IDS.FILE_TREE]: FolderOpen,
  [PANEL_IDS.GIT]: GitBranch,
  [PANEL_IDS.SEARCH]: Search,
  [PANEL_IDS.SESSION_LIST]: MessagesSquare,
  [PANEL_IDS.BOTS]: Bot,
};

const KANBAN_RAIL_VIEWS: Array<{
  id: 'builtin:columns' | 'builtin:repos' | 'builtin:usage';
  titleKey: string;
  fallback: string;
  Icon: LucideIcon;
}> = [
  {
    id: 'builtin:columns',
    titleKey: 'kanbanViews.columns',
    fallback: '任务面板',
    Icon: KanbanSquare,
  },
  {
    id: 'builtin:repos',
    titleKey: 'kanbanViews.repos',
    fallback: '仓库面板',
    Icon: GitFork,
  },
  {
    id: 'builtin:usage',
    titleKey: 'kanbanViews.usage',
    fallback: '计量统计',
    Icon: BarChart3,
  },
];

export function WorkspaceActivityRail({
  isEditorAreaVisible,
  onToggleEditorArea,
  mode = 'workspace',
}: {
  isEditorAreaVisible: boolean;
  onToggleEditorArea: () => void;
  mode?: 'workspace' | 'kanban';
}) {
  const { t } = useTranslation('panels');
  const kanbanContext = useOptionalKanbanSessionContext();
  const activeViewId = kanbanContext?.activeViewId ?? 'builtin:columns';
  const setActiveViewId = kanbanContext?.setActiveViewId;
  const {
    toggleFileTree,
    toggleGitPanel,
    toggleSearchPanel,
    toggleSessionList,
    toggleBotsPanel,
    isPanelOpen,
    placeLeftDockPanel,
    measureLeftDock,
    isLeftDockSplit,
    unsplitLeftDock,
  } = usePanelActionsContext();
  const persistedOrder = useActivityRailOrder();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );
  const [order, setOrder] = useState(persistedOrder);
  const [activeId, setActiveId] = useState<ActivityRailItemId | null>(null);
  const [dropZone, setDropZone] = useState<LeftPanelDropZone | null>(null);
  const [dockBox, setDockBox] = useState<Box | null>(null);
  const orderRef = useRef(order);
  const originRef = useRef<ActivityRailItemId[] | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const dropZoneRef = useRef<LeftPanelDropZone | null>(null);
  const dockBoxRef = useRef<Box | null>(null);
  orderRef.current = order;
  dropZoneRef.current = dropZone;
  dockBoxRef.current = dockBox;
  const persistedKey = persistedOrder.join('|');

  useEffect(() => {
    if (originRef.current) return;
    setOrder(persistedOrder);
  }, [persistedKey, persistedOrder]);

  const labels = useMemo(
    () =>
      ({
        [PANEL_IDS.FILE_TREE]: t('ideLayout.files'),
        [PANEL_IDS.GIT]: t('ideLayout.git'),
        [PANEL_IDS.SEARCH]: t('ideLayout.search'),
        [PANEL_IDS.SESSION_LIST]: t('panelRegistry.sessionList'),
        [PANEL_IDS.BOTS]: t('panelRegistry.bots', 'Bot 助手'),
      }) satisfies Record<ActivityRailItemId, string>,
    [t]
  );

  const toggles = useMemo(
    () =>
      ({
        [PANEL_IDS.FILE_TREE]: toggleFileTree,
        [PANEL_IDS.GIT]: toggleGitPanel,
        [PANEL_IDS.SEARCH]: toggleSearchPanel,
        [PANEL_IDS.SESSION_LIST]: toggleSessionList,
        [PANEL_IDS.BOTS]: toggleBotsPanel,
      }) satisfies Record<ActivityRailItemId, () => void>,
    [
      toggleBotsPanel,
      toggleFileTree,
      toggleGitPanel,
      toggleSearchPanel,
      toggleSessionList,
    ]
  );

  const persistOrder = useCallback((next: ActivityRailItemId[] | null) => {
    if (!next) return;
    setOrder(next);
    setActivityRailOrder(next);
  }, []);

  const handleDragStart = useCallback(
    ({ active }: DragStartEvent) => {
      originRef.current = orderRef.current;
      setActiveId(String(active.id) as ActivityRailItemId);
      const box = measureLeftDock();
      dockBoxRef.current = box;
      setDockBox(box);
      dropZoneRef.current = null;
      setDropZone(null);
    },
    [measureLeftDock]
  );

  const finishDrag = useCallback((next: ActivityRailItemId[] | null) => {
    const origin = originRef.current;
    originRef.current = null;
    setActiveId(null);
    dropZoneRef.current = null;
    setDropZone(null);
    dockBoxRef.current = null;
    setDockBox(null);
    if (!next) {
      if (origin) setOrder(origin);
      return;
    }
    setOrder(next);
    if (origin && next.join('|') !== origin.join('|')) {
      setActivityRailOrder(next);
    }
  }, []);

  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const pointer = args.pointerCoordinates;
    const box = dockBoxRef.current;
    if (pointer && box && boxContains(box, pointer)) {
      return [];
    }
    return closestCenter(args);
  }, []);

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    const pointer = pointerFromDrag(event);
    const box = dockBoxRef.current;
    const railBox = boxFromElement(railRef.current);
    let next: LeftPanelDropZone | null = null;
    if (pointer && box && !(railBox && boxContains(railBox, pointer))) {
      next = resolveLeftPanelDropZone(pointer, box);
    }
    if (next !== dropZoneRef.current) {
      dropZoneRef.current = next;
      setDropZone(next);
    }
  }, []);

  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      const origin = originRef.current ?? orderRef.current;
      const zone = dropZoneRef.current;
      const panelId = String(active.id) as ActivityRailItemId;
      if (zone) {
        finishDrag(origin);
        placeLeftDockPanel(panelId, zone);
        return;
      }
      if (!over) {
        finishDrag(null);
        return;
      }
      finishDrag(
        moveActivityRailItem(origin, panelId, String(over.id)) ?? origin
      );
    },
    [finishDrag, placeLeftDockPanel]
  );

  const handleDragCancel = useCallback(() => {
    finishDrag(null);
  }, [finishDrag]);

  const handleNudge = useCallback(
    (itemId: ActivityRailItemId, direction: -1 | 1) => {
      if (itemId === PANEL_IDS.SEARCH) return;
      const visible = order.filter((id) => id !== PANEL_IDS.SEARCH);
      const from = visible.indexOf(itemId);
      const target = from < 0 ? undefined : visible[from + direction];
      if (!target) return;
      persistOrder(moveActivityRailItem(order, itemId, target));
    },
    [order, persistOrder]
  );

  if (mode === 'kanban') {
    return (
      <nav
        ref={railRef}
        aria-label={t('ideLayout.activityRailAria')}
        className="workspace-activity-rail workspace-chrome relative flex w-9 shrink-0 flex-col items-center gap-0.5 pt-2"
      >
        {KANBAN_RAIL_VIEWS.map((view) => {
          const label = t(view.titleKey, view.fallback);
          const isActive = activeViewId === view.id;
          const Icon = view.Icon;
          return (
            <button
              key={view.id}
              type="button"
              data-testid={`kanban-rail-${view.id}`}
              aria-label={label}
              aria-pressed={isActive}
              title={label}
              onClick={() => setActiveViewId?.(view.id)}
              className={cn(
                'workspace-side-rail-button flex h-7 w-7 items-center justify-center',
                isActive && 'is-active'
              )}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          );
        })}
      </nav>
    );
  }

  return (
    <nav
      ref={railRef}
      aria-label={t('ideLayout.activityRailAria')}
      className="workspace-activity-rail workspace-chrome relative flex w-9 shrink-0 flex-col items-center gap-0.5 pt-2"
    >
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext
          items={order.filter((itemId) => itemId !== PANEL_IDS.SEARCH)}
          strategy={verticalListSortingStrategy}
        >
          {order
            .filter((itemId) => itemId !== PANEL_IDS.SEARCH)
            .map((itemId) => (
              <ActivityRailItem
                key={itemId}
                itemId={itemId}
                label={labels[itemId]}
                Icon={RAIL_ICONS[itemId]}
                active={isPanelOpen(itemId)}
                onSelect={toggles[itemId]}
                onNudge={handleNudge}
              />
            ))}
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {activeId ? (
            <ActivityRailMark
              label={labels[activeId]}
              Icon={RAIL_ICONS[activeId]}
              active={isPanelOpen(activeId)}
            />
          ) : null}
        </DragOverlay>
      </DndContext>
      {activeId && dockBox && dropZone
        ? createPortal(
            <div
              className="left-panel-split-overlay"
              style={{
                top: dockBox.y,
                left: dockBox.x,
                width: dockBox.width,
                height: dockBox.height,
              }}
            >
              <div
                className="left-panel-split-ghost"
                style={ghostStyle(dockBox, dropZone)}
              />
            </div>,
            document.body
          )
        : null}
      {isLeftDockSplit() ? (
        <button
          type="button"
          onClick={unsplitLeftDock}
          title={t('ideLayout.unsplitLeftDock')}
          aria-label={t('ideLayout.unsplitLeftDock')}
          className="workspace-side-rail-button flex h-7 w-7 items-center justify-center"
        >
          <Combine className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <button
        type="button"
        onClick={onToggleEditorArea}
        className={`workspace-side-rail-button hidden h-7 w-7 items-center justify-center ${
          isEditorAreaVisible ? 'is-active' : ''
        }`}
        title={
          isEditorAreaVisible
            ? t('ideLayout.hideEditorAndTerminal')
            : t('ideLayout.showEditorAndTerminal')
        }
        aria-pressed={isEditorAreaVisible}
      >
        <Code2 className="h-3.5 w-3.5" />
      </button>
    </nav>
  );
}

function ActivityRailItem({
  itemId,
  label,
  Icon,
  active,
  onSelect,
  onNudge,
}: {
  itemId: ActivityRailItemId;
  label: string;
  Icon: LucideIcon;
  active: boolean;
  onSelect: () => void;
  onNudge: (itemId: ActivityRailItemId, direction: -1 | 1) => void;
}) {
  const { t } = useTranslation('panels');
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: itemId,
  });
  const { onKeyDown: dragKeyDown, ...dragListeners } = listeners ?? {};

  return (
    <button
      type="button"
      ref={setNodeRef}
      {...attributes}
      {...dragListeners}
      data-basic-guide={
        itemId === PANEL_IDS.SESSION_LIST
          ? 'rail-session-list'
          : itemId === PANEL_IDS.FILE_TREE
            ? 'rail-file-tree'
            : itemId === PANEL_IDS.GIT
              ? 'rail-git'
              : undefined
      }
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        'workspace-side-rail-button flex h-7 w-7 items-center justify-center',
        active && 'is-active',
        isDragging && 'is-placeholder'
      )}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      onClick={onSelect}
      onKeyDown={(event) => {
        dragKeyDown?.(event);
        if (!event.altKey) return;
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          onNudge(itemId, -1);
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          onNudge(itemId, 1);
        }
      }}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="sr-only">{t('ideLayout.reorderHint')}</span>
    </button>
  );
}

function pointerFromDrag(event: DragMoveEvent | DragEndEvent): Point | null {
  const start = event.activatorEvent;
  if (!start || !('clientX' in start) || !('clientY' in start)) return null;
  const { clientX, clientY } = start as { clientX: unknown; clientY: unknown };
  if (typeof clientX !== 'number' || typeof clientY !== 'number') return null;
  return {
    x: clientX + event.delta.x,
    y: clientY + event.delta.y,
  };
}

function boxFromElement(element: HTMLElement | null): Box | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function ghostStyle(box: Box, zone: LeftPanelDropZone) {
  const ghost = ghostBoxForZone(box, zone);
  return {
    top: ghost.y - box.y,
    left: ghost.x - box.x,
    width: ghost.width,
    height: ghost.height,
  };
}

function ActivityRailMark({
  label,
  Icon,
  active,
}: {
  label: string;
  Icon: LucideIcon;
  active: boolean;
}) {
  return (
    <div
      className={cn(
        'workspace-side-rail-button is-dragging flex h-7 w-7 items-center justify-center',
        active && 'is-active'
      )}
      aria-hidden="true"
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="sr-only">{label}</span>
    </div>
  );
}
