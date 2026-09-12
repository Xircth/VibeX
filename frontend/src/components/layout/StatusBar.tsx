import { useProject } from '@/contexts/ProjectContext';
import { useUserSystem } from '@/components/ConfigProvider';
import { APP_NAME } from '@/lib/branding';
import { ProjectWindowStatusSummary } from '@/components/layout/ProjectWindowStatusSummary';
import { AttentionInboxBadge } from '@/components/layout/AttentionInboxBadge';
import { AutomationFailureBadge } from '@/components/layout/AutomationFailureBadge';
import { BackgroundTaskCountBadge } from '@/components/layout/BackgroundTaskCountBadge';
import { UpdateAvailableBadge } from '@/components/layout/UpdateAvailableBadge';
import { AgentStatusMenu } from '@/components/layout/AgentStatusMenu';
import {
  openAgentSettings,
  useAgentAcpUpdates,
  useAgentManagement,
} from '@/features/agent-management';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { PluginStatusItems } from '@/components/plugins/PluginStatusItems';

export function StatusBar() {
  const { project } = useProject();
  const { config } = useUserSystem();
  const { state: agentManagementState } = useAgentManagement();
  const updatableAgentIds = useAgentAcpUpdates(agentManagementState.agents);
  const railVisible = useWindowProjectsStore((state) => state.railVisible);

  return (
    <div className="workspace-divider-top relative z-20 flex h-6 shrink-0 select-none items-center justify-between overflow-visible bg-secondary px-2 text-[11px] text-secondary-foreground">
      <div className="min-w-0 overflow-visible pr-2">
        {railVisible ? (
          project && <span className="truncate opacity-90">{project.name}</span>
        ) : (
          <ProjectWindowStatusSummary />
        )}
      </div>

      <div className="flex items-center gap-2">
        <PluginStatusItems />
        <AttentionInboxBadge />
        <BackgroundTaskCountBadge />
        <UpdateAvailableBadge />
        <AutomationFailureBadge />
        <span className="hidden text-[10px] uppercase tracking-wide opacity-60 sm:inline">
          {APP_NAME}
        </span>
        <AgentStatusMenu
          agents={agentManagementState.agents}
          defaultAgentId={config?.executor_profile.executor ?? null}
          updatableAgentIds={updatableAgentIds}
          onOpenAgentSettings={openAgentSettings}
        />
      </div>
    </div>
  );
}
