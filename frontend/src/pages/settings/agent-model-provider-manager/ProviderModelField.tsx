import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AstryxSelect } from '@/components/ui/astryx-select';
import { Button } from '@/components/ui/button';

import { CUSTOM_MODEL_SENTINEL } from './constants';

/**
 * A model id field that offers the models the user enabled above it.
 *
 * The detection panel is where models get chosen, so asking for the same name
 * again as free text made the two halves of the form look unrelated. When
 * there is nothing to offer the field stays a plain input, which keeps the
 * "the endpoint does not list the model I want" path intact.
 */
export function ProviderModelField({
  label,
  ariaLabel,
  name,
  value,
  choices,
  disabled,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  name: string;
  value: string;
  choices: readonly string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('settings');
  const listed = value === '' || choices.includes(value);
  const [typing, setTyping] = useState(!listed);
  // A value saved before this model list existed has no option to sit on, so
  // show it as its own entry instead of an empty picker.
  const unlisted = value !== '' && !choices.includes(value);

  if (choices.length === 0) {
    return (
      <label>
        <span>{label}</span>
        <input
          aria-label={ariaLabel}
          autoComplete="off"
          disabled={disabled}
          name={name}
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    );
  }

  if (typing) {
    return (
      <label>
        <span>{label}</span>
        {/* A span, not a div: a label's content model is phrasing content. */}
        <span className="provider-model-field-custom">
          <input
            aria-label={ariaLabel}
            autoComplete="off"
            disabled={disabled}
            name={name}
            spellCheck={false}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-8"
            disabled={disabled}
            onClick={() => setTyping(false)}
          >
            {t('agents.providerModelUseList')}
          </Button>
        </span>
      </label>
    );
  }

  return (
    <label>
      <span>{label}</span>
      <AstryxSelect
        ariaLabel={ariaLabel}
        disabled={disabled}
        value={value}
        options={[
          ...choices.map((id) => ({ value: id, label: id })),
          ...(unlisted
            ? [{ value, label: `${value} (${t('agents.custom')})` }]
            : []),
          {
            value: CUSTOM_MODEL_SENTINEL,
            label: t('agents.providerModelCustomOption'),
          },
        ]}
        onChange={(next) => {
          if (next === CUSTOM_MODEL_SENTINEL) {
            setTyping(true);
            return;
          }
          onChange(next);
        }}
      />
    </label>
  );
}
