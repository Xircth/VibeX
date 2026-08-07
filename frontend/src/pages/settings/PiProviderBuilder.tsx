import { Plus, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { AstryxSelect } from '@/components/ui/astryx-select';
import { Button } from '@/components/ui/button';

const PROTOCOLS = [
  ['openai-completions', 'OpenAI Chat Completions'],
  ['openai-responses', 'OpenAI Responses'],
  ['anthropic-messages', 'Anthropic Messages'],
  ['google-generative-ai', 'Google Generative AI'],
] as const;

type ProviderDocument = Record<string, Record<string, unknown>>;

export function PiProviderBuilder({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('settings');
  const parsed = useMemo(
    () =>
      parseProviders(value, {
        topLevelObject: t('agents.piProviderJsonTopLevelObject'),
        entryObject: (id) => t('agents.piProviderJsonEntryObject', { id }),
        invalidJson: t('agents.invalidJson'),
      }),
    [t, value]
  );

  if (!parsed.ok) {
    return (
      <div className="pi-provider-builder">
        <p className="pi-provider-error" role="alert">
          {t('agents.piProviderJsonEditFailed', { error: parsed.error })}
        </p>
        <textarea
          aria-label={t('agents.customProviderJson')}
          autoComplete="off"
          disabled={disabled}
          name="pi_custom_providers_json"
          rows={7}
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    );
  }

  const entries = Object.entries(parsed.providers).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const commit = (providers: ProviderDocument) =>
    onChange(JSON.stringify(providers, null, 2));
  const patch = (id: string, key: string, nextValue: string) => {
    commit({
      ...parsed.providers,
      [id]: { ...parsed.providers[id], [key]: nextValue },
    });
  };
  const rename = (id: string, nextId: string) => {
    const normalized = nextId.trim();
    if (
      !normalized ||
      normalized === id ||
      Object.prototype.hasOwnProperty.call(parsed.providers, normalized)
    ) {
      return;
    }
    const providers = { ...parsed.providers };
    const provider = providers[id];
    delete providers[id];
    providers[normalized] = provider;
    commit(providers);
  };
  const add = () => {
    let suffix = 1;
    while (parsed.providers[`custom-${suffix}`]) suffix += 1;
    commit({
      ...parsed.providers,
      [`custom-${suffix}`]: {
        baseUrl: '',
        api: 'openai-responses',
      },
    });
  };
  const remove = (id: string) => {
    const providers = { ...parsed.providers };
    delete providers[id];
    commit(providers);
  };

  return (
    <div className="pi-provider-builder">
      {entries.length ? (
        <ul className="pi-provider-list">
          {entries.map(([id, provider]) => (
            <li key={id}>
              <div className="pi-provider-row-heading">
                <strong>{id}</strong>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  aria-label={t('agents.piProviderDeleteAria', { id })}
                  disabled={disabled}
                  onClick={() => remove(id)}
                >
                  <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="pi-provider-fields">
                <label>
                  <span>Provider ID</span>
                  <input
                    aria-label={`${id} Provider ID`}
                    autoComplete="off"
                    defaultValue={id}
                    disabled={disabled}
                    name={`pi_provider_${id}_id`}
                    spellCheck={false}
                    onBlur={(event) => rename(id, event.target.value)}
                  />
                </label>
                <label>
                  <span>API URL</span>
                  <input
                    aria-label={`${id} API URL`}
                    autoComplete="off"
                    disabled={disabled}
                    name={`pi_provider_${id}_url`}
                    spellCheck={false}
                    type="url"
                    value={stringValue(provider.baseUrl)}
                    onChange={(event) =>
                      patch(id, 'baseUrl', event.target.value)
                    }
                  />
                </label>
                <label>
                  <span>{t('agents.protocol')}</span>
                  <AstryxSelect
                    ariaLabel={t('agents.piProviderProtocolAria', { id })}
                    disabled={disabled}
                    value={stringValue(provider.api) || PROTOCOLS[0][0]}
                    options={PROTOCOLS.map(([protocol, label]) => ({
                      value: protocol,
                      label,
                    }))}
                    onChange={(next) => patch(id, 'api', next)}
                  />
                </label>
              </div>
              {Object.keys(provider).some(
                (key) => !['baseUrl', 'api'].includes(key)
              ) ? (
                <p className="pi-provider-preserved">
                  {t('agents.piProviderExtensionFieldsPreserved')}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="pi-provider-empty">{t('agents.piProviderEmpty')}</p>
      )}
      <Button
        size="sm"
        variant="outline"
        className="h-8 self-start"
        disabled={disabled}
        onClick={add}
      >
        <Plus aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
        {t('agents.addProvider')}
      </Button>
    </div>
  );
}

function parseProviders(
  value: string,
  messages: {
    topLevelObject: string;
    entryObject: (id: string) => string;
    invalidJson: string;
  }
): { ok: true; providers: ProviderDocument } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(value.trim() || '{}') as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      return { ok: false, error: messages.topLevelObject };
    }
    for (const [id, provider] of Object.entries(parsed)) {
      if (
        !provider ||
        Array.isArray(provider) ||
        typeof provider !== 'object'
      ) {
        return { ok: false, error: messages.entryObject(id) };
      }
    }
    return { ok: true, providers: parsed as ProviderDocument };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : messages.invalidJson,
    };
  }
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}
