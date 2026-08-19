import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  ChevronRight,
  CircleStop,
  Copy,
  FileInput,
  History,
  Loader2,
  PanelRightOpen,
  Play,
  Plus,
  Trash2,
  Workflow,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import {
  createAutomationApi,
  type AutomationRunView,
  type AutomationTemplateView,
  type AutomationView,
} from '@/lib/api/automations';
import { useBackendTransport } from '@/lib/transport';
import { SettingsSection } from './SettingsUi';
import { AutomationTemplateList } from './AutomationTemplateList';
import { AutomationTypeDialog } from './AutomationTypeDialog';

function scheduleLabel(automation: AutomationView, manualLabel: string) {
  return automation.trigger.kind === 'schedule'
    ? `${automation.trigger.cron} · ${automation.trigger.timezone}`
    : manualLabel;
}

export function AutomationCenter() {
  const navigate = useNavigate();
  const { t } = useTranslation('settings');
  const transport = useBackendTransport();
  const api = useMemo(() => createAutomationApi(transport), [transport]);
  const [automations, setAutomations] = useState<AutomationView[]>([]);
  const [templates, setTemplates] = useState<AutomationTemplateView[]>([]);
  const [engineActive, setEngineActive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importJson, setImportJson] = useState('');
  const [importing, setImporting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AutomationView | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, AutomationRunView[]>>({});

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [status, items, presets] = await Promise.all([
        api.engineStatus(),
        api.list(),
        api.templates(),
      ]);
      setEngineActive(status.active);
      setAutomations(items);
      setTemplates(presets);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openHistory = async (automationId: string) => {
    setHistoryId((current) => (current === automationId ? null : automationId));
    try {
      const history = await api.runs(automationId, 20);
      setRuns((current) => ({
        ...current,
        [automationId]: history,
      }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const copySpec = async (automation: AutomationView) => {
    try {
      const json = await api.exportSpec(automation.id);
      await navigator.clipboard.writeText(json);
      toast.success(t('automations.jsonCopied'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const importSpec = async () => {
    setImporting(true);
    try {
      const created = await api.importSpec(importJson);
      setAutomations((current) => [created, ...current]);
      setImportJson('');
      setImportOpen(false);
      toast.success(t('automations.importedDisabled'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="settings-sections">
      <SettingsSection
        icon={CalendarClock}
        title={t('automations.pageTitle')}
        description={t('automations.centerDescription')}
        bare
        action={
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setImportOpen(true)}
            >
              <FileInput className="mr-1.5 size-3.5" />{' '}
              {t('automations.importJson')}
            </Button>
            <Button
              size="sm"
              variant={templatesOpen ? 'secondary' : 'outline'}
              onClick={() => setTemplatesOpen((open) => !open)}
            >
              <PanelRightOpen className="mr-1.5 size-3.5" />{' '}
              {t('automations.templates')}
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1.5 size-3.5" /> {t('automations.newShort')}
            </Button>
          </div>
        }
      >
        <div className="flex min-h-[520px] items-start gap-3">
          <div className="settings-surface min-w-0 flex-1 overflow-hidden rounded-lg">
            {!engineActive ? (
              <div className="border-b bg-amber-500/[0.07] px-4 py-2.5 text-xs text-amber-800 dark:text-amber-300">
                {t('automations.nonOwnerDescription')}
              </div>
            ) : null}
            {loading ? (
              <div className="grid min-h-60 place-items-center text-xs text-muted-foreground">
                <span className="flex items-center gap-2">
                  <Loader2 className="size-3.5 animate-spin" />{' '}
                  {t('automations.loading')}
                </span>
              </div>
            ) : automations.length === 0 ? (
              <div className="grid min-h-72 place-items-center px-6 text-center">
                <div>
                  <Workflow className="mx-auto mb-3 size-7 text-muted-foreground" />
                  <p className="text-sm font-semibold">
                    {t('automations.centerEmptyTitle')}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('automations.centerEmptyDescription')}
                  </p>
                </div>
              </div>
            ) : (
              <ul className="divide-y" aria-label={t('automations.listAria')}>
                {automations.map((automation) => (
                  <li key={automation.id} className="px-4 py-3.5">
                    <div className="flex items-start gap-3">
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() =>
                          navigate(
                            `/settings/automations/${automation.id}/edit`
                          )
                        }
                      >
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold">
                            {automation.name}
                          </span>
                          <span className="rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                            {automation.target.kind === 'workflow'
                              ? t('automations.targetWorkflow')
                              : t('automations.targetTurn')}
                          </span>
                        </span>
                        <span className="mt-1 block text-[11px] text-muted-foreground">
                          {scheduleLabel(
                            automation,
                            t('automations.triggerManual')
                          )}
                          {automation.lastRunStatus
                            ? ` · ${t('automations.lastRunStatus', {
                                status: automation.lastRunStatus,
                              })}`
                            : ''}
                          {automation.nextRunAt
                            ? ` · ${t('automations.nextRun', {
                                time: new Date(
                                  automation.nextRunAt
                                ).toLocaleString(),
                              })}`
                            : ''}
                        </span>
                      </button>
                      <Switch
                        checked={automation.enabled}
                        disabled={!engineActive}
                        aria-label={t('automations.toggleAria', {
                          name: automation.name,
                        })}
                        onCheckedChange={(enabled) => {
                          void api
                            .setEnabled(automation.id, enabled)
                            .then(() =>
                              setAutomations((current) =>
                                current.map((item) =>
                                  item.id === automation.id
                                    ? { ...item, enabled }
                                    : item
                                )
                              )
                            )
                            .catch((error) =>
                              toast.error(
                                error instanceof Error
                                  ? error.message
                                  : String(error)
                              )
                            );
                        }}
                      />
                    </div>
                    <div className="mt-2 flex items-center gap-1">
                      {automation.unseenFailureCount ? (
                        <span className="mr-auto text-[11px] font-medium text-destructive">
                          {t('automations.unseenFailures', {
                            count: automation.unseenFailureCount,
                          })}
                        </span>
                      ) : (
                        <span className="mr-auto text-[10px] font-mono text-muted-foreground">
                          {automation.id.slice(0, 8)}
                        </span>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        title={t('automations.copyJson')}
                        onClick={() => void copySpec(automation)}
                      >
                        <Copy className="size-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        title={t('automations.runHistory')}
                        onClick={() => void openHistory(automation.id)}
                      >
                        <History className="size-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        title={t('automations.runNow')}
                        disabled={!engineActive || !automation.enabled}
                        onClick={() => {
                          void api
                            .runNow(automation.id)
                            .then((run) => {
                              setRuns((current) => ({
                                ...current,
                                [automation.id]: [
                                  run,
                                  ...(current[automation.id] ?? []),
                                ],
                              }));
                              setHistoryId(automation.id);
                            })
                            .catch((error) =>
                              toast.error(
                                error instanceof Error
                                  ? error.message
                                  : String(error)
                              )
                            );
                        }}
                      >
                        <Play className="size-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7 text-destructive"
                        title={t('automations.delete')}
                        disabled={!engineActive}
                        onClick={() => setDeleteTarget(automation)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        title={t('automations.edit')}
                        onClick={() =>
                          navigate(
                            `/settings/automations/${automation.id}/edit`
                          )
                        }
                      >
                        <ChevronRight className="size-3.5" />
                      </Button>
                    </div>
                    {historyId === automation.id ? (
                      <div className="mt-3 divide-y rounded-lg border bg-muted/15 px-3">
                        {(runs[automation.id] ?? []).length === 0 ? (
                          <p className="py-3 text-xs text-muted-foreground">
                            {t('automations.noRuns')}
                          </p>
                        ) : (
                          (runs[automation.id] ?? []).map((run) => (
                            <div
                              key={run.id}
                              className="flex items-center gap-3 py-2 text-xs"
                            >
                              <span className="w-20 font-medium">
                                {t(`automations.status.${run.status}`, {
                                  defaultValue: run.status,
                                })}
                              </span>
                              <time className="flex-1 text-muted-foreground">
                                {new Date(run.startedAt).toLocaleString()}
                              </time>
                              {run.workflowRunId ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7"
                                  onClick={() =>
                                    navigate(`/workflows/${run.workflowRunId}`)
                                  }
                                >
                                  {t('automations.openDag')}
                                </Button>
                              ) : null}
                              {run.status === 'running' ? (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="size-7"
                                  onClick={() =>
                                    void api
                                      .cancelRun(run.id)
                                      .then(() => openHistory(automation.id))
                                  }
                                >
                                  <CircleStop className="size-3.5" />
                                </Button>
                              ) : null}
                            </div>
                          ))
                        )}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {templatesOpen ? (
            <AutomationTemplateList
              templates={templates}
              onSelectWorkflow={() =>
                navigate(
                  '/settings/automations/new/workflow?template=research-brief'
                )
              }
              onSelectTurn={(templateId) =>
                navigate(
                  `/settings/automations/new/turn?template=${templateId}`
                )
              }
            />
          ) : null}
        </div>
      </SettingsSection>

      <AutomationTypeDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSelect={(type) => {
          setCreateOpen(false);
          navigate(`/settings/automations/new/${type}`);
        }}
      />

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogHeader>
          <DialogTitle>{t('automations.importTitle')}</DialogTitle>
          <DialogDescription>
            {t('automations.importDescription')}
          </DialogDescription>
        </DialogHeader>
        <DialogContent>
          <Textarea
            value={importJson}
            onChange={(event) => setImportJson(event.target.value)}
            className="min-h-72 font-mono text-xs"
            placeholder={'{\n  "formatVersion": 1,\n  …\n}'}
          />
        </DialogContent>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setImportOpen(false)}>
            {t('automations.cancel')}
          </Button>
          <Button
            disabled={!importJson.trim() || importing}
            onClick={() => void importSpec()}
          >
            {importing ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : null}
            {t('automations.importDisabled')}
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogHeader>
          <DialogTitle>{t('automations.deleteTitle')}</DialogTitle>
          <DialogDescription>
            {t('automations.deleteDescription', {
              name: deleteTarget?.name ?? '',
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
            {t('automations.cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (!deleteTarget) return;
              const id = deleteTarget.id;
              void api
                .remove(id)
                .then(() => {
                  setAutomations((current) =>
                    current.filter((item) => item.id !== id)
                  );
                  setDeleteTarget(null);
                })
                .catch((error) =>
                  toast.error(
                    error instanceof Error ? error.message : String(error)
                  )
                );
            }}
          >
            {t('automations.delete')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
