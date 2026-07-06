/**
 * Skills Settings — local management + skills.sh marketplace.
 *
 * Mirrors the MCP page: a "本地 Skill" view (scanned across every agent's skill
 * dirs + ~/.agents/skills + the global store ~/.vibex/skills, deduped by name
 * and optionally grouped by prefix) and a "Skill 市场" backed by skills.sh.
 *
 * Installing shells out to the `skills` CLI and then mirrors the skill into the
 * chosen targets — via symlink or file copy (configurable below the list).
 * "全局" hosting records the skill in ~/.vibex/skills and mirrors it into all
 * seven agents.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  BookOpenText,
  Check,
  CheckCircle2,
  Copy,
  Download,
  FileText,
  Globe,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AgentTypeIcon } from '@/components/agents/AgentTypeIcon';
import type { AgentType } from '@/features/agents/types';
import {
  skillsMarketApi,
  type LocalSkill,
  type SkillMarketItem,
} from '@/lib/api';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import { cn } from '@/lib/utils';

/* ── constants & helpers ─────────────────────────────────── */

type LeftTab = 'local' | 'market';
type HostMode = 'copy' | 'symlink';

type Selection =
  | { kind: 'local'; id: string }
  | { kind: 'market'; id: string }
  | null;

const AGENT_OPTIONS: { value: string; label: string }[] = [
  { value: 'claude_code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex CLI' },
  { value: 'gemini', label: 'Gemini CLI' },
  { value: 'openclaw', label: 'OpenClaw' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'cline', label: 'Cline' },
  { value: 'hermes', label: 'Hermes Agent' },
];

const AGENT_LABELS: Record<string, string> = Object.fromEntries(
  AGENT_OPTIONS.map((item) => [item.value, item.label])
);

type AgentsDraft = Record<string, boolean>;

function emptyAgents(value = false): AgentsDraft {
  return Object.fromEntries(AGENT_OPTIONS.map((a) => [a.value, value]));
}

function agentsToDraft(apps: string[]): AgentsDraft {
  const draft = emptyAgents(false);
  for (const app of apps) if (app in draft) draft[app] = true;
  return draft;
}

function selectedAgents(draft: AgentsDraft): string[] {
  return AGENT_OPTIONS.filter((a) => draft[a.value]).map((a) => a.value);
}

