import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Code2,
  FolderOpen,
  GitBranch,
  MessagesSquare,
  Search,
  type LucideIcon,
} from 'lucide-react';

import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { cn } from '@/lib/utils';
import {
  type ActivityRailItemId,
  moveActivityRailItem,
  nudgeActivityRailItem,
  setActivityRailOrder,
  useActivityRailOrder,
} from '@/lib/activityRailOrder';
import { PANEL_IDS } from '@/stores/useLayoutStore';

const RAIL_ICONS: Record<ActivityRailItemId, LucideIcon> = {
  [PANEL_IDS.FILE_TREE]: FolderOpen,
  [PANEL_IDS.GIT]: GitBranch,
  [PANEL_IDS.SEARCH]: Search,
  [PANEL_IDS.SESSION_LIST]: MessagesSquare,
};

export function WorkspaceActivityRail({
  isEditorAreaVisible,
  onToggleEditorArea,
}: {
  isEditorAreaVisible: boolean;
  onToggleEditorArea: () => void;
}) {
  const { t } = useTranslation('panels');
  const {
    toggleFileTree,
    toggleGitPanel,
    toggleSearchPanel,
    toggleSessionList,
    isPanelOpen,
  } = usePanelActionsContext();
  const persistedOrder = useActivityRailOrder();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );
  const [order, setOrder] = useState(persistedOrder);
  const [activeId, setActiveId] = useState<ActivityRailItemId | null>(null);
  const orderRef = useRef(order);
  const originRef = useRef<ActivityRailItemId[] | null>(null);
  orderRef.current = order;
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
      }) satisfies Record<ActivityRailItemId, () => void>,
    [toggleFileTree, toggleGitPanel, toggleSearchPanel, toggleSessionList]
  );

  const persistOrder = useCallback((next: ActivityRailItemId[] | null) => {
    if (!next) return;
    setOrder(next);
    setActivityRailOrder(next);
  }, []);

  const handleDragStart = useCallback(({ active }: DragStartEvent) => {
    originRef.current = orderRef.current;
    setActiveId(String(active.id) as ActivityRailItemId);
  }, []);

  const finishDrag = useCallback((next: ActivityRailItemId[] | null) => {
    const origin = originRef.current;
    originRef.current = null;
    setActiveId(null);
    if (!next) {
      if (origin) setOrder(origin);
      return;
    }
    setOrder(next);
    if (origin && next.join('|') !== origin.join('|')) {
      setActivityRailOrder(next);
    }
  }, []);

  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      const origin = originRef.current ?? orderRef.current;
      if (!over) {
        finishDrag(null);
        return;
      }
      finishDrag(
        moveActivityRailItem(origin, String(active.id), String(over.id)) ??
          origin
      );
    },
    [finishDrag]
  );

  const handleDragCancel = useCallback(() => {
    finishDrag(null);
  }, [finishDrag]);

  const handleNudge = useCallback(
    (itemId: ActivityRailItemId, direction: -1 | 1) => {
      persistOrder(nudgeActivityRailItem(order, itemId, direction));
    },
    [order, persistOrder]
  );

  return (
    <nav
      aria-label={t('ideLayout.activityRailAria')}
      className="workspace-activity-rail workspace-divider-right relative flex w-9 shrink-0 flex-col items-center gap-0.5 bg-secondary/30 pt-2"
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          {order.map((itemId) => (
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
        <DragOverlay>
          {activeId ? (
            <ActivityRailMark
              label={labels[activeId]}
              Icon={RAIL_ICONS[activeId]}
              active={isPanelOpen(activeId)}
            />
          ) : null}
        </DragOverlay>
      </DndContext>
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
