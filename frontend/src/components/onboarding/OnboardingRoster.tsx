import { useTranslation } from 'react-i18next';
import type { AgentId, AgentManagementView } from 'shared/types';
import { AgentBar } from '@/pages/settings/AgentBar';

export function OnboardingRoster({
  agents,
  ids,
  onChange,
  onInspect,
}: {
  agents: AgentManagementView[];
  ids: AgentId[];
  onChange: (ids: AgentId[]) => void;
  onInspect: (id: AgentId) => void;
}) {
  const { t } = useTranslation('dialogs');
  const ordered = ids.flatMap((id) => {
    const agent = agents.find((item) => item.agent_id === id);
    return agent ? [{ ...agent, enabled: true }] : [];
  });
  return (
    <section
      className="onboarding-roster settings-page"
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
