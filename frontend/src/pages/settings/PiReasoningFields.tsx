import { useTranslation } from 'react-i18next';

import { AstryxSelect } from '@/components/ui/astryx-select';
import {
  DEFAULT_ENABLED_PI_THINKING_LEVELS,
  PI_THINKING_LEVELS,
  implicitWireValue,
  isPiThinkingLevel,
  toggleThinkingLevel,
  type PiModelReasoning,
  type PiThinkingLevel,
} from '@/lib/piThinking';

export function PiReasoningFields({
  reasoning,
  thinkingLevel,
  disabled,
  onReasoningChange,
  onThinkingLevelChange,
}: {
  reasoning: PiModelReasoning;
  thinkingLevel: string;
  disabled: boolean;
  onReasoningChange: (next: PiModelReasoning) => void;
  onThinkingLevelChange: (next: string) => void;
}) {
  const { t } = useTranslation('settings');
  const availableLevels: readonly PiThinkingLevel[] = reasoning.enabled
    ? reasoning.levels
    : PI_THINKING_LEVELS;
  const effectiveThinkingLevel = reasoning.enabled
    ? thinkingLevel || 'off'
    : 'off';
  const selectValue = isPiThinkingLevel(effectiveThinkingLevel)
    ? effectiveThinkingLevel
    : (availableLevels[0] ?? 'off');

  return (
    <div className="pi-reasoning-fields">
      <label className="pi-reasoning-enable">
        <input
          aria-label={t('agents.piReasoningEnable')}
          checked={reasoning.enabled}
          disabled={disabled}
          name="pi_reasoning_enabled"
          type="checkbox"
          onChange={(event) => {
            const enabled = event.target.checked;
            onReasoningChange({
              ...reasoning,
              enabled,
              levels:
                enabled && reasoning.levels.length === 0
                  ? [...DEFAULT_ENABLED_PI_THINKING_LEVELS]
                  : reasoning.levels,
            });
          }}
        />
        <span>{t('agents.piReasoningEnable')}</span>
      </label>
      {reasoning.enabled ? (
        <div
          className="pi-wire-values"
          role="group"
          aria-label={t('agents.piWireValues')}
        >
          <p className="pi-wire-heading">{t('agents.piWireValues')}</p>
          {reasoning.levels.length === 0 ? (
            <p className="pi-configuration-error" role="alert">
              {t('agents.piThinkingLevelsEmpty')}
            </p>
          ) : null}
          {PI_THINKING_LEVELS.map((level) => {
            const active = reasoning.levels.includes(level);
            return (
              <div key={level} className="pi-wire-row">
                <label className="pi-wire-enable">
                  <input
                    aria-label={level}
                    checked={active}
                    disabled={disabled}
                    name={`pi_level_${level}`}
                    type="checkbox"
                    onChange={() => {
                      const levels = toggleThinkingLevel(
                        reasoning.levels,
                        level
                      );
                      onReasoningChange({ ...reasoning, levels });
                      if (thinkingLevel === level && !levels.includes(level)) {
                        onThinkingLevelChange(levels[0] ?? 'off');
                      }
                    }}
                  />
                  <span>{level}</span>
                </label>
                <input
                  aria-label={`${level} effort`}
                  autoComplete="off"
                  disabled={disabled || !active}
                  name={`pi_wire_${level}`}
                  placeholder={implicitWireValue(level)}
                  spellCheck={false}
                  value={reasoning.wireValues[level] ?? ''}
                  onChange={(event) =>
                    onReasoningChange({
                      ...reasoning,
                      wireValues: {
                        ...reasoning.wireValues,
                        [level]: event.target.value,
                      },
                    })
                  }
                />
              </div>
            );
          })}
        </div>
      ) : null}
      <label className="pi-reasoning-default">
        <span>{t('agents.piThinkingLevel')}</span>
        <AstryxSelect
          ariaLabel={t('agents.piThinkingLevel')}
          disabled={disabled || !reasoning.enabled}
          value={selectValue}
          options={availableLevels.map((level) => ({
            value: level,
            label: t(`agents.piThinking.${level}`),
          }))}
          onChange={onThinkingLevelChange}
        />
      </label>
    </div>
  );
}
