import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentManagementView } from 'shared/types';

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { AgentManagementIcon } from '@/components/agents/AgentManagementIcon';
import { moveAgentInOrder, nudgeAgentInOrder } from './agentBarOrder';

type AgentBarProps = {
  agents: AgentManagementView[];
  selectedAgentId: string | null;
  registryOpen: boolean;
  onSelect: (agentId: string) => void;
  onOpenRegistry: () => void;
  onReorder: (agentIds: string[]) => void;
};

export function AgentBar({
  agents,
  selectedAgentId,
  registryOpen,
  onSelect,
  onOpenRegistry,
  onReorder,
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
  const orderRef = useRef(order);
  const originRef = useRef<string[] | null>(null);
  orderRef.current = order;

  useEffect(() => {
    if (originRef.current) return;
    setOrder(incomingOrderKey ? incomingOrderKey.split('|') : []);
  }, [incomingOrderKey]);

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
    setActiveId(String(active.id));
  }, []);

  const handleDragOver = useCallback(({ active, over }: DragOverEvent) => {
    if (!over) return;
    setOrder(
      (current) =>
        moveAgentInOrder(current, String(active.id), String(over.id)) ?? current
    );
  }, []);

  const finishDrag = useCallback(
    (next: string[] | null) => {
      const origin = originRef.current;
      originRef.current = null;
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
      persistOrder(nudgeAgentInOrder(order, agentId, direction));
    },
    [order, persistOrder]
  );

  const activeAgent = activeId ? (agentById.get(activeId) ?? null) : null;

  return (
    <TooltipProvider delayDuration={180}>
      <nav
        aria-label={t('agents.agentListAria')}
        className="agent-management-bar"
      >
        <span aria-hidden="true" className="agent-management-bar-surface" />
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <SortableContext
            items={order}
            strategy={horizontalListSortingStrategy}
          >
            <div className="agent-management-bar-scroll">
              {order.map((agentId) => {
                const agent = agentById.get(agentId);
                if (!agent) return null;
                return (
                  <AgentBarItem
                    key={agent.agent_id}
                    agent={agent}
                    selected={
                      !registryOpen && selectedAgentId === agent.agent_id
                    }
                    onSelect={onSelect}
                    onNudge={handleNudge}
                  />
                );
              })}
            </div>
          </SortableContext>
          <DragOverlay>
            {activeAgent ? (
              <div className="settings-page">
                <AgentBarMark
                  agent={activeAgent}
                  selected={
                    !registryOpen && selectedAgentId === activeAgent.agent_id
                  }
                  overlay
                />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-current={registryOpen ? 'page' : undefined}
              aria-label={t('agents.addAgent')}
              className={cn(
                'agent-management-bar-item agent-management-bar-add',
                registryOpen && 'is-selected'
              )}
              onClick={onOpenRegistry}
            >
              <Plus aria-hidden="true" className="h-5 w-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('agents.acpRegistry')}</TooltipContent>
        </Tooltip>
      </nav>
    </TooltipProvider>
  );
}

function AgentBarItem({
  agent,
  selected,
  onSelect,
  onNudge,
}: {
  agent: AgentManagementView;
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
            transition,
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
          <AgentBarArtwork agent={agent} />
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
  selected,
  overlay = false,
}: {
  agent: AgentManagementView;
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
      <AgentBarArtwork agent={agent} />
    </div>
  );
}

function AgentBarArtwork({ agent }: { agent: AgentManagementView }) {
  return (
    <>
      <AgentManagementIcon agent={agent} className="h-6 w-6" />
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
