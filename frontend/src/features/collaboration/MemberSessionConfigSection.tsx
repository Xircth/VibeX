import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

import {
  CollaborationOptionSelect,
  CustomAgentControls,
} from './memberFormControls';

export const MEMBER_CONFIG_COPY = {
  title: '????',
  agent: '?? Agent',
  persona: '?????',
  save: '????',
  hint: '??????????????????????????????',
} as const;

export type MemberSessionConfig = {
  agent_id?: string | null;
  mode_id?: string | null;
  config_values?: Record<string, string> | null;
  persona_prompt?: string | null;
};

export function MemberSessionConfigSection({
  config,
  agents,
  onSave,
}: {
  config: MemberSessionConfig | null;
  agents: readonly { agent_id: string; name: string }[];
  onSave: (next: {
    agentId: string;
    modeId?: string;
    configValues: Record<string, string>;
    personaPrompt?: string;
  }) => void;
}) {
  const [agentId, setAgentId] = useState(config?.agent_id ?? '');
  const [modeId, setModeId] = useState(config?.mode_id ?? '');
  const [values, setValues] = useState<Record<string, string>>(
    config?.config_values ?? {}
  );
  const [persona, setPersona] = useState(config?.persona_prompt ?? '');
  useEffect(() => {
    setAgentId(config?.agent_id ?? '');
    setModeId(config?.mode_id ?? '');
    setValues(config?.config_values ?? {});
    setPersona(config?.persona_prompt ?? '');
  }, [config]);
  return (
    <section
      className="collab-profile-section"
      data-testid="collab-member-config"
    >
      <h4 className="collab-profile-section-title">{MEMBER_CONFIG_COPY.title}</h4>
      <div className="collab-form">
        <CollaborationOptionSelect
          ariaLabel={MEMBER_CONFIG_COPY.agent}
          value={agentId}
          placeholder={MEMBER_CONFIG_COPY.agent}
          options={agents.map((agent) => ({
            value: agent.agent_id,
            label: agent.name,
          }))}
          onChange={(next) => {
            setAgentId(next);
            setModeId('');
            setValues({});
          }}
        />
        <CustomAgentControls
          agentId={agentId}
          modeId={modeId}
          values={values}
          onModeId={setModeId}
          onValues={setValues}
        />
        <div className="collab-form-field">
          <Label htmlFor="collab-profile-persona">{MEMBER_CONFIG_COPY.persona}</Label>
          <Textarea
            id="collab-profile-persona"
            value={persona}
            onChange={(event) => setPersona(event.target.value)}
          />
        </div>
        <p className="collab-profile-row-sub">{MEMBER_CONFIG_COPY.hint}</p>
        <Button
          size="sm"
          disabled={!agentId}
          onClick={() =>
            onSave({
              agentId,
              modeId: modeId || undefined,
              configValues: values,
              personaPrompt: persona.trim() || undefined,
            })
          }
        >
          {MEMBER_CONFIG_COPY.save}
        </Button>
      </div>
    </section>
  );
}
