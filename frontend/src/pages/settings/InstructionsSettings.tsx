import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  Loader2,
  MessageSquareText,
  Plus,
  RefreshCw,
  Save,
  Search,
  Store,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { AgentTypeIcon } from '@/components/agents/AgentTypeIcon';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import type { AgentType } from '@/features/agents/types';
import { cn } from '@/lib/utils';
import { instructionsApi, type Instruction } from '@/lib/api';
import { SettingsPageHeader } from './SettingsUi';

type LeftTab = 'local' | 'market';
type Selection =
  | { kind: 'local'; id: string }
  | { kind: 'market'; id: string }
  | { kind: 'new' }
  | null;

interface InstructionDraft {
  name: string;
  content: string;
  agentTypes: string[];
}

const AGENT_OPTIONS: { value: string; label: string }[] = [
  { value: 'claude_code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex CLI' },
  { value: 'gemini', label: 'Gemini CLI' },
  { value: 'openclaw', label: 'OpenClaw' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'cline', label: 'Cline' },
  { value: 'hermes', label: 'Hermes Agent' },
];

const ALL_AGENT_TYPES = AGENT_OPTIONS.map((agent) => agent.value);

function emptyDraft(): InstructionDraft {
  return {
    name: '',
    content: '',
    agentTypes: [...ALL_AGENT_TYPES],
  };
}