function splitFrontmatter(content: string): {
  frontmatter: string | null;
  body: string;
} {
  const trimmed = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  if (trimmed.startsWith('---')) {
    const rest = trimmed.slice(3);
    const end = rest.indexOf('\n---');
    if (end !== -1) {
      return {
        frontmatter: rest.slice(0, end).trim(),
        body: rest.slice(end + 4).replace(/^\n+/, ''),
      };
    }
  }
  return { frontmatter: null, body: content };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ── reusable: target (全局 + agents) selector ───────────── */

function SkillTargetSelector({
  global,
  agents,
  onGlobalChange,
  onToggleAgent,
}: {
  global: boolean;
  agents: AgentsDraft;
  onGlobalChange: (next: boolean) => void;
  onToggleAgent: (agent: string, next: boolean) => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  return (
    <div className="space-y-1.5">
      <label className="flex w-full cursor-pointer items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-2 text-xs">
        <input
          type="checkbox"
          checked={global}
          onChange={(event) => onGlobalChange(event.target.checked)}
        />
        <Globe className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium">{t('skills.global')}</span>
        <span className="text-muted-foreground">{t('skills.globalHint')}</span>
      </label>
      <div
        className={cn(
          'grid grid-cols-1 gap-1 sm:grid-cols-2',
          global && 'pointer-events-none opacity-50'
        )}
      >
        {AGENT_OPTIONS.map((agent) => (
          <label
            key={agent.value}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs"
          >
            <input
              type="checkbox"
              checked={global || agents[agent.value]}
              disabled={global}
              onChange={(event) =>
                onToggleAgent(agent.value, event.target.checked)
              }
            />
            <AgentTypeIcon
              agentType={agent.value as AgentType}
              className="h-4 w-4"
            />
            <span>{agent.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/* ── main component ──────────────────────────────────────── */

export function SkillsSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const [leftTab, setLeftTab] = useState<LeftTab>('local');
  const [selection, setSelection] = useState<Selection>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, triggerSuccess] = useTemporaryFlag(2500);
  const [runningAction, setRunningAction] = useState<string | null>(null);

  // Persisted display/hosting preferences (live below the local list).
  const [grouping, setGrouping] = useState<boolean>(
    () => localStorage.getItem('vibex.skills.grouping') !== 'false'
  );
  const [hostMode, setHostMode] = useState<HostMode>(
    () =>
      (localStorage.getItem('vibex.skills.hostMode') as HostMode | null) ??
      'copy'
  );
  useEffect(() => {
    localStorage.setItem('vibex.skills.grouping', String(grouping));
  }, [grouping]);
  useEffect(() => {
    localStorage.setItem('vibex.skills.hostMode', hostMode);
  }, [hostMode]);

  // Local skills
  const [skills, setSkills] = useState<LocalSkill[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [localFilter, setLocalFilter] = useState('');
  const [content, setContent] = useState<string>('');
  const [contentLoading, setContentLoading] = useState(false);
  const [localGlobal, setLocalGlobal] = useState(false);
  const [localAgents, setLocalAgents] = useState<AgentsDraft>(emptyAgents());

  // Market
  const [marketQuery, setMarketQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SkillMarketItem[]>([]);

  // Install dialog
  const [installOpen, setInstallOpen] = useState(false);
  const [installGlobal, setInstallGlobal] = useState(true);
  const [installAgents, setInstallAgents] = useState<AgentsDraft>(
    emptyAgents(true)
  );

  const link = hostMode === 'symlink';

  /* ── loaders ──────────────────────────────────────────── */

  const refreshLocal = useCallback(async (): Promise<LocalSkill[]> => {
    setLocalLoading(true);
    try {
      const list = await skillsMarketApi.scanLocal();
      setSkills(list);
      return list;
    } catch (err) {
      setError(errorMessage(err));
      return [];
    } finally {
      setLocalLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshLocal();
  }, [refreshLocal]);

  const filtered = useMemo(() => {
    const query = localFilter.trim().toLowerCase();
    if (!query) return skills;
    return skills.filter(
      (skill) =>
        skill.id.toLowerCase().includes(query) ||
        (skill.description ?? '').toLowerCase().includes(query) ||
        skill.group.toLowerCase().includes(query)
    );
  }, [skills, localFilter]);

  // Group filtered skills by prefix for grouped display.
  const groups = useMemo(() => {
    const map = new Map<string, LocalSkill[]>();
    for (const skill of filtered) {
      const list = map.get(skill.group) ?? [];
      list.push(skill);
      map.set(skill.group, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const selectedSkill = useMemo(() => {
    if (selection?.kind !== 'local') return null;
    return skills.find((s) => s.id === selection.id) ?? null;
  }, [selection, skills]);

  // Load content + hosting state when the selected skill changes.
  useEffect(() => {
    if (!selectedSkill) return;
    setLocalGlobal(selectedSkill.global);
    setLocalAgents(agentsToDraft(selectedSkill.apps));
    setContent('');
    setContentLoading(true);
    let alive = true;
    void skillsMarketApi
      .readLocal(selectedSkill.id)
      .then((res) => {
        if (alive) setContent(res.content);
      })
      .catch((err) => {
        if (alive) setError(errorMessage(err));
      })
      .finally(() => {
        if (alive) setContentLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selectedSkill]);

  const preview = useMemo(() => splitFrontmatter(content), [content]);

  const selectedMarket = useMemo(() => {
    if (selection?.kind !== 'market') return null;
    return results.find((r) => r.skill_id === selection.id) ?? null;
  }, [selection, results]);

  // Lazily fetch the skill description when a market skill is selected.
  const [marketDescription, setMarketDescription] = useState<string | null>(
    null
  );
  const [marketDescLoading, setMarketDescLoading] = useState(false);
  const marketSource = selectedMarket?.source ?? null;
  const marketSkillId = selectedMarket?.skill_id ?? null;
  useEffect(() => {
    if (!marketSource || !marketSkillId) return;
    setMarketDescription(null);
    setMarketDescLoading(true);
    let alive = true;
    void skillsMarketApi
      .detail({ source: marketSource, skillId: marketSkillId })
      .then((res) => {
        if (alive) setMarketDescription(res.description);
      })
      .catch(() => {
        if (alive) setMarketDescription(null);
      })
      .finally(() => {
        if (alive) setMarketDescLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [marketSource, marketSkillId]);

  /* ── market ───────────────────────────────────────────── */

  const executeSearch = useCallback(async () => {
    setSearching(true);
    setError(null);
    try {
      // An empty/short query returns the 50 most popular skills (the backend
      // scrapes the skills.sh leaderboard); ≥2 chars hits the search API.
      const list = await skillsMarketApi.search(marketQuery);
      setResults(list);
    } catch (err) {
      setError(errorMessage(err));
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [marketQuery]);

  // Preload the popular list once when the settings page opens (not when the
  // market tab is first shown), so switching to the market is instant.
  const preloadedRef = useRef(false);
  useEffect(() => {
    if (preloadedRef.current) return;
    preloadedRef.current = true;
    void executeSearch();
  }, [executeSearch]);

  const openInstall = useCallback(() => {
    setInstallGlobal(true);
    setInstallAgents(emptyAgents(true));
    setInstallOpen(true);
  }, []);

  const confirmInstall = useCallback(async () => {
    if (!selectedMarket) return;
    const apps = installGlobal ? [] : selectedAgents(installAgents);
    if (!installGlobal && apps.length === 0) {
      setError(t('skills.selectAgentError'));
      return;
    }
    setRunningAction('install');
    setError(null);
    try {
      const list = await skillsMarketApi.install({
        source: selectedMarket.source,
        skillId: selectedMarket.skill_id,
        global: installGlobal,
        apps,
        link,
      });
      setSkills(list);
      setInstallOpen(false);
      triggerSuccess();
      setLeftTab('local');
      setSelection({ kind: 'local', id: selectedMarket.skill_id });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunningAction(null);
    }
  }, [selectedMarket, installGlobal, installAgents, link, triggerSuccess, t]);

  /* ── local hosting / uninstall ────────────────────────── */

  const applyHosting = useCallback(async () => {
    if (!selectedSkill) return;
    const apps = localGlobal ? [] : selectedAgents(localAgents);
    if (!localGlobal && apps.length === 0) {
      setError(t('skills.selectAgentError'));
      return;
    }
    setRunningAction(`host:${selectedSkill.id}`);
    setError(null);
    try {
      const list = await skillsMarketApi.setHosting({
        skillId: selectedSkill.id,
        global: localGlobal,
        apps,
        link,
      });
      setSkills(list);
      triggerSuccess();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunningAction(null);
    }
  }, [selectedSkill, localGlobal, localAgents, link, triggerSuccess, t]);

  const uninstall = useCallback(
    async (skillId: string) => {
      setRunningAction(`uninstall:${skillId}`);
      setError(null);
      try {
        const list = await skillsMarketApi.uninstall(skillId);
        setSkills(list);
        if (selection?.kind === 'local' && selection.id === skillId) {
          setSelection(null);
        }
        triggerSuccess();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setRunningAction(null);
      }
    },
    [selection, triggerSuccess]
  );

  /* ── render ───────────────────────────────────────────── */

  return (
    <div className="flex h-full min-h-0 gap-4">
      {/* Left panel */}
      <aside className="flex w-[340px] shrink-0 flex-col gap-3">
        <div className="flex items-center gap-1 rounded-lg border bg-muted-foreground/[0.06] p-0.5">
          {(['local', 'market'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setLeftTab(tab)}
              className={cn(
                'flex-1 rounded-md py-1.5 text-xs font-medium transition-colors',
                leftTab === tab
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {tab === 'local' ? t('skills.localTab') : t('skills.marketTab')}
            </button>
          ))}
        </div>

        {leftTab === 'local' ? (
          <LocalListPanel
            groups={groups}
            count={filtered.length}
            grouping={grouping}
            loading={localLoading}
            filter={localFilter}
            onFilterChange={setLocalFilter}
            activeId={selection?.kind === 'local' ? selection.id : null}
            onSelect={(id) => setSelection({ kind: 'local', id })}
            onRefresh={() => void refreshLocal()}
            onToggleGrouping={setGrouping}
            hostMode={hostMode}
            onHostModeChange={setHostMode}
          />
        ) : (
          <MarketListPanel
            query={marketQuery}
            onQueryChange={setMarketQuery}
            searching={searching}
            onSearch={() => void executeSearch()}
            results={results}
            activeId={selection?.kind === 'market' ? selection.id : null}
            onSelect={(id) => setSelection({ kind: 'market', id })}
          />
        )}
      </aside>

      {/* Right panel */}
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
        {error ? (
          <div className="shrink-0 px-4 pt-4">
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        ) : null}
        {success ? (
          <div className="shrink-0 px-4 pt-4">
            <Alert variant="success">
              <CheckCircle2 className="h-4 w-4" />
              <AlertDescription className="font-medium">
                {t('skills.operationSuccess')}
              </AlertDescription>
            </Alert>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {selection?.kind === 'local' && selectedSkill ? (
            <LocalDetail
              skill={selectedSkill}
              contentLoading={contentLoading}
              frontmatter={preview.frontmatter}
              body={preview.body}
              global={localGlobal}
              agents={localAgents}
              onGlobalChange={setLocalGlobal}
              onToggleAgent={(agent, next) =>
                setLocalAgents((prev) => ({ ...prev, [agent]: next }))
              }
              hostMode={hostMode}
              applying={runningAction === `host:${selectedSkill.id}`}
              removing={runningAction === `uninstall:${selectedSkill.id}`}
              onApply={() => void applyHosting()}
              onUninstall={() => void uninstall(selectedSkill.id)}
            />
          ) : selection?.kind === 'market' && selectedMarket ? (
            <MarketDetail
              item={selectedMarket}
              description={marketDescription}
              descriptionLoading={marketDescLoading}
              onInstall={openInstall}
            />
          ) : (
            <Placeholder tab={leftTab} />
          )}
        </div>
      </section>

      {/* Install dialog */}
      <Dialog open={installOpen} onOpenChange={setInstallOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('skills.installTitle')}</DialogTitle>
            <DialogDescription>
              {selectedMarket
                ? t('skills.installDescription', {
                    name: selectedMarket.name,
                  })
                : t('skills.installDescriptionFallback')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {t('skills.target')}
              </Label>
              <SkillTargetSelector
                global={installGlobal}
                agents={installAgents}
                onGlobalChange={setInstallGlobal}
                onToggleAgent={(agent, next) =>
                  setInstallAgents((prev) => ({ ...prev, [agent]: next }))
                }
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t('skills.installHostModeHint', {
                mode:
                  hostMode === 'symlink'
                    ? t('skills.hostModeSymlink')
                    : t('skills.hostModeCopy'),
              })}
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setInstallOpen(false)}
              disabled={runningAction === 'install'}
            >
              {t('common:cancel')}
            </Button>
            <Button
              type="submit"
              onClick={() => void confirmInstall()}
              disabled={runningAction === 'install'}
            >
              {runningAction === 'install' ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : null}
              {t('skills.confirmInstall')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ── left: local list ────────────────────────────────────── */

function LocalListPanel({
  groups,
  count,
  grouping,
  loading,
  filter,
  onFilterChange,
  activeId,
  onSelect,
  onRefresh,
  onToggleGrouping,
  hostMode,
  onHostModeChange,
}: {
  groups: [string, LocalSkill[]][];
  count: number;
  grouping: boolean;
  loading: boolean;
  filter: string;
  onFilterChange: (value: string) => void;
  activeId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  onToggleGrouping: (next: boolean) => void;
  hostMode: HostMode;
  onHostModeChange: (mode: HostMode) => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const flat = groups.flatMap(([, items]) => items);

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-xl border bg-card">
      <div className="p-2.5">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t('skills.searchLocalPlaceholder')}
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('skills.loading')}
          </div>
        ) : count === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <BookOpenText className="h-6 w-6 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              {filter ? t('skills.noMatch') : t('skills.emptyLocal')}
            </p>
          </div>
        ) : grouping ? (
          <div className="flex flex-col gap-1">
            {groups.map(([group, items]) =>
              items.length > 1 ? (
                <div key={group} className="flex flex-col gap-1">
                  <div className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {group}
                    <span className="ml-1 font-normal opacity-60">
                      {items.length}
                    </span>
                  </div>
                  {items.map((skill) => (
                    <SkillRow
                      key={skill.id}
                      skill={skill}
                      indented
                      active={skill.id === activeId}
                      onSelect={() => onSelect(skill.id)}
                    />
                  ))}
                </div>
              ) : (
                <SkillRow
                  key={group}
                  skill={items[0]}
                  active={items[0].id === activeId}
                  onSelect={() => onSelect(items[0].id)}
                />
              )
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {flat.map((skill) => (
              <SkillRow
                key={skill.id}
                skill={skill}
                active={skill.id === activeId}
                onSelect={() => onSelect(skill.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Config controls (below the list) */}
      <div className="space-y-2 border-t p-2.5">
        <label className="flex cursor-pointer items-center justify-between text-xs">
          <span className="text-muted-foreground">
            {t('skills.groupDisplay')}
          </span>
          <input
            type="checkbox"
            checked={grouping}
            onChange={(event) => onToggleGrouping(event.target.checked)}
          />
        </label>
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="shrink-0 text-muted-foreground">
            {t('skills.hostModeLabel')}
          </span>
          <div className="flex items-center gap-0.5 rounded-md border bg-muted/20 p-0.5">
            {(['copy', 'symlink'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => onHostModeChange(mode)}
                className={cn(
                  'rounded px-2 py-0.5 transition-colors',
                  hostMode === mode
                    ? 'bg-card font-medium shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {mode === 'copy'
                  ? t('skills.hostModeCopy')
                  : t('skills.hostModeSymlink')}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">
            {t('skills.totalCount', { count })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            disabled={loading}
            onClick={onRefresh}
          >
            <RefreshCw className="mr-1 h-3.5 w-3.5" />
            {t('skills.refresh')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SkillRow({
  skill,
  active,
  indented,
  onSelect,
}: {
  skill: LocalSkill;
  active: boolean;
  indented?: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        '!my-0 !h-auto !min-h-0 block w-full rounded-lg border px-2.5 py-2 text-left transition-colors',
        indented && 'ml-1.5 w-[calc(100%-0.375rem)]',
        active
          ? 'border-primary/60 bg-primary/5'
          : 'border-transparent hover:bg-foreground/[0.05]'
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {skill.id}
        </span>
        {skill.global ? (
          <Badge
            variant="secondary"
            className="h-5 shrink-0 gap-1 px-1.5 text-[9px]"
          >
            <Globe className="h-2.5 w-2.5" />
            {t('skills.global')}
          </Badge>
        ) : (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {t('skills.agentCount', { count: skill.apps.length })}
          </span>
        )}
      </div>
      <p className="mt-1 line-clamp-1 text-[10px] leading-4 text-muted-foreground">
        {skill.description?.trim() || skill.path}
      </p>
    </button>
  );
}

/* ── left: market list ───────────────────────────────────── */

function MarketListPanel({
  query,
  onQueryChange,
  searching,
  onSearch,
  results,
  activeId,
  onSelect,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  searching: boolean;
  onSearch: () => void;
  results: SkillMarketItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-xl border bg-card">
      <div className="space-y-2 p-2.5">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Globe className="h-3.5 w-3.5" />
          {t('skills.source')}
        </div>
        <div className="flex gap-1.5">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t('skills.searchMarketPlaceholder')}
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onSearch();
              }}
              className="h-8 pl-8 text-xs"
            />
          </div>
          <Button
            size="sm"
            className="h-8 w-8 shrink-0 p-0"
            disabled={searching}
            onClick={onSearch}
          >
            {searching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-1.5">
        {searching ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('skills.searching')}
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <BookOpenText className="h-6 w-6 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              {t('skills.noResults')}
            </p>
          </div>
        ) : (
          results.map((item) => {
            const active = item.skill_id === activeId;
            return (
              <div
                key={`${item.source}:${item.skill_id}`}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(item.skill_id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(item.skill_id);
                  }
                }}
                className={cn(
                  'w-full cursor-pointer rounded-lg border px-2.5 py-2 text-left transition-colors',
                  active
                    ? 'border-primary/60 bg-primary/5'
                    : 'border-transparent hover:bg-foreground/[0.05]'
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                    {item.name}
                  </span>
                  {typeof item.installs === 'number' ? (
                    <Badge
                      variant="outline"
                      className="h-4 shrink-0 px-1.5 text-[9px]"
                    >
                      {t('skills.installs', { count: item.installs })}
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                  {item.source}
                </p>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ── right: local detail ─────────────────────────────────── */

function LocalDetail({
  skill,
  contentLoading,
  frontmatter,
  body,
  global,
  agents,
  onGlobalChange,
  onToggleAgent,
  hostMode,
  applying,
  removing,
  onApply,
  onUninstall,
}: {
  skill: LocalSkill;
  contentLoading: boolean;
  frontmatter: string | null;
  body: string;
  global: boolean;
  agents: AgentsDraft;
  onGlobalChange: (next: boolean) => void;
  onToggleAgent: (agent: string, next: boolean) => void;
  hostMode: HostMode;
  applying: boolean;
  removing: boolean;
  onApply: () => void;
  onUninstall: () => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-base font-semibold">{skill.id}</span>
          {skill.global ? (
            <Badge variant="secondary" className="h-5 gap-1 px-1.5 text-[9px]">
              <Globe className="h-2.5 w-2.5" />
              {t('skills.global')}
            </Badge>
          ) : null}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 text-destructive hover:text-destructive"
          disabled={removing}
          onClick={onUninstall}
        >
          {removing ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          )}
          {t('skills.uninstall')}
        </Button>
      </div>

      {skill.apps.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {skill.apps.map((app) => (
            <Badge
              key={app}
              variant="outline"
              className="h-5 gap-1 px-1.5 text-[9px]"
            >
              <AgentTypeIcon agentType={app as AgentType} className="h-3 w-3" />
              {AGENT_LABELS[app] ?? app}
            </Badge>
          ))}
        </div>
      ) : null}

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">
            {t('skills.hostTarget')}
          </Label>
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={applying}
            onClick={onApply}
          >
            {applying ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : null}
            {t('skills.applyWithMode', {
              mode:
                hostMode === 'symlink'
                  ? t('skills.hostModeSymlink')
                  : t('skills.hostModeCopyShort'),
            })}
          </Button>
        </div>
        <SkillTargetSelector
          global={global}
          agents={agents}
          onGlobalChange={onGlobalChange}
          onToggleAgent={onToggleAgent}
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          {t('skills.skillMdPreview')}
        </Label>
        {contentLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('skills.reading')}
          </div>
        ) : (
          <div className="space-y-2">
            {frontmatter ? (
              <pre className="overflow-x-auto rounded-lg border bg-muted/30 px-3 py-2 font-mono text-[11px] text-muted-foreground">
                {frontmatter}
              </pre>
            ) : null}
            {body.trim() ? (
              <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
                {body}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t('skills.onlyMetadata')}
              </p>
            )}
          </div>
        )}
        <p className="break-all text-[11px] text-muted-foreground">
          {skill.path}
        </p>
      </div>
    </div>
  );
}

/* ── right: market detail ────────────────────────────────── */

function MarketDetail({
  item,
  description,
  descriptionLoading,
  onInstall,
}: {
  item: SkillMarketItem;
  description: string | null;
  descriptionLoading: boolean;
  onInstall: () => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const homepage = `https://skills.sh/${item.source}/${item.skill_id}`;
  const installCommand = `npx skills add ${item.source} --skill ${item.skill_id}`;
  const [copied, setCopied] = useState(false);

  const copyCommand = useCallback(() => {
    void navigator.clipboard
      .writeText(installCommand)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, [installCommand]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-all text-base font-semibold">{item.name}</h2>
          <p className="mt-0.5 break-all text-xs text-muted-foreground">
            {item.source}
          </p>
        </div>
        <Button size="sm" className="shrink-0" onClick={onInstall}>
          <Download className="mr-1.5 h-3.5 w-3.5" />
          {t('skills.install')}
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {typeof item.installs === 'number' ? (
          <Badge variant="outline">
            {t('skills.installs', { count: item.installs })}
          </Badge>
        ) : null}
        <Badge variant="secondary">skills.sh</Badge>
      </div>

      {/* Description */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          {t('skills.description')}
        </Label>
        {descriptionLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('skills.reading')}
          </div>
        ) : description ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
            {description}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t('skills.noDescription')}
          </p>
        )}
      </div>

      <a
        href={homepage}
        target="_blank"
        rel="noreferrer"
        className="block break-all text-xs text-primary underline"
      >
        {homepage}
      </a>

      {/* Install command — label separate from the click-to-copy command. */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          {t('skills.installCommand')}
        </Label>
        <button
          type="button"
          onClick={copyCommand}
          title={t('skills.clickToCopy')}
          className="flex w-full items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2 text-left transition-colors hover:bg-muted/40"
        >
          <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-foreground">
            {installCommand}
          </code>
          {copied ? (
            <Check className="h-3.5 w-3.5 shrink-0 text-success" />
          ) : (
            <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
        </button>
      </div>
    </div>
  );
}

/* ── right: placeholder ──────────────────────────────────── */

function Placeholder({ tab }: { tab: LeftTab }) {
  const { t } = useTranslation(['settings', 'common']);
  return (
    <div className="flex h-full flex-col items-center justify-center text-center text-muted-foreground">
      <BookOpenText className="h-10 w-10 opacity-30" />
      <p className="mt-3 text-sm">
        {tab === 'local'
          ? t('skills.placeholderLocal')
          : t('skills.placeholderMarket')}
      </p>
    </div>
  );
}
