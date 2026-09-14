import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';

import type { ProviderCatalogTemplateView } from './providerCatalogTypes';

export type ProviderCatalogPickerProps = {
  templates: ProviderCatalogTemplateView[];
  generation: number;
  showCustomTile: boolean;
  disabled?: boolean;
  onSelect: (next: ProviderCatalogTemplateView | 'custom') => void;
};

function catalogEndpoint(
  template: ProviderCatalogTemplateView
): string | undefined {
  return template.api_url || template.base_url || undefined;
}

function matchesCatalogQuery(
  template: ProviderCatalogTemplateView,
  query: string
): boolean {
  return [
    template.name,
    template.api_url,
    template.base_url,
    template.website_url,
  ].some((value) => value != null && value.toLowerCase().includes(query));
}

function compareCatalogName(
  left: ProviderCatalogTemplateView,
  right: ProviderCatalogTemplateView
): number {
  return left.name.localeCompare(right.name, 'en');
}

export function ProviderCatalogPicker({
  templates,
  generation,
  showCustomTile,
  disabled = false,
  onSelect,
}: ProviderCatalogPickerProps) {
  const { t } = useTranslation('settings');
  const [query, setQuery] = useState('');
  const [sortByName, setSortByName] = useState(false);

  useEffect(() => {
    setQuery('');
    setSortByName(false);
  }, [generation]);

  const visibleTemplates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? templates.filter((template) => matchesCatalogQuery(template, needle))
      : templates;
    if (!sortByName) return filtered;
    return [...filtered].sort(compareCatalogName);
  }, [query, sortByName, templates]);

  const showToolbar = templates.length > 0;
  const showEmpty =
    showToolbar && visibleTemplates.length === 0 && query.trim().length > 0;

  return (
    <div className="agent-model-provider-catalog">
      {showToolbar ? (
        <div className="agent-model-provider-catalog-toolbar">
          <label className="agent-model-provider-catalog-search raised-control">
            <Search aria-hidden="true" className="h-3.5 w-3.5" />
            <span className="sr-only">{t('agents.providerCatalogSearch')}</span>
            <input
              aria-label={t('agents.providerCatalogSearch')}
              autoComplete="off"
              disabled={disabled}
              placeholder={t('agents.providerCatalogSearch')}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault();
              }}
            />
          </label>
          <Button
            aria-pressed={sortByName}
            className="agent-model-provider-catalog-sort h-8"
            disabled={disabled}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => setSortByName((current) => !current)}
          >
            {t('agents.providerCatalogSortName')}
          </Button>
        </div>
      ) : null}

      {showCustomTile || visibleTemplates.length > 0 ? (
        <ul className="agent-model-provider-catalog-grid">
          {showCustomTile ? (
            <li className="agent-model-provider-catalog-tile">
              <button
                aria-label={t('agents.providerCatalogCustom')}
                disabled={disabled}
                type="button"
                onClick={() => onSelect('custom')}
              >
                <strong>{t('agents.providerCatalogCustom')}</strong>
              </button>
            </li>
          ) : null}
          {visibleTemplates.map((template) => {
            const endpoint = catalogEndpoint(template);
            const source = template.plugin_label
              ? `${t('agents.providerCatalogSourcePlugin')} · ${template.plugin_label}`
              : t('agents.providerCatalogSourcePlugin');
            return (
              <li
                key={`${template.plugin_id}:${template.id}`}
                className="agent-model-provider-catalog-tile"
              >
                <button
                  aria-label={template.name}
                  disabled={disabled}
                  type="button"
                  onClick={() => onSelect(template)}
                >
                  <strong>{template.name}</strong>
                  {endpoint ? (
                    <span className="agent-model-provider-catalog-endpoint">
                      {endpoint}
                    </span>
                  ) : null}
                  <span className="agent-model-provider-catalog-source">
                    {source}
                  </span>
                </button>
                {template.website_url || template.api_key_url ? (
                  <div className="agent-model-provider-catalog-links">
                    {template.website_url ? (
                      <a
                        href={template.website_url}
                        rel="noopener noreferrer"
                        target="_blank"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {t('agents.providerCatalogWebsite')}
                      </a>
                    ) : null}
                    {template.api_key_url ? (
                      <a
                        href={template.api_key_url}
                        rel="noopener noreferrer"
                        target="_blank"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {t('agents.providerCatalogGetKey')}
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {showEmpty ? (
        <p aria-live="polite" className="agent-model-provider-catalog-empty">
          {t('agents.providerCatalogEmpty')}
        </p>
      ) : null}
    </div>
  );
}
