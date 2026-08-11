import { Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentManagementView } from 'shared/types';

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { AgentManagementIcon } from './AgentManagementIcon';

const DRAG_THRESHOLD_PX = 4;

type AgentBarProps = {
  agents: AgentManagementView[];
  selectedAgentId: string | null;
  registryOpen: boolean;
  onSelect: (agentId: string) => void;
  onOpenRegistry: () => void;
};

export function AgentBar({
  agents,
  selectedAgentId,
  registryOpen,
  onSelect,
  onOpenRegistry,
}: AgentBarProps) {
  const { t } = useTranslation('settings');
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startScrollLeft: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const handlePointerDown = useCallback((event: React.PointerEvent) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: scroller.scrollLeft,
      moved: false,
    };
    setDragging(true);
    document.body.style.userSelect = 'none';
  }, []);

  // Listen on window instead of using setPointerCapture: capturing the
  // pointer on the scroll container retargets the browser's click event to
  // the container, which would swallow every agent-button click.
  useEffect(() => {
    if (!dragging) return;
    const handlePointerMove = (event: PointerEvent) => {
      const scroller = scrollRef.current;
      const drag = dragRef.current;
      if (!scroller || !drag || event.pointerId !== drag.pointerId) return;
      const delta = event.clientX - drag.startX;
      if (Math.abs(delta) > DRAG_THRESHOLD_PX) drag.moved = true;
      scroller.scrollLeft = drag.startScrollLeft - delta;
    };
    const endDrag = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      suppressClickRef.current = drag.moved;
      dragRef.current = null;
      setDragging(false);
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      document.body.style.userSelect = '';
    };
  }, [dragging]);

  const handleClickCapture = useCallback((event: React.MouseEvent) => {
    if (suppressClickRef.current) {
      event.preventDefault();
      event.stopPropagation();
      suppressClickRef.current = false;
    }
  }, []);

  return (
    <TooltipProvider delayDuration={180}>
      <nav
        aria-label={t('agents.agentListAria')}
        className="agent-management-bar"
      >
        <span aria-hidden="true" className="agent-management-bar-surface" />
        <div
          ref={scrollRef}
          className={cn(
            'agent-management-bar-scroll',
            dragging && 'is-dragging'
          )}
          onPointerDown={handlePointerDown}
          onClickCapture={handleClickCapture}
        >
          {agents.map((agent) => {
            const selected =
              !registryOpen && selectedAgentId === agent.agent_id;
            const status = t(
              `agents.lifecycleStatus.${agent.enabled ? agent.lifecycle : 'disabled'}`
            );
            const statusDescriptionId = `agent-status-${agent.agent_id}`;
            return (
              <Tooltip key={agent.agent_id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-current={selected ? 'true' : undefined}
                    aria-label={agent.display_name}
                    aria-describedby={statusDescriptionId}
                    className={cn(
                      'agent-management-bar-item',
                      selected && 'is-selected',
                      !agent.enabled && 'is-disabled'
                    )}
                    onClick={() => onSelect(agent.agent_id)}
                  >
                    <AgentManagementIcon agent={agent} className="h-6 w-6" />
                    <StatusMark agent={agent} />
                    <span id={statusDescriptionId} className="sr-only">
                      {status}
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {agent.display_name} · {status}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
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