function draftFromInstruction(instruction: Instruction): InstructionDraft {
  return {
    name: instruction.name,
    content: instruction.content,
    agentTypes: instruction.agent_types.length
      ? instruction.agent_types
      : [...ALL_AGENT_TYPES],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateDraft(draft: InstructionDraft): string | null {
  if (!draft.name.trim()) return '请填写指令名称。';
  if (/\s/.test(draft.name.trim())) return '指令名称不能包含空格。';
  if (!draft.content.trim()) return '请填写指令内容。';
  if (draft.agentTypes.length === 0) return '请至少选择一个可用 Agent。';
  return null;
}

function AgentMultiSelect({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const allSelected = value.length === AGENT_OPTIONS.length;
  const label = allSelected ? '全部 Agent' : `${value.length} 个 Agent`;

  const toggleAgent = (agent: string, checked: boolean) => {
    if (checked) {
      onChange([...new Set([...value, agent])]);
    } else {
      onChange(value.filter((item) => item !== agent));
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" type="button" className="justify-between">
          <span>{label}</span>
          <ChevronDown className="ml-2 h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <div className="space-y-2">
          <div
            role="button"
            tabIndex={0}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => onChange([...ALL_AGENT_TYPES])}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onChange([...ALL_AGENT_TYPES]);
              }
            }}
          >
            <Checkbox checked={allSelected} className="pointer-events-none" />
            <span className="font-medium">全部 Agent</span>
          </div>

          <div className="h-px bg-border" />

          {AGENT_OPTIONS.map((agent) => {
            const checked = value.includes(agent.value);
            return (
              <div
                key={agent.value}
                role="button"
                tabIndex={0}
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => toggleAgent(agent.value, !checked)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    toggleAgent(agent.value, !checked);
                  }
                }}
              >
                <Checkbox checked={checked} className="pointer-events-none" />
                <AgentTypeIcon
                  agentType={agent.value as AgentType}
                  className="h-4 w-4"
                />
                <span>{agent.label}</span>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function InstructionsSettings() {
  const [leftTab, setLeftTab] = useState<LeftTab>('local');
  const [selection, setSelection] = useState<Selection>(null);
  const [localInstructions, setLocalInstructions] = useState<Instruction[]>([]);
  const [marketInstructions, setMarketInstructions] = useState<Instruction[]>(
    []
  );
  const [search, setSearch] = useState('');
  const [loadingLocal, setLoadingLocal] = useState(false);
  const [loadingMarket, setLoadingMarket] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<InstructionDraft>(() => emptyDraft());
  const [dirty, setDirty] = useState(false);

  const selectedLocal = useMemo(() => {
    if (selection?.kind !== 'local') return null;
    return localInstructions.find((item) => item.id === selection.id) ?? null;
  }, [selection, localInstructions]);

  const selectedMarket = useMemo(() => {
    if (selection?.kind !== 'market') return null;
    return marketInstructions.find((item) => item.id === selection.id) ?? null;
  }, [selection, marketInstructions]);

  const refreshLocal = useCallback(async () => {
    try {
      setLoadingLocal(true);
      const list = await instructionsApi.listLocal();
      setLocalInstructions(list);
      return list;
    } catch (error) {
      toast.error('指令列表加载失败', { description: errorMessage(error) });
      return [];
    } finally {
      setLoadingLocal(false);
    }
  }, []);

  const refreshMarket = useCallback(async () => {
    try {
      setLoadingMarket(true);
      setMarketInstructions(await instructionsApi.listOfficial());
    } catch (error) {
      toast.error('官方市场加载失败', { description: errorMessage(error) });
    } finally {
      setLoadingMarket(false);
    }
  }, []);

  useEffect(() => {
    void refreshLocal();
    void refreshMarket();
  }, [refreshLocal, refreshMarket]);

  const visibleLocal = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query || leftTab !== 'local') return localInstructions;
    return localInstructions.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        item.content.toLowerCase().includes(query)
    );
  }, [leftTab, localInstructions, search]);

  const visibleMarket = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query || leftTab !== 'market') return marketInstructions;
    return marketInstructions.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        item.content.toLowerCase().includes(query) ||
        (item.description ?? '').toLowerCase().includes(query)
    );
  }, [leftTab, marketInstructions, search]);

  const selectLocal = (instruction: Instruction) => {
    setSelection({ kind: 'local', id: instruction.id });
    setDraft(draftFromInstruction(instruction));
    setDirty(false);
  };

  const selectMarket = (instruction: Instruction) => {
    setSelection({ kind: 'market', id: instruction.id });
    setDraft(draftFromInstruction(instruction));
    setDirty(false);
  };

  const startNew = () => {
    setLeftTab('local');
    setSelection({ kind: 'new' });
    setDraft(emptyDraft());
    setDirty(true);
  };

  const updateDraft = (patch: Partial<InstructionDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setDirty(true);
  };

  const saveLocal = async () => {
    const validation = validateDraft(draft);
    if (validation) {
      toast.error(validation);
      return;
    }

    try {
      setSaving(true);
      let saved: Instruction;
      if (selection?.kind === 'local') {
        saved = await instructionsApi.update(selection.id, {
          name: draft.name.trim(),
          content: draft.content.trim(),
          agent_types: draft.agentTypes,
        });
      } else {
        saved = await instructionsApi.create({
          name: draft.name.trim(),
          content: draft.content.trim(),
          agent_types: draft.agentTypes,
        });
      }

      const list = await refreshLocal();
      setSelection({ kind: 'local', id: saved.id });
      setLocalInstructions(list);
      setDraft(draftFromInstruction(saved));
      setDirty(false);
      toast.success('指令已保存');
    } catch (error) {
      toast.error('保存指令失败', { description: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const installMarket = async () => {
    if (!selectedMarket) return;
    const validation = validateDraft(draft);
    if (validation) {
      toast.error(validation);
      return;
    }

    try {
      setSaving(true);
      const saved = await instructionsApi.create({
        name: draft.name.trim(),
        content: draft.content.trim(),
        agent_types: draft.agentTypes,
      });
      await refreshLocal();
      setLeftTab('local');
      setSelection({ kind: 'local', id: saved.id });
      setDraft(draftFromInstruction(saved));
      setDirty(false);
      toast.success('已配置到本地');
    } catch (error) {
      toast.error('配置官方指令失败', { description: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const deleteLocal = async () => {
    if (!selectedLocal) return;
    const result = await ConfirmDialog.show({
      title: `删除指令 #${selectedLocal.name}?`,
      message: '删除后，任务输入框中对应的 #tag_name 片段也会不可用。',
      confirmText: '删除',
      cancelText: '取消',
      variant: 'destructive',
    });
    if (result !== 'confirmed') return;

    try {
      setSaving(true);
      await instructionsApi.delete(selectedLocal.id);
      await refreshLocal();
      setSelection(null);
      setDraft(emptyDraft());
      setDirty(false);
      toast.success('指令已删除');
    } catch (error) {
      toast.error('删除指令失败', { description: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const renderList = () => {
    const loading = leftTab === 'local' ? loadingLocal : loadingMarket;
    const items = leftTab === 'local' ? visibleLocal : visibleMarket;
    const activeId =
      selection &&
      ((leftTab === 'local' && selection.kind === 'local') ||
        (leftTab === 'market' && selection.kind === 'market'))
        ? selection.id
        : null;

    if (loading) {
      return (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          加载中
        </div>
      );
    }

    if (items.length === 0) {
      return (
        <div className="settings-empty-state py-10 text-center">
          {leftTab === 'local' ? '暂无本地指令。' : '暂无官方指令。'}
        </div>
      );
    }

    return items.map((item) => {
      const active = item.id === activeId;
      return (
        <button
          key={`${leftTab}:${item.id}`}
          type="button"
          className={cn(
            'w-full rounded-md border px-3 py-2 text-left transition-colors',
            active
              ? 'border-primary/60 bg-primary/10'
              : 'border-transparent hover:bg-foreground/[0.05]'
          )}
          onClick={() =>
            leftTab === 'local' ? selectLocal(item) : selectMarket(item)
          }
        >
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              #{item.name}
            </span>
            {leftTab === 'market' ? (
              <Badge variant="secondary" className="h-5 text-[10px]">
                官方
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {item.description ?? item.content}
          </p>
        </button>
      );
    });
  };

  const editorTitle =
    selection?.kind === 'new'
      ? '新建指令'
      : selection?.kind === 'market'
        ? '官方指令'
        : selectedLocal
          ? `#${selectedLocal.name}`
          : '指令预览';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SettingsPageHeader
        title="指令"
        description="管理可通过 #tag_name 插入任务输入框的快捷指令。"
      />

      <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)] gap-4">
        <aside className="settings-surface flex min-h-0 flex-col rounded-lg">
          <div className="border-b p-3">
            <div className="grid grid-cols-2 gap-1 rounded-md border bg-muted-foreground/[0.06] p-0.5">
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  'h-8 text-xs',
                  leftTab === 'local' && 'bg-background shadow-sm'
                )}
                onClick={() => setLeftTab('local')}
              >
                本地
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  'h-8 text-xs',
                  leftTab === 'market' && 'bg-background shadow-sm'
                )}
                onClick={() => setLeftTab('market')}
              >
                官方市场
              </Button>
            </div>

            <div className="relative mt-3">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索指令"
                className="pl-8"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
            {renderList()}
          </div>

          {leftTab === 'local' ? (
            <div className="flex gap-2 border-t p-3">
              <Button
                variant="outline"
                size="icon"
                type="button"
                onClick={refreshLocal}
                disabled={loadingLocal}
                title="刷新"
              >
                <RefreshCw
                  className={cn('h-4 w-4', loadingLocal && 'animate-spin')}
                />
              </Button>
              <Button type="button" className="flex-1" onClick={startNew}>
                <Plus className="mr-2 h-4 w-4" />
                新建指令
              </Button>
            </div>
          ) : (
            <div className="flex gap-2 border-t p-3">
              <Button
                variant="outline"
                className="flex-1"
                type="button"
                onClick={refreshMarket}
                disabled={loadingMarket}
              >
                <Store className="mr-2 h-4 w-4" />
                刷新市场
              </Button>
            </div>
          )}
        </aside>

        <section className="settings-surface min-h-0 overflow-y-auto rounded-lg p-4">
          {!selection ? (
            <div className="flex h-full flex-col items-center justify-center text-center text-muted-foreground">
              <MessageSquareText className="h-10 w-10 opacity-35" />
              <p className="mt-3 text-sm">选择左侧指令进行预览或编辑。</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold">{editorTitle}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {selection.kind === 'market'
                      ? '可调整配置后写入本地。'
                      : '保存后可在任务输入框继续使用 #tag_name。'}
                  </p>
                </div>
                <div className="flex gap-2">
                  {selection.kind === 'local' ? (
                    <Button
                      variant="outline"
                      type="button"
                      onClick={deleteLocal}
                      disabled={saving}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      删除
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    onClick={
                      selection.kind === 'market' ? installMarket : saveLocal
                    }
                    disabled={saving || (!dirty && selection.kind === 'local')}
                  >
                    {saving ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="mr-2 h-4 w-4" />
                    )}
                    {selection.kind === 'market' ? '配置到本地' : '保存'}
                  </Button>
                </div>
              </div>

              <div className="grid gap-4">
                <div className="settings-row settings-row--stacked">
                  <div>
                    <Label>名称</Label>
                    <p className="settings-row__description">
                      对应任务输入框中的 #tag_name。
                    </p>
                  </div>
                  <Input
                    value={draft.name}
                    onChange={(event) =>
                      updateDraft({ name: event.target.value })
                    }
                    placeholder="review_changes"
                  />
                </div>

                <div className="settings-row settings-row--stacked">
                  <div>
                    <Label>可用 Agent</Label>
                    <p className="settings-row__description">
                      默认全部，也可限制到指定 Agent。
                    </p>
                  </div>
                  <AgentMultiSelect
                    value={draft.agentTypes}
                    onChange={(agentTypes) => updateDraft({ agentTypes })}
                  />
                </div>

                <div className="settings-row settings-row--stacked">
                  <div>
                    <Label>内容</Label>
                    <p className="settings-row__description">
                      插入指令时写入任务输入框的完整提示词。
                    </p>
                  </div>
                  <Textarea
                    value={draft.content}
                    onChange={(event) =>
                      updateDraft({ content: event.target.value })
                    }
                    rows={14}
                  />
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
