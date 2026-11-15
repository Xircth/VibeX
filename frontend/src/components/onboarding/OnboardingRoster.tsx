import { useMemo } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { useTranslation } from 'react-i18next';
import type { AgentId, AgentManagementView } from 'shared/types';
import { cn } from '@/lib/utils';
import { AgentBar } from '@/pages/settings/AgentBar';

export const ONBOARDING_ROSTER_DROPPABLE_ID = 'onboarding-roster-dropzone';

export function OnboardingRoster({
  agents,
  ids,
  onChange,
  onInspect,
  dropReady = false,
}: {
  agents: AgentManagementView[];
  ids: AgentId[];
  onChange: (ids: AgentId[]) => void;
  onInspect: (id: AgentId) => void;
  dropReady?: boolean;
}) {
  const { t } = useTranslation('dialogs');
  const { setNodeRef, isOver } = useDroppable({
    id: ONBOARDING_ROSTER_DROPPABLE_ID,
  });
  const ordered = useMemo(
    () =>
      ids.flatMap((id) => {
        const agent = agents.find((item) => item.agent_id === id);
        return agent ? [{ ...agent, enabled: true }] : [];
      }),
    [agents, ids]
  );
  return (
    <section
      ref={setNodeRef}
      className={cn(
        'onboarding-roster settings-page',
        dropReady && 'is-drop-ready',
        isOver && 'is-drop-over'
      )}
      data-drop-over={isOver ? 'true' : undefined}
      aria-label={t('onboarding.rosterTitle')}
    >
      <header className="onboarding-roster-heading">
        <h3>{t('onboarding.rosterTitle')}</h3>
        <p>{t('onboarding.rosterDescription')}</p>
      </header>
      <AgentBar
        spacing="compact"
        showLabels
        agents={ordered}
        selectedAgentId={ids[0] ?? null}
        registryOpen={false}
        onSelect={onInspect}
        onReorder={onChange}
        onRemove={(id) => onChange(ids.filter((candidate) => candidate !== id))}
      />
      <p className="sr-only">{t('onboarding.rosterKeyboardHint')}</p>
    </section>
  );
}
