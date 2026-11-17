import { useUserSystem } from '@/components/ConfigProvider';
import { APP_NAME } from '@/lib/branding';
import { AttentionInboxBadge } from '@/components/layout/AttentionInboxBadge';
import { AccountStatusMenu } from '@/components/layout/AccountStatusMenu';
import { BackgroundProjectStatusStrip } from '@/components/layout/BackgroundProjectStatusStrip';
import { StatusBarMcp } from '@/components/layout/StatusBarMcp';
import { StatusBarConnectorButton } from '@/components/connectors/ConnectorMarketplace';
import { AutomationFailureBadge } from '@/components/layout/AutomationFailureBadge';
import { BackgroundTaskCountBadge } from '@/components/layout/BackgroundTaskCountBadge';
import { UpdateAvailableBadge } from '@/components/layout/UpdateAvailableBadge';
import { AgentStatusMenu } from '@/components/layout/AgentStatusMenu';
import { useActiveSubscriptionPlans } from '@/components/kanban/useActiveSubscriptionPlans';
import {
  openAgentSettings,
  useAgentAcpUpdates,
  useAgentManagement,
} from '@/features/agent-management';
import { PluginUpdateBadge } from './PluginUpdateBadge';
import { PluginStatusItems } from '@/components/plugins/PluginStatusItems';
import { BasicGuideExitButton } from '@/features/basic-guide';

export function StatusBar() {
  const { config } = useUserSystem();
  const { state: agentManagementState } = useAgentManagement();
  const updatableAgentIds = useAgentAcpUpdates(agentManagementState.agents);
  const { planUsagesByAgentId, refreshStale } = useActiveSubscriptionPlans(
    agentManagementState.agents
  );

  return (
    <div className="workspace-chrome relative z-20 flex h-9 shrink-0 select-none items-center justify-between gap-2 overflow-visible px-2 text-xs text-secondary-foreground">
      <div className="flex min-w-0 items-center gap-2 overflow-visible">
        <AccountStatusMenu />
        <BasicGuideExitButton />
        <BackgroundProjectStatusStrip />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <PluginStatusItems />
        <AttentionInboxBadge />
        <StatusBarMcp />
        <StatusBarConnectorButton />
        <PluginStatusItems placement="after-mcp" />
        <BackgroundTaskCountBadge />
        <UpdateAvailableBadge />
        <PluginUpdateBadge />
        <AutomationFailureBadge />
        <span className="hidden text-[10px] uppercase tracking-wide opacity-60 sm:inline">
          {APP_NAME}
        </span>
        <AgentStatusMenu
          agents={agentManagementState.agents}
          defaultAgentId={config?.executor_profile.executor ?? null}
          updatableAgentIds={updatableAgentIds}
          operations={agentManagementState.operations}
          planUsages={planUsagesByAgentId}
          onMenuOpen={refreshStale}
          onOpenAgentSettings={openAgentSettings}
        />
      </div>
    </div>
  );
}
