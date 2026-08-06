import { Database, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentId, AgentModelCatalogView } from 'shared/types';

import { Button } from '@/components/ui/button';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';

const MODEL_FIELDS: Partial<Record<AgentId, string>> = {
  codex: 'codex_model',
  cursor: 'cursor_model',
  kimi_code: 'kimi_model',
};

export function AgentModelCatalogControl({
  agentId,
  drafts,
  disabled,
  onSelect,
}: {
  agentId: AgentId;
  drafts: Record<string, string>;
  disabled: boolean;
  onSelect: (fieldId: string, value: string) => void;
}) {
  const { t } = useTranslation('settings');
  const fieldId = MODEL_FIELDS[agentId];
  const [catalog, setCatalog] = useState<AgentModelCatalogView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCatalog(null);
    setError(null);
  }, [agentId]);

  if (!fieldId) return null;

  const load = async (forceRefresh: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const result =
        agentId === 'codex'
          ? await agentManagementApi.codexModelCatalog(forceRefresh)
          : agentId === 'cursor'
            ? await agentManagementApi.cursorModelCatalog()
            : await agentManagementApi.kimiModelCatalog(
                drafts.kimi_base_url ?? '',
                drafts.kimi_api_key ?? ''
              );
      setCatalog(result);
      setError(result.error);
    } catch (cause) {
      setCatalog(null);
      setError(errorMessage(cause, t('agents.modelCatalogLoadFailed')));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="agent-model-catalog"
      aria-labelledby="agent-model-catalog-heading"
    >
      <div className="agent-model-catalog-copy">
        <Database aria-hidden="true" className="h-4 w-4" />
        <strong id="agent-model-catalog-heading">
          {t('agents.modelCatalog')}
        </strong>
      </div>
      <div className="agent-model-catalog-actions">
        {catalog?.models.length ? (
          <label>
            <span className="sr-only">{t('agents.selectCatalogModel')}</span>
            <select
              aria-label={t('agents.selectCatalogModel')}
              autoComplete="off"
              className="raised-control"
              disabled={disabled || loading}
              name={`${agentId}_catalog_model`}
              value={drafts[fieldId] ?? ''}
              onChange={(event) => onSelect(fieldId, event.target.value)}
            >
              <option value="">
                {t('agents.selectCatalogModelPlaceholder')}
              </option>
              {catalog.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label === model.id
                    ? model.id
                    : `${model.label} · ${model.id}`}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          disabled={disabled || loading}
          onClick={() => void load(catalog !== null)}
        >
          {loading ? (
            <Loader2
              aria-hidden="true"
              className="mr-1.5 h-3.5 w-3.5 animate-spin"
            />
          ) : (
            <RefreshCw aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          )}
          {catalog ? t('agents.refreshCatalog') : t('agents.loadModels')}
        </Button>
      </div>
      {catalog ? (
        <p className="agent-model-catalog-status" aria-live="polite">
          {t('agents.modelCount', { count: catalog.models.length })} ·{' '}
          {sourceLabel(t, catalog.source)}
          {catalog.default_model
            ? ` · ${t('agents.defaultModel', { model: catalog.default_model })}`
            : ''}
        </p>
      ) : null}
      {error ? (
        <p className="agent-model-catalog-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function sourceLabel(
  t: ReturnType<typeof useTranslation<'settings'>>['t'],
  source: AgentModelCatalogView['source']
) {
  switch (source) {
    case 'live':
      return t('agents.catalogSourceLive');
    case 'cache':
      return t('agents.catalogSourceCache');
    case 'unavailable':
      return t('agents.catalogSourceUnavailable');
  }
}
