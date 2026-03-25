import { useProject } from '@/contexts/ProjectContext';
import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import { useAgentAvailability } from '@/hooks/useAgentAvailability';
import { APP_NAME } from '@/lib/branding';
import { ProjectWindowStatusSummary } from '@/components/layout/ProjectWindowStatusSummary';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { BaseCodingAgent } from 'shared/types';

const CORE_AGENTS = [
  BaseCodingAgent.CLAUDE_CODE,
  BaseCodingAgent.CODEX,
  BaseCodingAgent.OPENCODE,
] as const;

function AgentStatusLight({
  agent,
}: {
  agent: BaseCodingAgent;
}) {
  const availability = useAgentAvailability(agent);
  const isOnline =
    availability?.status === 'login_detected' ||
    availability?.status === 'installation_found';
  const label = getAgentName(agent);

  return (
    <span
      className="flex items-center gap-1 rounded-full border border-border/60 bg-background/50 px-1.5 py-[1px]"
      title={`${label}: ${isOnline ? 'online' : 'offline'}`}
    >
      <span
        className={`h-2 w-2 rounded-full ${
          isOnline ? 'bg-emerald-400' : 'bg-red-400'
        }`}
      />
      <AgentIcon agent={agent} className="h-3.5 w-3.5" />
    </span>
  );
}

function AgentStatusCluster() {
  return (
    <div className="flex items-center gap-1.5">
      {CORE_AGENTS.map((agent) => (
        <AgentStatusLight key={agent} agent={agent} />
      ))}
    </div>
  );
}

export function StatusBar() {
  const { project } = useProject();
  const railVisible = useWindowProjectsStore((state) => state.railVisible);

  return (
    <div className="flex h-6 shrink-0 select-none items-center justify-between border-t border-border bg-secondary px-2 text-[11px] text-secondary-foreground">
      <div className="min-w-0 pr-2">
        {railVisible ? (
          project && <span className="truncate opacity-90">{project.name}</span>
        ) : (
          <ProjectWindowStatusSummary />
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="hidden text-[10px] uppercase tracking-wide opacity-60 sm:inline">
          {APP_NAME}
        </span>
        <AgentStatusCluster />
      </div>
    </div>
  );
}
