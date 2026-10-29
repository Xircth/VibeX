import { useTranslation } from 'react-i18next';

import { CLAUDE_MODEL_FIELDS } from './constants';
import { ProviderModelField } from './ProviderModelField';
import { parseClaudeModel } from './providerModelParse';

export function ClaudeProviderModelEditor({
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
  const parsed = parseClaudeModel(value);
  const write = (key: string, nextValue: string) => {
    // Edit the parsed object rather than a copy of the keys we render: an
    // unrelated field must not drop what we do not know about.
    const next = { ...parsed.raw };
    if (nextValue) next[key] = nextValue;
    else delete next[key];
    onChange(Object.keys(next).length ? JSON.stringify(next) : '');
  };
  return (
    <fieldset className="agent-model-provider-claude">
      <legend>{t('agents.providerModelMapping')}</legend>
      {CLAUDE_MODEL_FIELDS.map(([key, labelKey, kind]) => {
        const label = t(`agents.${labelKey}`);
        const ariaLabel = t('agents.providerModelFieldAria', { label });
        if (kind === 'text') {
          return (
            <label key={key}>
              <span>{label}</span>
              <input
                aria-label={ariaLabel}
                autoComplete="off"
                disabled={disabled}
                name={`claude_provider_${key}`}
                spellCheck={false}
                value={parsed.values[key] ?? ''}
                onChange={(event) => write(key, event.target.value)}
              />
            </label>
          );
        }
        return (
          <ProviderModelField
            key={key}
            ariaLabel={ariaLabel}
            choices={choices}
            disabled={disabled}
            label={label}
            name={`claude_provider_${key}`}
            value={parsed.values[key] ?? ''}
            onChange={(next) => write(key, next)}
          />
        );
      })}
    </fieldset>
  );
}
