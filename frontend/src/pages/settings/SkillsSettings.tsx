import { useEffect, useMemo, useState } from 'react';
import {
  BookOpenText,
  Bot,
  ChevronRight,
  Command,
  FileText,
  FolderSearch,
  Search,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { BaseCodingAgent, type ExecutorProfileId } from 'shared/types';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useUserSystem } from '@/components/ConfigProvider';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { skillsApi, type AgentLocalSkill } from '@/lib/api';

type SupportedAgent =
  | BaseCodingAgent.CLAUDE_CODE
  | BaseCodingAgent.CODEX
  | BaseCodingAgent.OPENCODE;

type CatalogItem =
  | {
      id: string;
      kind: 'local_skill';
      name: string;
      description: string | null;
      invocation: string;
      path: string;
    }
  | {
      id: string;
      kind: 'slash_command';
      name: string;
      description: string | null;
      invocation: string;
      isCustom: boolean;
    };

const SUPPORTED_AGENTS: Array<{
  value: SupportedAgent;
  label: string;
  description: string;
}> = [
  {
    value: BaseCodingAgent.CLAUDE_CODE,
    label: 'Claude Code',
    description: 'Slash commands and Claude skills',
  },
  {
    value: BaseCodingAgent.CODEX,
    label: 'Codex',
    description: 'Built-in commands and ~/.codex/skills',
  },
  {
    value: BaseCodingAgent.OPENCODE,
    label: 'OpenCode',
    description: 'Slash commands discovered from OpenCode',
  },
];

function getInitialAgent(
  executor: ExecutorProfileId | null | undefined
): SupportedAgent {
  if (
    executor?.executor === BaseCodingAgent.CLAUDE_CODE ||
    executor?.executor === BaseCodingAgent.CODEX ||
    executor?.executor === BaseCodingAgent.OPENCODE
  ) {
    return executor.executor;
  }

  return BaseCodingAgent.CLAUDE_CODE;
}

function isCustomSlashCommand(name: string): boolean {
  return name.includes(':') || name.includes('/');
}

