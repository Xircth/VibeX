import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import type { AgentId } from 'shared/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AgentManagementIcon } from '@/components/agents/AgentManagementIcon';
import type { OnboardingAgentOption } from './onboardingAgentModel';

/**
 * Dialog shown when locally installed Agent CLIs / desktop apps are detected
 * during onboarding. Lists each detected agent with a checkbox (all checked
 * by default). Confirming adds the selected agents to the VibeX roster.
 */
export function LocalAgentDetectedDialog({
  open,
  detected,
  onClose,
  onConfirm,
}: {
  open: boolean;
  detected: LocalDetectedAgent[];
  onClose: () => void;
  onConfirm: (ids: AgentId[]) => void;
}) {
  const { t } = useTranslation('dialogs');
  const [selected, setSelected] = useState<Set<AgentId>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (open && !initializedRef.current) {
      setSelected(new Set(detected.map((a) => a.agentId)));
      initializedRef.current = true;
    }
    if (!open) {
      initializedRef.current = false;
    }
  }, [open, detected]);

  const toggle = useCallback((id: AgentId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(detected.map((a) => a.agentId)));
  }, [detected]);

  const deselectAll = useCallback(() => {
    setSelected(new Set());
  }, []);

  const handleConfirm = async () => {
    if (confirming) return;
    setConfirming(true);
    try {
      onConfirm([...selected]);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(open) => !open && !confirming && onClose()}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('onboarding.localAgentsDetectedTitle')}</DialogTitle>
          <DialogDescription>
            {t('onboarding.localAgentsDetectedDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className="onboarding-local-agents-list">
          {detected.map((agent) => (
            <label key={agent.agentId} className="onboarding-local-agent-row">
              <input
                type="checkbox"
                checked={selected.has(agent.agentId)}
                onChange={() => toggle(agent.agentId)}
                className="onboarding-local-agent-checkbox"
              />
              <span className="onboarding-local-agent-icon">
                <AgentManagementIcon
                  agent={{
                    agent_id: agent.agentId,
                    icon_light: agent.iconLight,
                    icon_dark: agent.iconDark,
                    icon_svg: agent.iconSvg,
                  }}
                  className="h-5 w-5"
                />
              </span>
              <span className="onboarding-local-agent-name">
                {agent.displayName}
              </span>
              <span className="onboarding-local-agent-source">
                {t(agent.sourceLabelKey)}
              </span>
            </label>
          ))}
        </div>
        <div className="onboarding-local-agents-actions">
          <Button type="button" variant="ghost" size="sm" onClick={selectAll}>
            {t('onboarding.localAgentsSelectAll')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={deselectAll}
          >
            {t('onboarding.localAgentsDeselectAll')}
          </Button>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={confirming}
          >
            {t('onboarding.localAgentsSkip')}
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={confirming || selected.size === 0}
          >
            {confirming ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 motion-safe:animate-spin" />
                {t('onboarding.localAgentsConfirming')}
              </>
            ) : (
              t('onboarding.localAgentsConfirm')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type LocalDetectedAgent = {
  agentId: AgentId;
  displayName: string;
  iconLight: string | null;
  iconDark: string | null;
  iconSvg: string | null;
  sourceLabelKey: string;
};

/**
 * Filter the full agent option list down to those that have a locally detected
 * CLI or desktop installation (or an installed adapter not yet enabled in VibeX).
 */
export function findLocallyDetectedAgents(
  agents: OnboardingAgentOption[],
  enabledIds: Set<AgentId>
): LocalDetectedAgent[] {
  return agents
    .filter(
      (agent) =>
        agent.platformSupported &&
        (agent.localDetected ||
          (agent.runtimeInstalled &&
            (!agent.enabled || agent.needsInstallation) &&
            !enabledIds.has(agent.agentId)))
    )
    .map((agent) => ({
      agentId: agent.agentId,
      displayName: agent.displayName,
      iconLight: agent.iconLight,
      iconDark: agent.iconDark,
      iconSvg: agent.iconSvg,
      sourceLabelKey:
        !agent.needsInstallation &&
        (agent.lifecycle === 'ready' || agent.lifecycle === 'needs_auth')
          ? 'onboarding.localAgentReady'
          : 'onboarding.localAgentNeedsInstall',
    }));
}
