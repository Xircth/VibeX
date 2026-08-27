import { useTranslation } from 'react-i18next';
import type { AgentNativeConfigFieldView } from 'shared/types';

import { AstryxSelect } from '@/components/ui/astryx-select';
import { Switch } from '@/components/ui/switch';

import { containsCjk, humanizeIdentifier } from './agentConfigLabels';
import { PiProviderBuilder } from './PiProviderBuilder';

export const CODEX_QUICK_FIELDS = new Set<string>([
  'codex_reasoning_effort',
  'codex_reasoning_summary',
  'codex_verbosity',
  'codex_approval_policy',
  'codex_sandbox_mode',
  'codex_web_search',
  'codex_network_access',
]);

type Props = {
  fields: AgentNativeConfigFieldView[];
  drafts: Record<string, string>;
  disabled: boolean;
  onChange: (fieldId: string, value: string) => void;
};

export function AgentConfigFieldsCard({
  fields,
  drafts,
  disabled,
  onChange,
}: Props) {
  const { i18n } = useTranslation('settings');
  const english = i18n.resolvedLanguage?.startsWith('en') ?? false;
  if (!fields.length) return null;

  const labelOf = (field: AgentNativeConfigFieldView) =>
    english && containsCjk(field.label)
      ? humanizeIdentifier(field.id)
      : field.label;
  const optionLabel = (value: string, option: string) =>
    english && containsCjk(option) ? humanizeIdentifier(value) : option;

  const laidOut = layoutConfigFields(fields);

  return (
    <div className="agent-codex-quick">
      <div className="agent-codex-quick-grid">
        {laidOut.map(({ field }) => {
          if (isToggleField(field)) {
            return (
              <div className="agent-codex-quick-toggle" key={field.id}>
                <strong>{labelOf(field)}</strong>
                <Switch
                  aria-label={labelOf(field)}
                  checked={toggleChecked(field, drafts[field.id] ?? '')}
                  disabled={disabled}
                  onCheckedChange={(next) =>
                    onChange(field.id, toggleValue(field, next))
                  }
                />
              </div>
            );
          }
          return (
            <div
              className={`agent-codex-quick-field${
                isWideField(field) ? ' is-wide' : ''
              }`}
              key={field.id}
            >
              <span id={`agent-config-${field.id}-label`}>
                {labelOf(field)}
              </span>
              <ConfigControl
                disabled={disabled}
                field={field}
                label={labelOf(field)}
                optionLabel={optionLabel}
                value={drafts[field.id] ?? ''}
                onChange={(value) => onChange(field.id, value)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CodexQuickSettings(props: {
  fields: AgentNativeConfigFieldView[];
  drafts: Record<string, string>;
  disabled: boolean;
  onChange: (fieldId: string, value: string) => void;
}) {
  return <AgentConfigFieldsCard {...props} />;
}

function ConfigControl({
  field,
  value,
  disabled,
  label,
  optionLabel,
  onChange,
}: {
  field: AgentNativeConfigFieldView;
  value: string;
  disabled: boolean;
  label: string;
  optionLabel: (value: string, option: string) => string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('settings');
  const inputId = `agent-config-${field.id}`;
  if (field.id === 'pi_custom_providers') {
    return (
      <div id={inputId} aria-labelledby={`${inputId}-label`} role="group">
        <PiProviderBuilder
          value={value}
          disabled={disabled}
          onChange={onChange}
        />
      </div>
    );
  }
  if (field.kind === 'json') {
    return (
      <textarea
        id={inputId}
        aria-label={label}
        autoComplete="off"
        disabled={disabled}
        name={`agent_config_${field.id}`}
        placeholder="{}"
        rows={7}
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  if (field.kind === 'select') {
    return (
      <AstryxSelect
        id={inputId}
        ariaLabel={label}
        disabled={disabled}
        hasClear
        placeholder={fieldPlaceholder(field, t('agents.notSet'))}
        value={value}
        options={field.options.map((option) => ({
          value: option.value,
          label: optionLabel(option.value, option.label),
        }))}
        onChange={onChange}
      />
    );
  }
  return (
    <input
      id={inputId}
      aria-label={label}
      autoComplete={field.secret ? 'new-password' : 'off'}
      disabled={disabled}
      inputMode={field.kind === 'number' ? 'numeric' : undefined}
      name={`agent_config_${field.id}`}
      placeholder={
        field.secret && field.present
          ? t('agents.replaceSecretPlaceholder')
          : fieldPlaceholder(field, t('agents.notSet'))
      }
      type={
        field.secret ? 'password' : field.kind === 'number' ? 'number' : 'text'
      }
      value={
        field.secret && field.present && value === ''
          ? (field.masked_value ?? '••••••••')
          : value
      }
      onFocus={
        field.secret && field.present
          ? (event) => event.currentTarget.select()
          : undefined
      }
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function isWideField(field: AgentNativeConfigFieldView): boolean {
  return field.kind === 'json' || field.id === 'pi_custom_providers';
}

export function layoutConfigFields(
  fields: AgentNativeConfigFieldView[]
): { field: AgentNativeConfigFieldView; fill: boolean }[] {
  const compact: AgentNativeConfigFieldView[] = [];
  const toggles: AgentNativeConfigFieldView[] = [];
  const wide: AgentNativeConfigFieldView[] = [];
  fields.forEach((field) => {
    if (isWideField(field)) wide.push(field);
    else if (isToggleField(field)) toggles.push(field);
    else compact.push(field);
  });
  return [...compact, ...toggles, ...wide].map((field) => ({
    field,
    fill: false,
  }));
}

function fieldPlaceholder(
  field: AgentNativeConfigFieldView,
  fallback: string
): string {
  if (field.secret) return fallback;
  const option = field.options.find((entry) => entry.value === field.value);
  if (option) return option.label;
  return field.value || fallback;
}

export function fillGridRows(
  fields: AgentNativeConfigFieldView[]
): { field: AgentNativeConfigFieldView; fill: boolean }[] {
  const marked = fields.map((field) => ({ field, fill: false }));
  let column = 0;
  marked.forEach((item, index) => {
    if (isWideField(item.field) && column === 1) {
      for (let previous = index - 1; previous >= 0; previous -= 1) {
        if (!isWideField(marked[previous].field)) {
          marked[previous].fill = true;
          column = 0;
          break;
        }
      }
    }
    if (isWideField(item.field) || item.fill) {
      column = 0;
      return;
    }
    column = (column + 1) % 2;
  });
  if (column === 1) {
    for (let previous = marked.length - 1; previous >= 0; previous -= 1) {
      if (!isWideField(marked[previous].field)) {
        marked[previous].fill = true;
        break;
      }
    }
  }
  return marked;
}

function isToggleField(field: AgentNativeConfigFieldView): boolean {
  if (field.kind === 'boolean') return true;
  if (field.kind !== 'select' || field.options.length !== 2) return false;
  const values = field.options.map((option) => option.value);
  return (
    (values.includes('0') && values.includes('1')) ||
    (values.includes('true') && values.includes('false'))
  );
}

function toggleChecked(
  field: AgentNativeConfigFieldView,
  value: string
): boolean {
  const enabled = value === 'true' || value === '1' || value === 'on';
  return field.id === 'codex_responses_websockets'
    ? value === 'false'
    : enabled;
}

function toggleValue(
  field: AgentNativeConfigFieldView,
  checked: boolean
): string {
  if (field.id === 'codex_responses_websockets') {
    return String(!checked);
  }
  if (field.kind === 'boolean') return String(checked);
  const values = field.options.map((option) => option.value);
  if (values.includes('1') && values.includes('0')) {
    return checked ? '1' : '0';
  }
  return String(checked);
}
