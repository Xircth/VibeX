import { useDraggable } from '@dnd-kit/core';
import { CircleAlert, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentDiscoveryProgressView, AgentId } from 'shared/types';
import { AgentManagementIcon } from '@/components/agents/AgentManagementIcon';
import { Button } from '@/components/ui/button';
import { OnboardingAgentStatusBadge } from './OnboardingAgentStatusBadge';
import { cn } from '@/lib/utils';
import {
  canJoinOnboardingRoster,
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

function AgentSetupPickerRow({
  agent,
  check,
  inRoster,
  inspected,
  onInspect,
  onInstall,
  onJoinRoster,
}: {
  agent: OnboardingAgentOption;
  check?: OnboardingAgentCheck;
  inRoster: boolean;
  inspected: boolean;
  onInspect: (agentId: AgentId) => void;
  onInstall: (agentId: AgentId) => void;
  onJoinRoster?: (agentId: AgentId) => void;
}) {
  const { t } = useTranslation('dialogs');
  const status = onboardingAgentStatus(agent, check);
  const canDragToRoster =
    Boolean(onJoinRoster) && canJoinOnboardingRoster(status);
  const canClickToJoinRoster =
    Boolean(onJoinRoster) && status === 'ready' && !inRoster;
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `picker-agent:${agent.agentId}`,
    data: { agentId: agent.agentId },
    disabled: !canDragToRoster,
  });
  const wasDraggedRef = useRef(false);

  useEffect(() => {
    if (isDragging) {
      wasDraggedRef.current = true;
      return;
    }
    if (wasDraggedRef.current) {
      const timer = window.setTimeout(() => {
        wasDraggedRef.current = false;
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [isDragging]);

  const install = status === 'uninstalled' || status === 'install_failed';
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
      role="listitem"
      data-agent-id={agent.agentId}
      data-draggable={canDragToRoster ? 'true' : undefined}
      className={cn(
        'onboarding-agent-row',
        inspected && 'is-inspected',
        canDragToRoster && 'is-draggable',
        isDragging && 'is-dragging'
      )}
    >
      <button
        type="button"
        ref={setNodeRef}
        {...(canDragToRoster ? listeners : undefined)}
        className="onboarding-agent-inspect"
        onClick={() => {
          if (wasDraggedRef.current) {
            wasDraggedRef.current = false;
            return;
          }
          if (canClickToJoinRoster) {
            onJoinRoster?.(agent.agentId);
            return;
          }
          onInspect(agent.agentId);
        }}
        aria-label={t('onboarding.agentDetail', {
          agent: agent.displayName,
        })}
        aria-expanded={inspected}
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
        <span className="onboarding-agent-name">{agent.displayName}</span>
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
              install ? onInstall(agent.agentId) : onInspect(agent.agentId)
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
  rosterIds,
  onJoinRoster,
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
  rosterIds?: ReadonlyArray<AgentId>;
  onJoinRoster?: (agentId: AgentId) => void;
}) {
  const { t } = useTranslation('dialogs');
  const rosterSet = useMemo(() => new Set(rosterIds ?? []), [rosterIds]);
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
        {agents.map((agent) => (
          <AgentSetupPickerRow
            key={agent.agentId}
            agent={agent}
            check={checks[agent.agentId]}
            inRoster={rosterSet.has(agent.agentId)}
            inspected={agent.agentId === inspectedAgentId}
            onInspect={onInspect}
            onInstall={onInstall}
            onJoinRoster={onJoinRoster}
          />
        ))}
      </div>
    </div>
  );
}
