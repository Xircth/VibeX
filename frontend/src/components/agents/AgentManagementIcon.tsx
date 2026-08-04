import { Bot } from 'lucide-react';

import { AgentTypeIcon } from '@/components/agents/AgentTypeIcon';
import { cn } from '@/lib/utils';

type IconAgent = {
  agent_id: string;
  icon_light: string | null;
  icon_dark: string | null;
  icon_svg: string | null;
};

export function AgentManagementIcon({
  agent,
  className,
}: {
  agent: IconAgent;
  className?: string;
}) {
  if (
    agent.agent_id === 'claude_code' ||
    agent.agent_id === 'codex' ||
    agent.agent_id === 'opencode' ||
    agent.agent_id === 'pi'
  ) {
    return <AgentTypeIcon agentType={agent.agent_id} className={className} />;
  }

  if (agent.icon_svg) {
    return (
      <span
        aria-hidden="true"
        className={cn('agent-management-svg-icon', className)}
        dangerouslySetInnerHTML={{ __html: agent.icon_svg }}
      />
    );
  }

  if (agent.icon_light || agent.icon_dark) {
    const light = agent.icon_light ?? agent.icon_dark ?? '';
    const dark = agent.icon_dark ?? agent.icon_light ?? '';
    return (
      <picture aria-hidden="true" className={className}>
        <source media="(prefers-color-scheme: dark)" srcSet={dark} />
        <img alt="" className="h-full w-full object-contain" src={light} />
      </picture>
    );
  }

  return <Bot aria-hidden="true" className={className} />;
}
