import { CircleAlert, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentDiscoveryProgressView, AgentId } from 'shared/types';
import { AgentManagementIcon } from '@/components/agents/AgentManagementIcon';
import { Button } from '@/components/ui/button';
import { OnboardingAgentStatusBadge } from './OnboardingAgentStatusBadge';
import { cn } from '@/lib/utils';
import {
  onboardingAgentStatus,
  type OnboardingAgentCheck,
  type OnboardingAgentOption,
} from './onboardingAgentModel';

function DiscoveryProgressMeter({
  progress,
}: {
  progress: AgentDiscoveryProgressView;
}) {
  const { t } = useTranslation('dialogs');
  return (
    <div className="onboarding-discovery-progress">
      <div className="onboarding-discovery-progress-heading">
        <span className="onboarding-discovery-progress-title">
          <Loader2
            className="h-4 w-4 motion-safe:animate-spin"
            aria-hidden="true"
          />
          <strong>{t('onboarding.detectingAgents')}</strong>
        </span>
        {progress.total > 0 ? (
          <span>
            {t('onboarding.discoveryProgress', {
              completed: progress.completed,
              total: progress.total,
            })}
          </span>
        ) : (
          <span>{t('onboarding.discoveryPreparing')}</span>
        )}
      </div>
      <div
        className={cn(
          'onboarding-discovery-progress-track',
          progress.total === 0 && 'is-indeterminate'
        )}
        role="progressbar"
        aria-label={t('onboarding.discoveryProgressAria')}
        aria-valuemin={0}
        aria-valuenow={progress.total > 0 ? progress.completed : undefined}
        aria-valuemax={progress.total > 0 ? progress.total : undefined}
      >
        <span
          style={
            progress.total > 0
              ? {
                  width: `${Math.min(
                    100,
                    (progress.completed / progress.total) * 100
                  )}%`,
                }
              : undefined
          }
        />
      </div>
      <div className="onboarding-discovery-progress-meta">
        <span>
          {t('onboarding.discoveryFound', {
            count: progress.found,
          })}
        </span>
        <span>{t('onboarding.discoveryNonBlocking')}</span>
      </div>
    </div>
  );
}

export function AgentSetupPicker({
  agents,
  checks,
  loading,
  discoveryProgress,
  error,
  onRetry,
  onInspect,
  onInstall,
  inspectedAgentId,
}: {
  agents: OnboardingAgentOption[];
  checks: Record<string, OnboardingAgentCheck>;
  loading: boolean;
  discoveryProgress: AgentDiscoveryProgressView | null;
  error: string | null;
  onRetry: () => void;
  onInspect: (agentId: AgentId) => void;
  onInstall: (agentId: AgentId) => void;
  inspectedAgentId?: AgentId | null;
}) {
  const { t } = useTranslation('dialogs');
  const discoveryBusy =
    discoveryProgress?.phase === 'pending' ||
    discoveryProgress?.phase === 'checking';
  if (error)
    return (
      <div className="onboarding-agent-state" role="alert">
        <span>{error}</span>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t('onboarding.retry')}
        </Button>
      </div>
    );
  if (loading && !agents.length)
    return (
      <div className="onboarding-agent-loading" role="status">
        <Loader2 className="h-4 w-4 motion-safe:animate-spin" />
        {t('onboarding.loadingAgentCatalog')}
      </div>
    );
  return (
    <div className="onboarding-agent-picker">
      {discoveryBusy && discoveryProgress ? (
        <DiscoveryProgressMeter progress={discoveryProgress} />
      ) : discoveryProgress?.timed_out ? (
        <div className="onboarding-discovery-timeout" role="status">
          <CircleAlert aria-hidden="true" />
          <span>{t('onboarding.discoveryTimedOut')}</span>
        </div>
      ) : null}
      <div className="onboarding-agent-list" role="list">
        {agents.map((agent) => {
          const status = onboardingAgentStatus(agent, checks[agent.agentId]);
          const install =
            status === 'uninstalled' || status === 'install_failed';
          const action =
            status === 'uninstalled'
              ? 'installOneClick'
              : status === 'install_failed'
                ? 'reinstall'
                : status === 'needs_auth'
                  ? 'configureAuth'
                  : 'viewDetails';
          return (
            <article
              key={agent.agentId}
              role="listitem"
              className={cn(
                'onboarding-agent-row',
                agent.agentId === inspectedAgentId && 'is-inspected'
              )}
            >
              <button
                type="button"
                className="onboarding-agent-inspect"
                onClick={() => onInspect(agent.agentId)}
                aria-label={t('onboarding.agentDetail', {
                  agent: agent.displayName,
                })}
                aria-expanded={agent.agentId === inspectedAgentId}
              >
                <span className="onboarding-agent-icon">
                  <AgentManagementIcon
                    agent={{
                      agent_id: agent.agentId,
                      icon_light: agent.iconLight,
                      icon_dark: agent.iconDark,
                      icon_svg: agent.iconSvg,
                    }}
                    className="h-6 w-6"
                  />
                </span>
                <span className="onboarding-agent-name">
                  {agent.displayName}
                </span>
              </button>
              <div className="onboarding-agent-row-actions">
                <OnboardingAgentStatusBadge status={status} />
                {status === 'installing' || status === 'checking' ? (
                  <span className="onboarding-installing" role="status">
                    <Loader2
                      className="h-3.5 w-3.5 motion-safe:animate-spin"
                      aria-hidden="true"
                    />
                    {t(
                      status === 'installing'
                        ? 'onboarding.installingAgent'
                        : 'onboarding.checking'
                    )}
                  </span>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="onboarding-agent-action"
                    disabled={status === 'unsupported'}
                    onClick={() =>
                      install
                        ? onInstall(agent.agentId)
                        : onInspect(agent.agentId)
                    }
                    aria-label={t(`onboarding.${action}Aria`, {
                      agent: agent.displayName,
                    })}
                  >
                    {t(`onboarding.${action}`)}
                  </Button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
