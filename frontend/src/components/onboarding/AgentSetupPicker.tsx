import { useEffect, useState } from 'react';
import { Check, Download, Loader2, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentId } from 'shared/types';

import { AgentManagementIcon } from '@/components/agents/AgentManagementIcon';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

import type { OnboardingAgentOption } from './onboardingAgentModel';

export type AgentValidationError =
  | 'enabled-required'
  | 'default-required'
  | null;

const LOADING_AGENT_ROWS = 4;

function DefaultAgentLabel({ agent }: { agent: OnboardingAgentOption }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        className="onboarding-default-agent-icon inline-flex h-4 w-4 shrink-0 items-center justify-center"
        aria-hidden="true"
      >
        <AgentManagementIcon
          agent={{
            agent_id: agent.agentId,
            icon_light: agent.iconLight,
            icon_dark: agent.iconDark,
            icon_svg: agent.iconSvg,
          }}
          className="h-4 w-4"
        />
      </span>
      <span className="truncate">{agent.displayName}</span>
    </span>
  );
}

export function AgentSetupPicker({
  agents,
  enabledAgentIds,
  defaultAgentId,
  loading,
  error,
  validationError,
  onRetry,
  onEnabledChange,
  onDefaultChange,
}: {
  agents: OnboardingAgentOption[];
  enabledAgentIds: ReadonlySet<AgentId>;
  defaultAgentId: AgentId | null;
  loading: boolean;
  error: string | null;
  validationError: AgentValidationError;
  onRetry: () => void;
  onEnabledChange: (agentId: AgentId, enabled: boolean) => void;
  onDefaultChange: (agentId: AgentId) => void;
}) {
  const { t } = useTranslation('dialogs');
  const [defaultAgentOpen, setDefaultAgentOpen] = useState(false);
  const [showEnableAgentPrompt, setShowEnableAgentPrompt] = useState(false);
  const enabledAgents = agents.filter((agent) =>
    enabledAgentIds.has(agent.agentId)
  );
  const hasEnabledAgents = enabledAgents.length > 0;
  const showEnabledAgentsPrompt =
    (showEnableAgentPrompt || validationError === 'enabled-required') &&
    !hasEnabledAgents;
  const showDefaultRequiredPrompt =
    validationError === 'default-required' &&
    hasEnabledAgents &&
    defaultAgentId === null;

  useEffect(() => {
    if (hasEnabledAgents) {
      setShowEnableAgentPrompt(false);
      return;
    }
    setDefaultAgentOpen(false);
  }, [hasEnabledAgents]);

  if (loading) {
    return (
      <div
        className="onboarding-agent-loading"
        role="status"
        aria-label={t('onboarding.detectingAgents')}
        aria-live="polite"
      >
        <div
          className="onboarding-agent-loading-preview"
          data-testid="agent-loading-preview"
          aria-hidden="true"
        >
          <div className="onboarding-agent-loading-list">
            {Array.from({ length: LOADING_AGENT_ROWS }, (_, index) => (
              <div className="onboarding-agent-loading-row" key={index}>
                <span className="onboarding-agent-loading-checkbox" />
                <span className="onboarding-agent-loading-icon" />
                <span className="onboarding-agent-loading-copy">
                  <span />
                  <span />
                </span>
              </div>
            ))}
          </div>
          <div className="onboarding-agent-loading-default">
            <span />
            <span />
          </div>
        </div>
        <div className="onboarding-agent-loading-indicator">
          <Loader2
            className="h-4 w-4 motion-safe:animate-spin"
            aria-hidden="true"
          />
          <strong>{t('onboarding.detectingAgents')}</strong>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="onboarding-agent-state" role="alert">
        <span>{error}</span>
        <button type="button" onClick={onRetry}>
          {t('onboarding.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="onboarding-agent-picker">
      <div className="onboarding-agent-stage">
        <h3>{t('onboarding.enabledAgents')}</h3>
        <div className="onboarding-agent-list" role="list">
          {agents.map((agent) => {
            const enabled = enabledAgentIds.has(agent.agentId);
            return (
              <article
                key={agent.agentId}
                className={cn('onboarding-agent-row', enabled && 'is-enabled')}
                role="listitem"
              >
                <label className="onboarding-agent-enable">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(event) =>
                      onEnabledChange(agent.agentId, event.target.checked)
                    }
                    aria-label={t('onboarding.enableAgentAria', {
                      agent: agent.displayName,
                    })}
                  />
                  <span
                    className="onboarding-agent-checkbox"
                    aria-hidden="true"
                  >
                    <Check />
                  </span>
                </label>

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

                <div className="onboarding-agent-copy">
                  <div className="onboarding-agent-name-line">
                    <strong>{agent.displayName}</strong>
                    {agent.runtimeInstalled ? (
                      <span className="onboarding-status-badge is-installed">
                        <ShieldCheck aria-hidden="true" />
                        {t('onboarding.installed')}
                      </span>
                    ) : (
                      <span className="onboarding-status-badge">
                        <Download aria-hidden="true" />
                        {t('onboarding.notInstalled')}
                      </span>
                    )}
                    {agent.recommended ? (
                      <span className="onboarding-agent-source">
                        {t('onboarding.recommended')}
                      </span>
                    ) : agent.builtIn ? (
                      <span className="onboarding-agent-source">
                        {t('onboarding.builtIn')}
                      </span>
                    ) : null}
                  </div>
                  <p>{agent.description}</p>
                </div>
              </article>
            );
          })}
        </div>
      </div>

      <div className="onboarding-default-agent-field">
        <label htmlFor="onboarding-default-agent">
          {t('onboarding.defaultAgent')}
        </label>
        <div className="onboarding-default-agent-control">
          <Select
            value={defaultAgentId ?? ''}
            open={defaultAgentOpen}
            onOpenChange={(open) => {
              if (open && !hasEnabledAgents) {
                setShowEnableAgentPrompt(true);
                setDefaultAgentOpen(false);
                return;
              }
              setDefaultAgentOpen(open);
            }}
            onValueChange={(agentId) => onDefaultChange(agentId as AgentId)}
          >
            <SelectTrigger
              id="onboarding-default-agent"
              aria-disabled={!hasEnabledAgents}
              aria-describedby={
                showEnabledAgentsPrompt || showDefaultRequiredPrompt
                  ? 'onboarding-default-agent-prompt'
                  : undefined
              }
              className={cn(
                !hasEnabledAgents && 'is-awaiting-agent-selection',
                showDefaultRequiredPrompt && 'has-error'
              )}
            >
              <SelectValue
                placeholder={t('onboarding.selectDefaultAgentPlaceholder')}
              />
            </SelectTrigger>
            <SelectContent
              align="start"
              className="onboarding-popover-layer max-h-72"
            >
              {enabledAgents.map((agent) => (
                <SelectItem key={agent.agentId} value={agent.agentId}>
                  <DefaultAgentLabel agent={agent} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {showEnabledAgentsPrompt || showDefaultRequiredPrompt ? (
            <p
              id="onboarding-default-agent-prompt"
              className="onboarding-default-agent-prompt"
              role="alert"
            >
              {showEnabledAgentsPrompt
                ? t('onboarding.selectEnabledAgentsFirst')
                : t('onboarding.selectDefaultAgentRequired')}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
