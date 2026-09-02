import { Search, X } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { SETTINGS_SEARCH_ENTRIES } from './settingsSearchCatalog';
import { matchSettingsSearch } from './settingsSearchQuery';

type SettingsSearchProps = {
  query: string;
  onQueryChange: (query: string) => void;
  supports: (capability: string) => boolean;
  onSelect: (path: string, id: string) => void;
};

export function SettingsSearch({
  query,
  onQueryChange,
  supports,
  onSelect,
}: SettingsSearchProps) {
  const { t } = useTranslation('settings');
  const results = useMemo(() => {
    const visible = SETTINGS_SEARCH_ENTRIES.filter((entry) => {
      if (entry.anyOf) return entry.anyOf.some((cap) => supports(cap));
      return !entry.capability || supports(entry.capability);
    }).map((entry) => ({
      ...entry,
      label: t(entry.labelKey),
      group: t(`nav.${entry.groupKey}`),
    }));
    return matchSettingsSearch(visible, query);
  }, [query, supports, t]);

  return (
    <div className="settings-search">
      <div className="settings-search-field">
        <Search aria-hidden="true" className="settings-search-icon" />
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            if (query) onQueryChange('');
            else event.currentTarget.blur();
          }}
          placeholder={t('search.placeholder')}
          aria-label={t('search.aria')}
          autoComplete="off"
          spellCheck={false}
          className="settings-search-input"
        />
        {query ? (
          <button
            type="button"
            className="settings-search-clear"
            aria-label={t('search.clear')}
            onClick={() => onQueryChange('')}
          >
            <X aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {query.trim() ? (
        <ul className="settings-search-results" role="listbox">
          {results.length === 0 ? (
            <li className="settings-search-empty">{t('search.noResults')}</li>
          ) : (
            results.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className="settings-search-result"
                  aria-label={`${entry.label}, ${entry.group}`}
                  onClick={() => onSelect(entry.path, entry.id)}
                >
                  <span className="settings-search-result-label">
                    {entry.label}
                  </span>
                  <span className="settings-search-result-group">
                    {entry.group}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
