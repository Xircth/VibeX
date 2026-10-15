import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  type SortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentManagementView } from 'shared/types';

import { Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { AgentManagementIcon } from '@/components/agents/AgentManagementIcon';
import {
  AGENT_BAR_LAYOUT,
  agentBarLayoutStyle,
  agentBarPageGap,
  agentBarPageOf,
  agentBarPages,
  moveAgentInOrder,
  moveAgentToPageEdge,
  nudgeAgentInOrder,
} from './agentBarOrder';

type AgentBarProps = {
  agents: AgentManagementView[];
  selectedAgentId: string | null;
  registryOpen: boolean;
  refreshing?: boolean;
  /** Controls fixed at the end of the bar, outside the paged icons. */
  actions?: ReactNode;
  onSelect: (agentId: string) => void;
  onReorder: (agentIds: string[]) => void;
  onAdd?: () => void;
  onRefresh?: () => void;
  orientation?: 'horizontal' | 'vertical';
  /** Agents whose ACP runtime install has finished. */
  installReadyIds?: ReadonlySet<string>;
};

type PagerDirection = 'previous' | 'next';

const PAGER_DROPPABLE_IDS: Record<PagerDirection, string> = {
  previous: 'agent-bar-page-previous',
  next: 'agent-bar-page-next',
};
const PAGER_DROPPABLE_ID_SET = new Set(Object.values(PAGER_DROPPABLE_IDS));

/** Hovering a dragged icon over a pager arrow flips the page after this. */
const DRAG_PAGE_DELAY_MS = 450;

/**
 * Reordering is applied live from `onDragOver`, so the sortable strategy has
 * no transforms to contribute; this also keeps items on other pages from
 * being shifted by rects that are off screen.
 */
const keepLayout: SortingStrategy = () => null;

export function AgentBar(props: AgentBarProps) {
  if (props.orientation === 'vertical') {
    return <AgentBarVertical {...props} />;
  }
  return <AgentBarHorizontal {...props} />;
}

function AgentBarVertical({
  agents,
  selectedAgentId,
  registryOpen,
  onSelect,
  installReadyIds,
}: AgentBarProps) {
  const { t } = useTranslation('settings');
  return (
    <nav
      aria-label={t('agents.agentListAria')}
      className="agent-management-bar agent-management-bar-vertical"
      style={agentBarLayoutStyle}
    >
      {agents.map((agent) => {
        const selected = !registryOpen && selectedAgentId === agent.agent_id;
        const ready = installReadyIds?.has(agent.agent_id) ?? false;
        return (
          <button
            key={agent.agent_id}
            type="button"
            aria-label={agent.display_name}
            aria-current={selected ? 'true' : undefined}
            className={cn(
              'agent-management-bar-item',
              selected && 'is-selected',
              !agent.enabled && 'is-disabled'
            )}
            onClick={() => onSelect(agent.agent_id)}
          >
            <AgentManagementIcon agent={agent} className="h-5 w-5" />
            {ready ? (
              <span
                aria-hidden="true"
                className="settings-status-lamp settings-status-dot-success agent-install-lamp"
              />
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}

function AgentBarHorizontal({
  agents,
  selectedAgentId,
  registryOpen,
  refreshing = false,
  actions,
  onSelect,
  onReorder,
  onAdd,
  onRefresh,
}: AgentBarProps) {
  const { t } = useTranslation('settings');
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );
  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.agent_id, agent])),
    [agents]
  );
  const incomingOrderKey = agents.map((agent) => agent.agent_id).join('|');
  const [order, setOrder] = useState(() =>
    agents.map((agent) => agent.agent_id)
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);

  const [measuredWidths, setMeasuredWidths] = useState<Record<string, number>>(
    {}
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const elements = viewport.querySelectorAll<HTMLElement>('[data-agent-id]');
    const next: Record<string, number> = {};
    elements.forEach((el) => {
      const id = el.dataset.agentId;
      if (!id) return;
      const label = el.querySelector<HTMLElement>(
        '.agent-management-bar-label'
      );
      const measured = label?.scrollWidth ?? 0;
      if (measured > 0) {
        next[id] = Math.min(
          Math.ceil(measured) + 1,
          AGENT_BAR_LAYOUT.labelMaxWidth
        );
      }
    });
    setMeasuredWidths((prev) => {
      const keys = Object.keys(next);
      if (keys.length === 0) return prev;
      let diff = false;
      for (const k of keys) {
        if (prev[k] !== next[k]) {
          diff = true;
          break;
        }
      }
      return diff ? { ...prev, ...next } : prev;
    });
  }, [agents, incomingOrderKey]);

  const getLabelWidth = useCallback(
    (agentId: string) => {
      return measuredWidths[agentId] ?? AGENT_BAR_LAYOUT.labelMaxWidth;
    },
    [measuredWidths]
  );

  const [requestedPage, setRequestedPage] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const orderRef = useRef(order);
  const originRef = useRef<string[] | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const focusAfterNudgeRef = useRef<string | null>(null);
  orderRef.current = order;

  const expandedId = registryOpen ? null : selectedAgentId;
  const labelWidth = expandedId ? getLabelWidth(expandedId) : 0;
  const paging = useMemo(
    () => ({ viewportWidth, expandedId, labelWidth }),
    [viewportWidth, expandedId, labelWidth]
  );
  const pages = useMemo(() => agentBarPages(order, paging), [order, paging]);
  const pageGaps = useMemo(() => {
    if (pages.length === 0) return [];
    const baseGap = agentBarPageGap(pages[0] ?? [], paging);
    return pages.map((pageAgentIds, index) =>
      index === 0 ? baseGap : agentBarPageGap(pageAgentIds, paging, baseGap)
    );
  }, [pages, paging]);
  const page = Math.min(requestedPage, pages.length - 1);
  const pagingRef = useRef(paging);
  const pagesRef = useRef(pages);
  const pageRef = useRef(page);
  const pageCountRef = useRef(pages.length);
  const visibleIdsRef = useRef<string[]>([]);
  pagingRef.current = paging;
  pagesRef.current = pages;
  pageRef.current = page;
  pageCountRef.current = pages.length;
  visibleIdsRef.current = pages[page] ?? [];

  useEffect(() => {
    if (originRef.current) return;
    setOrder(incomingOrderKey ? incomingOrderKey.split('|') : []);
  }, [incomingOrderKey]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => setViewportWidth(viewport.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const hasAgents = order.length > 0;
  const alignedAgentIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!expandedId || !hasAgents) {
      alignedAgentIdRef.current = expandedId;
      return;
    }
    if (viewportWidth === 0) return;

    if (alignedAgentIdRef.current !== expandedId) {
      alignedAgentIdRef.current = expandedId;
      const selectedPage = agentBarPageOf(pages, expandedId);
      if (selectedPage !== null) {
        setRequestedPage(selectedPage);
      }
    }
  }, [expandedId, hasAgents, viewportWidth, pages]);

  useEffect(() => {
    if (pages.length > 0 && requestedPage >= pages.length) {
      setRequestedPage(pages.length - 1);
    }
  }, [pages.length, requestedPage]);

  useEffect(() => {
    const agentId = focusAfterNudgeRef.current;
    if (!agentId) return;
    focusAfterNudgeRef.current = null;
    Array.from(
      viewportRef.current?.querySelectorAll<HTMLElement>('[data-agent-id]') ??
        []
    )
      .find((element) => element.dataset.agentId === agentId)
      ?.focus();
  }, [order]);

  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const pagerHits = pointerWithin({
      ...args,
      droppableContainers: args.droppableContainers.filter((container) =>
        PAGER_DROPPABLE_ID_SET.has(String(container.id))
      ),
    });
    if (pagerHits.length > 0) return pagerHits;
    const visible = new Set(visibleIdsRef.current);
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter((container) =>
        visible.has(String(container.id))
      ),
    });
  }, []);

  const persistOrder = useCallback(
    (next: string[] | null) => {
      if (!next) return;
      setOrder(next);
      onReorder(next);
    },
    [onReorder]
  );

  const handleDragStart = useCallback(({ active }: DragStartEvent) => {
    originRef.current = orderRef.current;
    activeIdRef.current = String(active.id);
    setActiveId(String(active.id));
  }, []);

  const handleDragOver = useCallback(({ active, over }: DragOverEvent) => {
    if (!over) return;
    setOrder(
      (current) =>
        moveAgentInOrder(current, String(active.id), String(over.id)) ?? current
    );
  }, []);

  const flipPageWhileDragging = useCallback((direction: -1 | 1) => {
    const dragged = activeIdRef.current;
    const target = pageRef.current + direction;
    if (!dragged || target < 0 || target >= pageCountRef.current) return;
    setOrder(
      (current) =>
        moveAgentToPageEdge(
          current,
          dragged,
          agentBarPages(
            current.filter((id) => id !== dragged),
            pagingRef.current
          )[target],
          direction === 1 ? 'start' : 'end'
        ) ?? current
    );
    setRequestedPage(target);
  }, []);

  const finishDrag = useCallback(
    (next: string[] | null) => {
      const origin = originRef.current;
      originRef.current = null;
      activeIdRef.current = null;
      setActiveId(null);
      if (!next) {
        if (origin) setOrder(origin);
        return;
      }
      setOrder(next);
      if (origin && next.join('|') !== origin.join('|')) {
        onReorder(next);
      }
    },
    [onReorder]
  );

  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (!over) {
        finishDrag(null);
        return;
      }
      finishDrag(
        moveAgentInOrder(
          orderRef.current,
          String(active.id),
          String(over.id)
        ) ?? orderRef.current
      );
    },
    [finishDrag]
  );

  const handleDragCancel = useCallback(() => {
    finishDrag(null);
  }, [finishDrag]);

  const handleNudge = useCallback(
    (agentId: string, direction: -1 | 1) => {
      const next = nudgeAgentInOrder(order, agentId, direction);
      if (!next) return;
      persistOrder(next);
      const nextPage = agentBarPageOf(
        agentBarPages(next, pagingRef.current),
        agentId
      );
      if (nextPage !== null) setRequestedPage(nextPage);
      focusAfterNudgeRef.current = agentId;
    },
    [order, persistOrder]
  );

  const activeAgent = activeId ? (agentById.get(activeId) ?? null) : null;
  const pageStyle = { '--agent-bar-page': page } as CSSProperties;

  return (
    <TooltipProvider delayDuration={180}>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <nav
          aria-label={t('agents.agentListAria')}
          className="agent-management-bar"
          style={agentBarLayoutStyle}
        >
          <PagerArrow
            direction="previous"
            label={t('agents.previousAgentPage')}
            page={page}
            visible={page > 0}
            onStep={() => setRequestedPage(page - 1)}
            onDragHover={() => flipPageWhileDragging(-1)}
          />
          <div className="agent-management-bar-viewport" ref={viewportRef}>
            <SortableContext items={order} strategy={keepLayout}>
              <div className="agent-management-bar-track" style={pageStyle}>
                {pages.map((agentIds, index) => (
                  <div
                    key={index}
                    className="agent-management-bar-page"
                    style={{
                      gap: `${pageGaps[index] ?? AGENT_BAR_LAYOUT.itemGap}px`,
                    }}
                    inert={index !== page}
                  >
                    {agentIds.map((agentId) => {
                      const agent = agentById.get(agentId);
                      if (!agent) return null;
                      return (
                        <AgentBarItem
                          key={agent.agent_id}
                          agent={agent}
                          labelWidth={getLabelWidth(agent.agent_id)}
                          selected={
                            !registryOpen && selectedAgentId === agent.agent_id
                          }
                          onSelect={onSelect}
                          onNudge={handleNudge}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </SortableContext>
          </div>
          <AgentBarTailGroup
            registryOpen={registryOpen}
            refreshing={refreshing}
            nextPageVisible={page < pages.length - 1}
            page={page}
            onAdd={onAdd}
            onRefresh={onRefresh}
            onNextPage={() => setRequestedPage(page + 1)}
            onNextPageDragHover={() => flipPageWhileDragging(1)}
            actions={actions}
          />
          <DragOverlay>
            {activeAgent ? (
              <div className="settings-page" style={agentBarLayoutStyle}>
                <AgentBarMark
                  agent={activeAgent}
                  labelWidth={getLabelWidth(activeAgent.agent_id)}
                  selected={
                    !registryOpen && selectedAgentId === activeAgent.agent_id
                  }
                  overlay
                />
              </div>
            ) : null}
          </DragOverlay>
        </nav>
      </DndContext>
    </TooltipProvider>
  );
}

export type AgentBarTailGroupProps = {
  registryOpen?: boolean;
  refreshing?: boolean;
  nextPageVisible: boolean;
  page: number;
  onAdd?: () => void;
  onRefresh?: () => void;
  onNextPage: () => void;
  onNextPageDragHover: () => void;
  actions?: ReactNode;
};

export function AgentBarTailGroup({
  registryOpen = false,
  refreshing = false,
  nextPageVisible,
  page,
  onAdd,
  onRefresh,
  onNextPage,
  onNextPageDragHover,
  actions,
}: AgentBarTailGroupProps) {
  const { t } = useTranslation('settings');

  return (
    <div
      className="agent-management-bar-tail"
      role="group"
      aria-label={t('agents.tailActionsAria', 'Agent 控制与翻页')}
    >
      {actions ?? (
        <>
          {onAdd ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant={registryOpen ? 'secondary' : 'ghost'}
                  className="h-6 w-6 shrink-0 rounded-full p-0 hover:bg-transparent hover:text-foreground"
                  aria-current={registryOpen ? 'page' : undefined}
                  aria-label={t('agents.addAgent')}
                  onClick={onAdd}
                >
                  <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('agents.acpRegistry')}</TooltipContent>
            </Tooltip>
          ) : null}
          {onRefresh ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 shrink-0 rounded-full p-0 hover:bg-transparent hover:text-foreground"
                  aria-label={t('agents.refreshStatusAria')}
                  aria-busy={refreshing}
                  disabled={refreshing}
                  onClick={onRefresh}
                >
                  <RefreshCw
                    aria-hidden="true"
                    className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('agents.refreshStatusAria')}</TooltipContent>
            </Tooltip>
          ) : null}
        </>
      )}
      <PagerArrow
        direction="next"
        label={t('agents.nextAgentPage')}
        page={page}
        visible={nextPageVisible}
        onStep={onNextPage}
        onDragHover={onNextPageDragHover}
      />
    </div>
  );
}

function PagerArrow({
  direction,
  label,
  page,
  visible,
  onStep,
  onDragHover,
}: {
  direction: PagerDirection;
  label: string;
  page: number;
  visible: boolean;
  onStep: () => void;
  onDragHover: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: PAGER_DROPPABLE_IDS[direction],
    disabled: !visible,
  });

  useEffect(() => {
    if (!visible || !isOver) return;
    const timer = window.setTimeout(onDragHover, DRAG_PAGE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [visible, isOver, page, onDragHover]);

  return (
    <div
      className={cn(
        'agent-management-bar-pager',
        `is-${direction}`,
        visible && 'is-visible'
      )}
      ref={setNodeRef}
    >
      {visible ? (
        <button
          type="button"
          aria-label={label}
          className={cn(
            'agent-management-bar-pager-button',
            isOver && 'is-drop-target'
          )}
          onClick={(e) => {
            e.stopPropagation();
            onStep();
          }}
        >
          <svg aria-hidden="true" fill="none" viewBox="0 0 8 12">
            <path
              d="M6 1.5 1.5 6 6 10.5"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.6"
            />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

function AgentBarItem({
  agent,
  labelWidth,
  selected,
  onSelect,
  onNudge,
}: {
  agent: AgentManagementView;
  labelWidth: number;
  selected: boolean;
  onSelect: (agentId: string) => void;
  onNudge: (agentId: string, direction: -1 | 1) => void;
}) {
  const { t } = useTranslation('settings');
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: agent.agent_id,
    animateLayoutChanges: () => false,
  });
  const { onKeyDown: dragKeyDown, ...dragListeners } = listeners ?? {};
  const status = t(
    `agents.lifecycleStatus.${agent.enabled ? agent.lifecycle : 'disabled'}`
  );
  const statusDescriptionId = `agent-status-${agent.agent_id}`;

  return (
    <Tooltip open={isDragging ? false : undefined}>
      <TooltipTrigger asChild>
        <button
          type="button"
          ref={setNodeRef}
          {...attributes}
          {...dragListeners}
          data-agent-id={agent.agent_id}
          aria-current={selected ? 'true' : undefined}
          aria-label={agent.display_name}
          aria-describedby={statusDescriptionId}
          className={cn(
            'agent-management-bar-item',
            selected && 'is-selected',
            !agent.enabled && 'is-disabled',
            isDragging && 'is-placeholder'
          )}
          style={{
            transform: CSS.Transform.toString(transform),
            transition: isDragging ? transition : undefined,
          }}
          onClick={() => onSelect(agent.agent_id)}
          onKeyDown={(event) => {
            dragKeyDown?.(event);
            if (!event.altKey) return;
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              onNudge(agent.agent_id, -1);
            }
            if (event.key === 'ArrowRight') {
              event.preventDefault();
              onNudge(agent.agent_id, 1);
            }
          }}
        >
          <AgentBarArtwork agent={agent} labelWidth={labelWidth} />
          <span id={statusDescriptionId} className="sr-only">
            {status}. {t('agents.reorderHint')}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {agent.display_name} · {status}
      </TooltipContent>
    </Tooltip>
  );
}

function AgentBarMark({
  agent,
  labelWidth,
  selected,
  overlay = false,
}: {
  agent: AgentManagementView;
  labelWidth?: number;
  selected: boolean;
  overlay?: boolean;
}) {
  return (
    <div
      className={cn(
        'agent-management-bar-item',
        selected && 'is-selected',
        !agent.enabled && 'is-disabled',
        overlay && 'is-dragging'
      )}
    >
      <AgentBarArtwork agent={agent} labelWidth={labelWidth} />
    </div>
  );
}

function AgentBarArtwork({
  agent,
  labelWidth,
}: {
  agent: AgentManagementView;
  labelWidth?: number;
}) {
  return (
    <>
      <AgentManagementIcon agent={agent} className="h-5 w-5" />
      <span
        aria-hidden="true"
        className="agent-management-bar-label"
        style={
          labelWidth !== undefined
            ? ({ '--agent-label-width': `${labelWidth}px` } as CSSProperties)
            : undefined
        }
      >
        {agent.display_name}
      </span>
      <StatusMark agent={agent} />
    </>
  );
}

function StatusMark({ agent }: { agent: AgentManagementView }) {
  const tone =
    agent.lifecycle === 'ready'
      ? 'ready'
      : agent.lifecycle === 'needs_repair' ||
          agent.lifecycle === 'platform_unsupported' ||
          agent.lifecycle === 'retired'
        ? 'error'
        : agent.lifecycle === 'needs_auth' || agent.lifecycle === 'needs_config'
          ? 'warning'
          : 'busy';
  return (
    <span
      aria-hidden="true"
      className={cn('agent-management-status-mark', `is-${tone}`)}
    />
  );
}
