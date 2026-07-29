import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/ui/toast';
import { useTranslation } from 'react-i18next';
import { Clock, Pencil, Play, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsPageHeader, SettingsSection } from './SettingsUi';
import { useProjects } from '@/hooks/useProjects';
import { automationApi } from '@/lib/api/automations';
import type { Automation, AutomationInput, AutomationRun } from 'shared/types';
import {
  isPluginActionDraft,
  PluginActionEditor,
  type PluginActionDraft,
} from '@/components/plugins/PluginActionEditor';
import {
  tauriBackendTransport,
  type BackendTransport,
} from '@/lib/backendTransport';

const EXECUTORS = ['CLAUDE_CODE', 'CODEX', 'OPENCODE'] as const;

function emptyInput(projectId: string): AutomationInput {
  return {
    name: '',
    project_id: projectId,
    executor: 'CLAUDE_CODE',
    prompt: '',
    plugin_action_json: null,
    isolation: 'in_place',
    trigger_kind: 'manual',
    cron: null,
    enabled: true,
  };
}

function inputFromAutomation(automation: Automation): AutomationInput {
  return {
    name: automation.name,
    project_id: automation.project_id,
    executor: automation.executor,
    prompt: automation.prompt,
    plugin_action_json: automation.plugin_action_json,
    isolation: automation.isolation,
    trigger_kind: automation.trigger_kind,
    cron: automation.cron,
    enabled: automation.enabled,
  };
}

