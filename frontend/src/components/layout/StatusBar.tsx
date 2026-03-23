import { useProject } from '@/contexts/ProjectContext';
import { useAgentAvailability } from '@/hooks/useAgentAvailability';
import { APP_NAME } from '@/lib/branding';
import { ProjectWindowStatusSummary } from '@/components/layout/ProjectWindowStatusSummary';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { BaseCodingAgent } from 'shared/types';

const CORE_AGENTS = [
  { agent: BaseCodingAgent.CLAUDE_CODE, label: 'Claude Code' },
  { agent: BaseCodingAgent.CODEX, label: 'Codex' },
  { agent: BaseCodingAgent.OPENCODE, label: 'OpenCode' },
] as const;

function AgentStatusLight({
  agent,
  label,
}: {
  agent: BaseCodingAgent;
  label: string;
}) {
  const availability = useAgentAvailability(agent);
  const isOnline =
    availability?.status === 'login_detected' ||
    availability?.status === 'installation_found';

  return (
    <span
      className="flex items-center gap-1 rounded border border-border/60 bg-background/50 px-1.5 py-[1px]"
      title={`${label}: ${isOnline ? 'online' : 'offline'}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          isOnline ? 'bg-emerald-400' : 'bg-red-400'
        }`}
      />
      <span className="text-[10px] leading-none opacity-85">{label}</span>
    </span>
  );
}

function AgentStatusCluster() {
  return (
    <div className="flex items-center gap-1.5">
      {CORE_AGENTS.map(({ agent, label }) => (
        <AgentStatusLight key={agent} agent={agent} label={label} />
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
