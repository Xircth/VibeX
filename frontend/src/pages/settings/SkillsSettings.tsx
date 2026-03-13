/**
 * Skills Settings page — dual-panel layout with popular skills carousel.
 *
 * Left panel: search + command list grouped by custom/builtin with badges.
 * Right panel: selected command detail OR popular skills carousel at the top.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BookOpenText,
  Check,
  Download,
  FileText,
  Hash,
  Loader2,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  Zap,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from '@/components/ui/carousel';
import { useUserSystem } from '@/components/ConfigProvider';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { skillsApi, type PopularSkill } from '@/lib/api';
import type { BaseCodingAgent } from 'shared/types';

/* ── helpers ─────────────────────────────────────────────── */

interface SlashCommand {
  name: string;
  description?: string | null;
}

function classifyCommand(cmd: SlashCommand): 'custom' | 'builtin' {
  return cmd.name.includes(':') || cmd.name.includes('/') ? 'custom' : 'builtin';
}

const CATEGORY_LABELS: Record<string, string> = {
  quality: '质量',
  git: 'Git',
  testing: '测试',
  docs: '文档',
  performance: '性能',
  security: '安全',
  architecture: '架构',
};

const ICON_MAP: Record<string, typeof ShieldCheck> = {
  'shield-check': ShieldCheck,
  'git-commit': Terminal,
  'test-tube': Zap,
  wand: Sparkles,
  'file-text': FileText,
  zap: Zap,
  lock: ShieldCheck,
  globe: Hash,
};

function SkillIcon({ icon, className }: { icon: string; className?: string }) {
  const Icon = ICON_MAP[icon] ?? Sparkles;
  return <Icon className={className} />;
}

/* ── hooks ───────────────────────────────────────────────── */

