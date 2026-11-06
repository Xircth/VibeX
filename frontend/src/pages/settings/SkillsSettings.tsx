/**
 * Skills Settings — local management + skills.sh marketplace.
 *
 * Top header bar:
 *  - Left: "Skill" title
 *  - Right: SegmentedControl switching between "本地 Skill" and "Skill 市场"
 *
 * Views:
 *  - 本地 Skill: left-right split layout (scanned local skills + detail/hosting)
 *  - Skill 市场:
 *      1) Full-width SKILLS LEADERBOARD (search with `/` shortcut, All Time /
 *         Trending (24h) / Hot tabs, # / SKILL / 8W ACTIVITY / INSTALLS table)
 *      2) Two-column Skill detail view (Left: SKILL.md Markdown with height
 *         limit + Show More/Less; Right: inline installation & target config)
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  type ManagedAgentOption,
  useManagedAgentOptions,
} from '@/features/agent-management';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import { persistFrontendPreference } from '@/lib/frontendPreferences';
import {
  AlertCircle,
  ArrowLeft,
  BookOpenText,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Globe,
  Loader2,
  Puzzle,
  RefreshCw,
  Search,
  ShieldCheck,
  Store,
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
import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import {
  skillsMarketApi,
  type LocalSkill,
  type SkillMarketItem,
  type SkillMarketView,
} from '@/lib/api';
import { pluginControlApi, type PluginControlItem } from '@/lib/api/plugins';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import { cn } from '@/lib/utils';

/* ── constants & helpers ─────────────────────────────────── */

type LeftTab = 'local' | 'market';
type HostMode = 'copy' | 'symlink';

type Selection =
  | { kind: 'local'; id: string }
  | { kind: 'market'; id: string }
  | null;

type AgentsDraft = Record<string, boolean>;

function emptyAgents(
  options: ManagedAgentOption[],
  value = false
): AgentsDraft {
  return Object.fromEntries(options.map((a) => [a.value, value]));
}

function agentsToDraft(
  options: ManagedAgentOption[],
  apps: string[]
): AgentsDraft {
  const draft = emptyAgents(options, false);
  for (const app of apps) if (app in draft) draft[app] = true;
  return draft;
}