function formatLocalTime(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function AutomationsSettings({
  transport = tauriBackendTransport,
}: {
  transport?: BackendTransport;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const { projects } = useProjects();
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [draft, setDraft] = useState<AutomationInput | null>(null);
  /** Id of the automation being edited; null while creating a new one. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [runsByAutomation, setRunsByAutomation] = useState<
    Record<string, AutomationRun[]>
  >({});
  const [busy, setBusy] = useState(false);
  const [pluginAction, setPluginAction] = useState<PluginActionDraft | null>(
    null
  );
  const [isPluginActionReady, setIsPluginActionReady] = useState(true);

  const reload = useCallback(async () => {
    try {
      setAutomations(await automationApi.list());
    } catch (error) {
      toast.error(t('automations.loadFailed', { error: String(error) }));
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const startNew = () => {
    const projectId = projects[0]?.id ?? '';
    setEditingId(null);
    setDraft(emptyInput(projectId));
    setPluginAction(null);
    setIsPluginActionReady(true);
  };

  const startEdit = (automation: Automation) => {
    const input = inputFromAutomation(automation);
    setEditingId(automation.id);
    setDraft(input);
    try {
      const parsed = automation.plugin_action_json
        ? (JSON.parse(automation.plugin_action_json) as unknown)
        : null;
      if (parsed !== null && !isPluginActionDraft(parsed)) {
        throw new Error('invalid PluginAction shape');
      }
      setPluginAction(parsed);
      setIsPluginActionReady(automation.plugin_action_json === null);
    } catch {
      setPluginAction(null);
      setDraft({ ...input, plugin_action_json: null });
      setIsPluginActionReady(true);
      toast.error(t('automations.invalidPluginAction'));
    }
  };

  const closeDraft = () => {
    setDraft(null);
    setEditingId(null);
    setPluginAction(null);
    setIsPluginActionReady(true);
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.prompt.trim()) {
      toast.error(t('automations.nameAndPromptRequired'));
      return;
    }
    if (!draft.project_id) {
      toast.error(t('automations.projectRequired'));
      return;
    }
    if (draft.trigger_kind === 'cron' && !draft.cron?.trim()) {
      toast.error(t('automations.cronRequired'));
      return;
    }
    setBusy(true);
    try {
      if (editingId) {
        await automationApi.update(editingId, draft);
        toast.success(t('automations.updated'));
      } else {
        await automationApi.create(draft);
        toast.success(t('automations.created'));
      }
      closeDraft();
      await reload();
    } catch (error) {
      toast.error(t('automations.saveFailed', { error: String(error) }));
    } finally {
      setBusy(false);
    }
  };

  const runNow = async (automation: Automation) => {
    try {
      await automationApi.runNow(automation.id);
      toast.success(t('automations.triggered'));
      await loadRuns(automation.id);
    } catch (error) {
      toast.error(t('automations.runFailed', { error: String(error) }));
    }
  };

  const toggle = async (automation: Automation, enabled: boolean) => {
    try {
      await automationApi.setEnabled(automation.id, enabled);
      await reload();
    } catch (error) {
      toast.error(t('automations.toggleFailed', { error: String(error) }));
    }
  };

  const remove = async (automation: Automation) => {
    try {
      await automationApi.remove(automation.id);
      await reload();
    } catch (error) {
      toast.error(t('automations.deleteFailed', { error: String(error) }));
    }
  };

  const loadRuns = useCallback(async (automationId: string) => {
    try {
      const runs = await automationApi.runs(automationId, 5);
      setRunsByAutomation((prev) => ({ ...prev, [automationId]: runs }));
    } catch {
      // ignore
    }
  }, []);

  const patchDraft = (patch: Partial<AutomationInput>) =>
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title={t('automations.pageTitle')}
        description={t('automations.pageDescription')}
      />

      <SettingsSection
        icon={Clock}
        title={t('automations.pageTitle')}
        description={t('automations.sectionDescription')}
      >
        <div className="mb-3">
          {draft ? null : (
            <Button size="sm" variant="outline" onClick={startNew}>
              <Plus className="mr-1 h-4 w-4" />
              {t('automations.newAutomation')}
            </Button>
          )}
        </div>

        {draft ? (
          <div className="mb-4 space-y-3 rounded-[10px] border border-border p-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">
                  {t('automations.name')}
                </label>
                <Input
                  value={draft.name}
                  onChange={(e) => patchDraft({ name: e.target.value })}
                  placeholder={t('automations.namePlaceholder')}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">
                  {t('automations.project')}
                </label>
                <Select
                  value={draft.project_id}
                  onValueChange={(v) => patchDraft({ project_id: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t('automations.selectProject')} />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium">
                {t('automations.prompt')}
              </label>
              <PluginActionEditor
                transport={transport}
                value={pluginAction}
                showPromptEditor={false}
                onReadyChange={setIsPluginActionReady}
                onChange={(action) => {
                  const actionPrompt = action.promptBlocks
                    .map((block) => block.text)
                    .join('\n');
                  const combinedPrompt = [draft.prompt.trimEnd(), actionPrompt]
                    .filter(Boolean)
                    .join('\n\n');
                  setPluginAction({
                    ...action,
                    promptBlocks: [{ type: 'text', text: combinedPrompt }],
                  });
                  patchDraft({
                    prompt: combinedPrompt,
                    plugin_action_json: JSON.stringify({
                      ...action,
                      promptBlocks: [{ type: 'text', text: combinedPrompt }],
                    }),
                  });
                }}
              />
              <Textarea
                aria-label={t('automations.prompt')}
                value={draft.prompt}
                onChange={(e) => {
                  const prompt = e.target.value;
                  patchDraft({ prompt });
                  setPluginAction((current) =>
                    current
                      ? {
                          ...current,
                          promptBlocks: [{ type: 'text', text: prompt }],
                        }
                      : current
                  );
                  if (pluginAction) {
                    patchDraft({
                      plugin_action_json: JSON.stringify({
                        ...pluginAction,
                        promptBlocks: [{ type: 'text', text: prompt }],
                      }),
                    });
                  }
                }}
                placeholder={t('automations.promptPlaceholder')}
                rows={3}
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">
                  {t('automations.executor')}
                </label>
                <Select
                  value={draft.executor ?? 'CLAUDE_CODE'}
                  onValueChange={(v) => patchDraft({ executor: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXECUTORS.map((ex) => (
                      <SelectItem key={ex} value={ex}>
                        {ex}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">
                  {t('automations.trigger')}
                </label>
                <Select
                  value={draft.trigger_kind}
                  onValueChange={(v) =>
                    patchDraft({
                      trigger_kind: v,
                      cron: v === 'cron' ? (draft.cron ?? '0 3 * * *') : null,
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">
                      {t('automations.triggerManual')}
                    </SelectItem>
                    <SelectItem value="cron">
                      {t('automations.triggerCron')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">
                  {t('automations.cronLabel')}
                </label>
                <Input
                  value={draft.cron ?? ''}
                  onChange={(e) => patchDraft({ cron: e.target.value })}
                  placeholder="0 3 * * *"
                  disabled={draft.trigger_kind !== 'cron'}
                />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <p className="text-[11px] text-muted-foreground">
                {t('automations.isolationHint')}
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={closeDraft}>
                  {t('common:cancel')}
                </Button>
                <Button
                  size="sm"
                  onClick={() => void save()}
                  disabled={busy || !isPluginActionReady}
                >
                  {t('common:save')}
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {automations.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('automations.empty')}
          </p>
        ) : (
          <ul className="space-y-2">
            {automations.map((automation) => (
              <li
                key={automation.id}
                className="rounded-[10px] border border-border p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {automation.name}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {automation.trigger_kind === 'cron'
                        ? t('automations.cronSummary', {
                            cron: automation.cron,
                          })
                        : t('automations.triggerManual')}{' '}
                      ·{' '}
                      {automation.executor ?? t('automations.defaultExecutor')}
                      {automation.enabled &&
                      formatLocalTime(automation.next_run_at) ? (
                        <>
                          {' · '}
                          {t('automations.nextRun', {
                            time: formatLocalTime(automation.next_run_at),
                          })}
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Switch
                      checked={automation.enabled}
                      onCheckedChange={(v) => void toggle(automation, v)}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => void runNow(automation)}
                    >
                      <Play className="mr-1 h-3.5 w-3.5" />
                      {t('common:run')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => void loadRuns(automation.id)}
                    >
                      {t('common:history')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      title={t('automations.edit')}
                      onClick={() => startEdit(automation)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-destructive"
                      onClick={() => void remove(automation)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                {runsByAutomation[automation.id]?.length ? (
                  <ul className="mt-2 space-y-1 border-t border-border pt-2">
                    {runsByAutomation[automation.id].map((run) => (
                      <li
                        key={run.id}
                        className="flex items-center justify-between text-[11px] text-muted-foreground"
                      >
                        <span>
                          {formatLocalTime(run.started_at) ?? run.started_at}
                        </span>
                        <span
                          className={
                            run.status === 'failed' ||
                            run.status === 'interrupted'
                              ? 'text-destructive'
                              : ''
                          }
                        >
                          {run.status}
                          {run.error ? `：${run.error}` : ''}
                          {run.summary ? `：${run.summary}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
    </div>
  );
}
