import { useTranslation } from 'react-i18next';

import { AstryxSelect } from '@/components/ui/astryx-select';

import { ProviderModelField } from './ProviderModelField';
import { enabledModelIds, parseGrokModel } from './providerModelParse';
import type { GrokModelSpec } from './types';

export function GrokProviderModelEditor({
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
  const parsed = parseGrokModel(value);
  const patch = (next: GrokModelSpec) => {
    const payload: Record<string, unknown> = {
      ...parsed.raw,
      id: next.id,
      api_backend: next.api_backend,
      context_window: next.context_window ? Number(next.context_window) : null,
    };
    // Same as Pi: reorder only for a model the user had already enabled.
    const enabled = enabledModelIds(value);
    if (next.id !== '' && enabled.includes(next.id)) {
      payload.models = [next.id, ...enabled.filter((id) => id !== next.id)];
    }
    onChange(JSON.stringify(payload));
  };
  return (
    <fieldset className="agent-model-provider-claude">
      <legend>{t('agents.model')}</legend>
      <ProviderModelField
        ariaLabel={t('agents.providerModelAria')}
        choices={choices}
        disabled={disabled}
        label={t('agents.model')}
        name="grok_provider_model"
        value={parsed.id}
        onChange={(id) => patch({ ...parsed, id })}
      />
      <label>
        <span>{t('agents.grokApiBackend')}</span>
        <AstryxSelect
          ariaLabel={t('agents.grokApiBackend')}
          disabled={disabled}
          value={parsed.api_backend}
          options={[
            { value: 'responses', label: 'OpenAI Responses' },
            { value: 'chat_completions', label: 'OpenAI Chat Completions' },
            { value: 'messages', label: 'Anthropic Messages' },
          ]}
          onChange={(api_backend) => patch({ ...parsed, api_backend })}
        />
      </label>
      <label>
        <span>{t('agents.grokContextWindow')}</span>
        <input
          aria-label={t('agents.grokContextWindow')}
          autoComplete="off"
          disabled={disabled}
          inputMode="numeric"
          name="grok_provider_context"
          value={parsed.context_window}
          onChange={(event) =>
            patch({ ...parsed, context_window: event.target.value })
          }
        />
      </label>
    </fieldset>
  );
}