function usePopularSkills() {
  const [skills, setSkills] = useState<PopularSkill[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await skillsApi.getPopular();
      setSkills(data);
    } catch {
      // silently ignore — popular skills are optional
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { skills, loading, refresh };
}

/* ── main component ──────────────────────────────────────── */

export function SkillsSettings() {
  const { config } = useUserSystem();
  const defaultAgent = config?.executor_profile?.executor as
    | BaseCodingAgent
    | undefined;

  const { commands, discovering } = useSlashCommands(defaultAgent ?? null);
  const { skills: popularSkills, loading: skillsLoading, refresh: refreshSkills } = usePopularSkills();
  const [search, setSearch] = useState('');
  const [selectedCmd, setSelectedCmd] = useState<SlashCommand | null>(null);
  const [installingKey, setInstallingKey] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!search.trim()) return commands;
    const q = search.toLowerCase();
    return commands.filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(q) ||
        (cmd.description && cmd.description.toLowerCase().includes(q))
    );
  }, [commands, search]);

  const groups = useMemo(() => {
    const custom = filtered.filter((c) => classifyCommand(c) === 'custom');
    const builtin = filtered.filter((c) => classifyCommand(c) === 'builtin');
    return { custom, builtin };
  }, [filtered]);

  // auto-select first custom command (or first builtin if no custom)
  useEffect(() => {
    if (selectedCmd) return;
    const first = groups.custom[0] ?? groups.builtin[0] ?? null;
    if (first) setSelectedCmd(first);
  }, [groups, selectedCmd]);

  const handleInstall = useCallback(
    async (key: string) => {
      setInstallingKey(key);
      try {
        await skillsApi.install(key);
        await refreshSkills();
      } catch {
        // error handled silently
      } finally {
        setInstallingKey(null);
      }
    },
    [refreshSkills]
  );

  const handleUninstall = useCallback(
    async (key: string) => {
      setInstallingKey(key);
      try {
        await skillsApi.uninstall(key);
        await refreshSkills();
      } catch {
        // error handled silently
      } finally {
        setInstallingKey(null);
      }
    },
    [refreshSkills]
  );

  return (
    <div className="flex-1 overflow-hidden flex h-full">
      {/* ── Left Panel: Command List ──────────────────── */}
      <div className="w-56 shrink-0 flex h-full flex-col border-r">
        {/* Header */}
        <div className="shrink-0 border-b px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">技能与命令</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {defaultAgent
              ? `当前代理：${defaultAgent}`
              : '未配置默认代理'}
          </p>
        </div>

        {/* Search */}
        <div className="shrink-0 px-3 py-2 border-b">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="搜索命令..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-7 text-xs pl-8"
            />
          </div>
        </div>

        {/* Command List */}
        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-3">
          {discovering && (
            <div className="flex items-center gap-2 py-6 justify-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-xs">发现中...</span>
            </div>
          )}

          {!defaultAgent && !discovering && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <p className="text-xs text-amber-600 dark:text-amber-400">
                请在"代理"设置中选择默认代理。
              </p>
            </div>
          )}

          {/* Custom skills group */}
          {groups.custom.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 px-1 pb-1">
                <Sparkles className="h-3 w-3 text-muted-foreground" />
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  自定义技能 ({groups.custom.length})
                </span>
              </div>
              <div className="space-y-0.5">
                {groups.custom.map((cmd) => (
                  <CommandListItem
                    key={cmd.name}
                    cmd={cmd}
                    isSelected={selectedCmd?.name === cmd.name}
                    badge="custom"
                    onSelect={() => setSelectedCmd(cmd)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Built-in commands group */}
          {groups.builtin.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 px-1 pb-1">
                <Terminal className="h-3 w-3 text-muted-foreground" />
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  内置命令 ({groups.builtin.length})
                </span>
              </div>
              <div className="space-y-0.5">
                {groups.builtin.map((cmd) => (
                  <CommandListItem
                    key={cmd.name}
                    cmd={cmd}
                    isSelected={selectedCmd?.name === cmd.name}
                    badge="builtin"
                    onSelect={() => setSelectedCmd(cmd)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Empty */}
          {!discovering && defaultAgent && filtered.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <BookOpenText className="h-6 w-6 text-muted-foreground/40" />
              <p className="text-xs text-muted-foreground">
                {search ? '无匹配结果' : '无可用命令'}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── Right Panel: Detail + Popular Skills ─────── */}
      <div className="flex-1 min-w-0 flex h-full flex-col overflow-y-auto">
        {/* Popular Skills Carousel */}
        {!skillsLoading && popularSkills.length > 0 && (
          <PopularSkillsCarousel
            skills={popularSkills}
            installingKey={installingKey}
            onInstall={handleInstall}
            onUninstall={handleUninstall}
          />
        )}

        {/* Command Detail */}
        {selectedCmd ? (
          <CommandDetail cmd={selectedCmd} />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center text-muted-foreground">
              <Hash className="mx-auto h-10 w-10 opacity-30" />
              <p className="mt-3 text-sm">选择一个命令查看详情</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Popular Skills Carousel ────────────────────────────── */

function PopularSkillsCarousel({
  skills,
  installingKey,
  onInstall,
  onUninstall,
}: {
  skills: PopularSkill[];
  installingKey: string | null;
  onInstall: (key: string) => void;
  onUninstall: (key: string) => void;
}) {
  return (
    <div className="shrink-0 border-b px-6 py-4 space-y-2">
      <div className="flex items-center gap-2">
        <Download className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground">热门技能</span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        一键安装预配置的 Claude Code 技能到 ~/.claude/skills/ 目录。
      </p>
      <div className="relative overflow-hidden rounded-lg border bg-background">
        <Carousel className="w-full px-4 py-3">
          <CarouselContent>
            {skills.map((skill) => (
              <CarouselItem key={skill.key} className="sm:basis-1/3 lg:basis-1/4">
                <SkillCard
                  skill={skill}
                  isProcessing={installingKey === skill.key}
                  onInstall={() => onInstall(skill.key)}
                  onUninstall={() => onUninstall(skill.key)}
                />
              </CarouselItem>
            ))}
          </CarouselContent>
          <CarouselPrevious className="left-2 top-1/2 -translate-y-1/2 h-7 w-7 rounded-full border bg-background/80 shadow-sm backdrop-blur hover:bg-background" />
          <CarouselNext className="right-2 top-1/2 -translate-y-1/2 h-7 w-7 rounded-full border bg-background/80 shadow-sm backdrop-blur hover:bg-background" />
        </Carousel>
      </div>
    </div>
  );
}

function SkillCard({
  skill,
  isProcessing,
  onInstall,
  onUninstall,
}: {
  skill: PopularSkill;
  isProcessing: boolean;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  const categoryLabel = CATEGORY_LABELS[skill.category] ?? skill.category;

  return (
    <div className="group w-full text-left">
      <Card className="h-32 rounded-lg border hover:shadow-md transition relative overflow-hidden">
        <CardHeader className="pb-0 px-3 pt-3">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded border bg-muted grid place-items-center overflow-hidden shrink-0">
              <SkillIcon icon={skill.icon} className="w-3 h-3 text-muted-foreground" />
            </div>
            <CardTitle className="text-xs font-medium truncate flex-1">
              {skill.name}
            </CardTitle>
            {/* Install/Uninstall button */}
            {isProcessing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />
            ) : skill.installed ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onUninstall();
                }}
                className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                title="卸载技能"
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive hover:text-destructive/80" />
              </button>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onInstall();
                }}
                className="shrink-0"
                title="安装技能"
              >
                <Download className="h-3.5 w-3.5 text-blue-500 hover:text-blue-400" />
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-1.5 px-3 pb-3">
          <p className="text-[10px] text-muted-foreground line-clamp-2">
            {skill.description}
          </p>
          <div className="flex items-center gap-1.5 mt-2">
            <span className="rounded px-1.5 py-0.5 text-[9px] font-medium bg-muted text-muted-foreground">
              {categoryLabel}
            </span>
            {skill.installed && (
              <span className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium bg-green-500/10 text-green-600 dark:text-green-400">
                <Check className="h-2.5 w-2.5" />
                已安装
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ── sub-components ──────────────────────────────────────── */

function CommandListItem({
  cmd,
  isSelected,
  badge,
  onSelect,
}: {
  cmd: SlashCommand;
  isSelected: boolean;
  badge: 'custom' | 'builtin';
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`
        w-full text-left rounded-md px-2.5 py-1.5 transition-colors
        ${
          isSelected
            ? 'bg-accent text-accent-foreground'
            : 'hover:bg-muted/50 text-foreground'
        }
      `}
    >
      <div className="flex items-center gap-2">
        <code className="text-[11px] font-mono font-medium truncate flex-1">
          /{cmd.name}
        </code>
        <span
          className={`
            shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider
            ${
              badge === 'custom'
                ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                : 'bg-muted text-muted-foreground'
            }
          `}
        >
          {badge === 'custom' ? '自定义' : '内置'}
        </span>
      </div>
      {cmd.description && (
        <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1">
          {cmd.description}
        </p>
      )}
    </button>
  );
}

function CommandDetail({ cmd }: { cmd: SlashCommand }) {
  const isCustom = classifyCommand(cmd) === 'custom';
  const parts = cmd.name.split(':');

  return (
    <div className="p-6 space-y-6">
      {/* Title */}
      <div>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/5 border">
            {isCustom ? (
              <Sparkles className="h-5 w-5 text-blue-500" />
            ) : (
              <Terminal className="h-5 w-5 text-muted-foreground" />
            )}
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground">
              /{cmd.name}
            </h3>
            <span
              className={`
                inline-block mt-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider
                ${
                  isCustom
                    ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                    : 'bg-muted text-muted-foreground'
                }
              `}
            >
              {isCustom ? '自定义技能' : '内置命令'}
            </span>
          </div>
        </div>
      </div>

      {/* Description */}
      {cmd.description && (
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <FileText className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-foreground">描述</span>
          </div>
          <p className="text-sm text-foreground leading-relaxed">
            {cmd.description}
          </p>
        </div>
      )}

      {/* Metadata */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <span className="text-xs font-medium text-foreground">元数据</span>
        <div className="grid grid-cols-2 gap-3">
          <MetaItem label="类型" value={isCustom ? '自定义' : '内置'} />
          <MetaItem label="命令名" value={`/${cmd.name}`} />
          {isCustom && parts.length >= 2 && (
            <>
              <MetaItem label="来源" value={parts[0]} />
              <MetaItem label="技能" value={parts.slice(1).join(':')} />
            </>
          )}
        </div>
      </div>

      {/* Usage hint */}
      <div className="rounded-lg border bg-muted/30 p-4">
        <span className="text-xs font-medium text-foreground">使用方式</span>
        <div className="mt-2 rounded bg-card border px-3 py-2">
          <code className="text-xs font-mono text-foreground">
            /{cmd.name}
            {cmd.description && (
              <span className="text-muted-foreground"> [参数]</span>
            )}
          </code>
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">
          在 AI 对话输入框中输入上述命令即可调用。
        </p>
      </div>
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
      <span className="text-xs font-medium text-foreground">{value}</span>
    </div>
  );
}
