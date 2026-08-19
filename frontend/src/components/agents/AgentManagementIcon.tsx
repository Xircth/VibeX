import { Bot } from 'lucide-react';

import { AgentTypeIcon } from '@/components/agents/AgentTypeIcon';
import { cn } from '@/lib/utils';

type IconAgent = {
  agent_id: string;
  icon_light: string | null;
  icon_dark: string | null;
  icon_svg: string | null;
};

const AGENT_ICON_CALIBRATION_CLASS: Partial<Record<string, string>> = {
  cline: 'is-cline',
  hermes: 'is-hermes',
  codebuddy: 'is-codebuddy',
  grok: 'is-grok',
  kimi_code: 'is-kimi',
  kimi: 'is-kimi',
  cursor: 'is-cursor',
  deepseek_harness: 'is-deepseek',
};

export function AgentManagementIcon({
  agent,
  className,
}: {
  agent: IconAgent;
  className?: string;
}) {
  const iconClassName = cn(
    'agent-management-brand-icon',
    AGENT_ICON_CALIBRATION_CLASS[agent.agent_id],
    className
  );

  if (
    agent.agent_id === 'claude_code' ||
    agent.agent_id === 'codex' ||
    agent.agent_id === 'opencode' ||
    agent.agent_id === 'pi' ||
    agent.agent_id === 'deepseek_harness'
  ) {
    return <AgentTypeIcon agentType={agent.agent_id} className={className} />;
  }

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
