import { useCallback, useEffect, useMemo, useState } from 'react';
import { FilePlus2, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentId } from 'shared/types';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { agentManagementErrorMessage } from '@/features/agent-management';
import {
  skillsApi,
  type AgentSkillItem,
  type AgentSkillScope,
} from '@/lib/api';
import { cn } from '@/lib/utils';

const NEW_SKILL_TEMPLATE = `---
name: new-skill
description: Describe when this skill should be used.
---

# Instructions

Describe the workflow here.
`;

type Props = {
  agentId: AgentId;
  disabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
};

export function AgentSkillsManager({
  agentId,
  disabled = false,
  onDirtyChange,
}: Props) {
  const { t } = useTranslation(['settings', 'common']);
  const [scope, setScope] = useState<AgentSkillScope>('global');
  const [workspacePath, setWorkspacePath] = useState('');
  const [items, setItems] = useState<AgentSkillItem[]>([]);
  const [locations, setLocations] = useState<string[]>([]);
  const [projectSupported, setProjectSupported] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentSkillItem | null>(null);

  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId]
  );
  const requestWorkspace =
    scope === 'project' && workspacePath.trim() ? workspacePath.trim() : null;

  const load = useCallback(async () => {
    if (scope === 'project' && !requestWorkspace) {
      setItems([]);
      setLocations([]);
      setSelectedId(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await skillsApi.list(agentId, requestWorkspace);
      setProjectSupported(result.project_supported);
      setItems(result.skills.filter((item) => item.scope === scope));
      setLocations(
        result.locations
          .filter((location) => location.scope === scope)
          .map((location) => location.path)
      );
      setSelectedId((current) =>
        result.skills.some(
          (item) => item.scope === scope && item.id === current
        )
          ? current
          : null
      );
    } catch (cause) {
      setItems([]);
      setError(
        agentManagementErrorMessage(
          cause,
          t('settings:agents.skillsActionFailed')
        )
      );
    } finally {
      setLoading(false);
    }
  }, [agentId, requestWorkspace, scope, t]);

  useEffect(() => {
    setCreating(false);
    setSelectedId(null);
    setDraftId('');
    setDraftContent('');
    setOriginalContent('');
    void load();
  }, [load]);

  const open = useCallback(
    async (item: AgentSkillItem) => {
      setLoading(true);
      setError(null);
      try {
        const result = await skillsApi.read({
          agentType: agentId,
          scope,
          skillId: item.id,
          workspacePath: requestWorkspace,
        });
        setSelectedId(result.skill.id);
        setDraftId(result.skill.id);
        setDraftContent(result.content);
        setOriginalContent(result.content);
        setCreating(false);
      } catch (cause) {
        setError(
          agentManagementErrorMessage(
            cause,
            t('settings:agents.skillsActionFailed')
          )
        );
      } finally {
        setLoading(false);
      }
    },
    [agentId, requestWorkspace, scope, t]
  );

  const beginCreate = () => {
    setSelectedId(null);
    setDraftId('');
    setDraftContent(NEW_SKILL_TEMPLATE);
    setOriginalContent('');
    setCreating(true);
    setError(null);
  };

  const save = async () => {
    const skillId = draftId.trim();
    if (!skillId) {
      setError(t('settings:agents.skillsNameRequired'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await skillsApi.save({
        agentType: agentId,
        scope,
        skillId,
        content: draftContent,
        workspacePath: requestWorkspace,
      });
      await load();
      await open(saved);
    } catch (cause) {
      setError(
        agentManagementErrorMessage(
          cause,
          t('settings:agents.skillsActionFailed')
        )
      );
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setSaving(true);
    setError(null);
    try {
      await skillsApi.delete({
        agentType: agentId,
        scope: deleteTarget.scope,
        skillId: deleteTarget.id,
        workspacePath: requestWorkspace,
      });
      setDeleteTarget(null);
      setSelectedId(null);
      setDraftId('');
      setDraftContent('');
      setOriginalContent('');
      await load();
    } catch (cause) {
      setError(
        agentManagementErrorMessage(
          cause,
          t('settings:agents.skillsActionFailed')
        )
      );
    } finally {
      setSaving(false);
    }
  };

  const readOnly = selected?.read_only === true;
  const dirty =
    creating ||
    draftId !== (selected?.id ?? '') ||
    draftContent !== originalContent;
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  const editorVisible = creating || selected !== null;

  return (
    <section className="mx-4 mb-4 rounded-lg border bg-muted/10">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2.5">
        <div>
          <h4 className="text-sm font-medium">
            {t('settings:agents.skillsTitle')}
          </h4>
          <p className="text-xs text-muted-foreground">
            {t('settings:agents.skillsDescription')}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            disabled={disabled || loading}
            aria-label={t('settings:agents.skillsRefresh')}
            onClick={() => void load()}
          >
            <RefreshCw
              className={cn('h-3.5 w-3.5', loading && 'animate-spin')}
            />
          </Button>
          <Button
            size="sm"
            className="h-7"
            disabled={disabled || (scope === 'project' && !requestWorkspace)}
            onClick={beginCreate}
          >
            <FilePlus2 className="mr-1.5 h-3.5 w-3.5" />
            {t('settings:agents.skillsNew')}
          </Button>
        </div>
      </div>

      <div className="space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border bg-background p-0.5">
            {(['global', 'project'] as const)
              .filter((value) => value === 'global' || projectSupported)
              .map((value) => (
                <button
                  key={value}
                  type="button"
                  className={cn(
                    'rounded px-2.5 py-1 text-xs transition-colors',
                    scope === value
                      ? 'bg-muted font-medium text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                  onClick={() => setScope(value)}
                >
                  {t(`settings:agents.skillsScope.${value}`)}
                </button>
              ))}
          </div>
          {scope === 'project' ? (
            <Input
              aria-label={t('settings:agents.skillsWorkspacePath')}
              className="h-8 min-w-64 flex-1 font-mono text-xs"
              value={workspacePath}
              placeholder={t('settings:agents.skillsWorkspacePlaceholder')}
              onChange={(event) => setWorkspacePath(event.target.value)}
            />
          ) : null}
        </div>

        {locations.length > 0 ? (
          <p className="break-all font-mono text-xs text-muted-foreground">
            {locations.join(' · ')}
          </p>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="grid min-h-56 gap-3 md:grid-cols-[minmax(12rem,0.36fr)_minmax(0,1fr)]">
          <div className="min-h-0 space-y-1 overflow-y-auto rounded-md border bg-background p-1.5">
            {loading ? (
              <div className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('settings:agents.skillsLoading')}
              </div>
            ) : items.length === 0 ? (
              <p className="p-2 text-xs text-muted-foreground">
                {scope === 'project' && !requestWorkspace
                  ? t('settings:agents.skillsChooseWorkspace')
                  : t('settings:agents.skillsEmpty')}
              </p>
            ) : (
              items.map((item) => (
                <button
                  key={`${item.scope}:${item.id}`}
                  type="button"
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs',
                    selectedId === item.id
                      ? 'bg-primary/10 text-foreground'
                      : 'hover:bg-muted/60'
                  )}
                  onClick={() => void open(item)}
                >
                  <span className="truncate font-medium">{item.id}</span>
                  {item.read_only ? (
                    <Badge variant="outline">
                      {t('settings:agents.skillsReadOnly')}
                    </Badge>
                  ) : null}
                </button>
              ))
            )}
          </div>

          <div className="min-w-0 rounded-md border bg-background p-3">
            {!editorVisible ? (
              <p className="text-xs text-muted-foreground">
                {t('settings:agents.skillsSelectHint')}
              </p>
            ) : (
              <div className="space-y-2.5">
                <Input
                  aria-label={t('settings:agents.skillsName')}
                  className="h-8 font-mono text-xs"
                  disabled={disabled || saving || !creating || readOnly}
                  value={draftId}
                  placeholder="review-changes"
                  onChange={(event) => setDraftId(event.target.value)}
                />
                <Textarea
                  aria-label={t('settings:agents.skillsContent')}
                  className="min-h-64 resize-y font-mono text-xs leading-5"
                  disabled={disabled || saving || readOnly}
                  spellCheck={false}
                  value={draftContent}
                  onChange={(event) => setDraftContent(event.target.value)}
                />
                <div className="flex items-center justify-end gap-1.5">
                  {selected && !selected.read_only ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-destructive hover:text-destructive"
                      disabled={disabled || saving}
                      onClick={() => setDeleteTarget(selected)}
                    >
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                      {t('settings:agents.skillsDelete')}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    className="h-7"
                    disabled={disabled || saving || readOnly || !dirty}
                    onClick={() => void save()}
                  >
                    {saving ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    {t('settings:agents.skillsSave')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings:agents.skillsDeleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('settings:agents.skillsDeleteDescription', {
                name: deleteTarget?.id ?? '',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => setDeleteTarget(null)}
            >
              {t('common:cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={saving}
              onClick={() => void remove()}
            >
              {t('settings:agents.skillsDelete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
