import { useProject } from '@/contexts/ProjectContext';
import { useUserSystem } from '@/components/ConfigProvider';
import { APP_NAME } from '@/lib/branding';
import { ProjectWindowStatusSummary } from '@/components/layout/ProjectWindowStatusSummary';
import { AttentionInboxBadge } from '@/components/layout/AttentionInboxBadge';
import { AutomationFailureBadge } from '@/components/layout/AutomationFailureBadge';
import { BackgroundTaskCountBadge } from '@/components/layout/BackgroundTaskCountBadge';
import { UpdateAvailableBadge } from '@/components/layout/UpdateAvailableBadge';
import { AgentStatusMenu } from '@/components/layout/AgentStatusMenu';
import { useAgentManagement } from '@/features/agent-management';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import { createPluginControlApi } from '@/lib/api/plugins';
import { useBackendTransport } from '@/lib/transport';
import { useMemo } from 'react';

export function StatusBar() {
  const { project } = useProject();
  const { config } = useUserSystem();
  const { state: agentManagementState } = useAgentManagement();
  const railVisible = useWindowProjectsStore((state) => state.railVisible);
  const statusItems = usePluginHostContributions('status').slice(0, 3);
  const transport = useBackendTransport();
  const pluginApi = useMemo(
    () => createPluginControlApi(transport),
    [transport]
  );

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
        {statusItems.map((item) => {
          const metadata = contributionMetadata(item);
          const text = String(metadata.text ?? item.label).slice(0, 24);
          const handler =
            typeof metadata.handler === 'string' ? metadata.handler : item.id;
          return (
            <button
              key={`${item.pluginId}:${item.id}`}
              type="button"
              className="max-w-[8rem] truncate text-[10px] opacity-80"
              onClick={() =>
                void pluginApi.invokeContribution(item.pluginId, handler)
              }
            >
              {text}
            </button>
          );
        })}
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
        />
      </div>
    </div>
  );
}
