import { Plus } from 'lucide-react';
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
  return (
    <TooltipProvider delayDuration={180}>
      <nav
        aria-label={t('agents.agentListAria')}
        className="agent-management-bar"
      >
        <div className="agent-management-bar-scroll">
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
