import { useTranslation } from 'react-i18next';

import { AstryxSelect } from '@/components/ui/astryx-select';
import { piReasoningIssue } from '@/lib/piThinking';

import { PiReasoningFields } from '../PiReasoningFields';
import { PI_PROTOCOLS } from './constants';
import { ProviderModelField } from './ProviderModelField';
import {
  enabledModelIds,
  parsePiModel,
  writePiReasoning,
} from './providerModelParse';
import type { PiModelSpec } from './types';

export function PiProviderModelEditor({
  value,
  choices,
  disabled,
  onChange,
}: {
  value: string;
  choices: readonly string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('settings');
  const parsed = parsePiModel(value);
  const patch = (next: PiModelSpec) => {
    const payload: Record<string, unknown> = {
      ...parsed.raw,
      id: next.id,
      api: next.api,
    };
    // Picking one of the enabled models makes it the default, and the backend
    // reads the first entry, so it has to lead the list. A typed id is left
    // out of the list entirely: the list is what the detection panel manages,
    // and adding every keystroke to it would fill it with partial ids.
    const enabled = enabledModelIds(value);
    if (next.id !== '' && enabled.includes(next.id)) {
      payload.models = [next.id, ...enabled.filter((id) => id !== next.id)];
    }
    writePiReasoning(payload, next);
    onChange(JSON.stringify(payload));
  };
  const defaultUnlisted =
    piReasoningIssue(parsed.reasoning, parsed.thinkingLevel) ===
    'default-unlisted';
  return (
    <fieldset className="agent-model-provider-claude">
      <legend>{t('agents.model')}</legend>
      <ProviderModelField
        ariaLabel={t('agents.providerModelAria')}
        choices={choices}
        disabled={disabled}
        label={t('agents.model')}
        name="pi_provider_model"
        value={parsed.id}
        onChange={(id) => patch({ ...parsed, id })}
      />
      <label>
        <span>{t('agents.customProviderProtocol')}</span>
        <AstryxSelect
          ariaLabel={t('agents.customProviderProtocol')}
          disabled={disabled}
          value={parsed.api}
          options={PI_PROTOCOLS.map((protocol) => ({
            value: protocol,
            label: protocol,
          }))}
          onChange={(api) => patch({ ...parsed, api })}
        />
      </label>
      <div className="pi-reasoning-card">
        <PiReasoningFields
          disabled={disabled}
          reasoning={parsed.reasoning}
          thinkingLevel={parsed.thinkingLevel}
          onReasoningChange={(reasoning) => patch({ ...parsed, reasoning })}
          onThinkingLevelChange={(thinkingLevel) =>
            patch({ ...parsed, thinkingLevel })
          }
        />
      </div>
      {defaultUnlisted ? (
        <p className="agent-model-provider-error" role="alert">
          {t('agents.piDefaultLevelUnlisted')}
        </p>
      ) : null}
    </fieldset>
  );
}
