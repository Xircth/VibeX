import { AgentIcon } from '@/components/agents/AgentIcon';

import type { WorkflowStudioAgentOption } from '../workflowAgent';

export function StudioAgentIcon({
  agentId,
  agentOptions,
  className,
}: {
  agentId: string;
  agentOptions: WorkflowStudioAgentOption[];
  className?: string;
}) {
  const icons = agentOptions.find((agent) => agent.value === agentId);
  return (
    <AgentIcon
      agent={agentId}
      className={className}
      iconLight={icons?.iconLight}
      iconDark={icons?.iconDark}
      iconSvg={icons?.iconSvg}
    />
  );
}
