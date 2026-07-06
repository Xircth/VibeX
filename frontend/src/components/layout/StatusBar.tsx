import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useProject } from '@/contexts/ProjectContext';
import { useOptionalKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { conversationApi } from '@/features/conversation/conversationApi';
import { TokenUsageIndicator } from '@/components/tasks/follow-up/TokenUsageIndicator';
import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import { useAgentAvailability } from '@/hooks/useAgentAvailability';
import { APP_NAME } from '@/lib/branding';
import { ProjectWindowStatusSummary } from '@/components/layout/ProjectWindowStatusSummary';
import { AutomationFailureBadge } from '@/components/layout/AutomationFailureBadge';
import { BackgroundTaskCountBadge } from '@/components/layout/BackgroundTaskCountBadge';
import { UpdateAvailableBadge } from '@/components/layout/UpdateAvailableBadge';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { AgentKind } from 'shared/types';

const CORE_AGENTS = [
  'claude_code',
  'codex',
  'opencode',
] as const;

function AgentStatusLight({ agent }: { agent: AgentKind }) {
  const { t } = useTranslation('statusbar');
  const availability = useAgentAvailability(agent);
  const isOnline =
    availability?.status === 'login_detected' ||
    availability?.status === 'installation_found';
  const label = getAgentName(agent);

  return (
    <span
      className="flex items-center gap-1 rounded-full border border-border/60 bg-background/50 px-1.5 py-[1px]"
      title={`${label}: ${isOnline ? t('online') : t('offline')}`}
    >
      <span
        className={`h-2 w-2 rounded-full ${
          isOnline ? 'bg-[hsl(var(--success))]' : 'bg-destructive'
        }`}
      />
      <AgentIcon agent={agent} className="h-3.5 w-3.5" />
    </span>
  );
}

/**
 * Context-window ring for the active (right-panel) session (P3-5b). The right
 * session's id IS the DB conversation id, so we read its projected session_stats
 * and reuse the composer's TokenUsageIndicator. Renders nothing on the board view
 * (no active session) or when the agent reports no context window.
 */
function SessionContextRing() {
  const sessionContext = useOptionalKanbanSessionContext();
  const sessionId = sessionContext?.rightSession?.sessionId ?? null;

  const { data } = useQuery({
    queryKey: ['statusBarConversationContext', sessionId],
    queryFn: () => conversationApi.detail(sessionId as string),
    enabled: !!sessionId,
    refetchInterval: 15_000,
    meta: { suppressGlobalError: true },
  });

  const stats = data?.session_stats;
  if (!stats) return null;

  return (
    <TokenUsageIndicator
      tokenUsageInfo={{
        total_tokens: Number(stats.context_window_used_tokens ?? 0n),
        model_context_window: Number(stats.context_window_max_tokens ?? 0n),
      }}
    />
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
    <div className="workspace-divider-top flex h-6 shrink-0 select-none items-center justify-between bg-secondary px-2 text-[11px] text-secondary-foreground">
      <div className="min-w-0 pr-2">
        {railVisible ? (
          project && <span className="truncate opacity-90">{project.name}</span>
        ) : (
          <ProjectWindowStatusSummary />
        )}
      </div>

      <div className="flex items-center gap-2">
        <SessionContextRing />
        <BackgroundTaskCountBadge />
        <UpdateAvailableBadge />
        <AutomationFailureBadge />
        <span className="hidden text-[10px] uppercase tracking-wide opacity-60 sm:inline">
          {APP_NAME}
        </span>
        <AgentStatusCluster />
      </div>
    </div>
  );
}
