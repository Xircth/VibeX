import { useTranslation } from 'react-i18next';

import { AstryxSelect } from '@/components/ui/astryx-select';

import { ProviderModelField } from './ProviderModelField';
import { enabledModelIds, parseGrokModel } from './providerModelParse';
import type { GrokBackendSearchSetting, GrokModelSpec } from './types';

function serializeBackendSearch(
  setting: GrokBackendSearchSetting
): boolean | null {
  if (setting === 'enabled') return true;
  if (setting === 'disabled') return false;
  return null;
}

function serializeOptionalNonNegativeInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
}

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
    const backendSearch = serializeBackendSearch(next.supports_backend_search);
    const maxRetries = serializeOptionalNonNegativeInt(next.max_retries);
    const payload: Record<string, unknown> = {
      ...parsed.raw,
      id: next.id,
      api_backend: next.api_backend,
      context_window: next.context_window ? Number(next.context_window) : null,
    };
    if (backendSearch !== null) {
      payload.supports_backend_search = backendSearch;
      payload.web_search = backendSearch;
    } else {
      if ('supports_backend_search' in parsed.raw) {
        payload.supports_backend_search = null;
      }
      if ('web_search' in parsed.raw) {
        payload.web_search = null;
      }
    }
    if (maxRetries !== null) {
      payload.max_retries = maxRetries;
    } else if ('max_retries' in parsed.raw) {
      payload.max_retries = null;
    }
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
      <label>
        <span>{t('agents.grokBackendSearch')}</span>
        <AstryxSelect
          ariaLabel={t('agents.grokBackendSearch')}
          disabled={disabled}
          value={parsed.supports_backend_search}
          options={[
            { value: 'unset', label: t('agents.grokBackendSearchDefault') },
            { value: 'enabled', label: t('agents.grokBackendSearchEnabled') },
            {
              value: 'disabled',
              label: t('agents.grokBackendSearchDisabled'),
            },
          ]}
          onChange={(supports_backend_search) =>
            patch({
              ...parsed,
              supports_backend_search:
                supports_backend_search as GrokBackendSearchSetting,
            })
          }
        />
      </label>
      <label>
        <span>{t('agents.grokMaxRetries')}</span>
        <input
          aria-label={t('agents.grokMaxRetries')}
          autoComplete="off"
          disabled={disabled}
          inputMode="numeric"
          name="grok_provider_max_retries"
          value={parsed.max_retries}
          onChange={(event) =>
            patch({ ...parsed, max_retries: event.target.value })
          }
        />
      </label>
    </fieldset>
  );
}
