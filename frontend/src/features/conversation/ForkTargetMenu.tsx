import { GitFork } from 'lucide-react';
import { AgentIcon } from '@/components/agents/AgentIcon';
import type { ProductContextMenuItem } from '@/components/context-menu/contextMenuTypes';
import type { SelectableAgent } from '@/features/agents/useSelectableAgents';

export interface BuildForkTargetSubmenuParams {
  id: string;
  label: string;
  headerLabel: string;
  agents: readonly SelectableAgent[];
  disabled?: boolean;
  onSelectAgent: (agentId: string) => void;
}

export function buildForkTargetSubmenu({
  id,
  label,
  headerLabel,
  agents,
  disabled = false,
  onSelectAgent,
}: BuildForkTargetSubmenuParams): ProductContextMenuItem {
  return {
    type: 'submenu',
    id,
    label,
    icon: GitFork,
    headerLabel,
    childrenMaxHeightClass: 'max-h-56 overflow-y-auto',
    disabled: disabled || agents.length === 0,
    children: agents.map((agent) => ({
      id: `${id}:${agent.agentId}`,
      label: agent.displayName,
      iconNode: (
        <span className="shrink-0" aria-hidden="true">
          <AgentIcon
            agent={agent.agentId}
            iconLight={agent.iconLight}
            iconDark={agent.iconDark}
            iconSvg={agent.iconSvg}
            className="h-4 w-4"
          />
        </span>
      ),
      onSelect: () => onSelectAgent(agent.agentId),
    })),
  };
}
