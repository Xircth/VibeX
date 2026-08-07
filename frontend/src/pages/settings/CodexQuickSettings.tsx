import { useTranslation } from 'react-i18next';
import type { AgentNativeConfigFieldView } from 'shared/types';

import { AstryxSelect } from '@/components/ui/astryx-select';
import { Switch } from '@/components/ui/switch';

import { containsCjk, humanizeIdentifier } from './agentConfigLabels';

const QUICK_SELECT_FIELDS = [
  'codex_reasoning_effort',
  'codex_reasoning_summary',
  'codex_verbosity',
  'codex_approval_policy',
  'codex_sandbox_mode',
  'codex_web_search',
] as const;

const QUICK_TOGGLE_FIELDS = ['codex_skills', 'codex_network_access'] as const;

export const CODEX_QUICK_FIELDS = new Set<string>([
  ...QUICK_SELECT_FIELDS,
  ...QUICK_TOGGLE_FIELDS,
]);

type Props = {
  fields: AgentNativeConfigFieldView[];
  drafts: Record<string, string>;
  disabled: boolean;
  onChange: (fieldId: string, value: string) => void;
};

export function CodexQuickSettings({
  fields,
  drafts,
  disabled,
  onChange,
}: Props) {
  const { t, i18n } = useTranslation('settings');
  const english = i18n.resolvedLanguage?.startsWith('en') ?? false;
  const selectFields = QUICK_SELECT_FIELDS.map((id) =>
    fields.find((field) => field.id === id)
  ).filter((field): field is AgentNativeConfigFieldView => field != null);
  const toggleFields = QUICK_TOGGLE_FIELDS.map((id) =>
    fields.find((field) => field.id === id)
  ).filter((field): field is AgentNativeConfigFieldView => field != null);

  if (!selectFields.length && !toggleFields.length) return null;

  const label = (field: AgentNativeConfigFieldView) =>
    english && containsCjk(field.label)
      ? humanizeIdentifier(field.id)
      : field.label;
  const optionLabel = (value: string, optionLabel: string) =>
    english && containsCjk(optionLabel)
      ? humanizeIdentifier(value)
      : optionLabel;

  return (
    <div className="agent-codex-quick">
      {selectFields.length ? (
        <div className="agent-codex-quick-grid">
          {selectFields.map((field) => (
            <label className="agent-codex-quick-field" key={field.id}>
              <span>{label(field)}</span>
              <AstryxSelect
                ariaLabel={label(field)}
                disabled={disabled}
                hasClear
                placeholder={t('agents.notSet')}
                value={drafts[field.id] ?? ''}
                options={field.options.map((option) => ({
                  value: option.value,
                  label: optionLabel(option.value, option.label),
                }))}
                onChange={(value) => onChange(field.id, value)}
              />
            </label>
          ))}
        </div>
      ) : null}
      {toggleFields.length ? (
        <div className="agent-codex-quick-toggles">
          {toggleFields.map((field) => (
            <div className="agent-codex-quick-toggle" key={field.id}>
              <strong>{label(field)}</strong>
              <Switch
                aria-label={label(field)}
                checked={drafts[field.id] === 'true'}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  onChange(field.id, String(checked))
                }
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
