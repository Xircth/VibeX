import { ChevronDown, Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

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

function catalogTitle(template: ProviderCatalogTemplateView): string {
  return template.name.trim() || template.display_name?.trim() || template.id;
}

function matchesCatalogQuery(
  template: ProviderCatalogTemplateView,
  query: string
): boolean {
  return [
    catalogTitle(template),
    template.api_url,
    template.base_url,
    template.website_url,
  ].some((value) => value != null && value.toLowerCase().includes(query));
}

export function ProviderCatalogPicker({
  templates,
  generation,
  showCustomTile,
  disabled = false,
  onSelect,
}: ProviderCatalogPickerProps) {
  const { t } = useTranslation('settings');
  const listId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<
    ProviderCatalogTemplateView | 'custom' | null
  >(showCustomTile ? 'custom' : null);

  useEffect(() => {
    setQuery('');
    setSelected(showCustomTile ? 'custom' : null);
  }, [generation, showCustomTile]);

  const visibleTemplates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return templates;
    return templates.filter((template) =>
      matchesCatalogQuery(template, needle)
    );
  }, [query, templates]);

  const showSearch = templates.length > 0;
  const showEmpty =
    showSearch && visibleTemplates.length === 0 && query.trim().length > 0;
  const selectedLabel =
    selected === 'custom'
      ? t('agents.providerCatalogCustom')
      : selected
        ? catalogTitle(selected)
        : t('agents.providerCatalogChoose');

  const choose = (next: ProviderCatalogTemplateView | 'custom') => {
    setSelected(next);
    setOpen(false);
    setQuery('');
    onSelect(next);
  };

  return (
    <div className="agent-model-provider-catalog">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery('');
        }}
      >
        <PopoverTrigger asChild>
          <button
            aria-controls={open ? listId : undefined}
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-label={t('agents.providerCatalogChoose')}
            className="agent-model-provider-catalog-trigger"
            disabled={disabled}
            role="combobox"
            type="button"
          >
            <span className="agent-model-provider-catalog-trigger-label">
              {selectedLabel}
            </span>
            <ChevronDown
              aria-hidden="true"
              className="h-4 w-4 shrink-0 opacity-50"
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="agent-model-provider-catalog-popover tahoe-popover"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            searchRef.current?.focus();
          }}
          sideOffset={4}
        >
          {showSearch ? (
            <div className="agent-model-provider-catalog-search">
              <Search aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <input
                ref={searchRef}
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
            </div>
          ) : null}
          <ul
            aria-label={t('agents.providerCatalogChoose')}
            className="agent-model-provider-catalog-list"
            id={listId}
            role="listbox"
          >
            {showCustomTile ? (
              <li role="none">
                <button
                  aria-label={t('agents.providerCatalogCustom')}
                  aria-selected={selected === 'custom'}
                  className={cn(
                    'agent-model-provider-catalog-option',
                    selected === 'custom' && 'is-active'
                  )}
                  disabled={disabled}
                  role="option"
                  type="button"
                  onClick={() => choose('custom')}
                >
                  <strong>{t('agents.providerCatalogCustom')}</strong>
                </button>
              </li>
            ) : null}
            {visibleTemplates.map((template) => {
              const title = catalogTitle(template);
              const endpoint = catalogEndpoint(template);
              const source = template.plugin_label
                ? `${t('agents.providerCatalogSourcePlugin')} · ${template.plugin_label}`
                : t('agents.providerCatalogSourcePlugin');
              const active =
                selected !== 'custom' &&
                selected?.plugin_id === template.plugin_id &&
                selected?.id === template.id;
              return (
                <li key={`${template.plugin_id}:${template.id}`} role="none">
                  <button
                    aria-label={title}
                    aria-selected={active}
                    className={cn(
                      'agent-model-provider-catalog-option',
                      active && 'is-active'
                    )}
                    disabled={disabled}
                    role="option"
                    type="button"
                    onClick={() => choose(template)}
                  >
                    <strong>{title}</strong>
                    {endpoint ? (
                      <span className="agent-model-provider-catalog-endpoint">
                        {endpoint}
                      </span>
                    ) : null}
                    <span className="agent-model-provider-catalog-source">
                      {source}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {showEmpty ? (
            <p
              aria-live="polite"
              className="agent-model-provider-catalog-empty"
            >
              {t('agents.providerCatalogEmpty')}
            </p>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}
