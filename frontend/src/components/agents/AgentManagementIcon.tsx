import { Bot } from 'lucide-react';

import {
  AgentTypeIcon,
  hasAgentTypeIcon,
} from '@/components/agents/AgentTypeIcon';
import { cn } from '@/lib/utils';

type IconAgent = {
  agent_id: string;
  icon_light: string | null;
  icon_dark: string | null;
  icon_svg: string | null;
};

/**
 * Built-in Agents always render their compiled-in glyph so every mark fills
 * the caller's box the same way; registry artwork is only for Agents the app
 * ships no glyph for.
 */
export function AgentManagementIcon({
  agent,
  className,
}: {
  agent: IconAgent;
  className?: string;
}) {
  if (hasAgentTypeIcon(agent.agent_id)) {
    return (
      <AgentTypeIcon
        agentType={agent.agent_id}
        className={cn('text-foreground', className)}
      />
    );
  }

  const iconClassName = cn('agent-management-brand-icon', className);

  if (agent.icon_light || agent.icon_dark) {
    const light = agent.icon_light ?? agent.icon_dark ?? '';
    const dark = agent.icon_dark ?? agent.icon_light ?? '';
    return (
      <span aria-hidden="true" className={iconClassName}>
        <picture className="agent-management-brand-picture">
          <source media="(prefers-color-scheme: dark)" srcSet={dark} />
          <img
            alt=""
            className="agent-management-brand-artwork object-contain"
            src={light}
          />
        </picture>
      </span>
    );
  }

  if (agent.icon_svg) {
    return (
      <span
        aria-hidden="true"
        className={cn('agent-management-svg-icon', iconClassName)}
        dangerouslySetInnerHTML={{ __html: agent.icon_svg }}
      />
    );
  }

  return <Bot aria-hidden="true" className={className} />;
}
