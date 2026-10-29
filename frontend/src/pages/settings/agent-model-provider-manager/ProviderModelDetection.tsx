import { Loader2, ScanSearch } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentId, AgentModelCatalogView } from 'shared/types';

import { AstryxSelect } from '@/components/ui/astryx-select';
import { Button } from '@/components/ui/button';

import { CLAUDE_DETECTED_MODEL_TARGETS } from './constants';

export function ProviderModelDetection({
  agentId,
  catalog,
  claudeMappingTarget,
  disabled,
  error,
  loading,
  selectedIds,
  onDetect,
  onMappingTargetChange,
  onToggleModel,
  onToggleAll,
}: {
  agentId: AgentId;
  catalog: AgentModelCatalogView | null;
  claudeMappingTarget: string;
  disabled: boolean;
  error: string | null;
  loading: boolean;
  selectedIds: string[];
  onDetect: () => void;
  onMappingTargetChange: (value: string) => void;
  onToggleModel: (id: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
}) {
  const { t } = useTranslation('settings');
  const models = catalog?.models ?? [];
  const selected = new Set(selectedIds);
  const allSelected =
    models.length > 0 && models.every((item) => selected.has(item.id));
  return (
    <div className="agent-model-provider-detection">
      <div className="provider-detected-models-heading">
        <span className="provider-detected-models-title">
          {t('agents.providerDetectedModels')}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          aria-busy={loading}
          disabled={disabled || loading}
          onClick={onDetect}
        >
          {loading ? (
            <Loader2
              aria-hidden="true"
              className="mr-1.5 h-3.5 w-3.5 animate-spin"
            />
          ) : (
            <ScanSearch aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          )}
          {t('agents.providerDetectModels')}
        </Button>
        {loading ? (
          <p aria-live="polite">{t('agents.providerDetectingModels')}</p>
        ) : catalog ? (
          <p aria-live="polite">
            {models.length
              ? t('agents.providerDetectedModelCount', {
                  count: models.length,
                })
              : t('agents.providerDetectedModelsEmpty')}
          </p>
        ) : null}
        {models.length > 0 && agentId === 'claude_code' ? (
          <AstryxSelect
            ariaLabel={t('agents.providerDetectedMappingTargetAria')}
            disabled={disabled || loading}
            value={claudeMappingTarget}
            options={CLAUDE_DETECTED_MODEL_TARGETS.map(([key, labelKey]) => ({
              value: key,
              label: t(`agents.${labelKey}`),
            }))}
            onChange={onMappingTargetChange}
          />
        ) : null}
        {models.length > 0 ? (
          <div className="provider-detected-models-heading-actions">
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              disabled={disabled || loading || allSelected}
              onClick={() => onToggleAll(true)}
            >
              {t('agents.providerDetectedSelectAll')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              disabled={disabled || loading || selected.size === 0}
              onClick={() => onToggleAll(false)}
            >
              {t('agents.providerDetectedClear')}
            </Button>
          </div>
        ) : null}
      </div>
      {models.length > 0 ? (
        <div
          className="provider-detected-models"
          role="group"
          aria-label={t('agents.providerDetectedModels')}
        >
          {models.map((detected) => (
            <label key={detected.id}>
              <input
                type="checkbox"
                checked={selected.has(detected.id)}
                disabled={disabled || loading}
                name={`detected_model_${detected.id}`}
                onChange={(event) =>
                  onToggleModel(detected.id, event.target.checked)
                }
              />
              <span>
                <strong>{detected.label}</strong>
                {/* The id only adds information when it differs from the name. */}
                {detected.label === detected.id ? null : (
                  <code title={detected.id}>{detected.id}</code>
                )}
              </span>
            </label>
          ))}
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
