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
import { useTranslation } from 'react-i18next';

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

// Returns an i18n key (resolved by the caller via `t`) or null when valid.
function validateDraft(draft: InstructionDraft): string | null {
  if (!draft.name.trim()) return 'instructions.nameRequired';
  if (/\s/.test(draft.name.trim())) return 'instructions.nameNoSpaces';
  if (!draft.content.trim()) return 'instructions.contentRequired';
  if (draft.agentTypes.length === 0) return 'instructions.agentRequired';
  return null;
}

function AgentMultiSelect({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const allSelected = value.length === AGENT_OPTIONS.length;
  const label = allSelected
    ? t('instructions.allAgents')
    : t('instructions.agentCount', { count: value.length });

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
            <span className="font-medium">{t('instructions.allAgents')}</span>
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
  const { t } = useTranslation(['settings', 'common']);
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
      toast.error(t('instructions.loadListFailed'), {
        description: errorMessage(error),
      });
      return [];
    } finally {
      setLoadingLocal(false);
    }
  }, [t]);

  const refreshMarket = useCallback(async () => {
    try {
      setLoadingMarket(true);
      setMarketInstructions(await instructionsApi.listOfficial());
    } catch (error) {
      toast.error(t('instructions.loadMarketFailed'), {
        description: errorMessage(error),
      });
    } finally {
      setLoadingMarket(false);
    }
  }, [t]);

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
      toast.error(t(validation));
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
      toast.success(t('instructions.saved'));
    } catch (error) {
      toast.error(t('instructions.saveFailed'), {
        description: errorMessage(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const installMarket = async () => {
    if (!selectedMarket) return;
    const validation = validateDraft(draft);
    if (validation) {
      toast.error(t(validation));
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
      toast.success(t('instructions.installedToLocal'));
    } catch (error) {
      toast.error(t('instructions.installFailed'), {
        description: errorMessage(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const deleteLocal = async () => {
    if (!selectedLocal) return;
    const result = await ConfirmDialog.show({
      title: t('instructions.deleteConfirmTitle', { name: selectedLocal.name }),
      message: t('instructions.deleteConfirmMessage'),
      confirmText: t('common:delete'),
      cancelText: t('common:cancel'),
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
      toast.success(t('instructions.deleted'));
    } catch (error) {
      toast.error(t('instructions.deleteFailed'), {
        description: errorMessage(error),
      });
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
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('instructions.loading')}
        </div>
      );
    }

    if (items.length === 0) {
      return (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <MessageSquareText className="h-6 w-6 text-muted-foreground/40" />
          <p className="text-xs text-muted-foreground">
            {leftTab === 'local'
              ? t('instructions.emptyLocal')
              : t('instructions.emptyMarket')}
          </p>
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
            'w-full rounded-lg border px-2.5 py-2 text-left transition-colors',
            active
              ? 'border-primary/60 bg-primary/5'
              : 'border-transparent hover:bg-foreground/[0.05]'
          )}
          onClick={() =>
            leftTab === 'local' ? selectLocal(item) : selectMarket(item)
          }
        >
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
              #{item.name}
            </span>
            {leftTab === 'market' ? (
              <Badge
                variant="secondary"
                className="h-5 shrink-0 px-1.5 text-[9px]"
              >
                {t('instructions.officialBadge')}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 line-clamp-1 text-[10px] leading-4 text-muted-foreground">
            {item.description ?? item.content}
          </p>
        </button>
      );
    });
  };

  const editorTitle =
    selection?.kind === 'new'
      ? t('instructions.newInstruction')
      : selection?.kind === 'market'
        ? t('instructions.officialInstruction')
        : selectedLocal
          ? `#${selectedLocal.name}`
          : t('instructions.preview');

  return (
    <div className="flex h-full min-h-0 gap-4">
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
              {tab === 'local'
                ? t('instructions.tabLocal')
                : t('instructions.tabMarket')}
            </button>
          ))}
        </div>

        <div className="flex min-h-0 flex-1 flex-col rounded-xl border bg-card">
          <div className="p-2.5">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('instructions.searchPlaceholder')}
                className="h-8 pl-8 text-xs"
              />
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-1.5">
            {renderList()}
          </div>

          {leftTab === 'local' ? (
            <div className="flex gap-2 border-t p-2.5">
              <Button
                variant="outline"
                size="sm"
                type="button"
                className="h-8 w-8 shrink-0 p-0"
                onClick={refreshLocal}
                disabled={loadingLocal}
                title={t('instructions.refresh')}
              >
                <RefreshCw
                  className={cn('h-3.5 w-3.5', loadingLocal && 'animate-spin')}
                />
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-8 flex-1 text-xs"
                onClick={startNew}
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                {t('instructions.newInstruction')}
              </Button>
            </div>
          ) : (
            <div className="flex gap-2 border-t p-2.5">
              <Button
                variant="outline"
                size="sm"
                className="h-8 flex-1 text-xs"
                type="button"
                onClick={refreshMarket}
                disabled={loadingMarket}
              >
                <Store className="mr-1.5 h-3.5 w-3.5" />
                {t('instructions.refreshMarket')}
              </Button>
            </div>
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {!selection ? (
            <div className="flex h-full flex-col items-center justify-center text-center text-muted-foreground">
              <MessageSquareText className="h-10 w-10 opacity-30" />
              <p className="mt-3 text-sm">{t('instructions.selectPrompt')}</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold">{editorTitle}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {selection.kind === 'market'
                      ? t('instructions.marketHint')
                      : t('instructions.localHint')}
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
                      {t('common:delete')}
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
                    {selection.kind === 'market'
                      ? t('instructions.installToLocal')
                      : t('common:save')}
                  </Button>
                </div>
              </div>

              <div className="grid gap-4">
                <div className="settings-row settings-row--stacked">
                  <div>
                    <Label>{t('instructions.nameLabel')}</Label>
                    <p className="settings-row__description">
                      {t('instructions.nameFieldDescription')}
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
                    <Label>{t('instructions.agentLabel')}</Label>
                    <p className="settings-row__description">
                      {t('instructions.agentFieldDescription')}
                    </p>
                  </div>
                  <AgentMultiSelect
                    value={draft.agentTypes}
                    onChange={(agentTypes) => updateDraft({ agentTypes })}
                  />
                </div>

                <div className="settings-row settings-row--stacked">
                  <div>
                    <Label>{t('instructions.contentLabel')}</Label>
                    <p className="settings-row__description">
                      {t('instructions.contentFieldDescription')}
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
        </div>
      </section>
    </div>
  );
}
