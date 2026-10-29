import { useTranslation } from 'react-i18next';
import type { AgentId } from 'shared/types';

import { ProviderModelField } from './ProviderModelField';
import {
  enabledModelIds,
  selectedModelIds,
  serializeSelectedModels,
} from './providerModelParse';

export function DefaultProviderModelEditor({
  agentId,
  value,
  choices,
  disabled,
  onChange,
}: {
  agentId: AgentId;
  value: string;
  choices: readonly string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('settings');
  const ids = selectedModelIds(value);
  const patch = (id: string) => {
    const enabled = enabledModelIds(value);
    if (id !== '' && enabled.includes(id)) {
      onChange(
        serializeSelectedModels(agentId, value, [
          id,
          ...enabled.filter((item) => item !== id),
        ])
      );
      return;
    }
    if (enabled.length === 0) {
      onChange(id);
      return;
    }
    // A typed id becomes the default; the enabled list stays the detection
    // panel's, matching Pi so keystrokes do not fill that list with fragments.
    onChange(
      JSON.stringify({
        default: id,
        id,
        models: enabled,
      })
    );
  };
  return (
    <fieldset className="agent-model-provider-claude">
      <legend>{t('agents.model')}</legend>
      <ProviderModelField
        ariaLabel={t('agents.providerModelAria')}
        choices={choices}
        disabled={disabled}
        label={t('agents.model')}
        name={`${agentId}_model_provider_model`}
        value={ids[0] ?? ''}
        onChange={patch}
      />
    </fieldset>
  );
}
