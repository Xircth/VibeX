import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BookOpenText,
  Eye,
  FileText,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { agentsApi } from '@/features/agents/api';
import type { AgentRegistryEntry, AgentType } from '@/features/agents/types';
import {
  skillsApi,
  type AgentSkillItem,
  type AgentSkillScope,
} from '@/lib/api';
import { cn } from '@/lib/utils';

const DEFAULT_TEMPLATE = `---
name: new-skill
description: 描述这个技能的用途与触发时机。
---

# 新技能

在这里编写技能内容（Markdown）。
`;

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

export function SkillsSettings() {
  const [agents, setAgents] = useState<AgentRegistryEntry[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentType | null>(null);
  const [scope, setScope] = useState<AgentSkillScope>('global');
  const [projectPath, setProjectPath] = useState('');
  const [search, setSearch] = useState('');

  const [skills, setSkills] = useState<AgentSkillItem[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [draftReadOnly, setDraftReadOnly] = useState(false);
  const [isDrafting, setIsDrafting] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const workspaceParam =
    scope === 'project' ? projectPath.trim() || null : null;
  const projectMissing = scope === 'project' && !projectPath.trim();

  useEffect(() => {
    let alive = true;
    void agentsApi
      .listRegistry()
      .then((entries) => {
        if (!alive) return;
        setAgents(entries);
        setSelectedAgent(
          (current) => current ?? entries[0]?.agent_type ?? null
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const loadSkills = useCallback(async () => {
    if (!selectedAgent || projectMissing) {
      setSkills([]);
      setListError(null);
      return;
    }
    setListLoading(true);
    setListError(null);
    try {
      const result = await skillsApi.list(selectedAgent, workspaceParam);
      setSkills(result.skills);
    } catch (error) {
      setSkills([]);
      setListError(error instanceof Error ? error.message : '加载技能失败');
    } finally {
      setListLoading(false);
    }
  }, [selectedAgent, workspaceParam, projectMissing]);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    setSelectedId(null);
    setIsDrafting(false);
    setDraftContent('');
    setDraftId('');
    setActionError(null);
    setPendingDelete(null);
  }, [selectedAgent, scope, projectPath]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return skills;
    return skills.filter(
      (skill) =>
        skill.id.toLowerCase().includes(query) ||
        (skill.description ?? '').toLowerCase().includes(query) ||
        skill.path.toLowerCase().includes(query)
    );
  }, [skills, search]);

  const openSkill = useCallback(
    async (skill: AgentSkillItem, edit: boolean) => {
      if (!selectedAgent) return;
      setSelectedId(skill.id);
      setIsDrafting(false);
      setActionError(null);
      setPendingDelete(null);
      setReading(true);
      try {
        const result = await skillsApi.read({
          agentType: selectedAgent,
          scope: skill.scope,
          skillId: skill.id,
          workspacePath: workspaceParam,
        });
        setDraftId(result.skill.id);
        setDraftContent(result.content);
        setDraftReadOnly(result.skill.read_only);
        setIsEditing(edit && !result.skill.read_only);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : '读取技能失败');
      } finally {
        setReading(false);
      }
    },
    [selectedAgent, workspaceParam]
  );

  const startCreate = useCallback(() => {
    setIsDrafting(true);
    setSelectedId(null);
    setDraftId('');
    setDraftContent(DEFAULT_TEMPLATE);
    setDraftReadOnly(false);
    setIsEditing(true);
    setActionError(null);
    setPendingDelete(null);
  }, []);

  const save = useCallback(async () => {
    if (!selectedAgent) return;
    const id = draftId.trim();
    if (!id) {
      setActionError('请填写技能名');
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      const saved = await skillsApi.save({
        agentType: selectedAgent,
        scope,
        skillId: id,
        content: draftContent,
        workspacePath: workspaceParam,
      });
      await loadSkills();
      setIsDrafting(false);
      setSelectedId(saved.id);
      setIsEditing(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '保存技能失败');
    } finally {
      setSaving(false);
    }
  }, [selectedAgent, scope, draftId, draftContent, workspaceParam, loadSkills]);

  const remove = useCallback(
    async (skill: AgentSkillItem) => {
      if (!selectedAgent) return;
      setActionError(null);
      try {
        await skillsApi.delete({
          agentType: selectedAgent,
          scope: skill.scope,
          skillId: skill.id,
          workspacePath: workspaceParam,
        });
        setPendingDelete(null);
        if (selectedId === skill.id) {
          setSelectedId(null);
          setDraftContent('');
          setDraftId('');
        }
        await loadSkills();
      } catch (error) {
        setActionError(error instanceof Error ? error.message : '删除技能失败');
      }
    },
    [selectedAgent, workspaceParam, selectedId, loadSkills]
  );

  const hasDetail = isDrafting || !!selectedId;
  const preview = useMemo(() => splitFrontmatter(draftContent), [draftContent]);

  return (
    <div className="flex h-full min-h-0 gap-4">
      {/* Master: agent + scope + skills list */}
      <aside className="flex w-72 shrink-0 flex-col gap-3">
        <div className="border bg-cardspace-y-3 rounded-xl p-3">
          <div className="flex flex-wrap gap-1">
            {agents.map((agent) => {
              const active = agent.agent_type === selectedAgent;
              return (
                <button
                  key={agent.agent_type}
                  type="button"
                  onClick={() => setSelectedAgent(agent.agent_type)}
                  className={cn(
                    'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                    active
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'border hover:bg-foreground/[0.06]'
                  )}
                >
                  {agent.name}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-1 rounded-lg border bg-muted-foreground/[0.06] p-0.5">
            {(['global', 'project'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setScope(value)}
                className={cn(
                  'flex-1 rounded-md py-1 text-xs font-medium transition-colors',
                  scope === value
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {value === 'global' ? '全局' : '项目'}
              </button>
            ))}
          </div>

          {scope === 'project' ? (
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">
                项目文件夹路径
              </Label>
              <Input
                value={projectPath}
                placeholder="例如 D:/code/my-project"
                className="h-8 text-xs"
                onChange={(event) => setProjectPath(event.target.value)}
              />
            </div>
          ) : null}

          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="搜索技能..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>

        <div className="border bg-cardflex min-h-0 flex-1 flex-col rounded-xl">
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {listLoading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                加载中…
              </div>
            ) : projectMissing ? (
              <p className="px-2 py-8 text-center text-xs text-muted-foreground">
                请输入项目文件夹路径以查看其技能。
              </p>
            ) : listError ? (
              <p className="px-2 py-6 text-center text-xs text-destructive">
                {listError}
              </p>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <BookOpenText className="h-6 w-6 text-muted-foreground/40" />
                <p className="text-xs text-muted-foreground">
                  {search ? '无匹配结果' : '暂无技能，点击“新建技能”创建。'}
                </p>
              </div>
            ) : (
              <div className="space-y-0.5">
                {filtered.map((skill) => (
                  <SkillRow
                    key={`${skill.scope}:${skill.id}`}
                    skill={skill}
                    selected={selectedId === skill.id && !isDrafting}
                    onSelect={() => void openSkill(skill, false)}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 border-t px-2 py-2">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              title="刷新"
              disabled={listLoading}
              onClick={() => void loadSkills()}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={!selectedAgent || projectMissing}
              onClick={startCreate}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              新建技能
            </Button>
          </div>
        </div>
      </aside>

      {/* Detail */}
      <section className="border bg-cardmin-w-0 flex-1 overflow-hidden rounded-xl">
        {!hasDetail ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-muted-foreground">
            <BookOpenText className="h-10 w-10 opacity-30" />
            <p className="mt-3 text-sm">选择左侧技能，或点击“新建技能”创建。</p>
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 pt-3">
              <div className="flex min-w-0 items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-[15px] font-semibold text-foreground">
                  {isDrafting ? '新建技能' : draftId}
                </span>
                {draftReadOnly ? (
                  <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-medium text-warning">
                    系统（只读）
                  </span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {!draftReadOnly ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={() => setIsEditing((value) => !value)}
                  >
                    {isEditing ? (
                      <Eye className="mr-1.5 h-3.5 w-3.5" />
                    ) : (
                      <Pencil className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    {isEditing ? '预览' : '编辑'}
                  </Button>
                ) : null}
                {!isDrafting && selectedId && !draftReadOnly ? (
                  pendingDelete === selectedId ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8"
                        onClick={() => setPendingDelete(null)}
                      >
                        取消
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-8"
                        onClick={() => {
                          const target = skills.find(
                            (item) => item.id === selectedId
                          );
                          if (target) void remove(target);
                        }}
                      >
                        <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                        确认删除
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8"
                      onClick={() => setPendingDelete(selectedId)}
                    >
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                      删除
                    </Button>
                  )
                ) : null}
                {!draftReadOnly ? (
                  <Button
                    size="sm"
                    className="h-8"
                    disabled={saving || reading}
                    onClick={() => void save()}
                  >
                    {saving ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Save className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    保存
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 pb-3.5 pt-3">
              {actionError ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {actionError}
                </div>
              ) : null}

              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">
                  技能名
                </Label>
                <Input
                  value={draftId}
                  placeholder="my-skill"
                  className="h-8 text-xs"
                  disabled={!isDrafting || draftReadOnly}
                  onChange={(event) => setDraftId(event.target.value)}
                />
                <p className="text-[11px] text-muted-foreground">
                  {isDrafting
                    ? '字母、数字、- _ . ；保存到当前作用域的技能目录。'
                    : '创建后不可重命名。'}
                </p>
              </div>

              {reading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  正在读取技能…
                </div>
              ) : isEditing ? (
                <Textarea
                  value={draftContent}
                  spellCheck={false}
                  className="min-h-80 font-mono text-xs"
                  placeholder={
                    '---\nname: ...\ndescription: ...\n---\n\n# 标题'
                  }
                  onChange={(event) => setDraftContent(event.target.value)}
                />
              ) : (
                <SkillPreview
                  frontmatter={preview.frontmatter}
                  body={preview.body}
                />
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function SkillRow({
  skill,
  selected,
  onSelect,
}: {
  skill: AgentSkillItem;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-left transition-colors',
        selected
          ? 'bg-primary text-primary-foreground'
          : 'hover:bg-foreground/[0.06]'
      )}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {skill.id}
        </span>
        <span
          className={cn(
            'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider',
            selected ? 'bg-white/20' : 'bg-muted text-muted-foreground'
          )}
        >
          {skill.scope === 'global' ? '全局' : '项目'}
        </span>
        {skill.read_only ? (
          <span
            className={cn(
              'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium',
              selected ? 'bg-white/20' : 'bg-warning/15 text-warning'
            )}
          >
            只读
          </span>
        ) : null}
      </div>
      <span
        className={cn(
          'line-clamp-1 text-[10px]',
          selected ? 'text-primary-foreground/75' : 'text-muted-foreground'
        )}
      >
        {skill.description?.trim() || skill.path}
      </span>
    </button>
  );
}

function SkillPreview({
  frontmatter,
  body,
}: {
  frontmatter: string | null;
  body: string;
}) {
  if (!frontmatter && !body.trim()) {
    return (
      <p className="text-xs text-muted-foreground">
        暂无内容，点击“编辑”开始编写。
      </p>
    );
  }
  return (
    <div className="space-y-3">
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
        <p className="text-xs text-muted-foreground">仅包含元数据。</p>
      )}
    </div>
  );
}
