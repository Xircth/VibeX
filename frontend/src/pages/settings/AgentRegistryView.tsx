import { Loader2, RefreshCw, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentRegistryView,
  AgentRegistryViewRow,
  UserAgentDefinitionRequest,
} from 'shared/types';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { AgentManagementIcon } from './AgentManagementIcon';
import { UserAgentDefinitionEditor } from './UserAgentDefinitionEditor';

type AgentRegistryViewProps = {
  view: AgentRegistryView | null;
  loading: boolean;
  addingAgentId: string | null;
  onRefresh: () => void;
  onAdd: (row: AgentRegistryViewRow) => void;
  onAddUserDefinition: (request: UserAgentDefinitionRequest) => void;
};

export function AgentRegistryViewPanel({
  view,
  loading,
  addingAgentId,
  onRefresh,
  onAdd,
  onAddUserDefinition,
}: AgentRegistryViewProps) {
  const { t, i18n } = useTranslation('settings');
  const [source, setSource] = useState<'official' | 'manual'>('official');
  const [tab, setTab] = useState<'installed' | 'uninstalled'>('installed');
  const [query, setQuery] = useState('');
  const rows = useMemo(() => {
    const source = tab === 'installed' ? view?.installed : view?.uninstalled;
    const normalized = query.trim().toLocaleLowerCase();
    return [...(source ?? [])]
      .filter(
        (row) =>
          !normalized ||
          row.display_name.toLocaleLowerCase().includes(normalized) ||
          row.description.toLocaleLowerCase().includes(normalized) ||
          row.agent_id.toLocaleLowerCase().includes(normalized) ||
          row.registry_id?.toLocaleLowerCase().includes(normalized) ||
          row.authors.some((author) =>
            author.toLocaleLowerCase().includes(normalized)
          )
      )
      .sort((left, right) => {
        if (left.built_in !== right.built_in) {
          return left.built_in ? -1 : 1;
        }
        return (
          left.display_name.localeCompare(right.display_name) ||
          left.agent_id.localeCompare(right.agent_id)
        );
      });
  }, [query, tab, view]);

  return (
    <section aria-labelledby="agent-registry-title" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2
            className="text-base font-semibold text-foreground"
            id="agent-registry-title"
          >
            {t('agents.acpRegistry')}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('agents.registryDescription')}
          </p>
        </div>
        {source === 'official' ? (
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={loading}
            onClick={onRefresh}
          >
            {loading ? (
              <Loader2
                aria-hidden="true"
                className="mr-1.5 h-3.5 w-3.5 animate-spin"
              />
            ) : (
              <RefreshCw aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
            )}
            {t('agents.refresh')}
          </Button>
        ) : null}
      </div>

      <div
        aria-label={t('agents.agentSourceAria')}
        className="agent-registry-tabs w-fit"
        role="tablist"
      >
        <button
          type="button"
          aria-selected={source === 'official'}
          className={cn(
            'agent-registry-tab',
            source === 'official' && 'is-selected'
          )}
          role="tab"
          onClick={() => setSource('official')}
        >
          {t('agents.officialRegistry')}
        </button>
        <button
          type="button"
          aria-selected={source === 'manual'}
          className={cn(
            'agent-registry-tab',
            source === 'manual' && 'is-selected'
          )}
          role="tab"
          onClick={() => setSource('manual')}
        >
          {t('agents.manualAdd')}
        </button>
      </div>

      {source === 'manual' ? (
        <UserAgentDefinitionEditor
          currentPlatform={view?.current_platform ?? 'unknown'}
          loading={addingAgentId !== null}
          submitLabel={t('agents.addAndInstall')}
          onSubmit={onAddUserDefinition}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span
              aria-label={
                view?.fresh
                  ? t('agents.registrySnapshotFreshAria')
                  : t('agents.registrySnapshotStaleAria')
              }
              className={cn(
                'agent-registry-status',
                view?.fresh
                  ? 'settings-status-pill-success'
                  : 'settings-status-pill-warning'
              )}
              role="status"
            >
              {view?.fresh
                ? t('agents.snapshotFresh')
                : t('agents.offlineCache')}
            </span>
            <span>
              {view?.fetched_at
                ? t('agents.fetchedAt', {
                    time: new Date(view.fetched_at).toLocaleString(
                      i18n.language
                    ),
                  })
                : t('agents.noSuccessfulSnapshot')}
            </span>
            {view?.snapshot_id ? (
              <span className="font-mono">ID {view.snapshot_id}</span>
            ) : null}
            {view?.refresh_error ? (
              <span className="text-destructive">{view.refresh_error}</span>
            ) : null}
          </div>

          <div className="agent-registry-toolbar">
            <div
              aria-label={t('agents.registryCategoryAria')}
              className="agent-registry-tabs"
              role="tablist"
            >
              <button
                type="button"
                aria-selected={tab === 'installed'}
                className={cn(
                  'agent-registry-tab',
                  tab === 'installed' && 'is-selected'
                )}
                role="tab"
                onClick={() => setTab('installed')}
              >
                {t('agents.installedCount', {
                  count: view?.installed.length ?? 0,
                })}
              </button>
              <button
                type="button"
                aria-selected={tab === 'uninstalled'}
                className={cn(
                  'agent-registry-tab',
                  tab === 'uninstalled' && 'is-selected'
                )}
                role="tab"
                onClick={() => setTab('uninstalled')}
              >
                {t('agents.uninstalledCount', {
                  count: view?.uninstalled.length ?? 0,
                })}
              </button>
            </div>
            <label className="agent-registry-search">
              <Search aria-hidden="true" className="h-3.5 w-3.5" />
              <input
                aria-label={t('agents.searchAgentAria')}
                className="agent-registry-search-input"
                type="search"
                value={query}
                placeholder={t('agents.searchRegistryPlaceholder')}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>

          <ul className="settings-surface agent-registry-list">
            {rows.map((row) => (
              <li className="agent-registry-row" key={row.agent_id}>
                <div className="agent-registry-row-icon">
                  <AgentManagementIcon agent={row} className="h-6 w-6" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {row.display_name}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {row.version}
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {row.description}
                  </p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {[row.authors.join('、'), row.registry_id]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                {tab === 'uninstalled' ? (
                  <Button
                    size="sm"
                    className="h-8 shrink-0"
                    disabled={
                      !view?.fresh ||
                      !row.platform_supported ||
                      addingAgentId === row.agent_id
                    }
                    aria-label={t('agents.installAgentAria', {
                      agent: row.display_name,
                    })}
                    onClick={() => onAdd(row)}
                  >
                    {addingAgentId === row.agent_id ? (
                      <Loader2
                        aria-hidden="true"
                        className="mr-1.5 h-3.5 w-3.5 animate-spin"
                      />
                    ) : null}
                    {row.platform_supported
                      ? t('agents.fixInstall')
                      : t('agents.platformUnsupported')}
                  </Button>
                ) : (
                  <span
                    role="status"
                    className={cn(
                      'agent-registry-status',
                      row.installed
                        ? 'settings-status-pill-success'
                        : 'settings-status-pill-warning'
                    )}
                  >
                    {row.installed
                      ? t('agents.installed')
                      : t('agents.notInstalled')}
                  </span>
                )}
              </li>
            ))}
            {!loading && rows.length === 0 ? (
              <li className="px-4 py-10 text-center text-xs text-muted-foreground">
                {query
                  ? t('agents.noMatchingAgents')
                  : t('agents.noAgentsInCategory')}
              </li>
            ) : null}
          </ul>
        </>
      )}
    </section>
  );
}
