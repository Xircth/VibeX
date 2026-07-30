import { Loader2, RefreshCw, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AgentRegistryView, AgentRegistryViewRow } from 'shared/types';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { AgentManagementIcon } from './AgentManagementIcon';

type AgentRegistryViewProps = {
  view: AgentRegistryView | null;
  loading: boolean;
  addingAgentId: string | null;
  onRefresh: () => void;
  onAdd: (row: AgentRegistryViewRow) => void;
};

export function AgentRegistryViewPanel({
  view,
  loading,
  addingAgentId,
  onRefresh,
  onAdd,
}: AgentRegistryViewProps) {
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
          row.agent_id.toLocaleLowerCase().includes(normalized)
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
            className="text-[15px] font-semibold text-foreground"
            id="agent-registry-title"
          >
            ACP 注册表
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            从官方注册表添加 Agent；安装仍使用本地 Runtime 与本地 ACP。
          </p>
        </div>
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
          刷新
        </Button>
      </div>

      <div className="agent-registry-toolbar">
        <div
          aria-label="注册表分类"
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
            已安装 {view?.installed.length ?? 0}
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
            未安装 {view?.uninstalled.length ?? 0}
          </button>
        </div>
        <label className="agent-registry-search">
          <Search aria-hidden="true" className="h-3.5 w-3.5" />
          <input
            aria-label="搜索 Agent"
            className="agent-registry-search-input"
            type="search"
            value={query}
            placeholder="搜索名称或 Agent ID"
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
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {row.version}
                </span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                {row.description}
              </p>
            </div>
            {tab === 'uninstalled' ? (
              <Button
                size="sm"
                className="h-8 shrink-0"
                disabled={
                  !row.platform_supported || addingAgentId === row.agent_id
                }
                aria-label={`安装 ${row.display_name}`}
                onClick={() => onAdd(row)}
              >
                {addingAgentId === row.agent_id ? (
                  <Loader2
                    aria-hidden="true"
                    className="mr-1.5 h-3.5 w-3.5 animate-spin"
                  />
                ) : null}
                {row.platform_supported ? '安装' : '当前平台不支持'}
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
                {row.installed ? '已安装' : '未安装'}
              </span>
            )}
          </li>
        ))}
        {!loading && rows.length === 0 ? (
          <li className="px-4 py-10 text-center text-xs text-muted-foreground">
            {query ? '没有匹配的 Agent。' : '当前分类没有 Agent。'}
          </li>
        ) : null}
      </ul>
    </section>
  );
}