function normalizeText(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

function buildSelectedProfile(agent: SupportedAgent): ExecutorProfileId {
  return {
    executor: agent,
    variant: null,
  };
}

function useAgentLocalSkills(agent: SupportedAgent) {
  const [skills, setSkills] = useState<AgentLocalSkill[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (agent !== BaseCodingAgent.CODEX) {
      setSkills([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    skillsApi
      .listLocal(agent)
      .then((data) => {
        if (!cancelled) {
          setSkills(data);
        }
      })
      .catch((error) => {
        console.error('Failed to list local agent skills:', error);
        if (!cancelled) {
          setSkills([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [agent]);

  return { skills, loading };
}

export function SkillsSettings() {
  const { config } = useUserSystem();
  const [selectedAgent, setSelectedAgent] = useState<SupportedAgent>(() =>
    getInitialAgent(config?.executor_profile)
  );
  const [search, setSearch] = useState('');
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<
    Record<'local' | 'customCommands' | 'builtinCommands', boolean>
  >({
    local: true,
    customCommands: true,
    builtinCommands: true,
  });

  const selectedProfile = useMemo(
    () => buildSelectedProfile(selectedAgent),
    [selectedAgent]
  );
  const { commands, discovering } = useSlashCommands(selectedProfile);
  const { skills: localSkills, loading: localSkillsLoading } =
    useAgentLocalSkills(selectedAgent);

  const catalogItems = useMemo<CatalogItem[]>(() => {
    const slashItems: CatalogItem[] = commands.map((command) => ({
      id: `slash:${command.name}`,
      kind: 'slash_command',
      name: command.name,
      description: command.description ?? null,
      invocation: `/${command.name}`,
      isCustom: isCustomSlashCommand(command.name),
    }));

    const localSkillItems: CatalogItem[] = localSkills.map((skill) => ({
      id: `skill:${skill.name}`,
      kind: 'local_skill',
      name: skill.name,
      description: skill.description,
      invocation: skill.invocation,
      path: skill.path,
    }));

    return [...localSkillItems, ...slashItems];
  }, [commands, localSkills]);

  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return catalogItems;
    }

    return catalogItems.filter((item) => {
      const haystacks = [
        item.name,
        item.description ?? '',
        item.invocation,
        item.kind === 'local_skill' ? item.path : '',
      ];

      return haystacks.some((value) => value.toLowerCase().includes(query));
    });
  }, [catalogItems, search]);

  const groups = useMemo(() => {
    const local = filteredItems.filter(
      (item): item is Extract<CatalogItem, { kind: 'local_skill' }> =>
        item.kind === 'local_skill'
    );
    const customCommands = filteredItems.filter(
      (item): item is Extract<CatalogItem, { kind: 'slash_command' }> =>
        item.kind === 'slash_command' && item.isCustom
    );
    const builtinCommands = filteredItems.filter(
      (item): item is Extract<CatalogItem, { kind: 'slash_command' }> =>
        item.kind === 'slash_command' && !item.isCustom
    );

    return { local, customCommands, builtinCommands };
  }, [filteredItems]);

  useEffect(() => {
    setSelectedItemId((current) => {
      if (current && catalogItems.some((item) => item.id === current)) {
        return current;
      }
      return catalogItems[0]?.id ?? null;
    });
  }, [catalogItems]);

  const selectedItem = useMemo(
    () => catalogItems.find((item) => item.id === selectedItemId) ?? null,
    [catalogItems, selectedItemId]
  );

  const isLoading = discovering || localSkillsLoading;

  return (
    <div className="flex h-full flex-1 overflow-hidden">
      <div className="flex h-full w-64 shrink-0 flex-col border-r">
        <div className="shrink-0 border-b px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">技能</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            按代理查看本地技能和可调用命令
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {SUPPORTED_AGENTS.map((agent) => (
              <Button
                key={agent.value}
                type="button"
                variant={selectedAgent === agent.value ? 'default' : 'outline'}
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setSelectedAgent(agent.value)}
                title={agent.description}
              >
                {agent.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="shrink-0 border-b px-3 py-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="搜索技能或命令..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-7 pl-8 text-xs"
            />
          </div>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-2 py-2">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
              <Sparkles className="h-4 w-4 animate-pulse" />
              <span className="text-xs">加载中...</span>
            </div>
          ) : null}

          {groups.local.length > 0 ? (
            <CatalogGroup
              groupKey="local"
              title="本地技能"
              icon={FolderSearch}
              items={groups.local}
              selectedItemId={selectedItemId}
              onSelect={setSelectedItemId}
              expanded={expandedGroups.local}
              onToggle={() =>
                setExpandedGroups((current) => ({
                  ...current,
                  local: !current.local,
                }))
              }
            />
          ) : null}

          {groups.customCommands.length > 0 ? (
            <CatalogGroup
              groupKey="customCommands"
              title="自定义命令"
              icon={Sparkles}
              items={groups.customCommands}
              selectedItemId={selectedItemId}
              onSelect={setSelectedItemId}
              expanded={expandedGroups.customCommands}
              onToggle={() =>
                setExpandedGroups((current) => ({
                  ...current,
                  customCommands: !current.customCommands,
                }))
              }
            />
          ) : null}

          {groups.builtinCommands.length > 0 ? (
            <CatalogGroup
              groupKey="builtinCommands"
              title="内置命令"
              icon={Terminal}
              items={groups.builtinCommands}
              selectedItemId={selectedItemId}
              onSelect={setSelectedItemId}
              expanded={expandedGroups.builtinCommands}
              onToggle={() =>
                setExpandedGroups((current) => ({
                  ...current,
                  builtinCommands: !current.builtinCommands,
                }))
              }
            />
          ) : null}

          {!isLoading && filteredItems.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <BookOpenText className="h-6 w-6 text-muted-foreground/40" />
              <p className="text-xs text-muted-foreground">
                {search ? '无匹配结果' : '无可用技能或命令'}
              </p>
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {selectedItem ? (
          <CatalogDetail item={selectedItem} agent={selectedAgent} />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center text-muted-foreground">
              <Bot className="mx-auto h-10 w-10 opacity-30" />
              <p className="mt-3 text-sm">选择一个技能或命令查看详情</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CatalogGroup({
  groupKey,
  title,
  icon: Icon,
  items,
  selectedItemId,
  onSelect,
  expanded,
  onToggle,
}: {
  groupKey: 'local' | 'customCommands' | 'builtinCommands';
  title: string;
  icon: typeof Sparkles;
  items: CatalogItem[];
  selectedItemId: string | null;
  onSelect: (id: string) => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-muted/40"
        aria-expanded={expanded}
        aria-controls={`skills-group-${groupKey}`}
      >
        <ChevronRight
          className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${
            expanded ? 'rotate-90' : ''
          }`}
        />
        <Icon className="h-3 w-3 text-muted-foreground" />
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {title} ({items.length})
        </span>
      </button>
      {expanded ? (
        <div id={`skills-group-${groupKey}`} className="space-y-0.5">
          {items.map((item) => (
            <CatalogListItem
              key={item.id}
              item={item}
              isSelected={selectedItemId === item.id}
              onSelect={() => onSelect(item.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CatalogListItem({
  item,
  isSelected,
  onSelect,
}: {
  item: CatalogItem;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-md px-2.5 py-1.5 text-left transition-colors ${
        isSelected
          ? 'bg-accent text-accent-foreground'
          : 'text-foreground hover:bg-muted/50'
      }`}
    >
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate font-mono text-[11px] font-medium">
          {item.invocation}
        </code>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
          {item.kind === 'local_skill' ? '技能' : '命令'}
        </span>
      </div>
      <p className="mt-0.5 line-clamp-1 text-[10px] text-muted-foreground">
        {normalizeText(item.description) || item.name}
      </p>
    </button>
  );
}

function CatalogDetail({
  item,
  agent,
}: {
  item: CatalogItem;
  agent: SupportedAgent;
}) {
  const agentLabel =
    SUPPORTED_AGENTS.find((entry) => entry.value === agent)?.label ?? agent;

  return (
    <div className="space-y-6 p-6">
      <div>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border bg-primary/5">
            {item.kind === 'local_skill' ? (
              <FolderSearch className="h-5 w-5 text-blue-500" />
            ) : (
              <Command className="h-5 w-5 text-muted-foreground" />
            )}
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground">
              {item.invocation}
            </h3>
            <span className="mt-0.5 inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {item.kind === 'local_skill' ? '本地技能' : '命令'}
            </span>
          </div>
        </div>
      </div>

      {normalizeText(item.description) ? (
        <div className="rounded-lg border bg-card p-4">
          <div className="mb-2 flex items-center gap-2">
            <FileText className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-foreground">描述</span>
          </div>
          <p className="text-sm leading-relaxed text-foreground">
            {item.description}
          </p>
        </div>
      ) : null}

      <div className="space-y-3 rounded-lg border bg-card p-4">
        <span className="text-xs font-medium text-foreground">元数据</span>
        <div className="grid grid-cols-2 gap-3">
          <MetaItem label="代理" value={agentLabel} />
          <MetaItem
            label="调用方式"
            value={item.kind === 'local_skill' ? '$调用技能' : '命令'}
          />
          <MetaItem label="调用前缀" value={item.invocation} />
          <MetaItem label="名称" value={item.name} />
          {item.kind === 'local_skill' ? (
            <MetaItem label="目录" value={item.path} fullWidth />
          ) : null}
        </div>
      </div>

      <div className="rounded-lg border bg-muted/30 p-4">
        <span className="text-xs font-medium text-foreground">使用方式</span>
        <div className="mt-2 rounded border bg-card px-3 py-2">
          <code className="text-xs text-foreground">{item.invocation}</code>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          {item.kind === 'local_skill'
            ? '在 Codex 输入框中以 $前缀调用该技能。'
            : '在支持命令的输入框中输入该命令即可调用。'}
        </p>
      </div>
    </div>
  );
}

function MetaItem({
  label,
  value,
  fullWidth = false,
}: {
  label: string;
  value: string;
  fullWidth?: boolean;
}) {
  return (
    <div className={`flex flex-col gap-0.5 ${fullWidth ? 'col-span-2' : ''}`}>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="break-all text-xs font-medium text-foreground">
        {value}
      </span>
    </div>
  );
}