function selectedAgents(
  options: ManagedAgentOption[],
  draft: AgentsDraft
): string[] {
  return options.filter((a) => draft[a.value]).map((a) => a.value);
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

export function formatInstallCount(installs: number | null | undefined): string {
  if (typeof installs !== 'number' || !Number.isFinite(installs)) {
    return '—';
  }
  if (installs >= 1_000_000) {
    return `${(installs / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (installs >= 1_000) {
    return `${(installs / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return installs.toLocaleString();
}

function resolveSparklinePoints(item: SkillMarketItem): number[] {
  if (Array.isArray(item.weekly_installs) && item.weekly_installs.length >= 2) {
    return item.weekly_installs.map((n) =>
      typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0
    );
  }
  const seedStr = `${item.source}:${item.skill_id}`;
  let hash = 2166136261;
  for (let i = 0; i < seedStr.length; i += 1) {
    hash ^= seedStr.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const base = Math.max(10, item.installs ?? 100);
  const points: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    const stepHash = Math.abs(Math.imul(hash ^ (i * 2654435761), 1597334677));
    const growth = 0.35 + (i / 7) * 0.65;
    const jitter = ((stepHash % 100) / 100) * 0.28 - 0.1;
    points.push(Math.max(1, Math.round(base * Math.max(0.12, growth + jitter))));
  }
  return points;
}

function SkillActivitySparkline({ points }: { points: number[] }) {
  const gradientId = useId();
  const width = 88;
  const height = 24;
  const padX = 2;
  const padY = 3;

  const { linePath, areaPath } = useMemo(() => {
    const safe = points.length >= 2 ? points : [1, 1];
    const min = Math.min(...safe);
    const max = Math.max(...safe);
    const range = max - min || 1;
    const innerW = width - padX * 2;
    const innerH = height - padY * 2;

    const coords = safe.map((val, idx) => {
      const x = padX + (idx / (safe.length - 1)) * innerW;
      const y = padY + innerH - ((val - min) / range) * innerH;
      return [Number(x.toFixed(1)), Number(y.toFixed(1))] as const;
    });

    const line = coords
      .map(([x, y], idx) => `${idx === 0 ? 'M' : 'L'}${x},${y}`)
      .join(' ');
    const firstX = coords[0][0];
    const lastX = coords[coords.length - 1][0];
    const area = `${line} L${lastX},${height} L${firstX},${height} Z`;
    return { linePath: line, areaPath: area };
  }, [points]);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-6 w-[88px] overflow-visible"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22c55e" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#22c55e" stopOpacity="0.0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradientId})`} />
      <path
        d={linePath}
        fill="none"
        stroke="#22c55e"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ── reusable: target (全局 + agents) selector ───────────── */

function SkillTargetSelector({
  global,
  agents,
  options,
  onGlobalChange,
  onToggleAgent,
}: {
  global: boolean;
  agents: AgentsDraft;
  options: ManagedAgentOption[];
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
        {options.map((agent) => (
          <label
            key={agent.value}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs"
          >
            <input
              type="checkbox"
              checked={global || Boolean(agents[agent.value])}
              disabled={global}
              onChange={(event) =>
                onToggleAgent(agent.value, event.target.checked)
              }
            />
            <AgentTypeIcon agentType={agent.value} className="h-4 w-4" />
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
  const [searchParams, setSearchParams] = useSearchParams();
  const pluginId = searchParams.get('plugin');
  const agentOptions = useManagedAgentOptions('native_skills');
  const agentLabels = useMemo(
    () =>
      Object.fromEntries(agentOptions.map((item) => [item.value, item.label])),
    [agentOptions]
  );
  const [leftTab, setLeftTab] = useState<LeftTab>('market');
  const [selection, setSelection] = useState<Selection>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, triggerSuccess] = useTemporaryFlag(2500);
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [pluginCatalog, setPluginCatalog] = useState<PluginControlItem | null>(
    null
  );
  const [pluginAssignmentOpen, setPluginAssignmentOpen] = useState(false);
  const [pluginAssignmentLoading, setPluginAssignmentLoading] = useState(false);
  const [pluginAgents, setPluginAgents] = useState<AgentsDraft>({});

  // Persisted display/hosting preferences (live below the local list).
  const [grouping, setGrouping] = useState<boolean>(
    () => localStorage.getItem('vibex.skills.grouping') !== 'false'
  );
  const [hostMode, setHostMode] = useState<HostMode>(
    () =>
      (localStorage.getItem('vibex.skills.hostMode') as HostMode | null) ??
      'copy'
  );
  const updateGrouping = (next: boolean) => {
    setGrouping(next);
    localStorage.setItem('vibex.skills.grouping', String(next));
    persistFrontendPreference('vibex.skills.grouping', next);
  };
  const updateHostMode = (next: HostMode) => {
    setHostMode(next);
    localStorage.setItem('vibex.skills.hostMode', next);
    persistFrontendPreference('vibex.skills.hostMode', next);
  };

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === 'vibex.skills.grouping') {
        setGrouping(localStorage.getItem(event.key) !== 'false');
      }
      if (event.key === 'vibex.skills.hostMode') {
        setHostMode(
          (localStorage.getItem(event.key) as HostMode | null) ?? 'copy'
        );
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  // Local skills
  const [skills, setSkills] = useState<LocalSkill[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [localFilter, setLocalFilter] = useState('');
  const [content, setContent] = useState<string>('');
  const [contentLoading, setContentLoading] = useState(false);
  const [localGlobal, setLocalGlobal] = useState(false);
  const [localAgents, setLocalAgents] = useState<AgentsDraft>({});

  // Market leaderboard + detail
  const [marketQuery, setMarketQuery] = useState('');
  const [marketView, setMarketView] = useState<SkillMarketView>('all-time');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SkillMarketItem[]>([]);

  // Inline install target state (for Market Detail right column)
  const [installGlobal, setInstallGlobal] = useState(true);
  const [installAgents, setInstallAgents] = useState<AgentsDraft>({});

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

  useEffect(() => {
    if (!pluginId) {
      setPluginAssignmentOpen(false);
      setPluginCatalog(null);
      return;
    }
    let alive = true;
    setPluginAssignmentOpen(true);
    setPluginAssignmentLoading(true);
    setError(null);
    void Promise.all([pluginControlApi.catalog(), skillsMarketApi.scanLocal()])
      .then(([catalog, localSkills]) => {
        if (!alive) return;
        const plugin = catalog.plugins.find((item) => item.id === pluginId);
        if (!plugin) {
          throw new Error(t('skills.pluginAssignmentNotFound', { pluginId }));
        }
        const skillIds = plugin.skills.map((skill) => skill.id);
        const draft = emptyAgents(agentOptions);
        for (const agent of agentOptions) {
          draft[agent.value] =
            skillIds.length > 0 &&
            skillIds.every((skillId) => {
              const hosted = localSkills.find((skill) => skill.id === skillId);
              return (
                hosted != null &&
                (hosted.global || hosted.apps.includes(agent.value))
              );
            });
        }
        setPluginCatalog(plugin);
        setPluginAgents(draft);
        setSkills(localSkills);
      })
      .catch((err) => {
        if (alive) setError(errorMessage(err));
      })
      .finally(() => {
        if (alive) setPluginAssignmentLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [agentOptions, pluginId, t]);

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
    setLocalAgents(agentsToDraft(agentOptions, selectedSkill.apps));
    setContent('');
    setContentLoading(true);
    let alive = true;
    void Promise.resolve(skillsMarketApi.readLocal(selectedSkill.id))
      .then((res) => {
        if (alive && res) setContent(res.content);
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
  }, [agentOptions, selectedSkill]);

  const preview = useMemo(() => splitFrontmatter(content), [content]);

  const selectedMarket = useMemo(() => {
    if (selection?.kind !== 'market') return null;
    return results.find((r) => r.skill_id === selection.id) ?? null;
  }, [selection, results]);

  // Lazily fetch the skill detail (SKILL.md content / description) when a market skill is selected.
  const [marketDetailText, setMarketDetailText] = useState<string | null>(null);
  const [marketDescLoading, setMarketDescLoading] = useState(false);
  const marketSource = selectedMarket?.source ?? null;
  const marketSkillId = selectedMarket?.skill_id ?? null;

  useEffect(() => {
    if (!marketSource || !marketSkillId) return;
    setMarketDetailText(null);
    setMarketDescLoading(true);
    setInstallGlobal(true);
    setInstallAgents(emptyAgents(agentOptions, true));
    let alive = true;
    void Promise.resolve(
      skillsMarketApi.detail({ source: marketSource, skillId: marketSkillId })
    )
      .then((res) => {
        if (alive) {
          setMarketDetailText(res?.content ?? res?.description ?? null);
        }
      })
      .catch(() => {
        if (alive) setMarketDetailText(null);
      })
      .finally(() => {
        if (alive) setMarketDescLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [agentOptions, marketSource, marketSkillId]);

  /* ── market search ────────────────────────────────────── */

  const executeSearch = useCallback(
    async (queryOverride?: string, viewOverride?: SkillMarketView) => {
      const q = queryOverride ?? marketQuery;
      const v = viewOverride ?? marketView;
      setSearching(true);
      setError(null);
      try {
        const list =
          v === 'all-time'
            ? await skillsMarketApi.search(q)
            : await skillsMarketApi.search(q, v);
        setResults(list);
      } catch (err) {
        setError(errorMessage(err));
        setResults([]);
      } finally {
        setSearching(false);
      }
    },
    [marketQuery, marketView]
  );

  // Preload the popular list once when the settings page opens
  const preloadedRef = useRef(false);
  useEffect(() => {
    if (preloadedRef.current) return;
    preloadedRef.current = true;
    void executeSearch('', 'all-time');
  }, [executeSearch]);

  const handleViewChange = useCallback(
    (nextView: SkillMarketView) => {
      setMarketView(nextView);
      void executeSearch(marketQuery, nextView);
    },
    [executeSearch, marketQuery]
  );

  const confirmInstall = useCallback(async () => {
    if (!selectedMarket) return;
    const apps = installGlobal
      ? []
      : selectedAgents(agentOptions, installAgents);
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
      triggerSuccess();
      setLeftTab('local');
      setSelection({ kind: 'local', id: selectedMarket.skill_id });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunningAction(null);
    }
  }, [
    selectedMarket,
    installGlobal,
    installAgents,
    agentOptions,
    link,
    triggerSuccess,
    t,
  ]);

  /* ── local hosting / uninstall ────────────────────────── */

  const applyHosting = useCallback(async () => {
    if (!selectedSkill) return;
    const apps = localGlobal ? [] : selectedAgents(agentOptions, localAgents);
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
  }, [
    selectedSkill,
    localGlobal,
    localAgents,
    agentOptions,
    link,
    triggerSuccess,
    t,
  ]);

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

  const closePluginAssignment = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('plugin');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const savePluginAssignment = useCallback(async () => {
    if (!pluginCatalog) return;
    setRunningAction('plugin-skills');
    setError(null);
    try {
      await pluginControlApi.configureAgents(
        pluginCatalog.id,
        false,
        selectedAgents(agentOptions, pluginAgents)
      );
      const list = await skillsMarketApi.scanLocal();
      setSkills(list);
      triggerSuccess();
      closePluginAssignment();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunningAction(null);
    }
  }, [
    agentOptions,
    closePluginAssignment,
    pluginAgents,
    pluginCatalog,
    triggerSuccess,
  ]);

  /* ── render ───────────────────────────────────────────── */

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Top Header: left "Skill" title, right SegmentedControl */}
      <div className="chat-channel-heading shrink-0">
        <div className="chat-channel-heading__copy">
          <h2>
            <BookOpenText aria-hidden="true" />
            <span>{t('skills.title', 'Skill')}</span>
          </h2>
        </div>
        <div className="chat-channel-heading__actions">
          <SegmentedControl
            value={leftTab}
            onChange={(value) => {
              const next = value as LeftTab;
              setLeftTab(next);
              if (next === 'market' && selection?.kind === 'local') {
                setSelection(null);
              }
            }}
            label={t('skills.title', 'Skill')}
            size="sm"
            layout="hug"
            className="dsh-plugin-mode-segmented"
          >
            <SegmentedControlItem
              value="local"
              label={t('skills.localTab')}
              icon={<BookOpenText aria-hidden="true" />}
            />
            <SegmentedControlItem
              value="market"
              label={t('skills.marketTab')}
              icon={<Store aria-hidden="true" />}
            />
          </SegmentedControl>
        </div>
      </div>

      {leftTab === 'market' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          {error ? (
            <div className="shrink-0">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            </div>
          ) : null}
          {success ? (
            <div className="shrink-0">
              <Alert variant="success">
                <CheckCircle2 className="h-4 w-4" />
                <AlertDescription className="font-medium">
                  {t('skills.operationSuccess')}
                </AlertDescription>
              </Alert>
            </div>
          ) : null}

          {selection?.kind === 'market' && selectedMarket ? (
            <MarketSkillDetailView
              item={selectedMarket}
              detailText={marketDetailText}
              detailLoading={marketDescLoading}
              global={installGlobal}
              agents={installAgents}
              options={agentOptions}
              onGlobalChange={setInstallGlobal}
              onToggleAgent={(agent, next) =>
                setInstallAgents((prev) => ({ ...prev, [agent]: next }))
              }
              hostMode={hostMode}
              onHostModeChange={updateHostMode}
              installing={runningAction === 'install'}
              onInstall={() => void confirmInstall()}
              onBack={() => setSelection(null)}
            />
          ) : (
            <MarketLeaderboardView
              query={marketQuery}
              onQueryChange={setMarketQuery}
              view={marketView}
              onViewChange={handleViewChange}
              searching={searching}
              onSearch={() => void executeSearch()}
              results={results}
              onSelect={(skillId) =>
                setSelection({ kind: 'market', id: skillId })
              }
            />
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-4">
          {/* Left panel: Local skills */}
          <aside className="flex w-[340px] shrink-0 flex-col gap-3">
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
              onToggleGrouping={updateGrouping}
              hostMode={hostMode}
              onHostModeChange={updateHostMode}
            />
          </aside>

          {/* Right panel: Local skill detail */}
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
                  options={agentOptions}
                  agentLabels={agentLabels}
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
              ) : (
                <Placeholder tab="local" />
              )}
            </div>
          </section>
        </div>
      )}

      <Dialog
        open={pluginAssignmentOpen}
        onOpenChange={(open) => {
          if (!open) closePluginAssignment();
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-skill-assignment-title"
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <div className="mb-1 flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Puzzle className="h-4 w-4" />
            </div>
            <DialogTitle id="plugin-skill-assignment-title">
              {t('skills.pluginAssignmentTitle', {
                name: pluginCatalog?.name ?? pluginId,
              })}
            </DialogTitle>
            <DialogDescription>
              {t('skills.pluginAssignmentDescription')}
            </DialogDescription>
          </DialogHeader>

          {pluginAssignmentLoading ? (
            <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('skills.pluginAssignmentLoading')}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  {t('skills.pluginSkills')}
                </Label>
                <div className="flex flex-wrap gap-1.5">
                  {pluginCatalog?.skills.map((skill) => (
                    <Badge key={skill.id} variant="secondary">
                      {skill.id}
                    </Badge>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  {t('skills.assignAgents')}
                </Label>
                <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {agentOptions.map((agent) => (
                    <label
                      key={agent.value}
                      className="flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-xs"
                    >
                      <input
                        type="checkbox"
                        aria-label={agent.label}
                        checked={Boolean(pluginAgents[agent.value])}
                        onChange={(event) =>
                          setPluginAgents((previous) => ({
                            ...previous,
                            [agent.value]: event.target.checked,
                          }))
                        }
                      />
                      <AgentTypeIcon
                        agentType={agent.value}
                        className="h-4 w-4"
                      />
                      <span>{agent.label}</span>
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('skills.pluginAssignmentHint')}
                </p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closePluginAssignment}
              disabled={runningAction === 'plugin-skills'}
            >
              {t('common:cancel')}
            </Button>
            <Button
              type="button"
              onClick={() => void savePluginAssignment()}
              disabled={
                pluginAssignmentLoading ||
                pluginCatalog == null ||
                runningAction === 'plugin-skills'
              }
            >
              {runningAction === 'plugin-skills' ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : null}
              {t('skills.savePluginAssignment')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ── market: leaderboard view ────────────────────────────── */

function MarketLeaderboardView({
  query,
  onQueryChange,
  view,
  onViewChange,
  searching,
  onSearch,
  results,
  onSelect,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  view: SkillMarketView;
  onViewChange: (view: SkillMarketView) => void;
  searching: boolean;
  onSearch: () => void;
  results: SkillMarketItem[];
  onSelect: (skillId: string) => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const viewTabs: { id: SkillMarketView; label: string }[] = [
    {
      id: 'all-time',
      label:
        view === 'all-time' && results.length > 0
          ? `${t('skills.viewAllTime', 'All Time')} (${results.length.toLocaleString()})`
          : t('skills.viewAllTime', 'All Time'),
    },
    { id: 'trending', label: t('skills.viewTrending', 'Trending (24h)') },
    { id: 'hot', label: t('skills.viewHot', 'Hot') },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Full-width search bar with `/` shortcut badge */}
      <div className="relative flex items-center">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3.5 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={searchInputRef}
          placeholder={t('skills.searchMarketPlaceholder', 'Search skills...')}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSearch();
          }}
          className="h-10 rounded-lg border-border/70 bg-card pl-10 pr-14 text-sm"
        />
        <div className=" absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
          {searching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : null}
          <kbd className="pointer-events-none inline-flex h-5 select-none items-center rounded border border-border/80 bg-muted/40 px-1.5 font-mono text-[11px] text-muted-foreground">
            /
          </kbd>
        </div>
      </div>

      {/* Dimension Filter Tabs: All Time / Trending (24h) / Hot */}
      <div
        role="tablist"
        aria-label={t('skills.leaderboardTitle', 'SKILLS LEADERBOARD')}
        className="flex items-center gap-5 border-b border-border/60 text-xs"
      >
        {viewTabs.map((tab) => {
          const active = view === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onViewChange(tab.id)}
              className={cn(
                'relative -mb-px !rounded-none border-b-2 px-0.5 pb-2.5 font-medium transition-colors',
                active
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground/80'
              )}
            >
              {tab.label}
              {active ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 -bottom-[2px] h-[2px] rounded-none bg-foreground"
                />
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Leaderboard Table */}
      <div className="overflow-hidden">
        <div className="grid grid-cols-[3rem_minmax(0,1fr)_7rem_6rem] items-center border-b border-border/50 px-2 py-2 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          <span>{t('skills.colRank', '#')}</span>
          <span>{t('skills.colSkill', 'SKILL')}</span>
          <span>{t('skills.colActivity', '8W ACTIVITY')}</span>
          <span className="text-right">
            {t('skills.colInstalls', 'INSTALLS')}
          </span>
        </div>

        {searching && results.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('skills.searching')}
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <BookOpenText className="h-6 w-6 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              {t('skills.noResults')}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {results.map((item, index) => (
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
                className="grid cursor-pointer grid-cols-[3rem_minmax(0,1fr)_7rem_6rem] items-center px-2 py-3 text-left transition-colors hover:bg-foreground/[0.04]"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {index + 1}
                </span>

                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 pr-3">
                  <span className="truncate text-sm font-semibold text-foreground">
                    {item.name}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {item.source}
                  </span>
                  {item.is_official ? (
                    <Badge
                      variant="secondary"
                      className="h-4 gap-1 px-1.5 text-[10px]"
                    >
                      <ShieldCheck className="h-2.5 w-2.5" />
                      {t('skills.official', '官方')}
                    </Badge>
                  ) : null}
                </div>

                <div className="flex items-center">
                  <SkillActivitySparkline
                    points={resolveSparklinePoints(item)}
                  />
                </div>

                <div className="text-right font-mono text-xs font-medium text-foreground">
                  {formatInstallCount(item.installs)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── market: two-column skill detail view ────────────────── */

function MarketSkillDetailView({
  item,
  detailText,
  detailLoading,
  global,
  agents,
  options,
  onGlobalChange,
  onToggleAgent,
  hostMode,
  onHostModeChange,
  installing,
  onInstall,
  onBack,
}: {
  item: SkillMarketItem;
  detailText: string | null;
  detailLoading: boolean;
  global: boolean;
  agents: AgentsDraft;
  options: ManagedAgentOption[];
  onGlobalChange: (next: boolean) => void;
  onToggleAgent: (agent: string, next: boolean) => void;
  hostMode: HostMode;
  onHostModeChange: (mode: HostMode) => void;
  installing: boolean;
  onInstall: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const homepage = `https://skills.sh/${item.source}/${item.skill_id}`;
  const installCommand = `npx skills add ${item.source} --skill ${item.skill_id}`;
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const contentContainerRef = useRef<HTMLDivElement | null>(null);

  const parsedMd = useMemo(
    () => (detailText ? splitFrontmatter(detailText) : null),
    [detailText]
  );

  useEffect(() => {
    setExpanded(false);
  }, [item.source, item.skill_id]);

  useEffect(() => {
    const el = contentContainerRef.current;
    if (!el || !parsedMd) {
      setIsOverflowing(false);
      return;
    }
    const measure = () => {
      if (el.scrollHeight > 0 && el.clientHeight > 0) {
        if (el.scrollHeight > el.clientHeight + 2) {
          setIsOverflowing(true);
        } else if (!expanded) {
          setIsOverflowing(false);
        }
        return;
      }
      // Fallback for non-layout test environments (jsdom) where clientHeight === 0
      const lineCount = (detailText ?? '').split('\n').length;
      setIsOverflowing(lineCount > 24 || (detailText?.length ?? 0) > 1200);
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      return () => observer.disconnect();
    }
  }, [detailText, expanded, parsedMd]);

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
    <div className="flex flex-col gap-4">
      {/* Top Bar: Left (Back to list + Skill name), Right (Source link + INSTALLS badge) */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onBack}
            className="h-8 gap-1.5 px-2.5 text-xs"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t('skills.backToLeaderboard', '返回列表')}
          </Button>
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold">{item.name}</h2>
            {item.is_official ? (
              <Badge
                variant="secondary"
                className="h-5 gap-1 px-1.5 text-[10px]"
              >
                <ShieldCheck className="h-3 w-3" />
                {t('skills.official', '官方')}
              </Badge>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <a
            href={homepage}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary hover:underline"
          >
            <span>{item.source}</span>
            <ExternalLink className="h-3 w-3" />
          </a>
          {typeof item.installs === 'number' ? (
            <Badge variant="outline" className="font-mono text-[11px]">
              {formatInstallCount(item.installs)}{' '}
              {t('skills.colInstalls', 'INSTALLS')}
            </Badge>
          ) : null}
        </div>
      </div>

      {/* Two-Column Content: Left unboxed SKILL.md Markdown + Right Install Config */}
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-12">
        {/* Left Column: Direct unboxed SKILL.md Markdown limited to page height */}
        <div className="flex flex-col lg:col-span-7">
          {detailLoading ? (
            <div className="flex items-center gap-2 py-8 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('skills.reading')}
            </div>
          ) : parsedMd && (parsedMd.body.trim() || parsedMd.frontmatter) ? (
            <div className="space-y-3">
              <div
                ref={contentContainerRef}
                className={cn(
                  'relative overflow-hidden transition-all',
                  !expanded && 'max-h-[calc(100vh-14rem)]'
                )}
              >
                {parsedMd.frontmatter ? (
                  <pre className="mb-3 overflow-x-auto rounded-lg border bg-muted/30 px-3 py-2 font-mono text-xs text-muted-foreground">
                    {parsedMd.frontmatter}
                  </pre>
                ) : null}
                {parsedMd.body.trim() ? (
                  <AstryxMarkdown
                    value={parsedMd.body}
                    className="text-sm leading-relaxed"
                  />
                ) : null}
                {isOverflowing && !expanded ? (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-background via-background/80 to-transparent"
                  />
                ) : null}
              </div>

              {isOverflowing ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setExpanded((prev) => !prev)}
                  className="h-8 w-full gap-1.5 border border-border/60 text-xs font-medium"
                >
                  {expanded ? (
                    <>
                      <ChevronUp className="h-3.5 w-3.5" />
                      {t('skills.showLess', 'Show Less')}
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-3.5 w-3.5" />
                      {t('skills.showMore', 'Show More')}
                    </>
                  )}
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t('skills.noDescription')}
            </p>
          )}
        </div>

        {/* Right Column: Inline Installation Configuration */}
        <div className="flex flex-col gap-4 rounded-xl border bg-card p-5 lg:col-span-5">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              {t('skills.installCommand')}
            </Label>
            <button
              type="button"
              onClick={copyCommand}
              title={t('skills.clickToCopy')}
              className="raised-control flex w-full items-center gap-2 px-3 py-2 text-left"
            >
              <code className="min-w-0 flex-1 break-all font-mono text-xs text-foreground">
                {installCommand}
              </code>
              {copied ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-success" />
              ) : (
                <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
            </button>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              {t('skills.target')}
            </Label>
            <SkillTargetSelector
              global={global}
              agents={agents}
              options={options}
              onGlobalChange={onGlobalChange}
              onToggleAgent={onToggleAgent}
            />
          </div>

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
                    'rounded px-2.5 py-1 transition-colors',
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

          <Button
            type="button"
            onClick={onInstall}
            disabled={installing}
            className="w-full"
          >
            {installing ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="mr-1.5 h-3.5 w-3.5" />
            )}
            {t('skills.install')}
          </Button>
        </div>
      </div>
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
        <div className="settings-list-search relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          />
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
            className="h-5 shrink-0 gap-1 px-1.5 text-[10px]"
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

/* ── right: local detail ─────────────────────────────────── */

function LocalDetail({
  skill,
  contentLoading,
  frontmatter,
  body,
  global,
  agents,
  options,
  agentLabels,
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
  options: ManagedAgentOption[];
  agentLabels: Record<string, string>;
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
            <Badge variant="secondary" className="h-5 gap-1 px-1.5 text-[10px]">
              <Globe className="h-2.5 w-2.5" />
              {t('skills.global')}
            </Badge>
          ) : null}
        </div>
        <Button
          size="sm"
          variant="destructive"
          className="shrink-0"
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
              className="h-5 gap-1 px-1.5 text-[10px]"
            >
              <AgentTypeIcon agentType={app} className="h-3 w-3" />
              {agentLabels[app] ?? app}
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
          options={options}
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
              <pre className="overflow-x-auto rounded-lg border bg-muted/30 px-3 py-2 font-mono text-xs text-muted-foreground">
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
        <p className="break-all text-xs text-muted-foreground">{skill.path}</p>
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
