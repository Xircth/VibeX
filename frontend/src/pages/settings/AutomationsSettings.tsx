import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  CalendarClock,
  Clock3,
  AlertTriangle,
  History,
  LayoutTemplate,
  Loader2,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import type {
  AgentSessionControlsSnapshot,
  ExecutorProfileId,
  GitBranch,
} from 'shared/types';

import {
  PluginActionEditor,
  type PluginActionDraft,
} from '@/components/plugins/PluginActionEditor';
import { SessionControlsFields } from '@/components/sessions/SessionControlsFields';
import { SessionComposerInput } from '@/components/tasks/follow-up/SessionComposerInput';
import RepoBranchSelector from '@/components/tasks/RepoBranchSelector';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import {
  createAutomationApi,
  type AutomationDraftRequest,
  type AutomationIsolation,
  type AutomationTemplateView,
  type AutomationRunView,
  type AutomationView,
} from '@/lib/api/automations';
import { type BackendTransport } from '@/lib/backendTransport';
import { useBackendTransport } from '@/lib/transport';
import { SettingsPageHeader, SettingsSection } from './SettingsUi';

type ProjectOption = {
  id: string;
  name: string;
};

type RepoOption = {
  id: string;
  display_name: string;
  path: string;
  default_target_branch?: string | null;
};

type AgentOption = {
  agent_id: string;
  display_name: string;
  enabled: boolean;
  retired: boolean;
  lifecycle: string;
};

type BranchConfig = {
  repoId: string;
  repoDisplayName: string;
  rootFolder: string;
  targetBranch: string | null;
  branches: GitBranch[];
};

type EditorDraft = {
  name: string;
  enabled: boolean;
  prompt: string;
  triggerKind: 'manual' | 'schedule';
  scheduleTime: string;
  timezone: string;
  modeId: string | null;
  configValues: Record<string, string>;
  pluginAction: PluginActionDraft | null;
  projectId: string;
  branch: string | null;
  agentId: string;
  executorProfileId: ExecutorProfileId | null;
  isolation: AutomationIsolation;
};

function emptyDraft(projectId = '', agentId = 'codex'): EditorDraft {
  return {
    name: '',
    enabled: true,
    prompt: '',
    triggerKind: 'manual',
    scheduleTime: '03:00',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    modeId: null,
    configValues: {},
    pluginAction: null,
    projectId,
    branch: null,
    agentId,
    executorProfileId: {
      executor: agentId,
      variant: null,
    },
    isolation: 'worktree_per_run',
  };
}

function dailyCron(time: string): string {
  const [hour = '0', minute = '0'] = time.split(':');
  return `${Number(minute)} ${Number(hour)} * * *`;
}

function cronToDailyTime(cron: string): string {
  const [minute, hour] = cron.trim().split(/\s+/);
  if (!minute || !hour || !/^\d+$/.test(minute) || !/^\d+$/.test(hour)) {
    return '03:00';
  }
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

function formatLocalTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function isAgentOption(value: unknown): value is AgentOption {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AgentOption).agent_id === 'string' &&
    typeof (value as AgentOption).display_name === 'string'
  );
}

export function AutomationsSettings({
  transport: transportOverride,
  pollIntervalMs = 1_000,
  editorOnly = false,
  automationId = null,
  templateId = null,
  onSaved,
  onCancel,
}: {
  transport?: BackendTransport;
  pollIntervalMs?: number;
  editorOnly?: boolean;
  automationId?: string | null;
  templateId?: string | null;
  onSaved?: (automation: AutomationView) => void;
  onCancel?: () => void;
}) {
  const contextTransport = useBackendTransport();
  const transport = transportOverride ?? contextTransport;
  const { t } = useTranslation(['settings', 'common']);
  const api = useMemo(() => createAutomationApi(transport), [transport]);
  const [automations, setAutomations] = useState<AutomationView[]>([]);
  const [templates, setTemplates] = useState<AutomationTemplateView[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [branchConfigs, setBranchConfigs] = useState<BranchConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [controls, setControls] = useState<AgentSessionControlsSnapshot | null>(
    null
  );
  const [controlsLoading, setControlsLoading] = useState(false);
  const [controlsError, setControlsError] = useState<string | null>(null);
  const [pluginActionReady, setPluginActionReady] = useState(true);
  const [runsByAutomation, setRunsByAutomation] = useState<
    Record<string, AutomationRunView[]>
  >({});
  const [historyOpenId, setHistoryOpenId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewRuns, setPreviewRuns] = useState<string[]>([]);
  const [engineActive, setEngineActive] = useState(true);
  const editorInitialized = useRef(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [
        engineStatus,
        loadedAutomations,
        loadedTemplates,
        projectValue,
        agentValue,
      ] = await Promise.all([
        api.engineStatus(),
        api.list(),
        api.templates(),
        transport.call('get_projects'),
        transport.call('agent_management_bar'),
      ]);
      setEngineActive(engineStatus.active);
      setAutomations(loadedAutomations);
      setTemplates(loadedTemplates);
      setProjects(
        Array.isArray(projectValue)
          ? projectValue.filter(
              (project): project is ProjectOption =>
                typeof project === 'object' &&
                project !== null &&
                typeof project.id === 'string' &&
                typeof project.name === 'string'
            )
          : []
      );
      setAgents(
        Array.isArray(agentValue)
          ? agentValue.filter(
              (agent) =>
                isAgentOption(agent) &&
                agent.enabled &&
                !agent.retired &&
                agent.lifecycle === 'ready'
            )
          : []
      );
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [api, transport]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!draft?.projectId) {
      setBranchConfigs([]);
      return;
    }
    let active = true;
    void transport
      .call('get_project_repositories', { id: draft.projectId })
      .then(async (value) => {
        if (!Array.isArray(value)) return [];
        const repos = value.filter(
          (repo): repo is RepoOption =>
            typeof repo === 'object' &&
            repo !== null &&
            typeof repo.id === 'string' &&
            typeof repo.display_name === 'string' &&
            typeof repo.path === 'string'
        );
        return Promise.all(
          repos.map(async (repo) => {
            const branchesValue = await transport.call('get_repo_branches', {
              repoId: repo.id,
            });
            const branches = Array.isArray(branchesValue)
              ? (branchesValue as GitBranch[])
              : [];
            const targetBranch = draft.branch
              ? (branches.find((branch) => branch.name === draft.branch)
                  ?.name ?? null)
              : (repo.default_target_branch ??
                branches.find((branch) => branch.is_current)?.name ??
                branches[0]?.name ??
                null);
            return {
              repoId: repo.id,
              repoDisplayName: repo.display_name,
              rootFolder: repo.path,
              targetBranch,
              branches,
            };
          })
        );
      })
      .then((configs) => {
        if (active) setBranchConfigs(configs);
      })
      .catch((error) => {
        if (active) {
          setBranchConfigs([]);
          toast.error(
            t('automations.branchesLoadFailed', {
              error: error instanceof Error ? error.message : String(error),
            })
          );
        }
      });
    return () => {
      active = false;
    };
  }, [draft?.branch, draft?.projectId, t, transport]);

  useEffect(() => {
    if (!draft) return;
    if (!draft.projectId && projects[0]) {
      setDraft((current) =>
        current ? { ...current, projectId: projects[0].id } : current
      );
    }
    if (
      (!draft.agentId || draft.agentId === 'codex') &&
      agents[0] &&
      !agents.some((agent) => agent.agent_id === draft.agentId)
    ) {
      setDraft((current) =>
        current
          ? {
              ...current,
              agentId: agents[0].agent_id,
              executorProfileId: {
                executor: agents[0].agent_id,
                variant: null,
              },
            }
          : current
      );
    }
  }, [agents, draft, projects]);

  useEffect(() => {
    if (!draft?.agentId) {
      setControls(null);
      return;
    }
    let active = true;
    const agentId = draft.agentId;
    setControlsLoading(true);
    setControlsError(null);
    void transport
      .call('agent_capability_catalog', { agentId })
      .then((value) => {
        if (!active || typeof value !== 'object' || value === null) return;
        const catalog = value as AgentSessionControlsSnapshot;
        if (
          !Array.isArray(catalog.modes) ||
          !Array.isArray(catalog.config_options)
        ) {
          throw new Error(t('automations.invalidAgentControls'));
        }
        setControls(catalog);
        setDraft((current) => {
          if (!current || current.agentId !== agentId) return current;
          const advertised = Object.fromEntries(
            catalog.config_options.flatMap((option) => {
              if (option.value === null || option.value === undefined)
                return [];
              return [[option.key, String(option.value)]];
            })
          );
          return {
            ...current,
            modeId: current.modeId ?? catalog.current_mode ?? null,
            configValues:
              Object.keys(current.configValues).length > 0
                ? current.configValues
                : advertised,
          };
        });
      })
      .catch((error) => {
        if (active) {
          setControls(null);
          setControlsError(
            error instanceof Error ? error.message : String(error)
          );
        }
      })
      .finally(() => {
        if (active) setControlsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [draft?.agentId, t, transport]);

  const loadRuns = useCallback(
    async (automationId: string) => {
      try {
        const runs = await api.runs(automationId, 20);
        setRunsByAutomation((current) => ({
          ...current,
          [automationId]: runs,
        }));
        setRunError(null);
        return runs;
      } catch (error) {
        setRunError(error instanceof Error ? error.message : String(error));
        return [];
      }
    },
    [api]
  );

  useEffect(() => {
    const runningAutomationIds = Object.entries(runsByAutomation)
      .filter(([, runs]) => runs.some((run) => run.status === 'running'))
      .map(([automationId]) => automationId);
    if (runningAutomationIds.length === 0) return;
    const timer = window.setTimeout(() => {
      for (const automationId of runningAutomationIds) {
        void loadRuns(automationId);
      }
    }, pollIntervalMs);
    return () => window.clearTimeout(timer);
  }, [loadRuns, pollIntervalMs, runsByAutomation]);

  const startNew = useCallback(() => {
    const projectId = projects[0]?.id ?? '';
    const agentId = agents[0]?.agent_id ?? 'codex';
    setEditingId(null);
    setDraft(emptyDraft(projectId, agentId));
  }, [agents, projects]);

  const closeDraft = (notify = true) => {
    setDraft(null);
    setEditingId(null);
    setBranchConfigs([]);
    setPreviewRuns([]);
    setPreviewError(null);
    if (editorOnly && notify) onCancel?.();
  };

  const selectedBranch = branchConfigs[0] ?? null;

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.prompt.trim()) {
      toast.error(t('automations.nameAndPromptRequired'));
      return;
    }
    if (!draft.projectId) {
      toast.error(t('automations.projectRequired'));
      return;
    }
    if (!selectedBranch?.rootFolder || !selectedBranch.targetBranch) {
      toast.error(t('automations.branchRequired'));
      return;
    }
    if (draft.triggerKind === 'schedule' && !draft.timezone.trim()) {
      toast.error(t('automations.timezoneRequired'));
      return;
    }
    const input: AutomationDraftRequest = {
      name: draft.name.trim(),
      enabled: draft.enabled,
      trigger:
        draft.triggerKind === 'schedule'
          ? {
              kind: 'schedule',
              cron: dailyCron(draft.scheduleTime),
              timezone: draft.timezone.trim(),
            }
          : { kind: 'manual' },
      launch: {
        promptBlocks: [{ type: 'text', text: draft.prompt }],
        displayText: draft.prompt,
        agent: {
          agentId: draft.agentId,
          executorProfileId: draft.executorProfileId,
        },
        modeId: draft.modeId,
        configValues: Object.entries(draft.configValues).map(
          ([key, value]) => ({
            key,
            value,
          })
        ),
        pluginActions: draft.pluginAction
          ? [
              {
                pluginId: draft.pluginAction.pluginId,
                action: {
                  id: draft.pluginAction.actionId,
                  label: draft.pluginAction.label,
                  requiredSkills: [...draft.pluginAction.requiredSkills],
                  requiredTools: [...draft.pluginAction.requiredTools],
                  promptBlocks: draft.pluginAction.promptBlocks.map(
                    (block) => ({
                      ...block,
                    })
                  ),
                  artifactIntent: draft.pluginAction.artifactIntent
                    ? {
                        ...draft.pluginAction.artifactIntent,
                        mediaTypes: [
                          ...draft.pluginAction.artifactIntent.mediaTypes,
                        ],
                      }
                    : null,
                },
              },
            ]
          : [],
        skills: draft.pluginAction
          ? [...draft.pluginAction.requiredSkills]
          : [],
        workspace: {
          projectId: draft.projectId,
          rootFolder: selectedBranch.rootFolder,
          branch: selectedBranch.targetBranch,
          isolation: draft.isolation,
        },
        labelSnapshot: draft.name.trim(),
      },
    };
    setSaving(true);
    try {
      const saved = editingId
        ? await api.update(editingId, input)
        : await api.create(input);
      setAutomations((current) => [
        saved,
        ...current.filter((automation) => automation.id !== saved.id),
      ]);
      toast.success(
        t(editingId ? 'automations.updated' : 'automations.created')
      );
      closeDraft(false);
      onSaved?.(saved);
    } catch (error) {
      toast.error(
        t('automations.saveFailed', {
          error: error instanceof Error ? error.message : String(error),
        })
      );
    } finally {
      setSaving(false);
    }
  };

  const setBranch = (repoId: string, branch: string) => {
    setBranchConfigs((current) =>
      current.map((config) =>
        config.repoId === repoId ? { ...config, targetBranch: branch } : config
      )
    );
    setDraft((current) => (current ? { ...current, branch } : current));
  };

  const startEdit = useCallback(
    (automation: AutomationView) => {
      if (!automation.launch) {
        toast.error(t('automations.workflowEditUnavailable'));
        return;
      }
      setEditingId(automation.id);
      setDraft({
        name: automation.name,
        enabled: automation.enabled,
        prompt: automation.launch.displayText,
        triggerKind:
          automation.trigger.kind === 'schedule' ? 'schedule' : 'manual',
        scheduleTime:
          automation.trigger.kind === 'schedule'
            ? cronToDailyTime(automation.trigger.cron)
            : '03:00',
        timezone:
          automation.trigger.kind === 'schedule'
            ? automation.trigger.timezone
            : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        modeId: automation.launch.modeId,
        configValues: Object.fromEntries(
          automation.launch.configValues.map(({ key, value }) => [key, value])
        ),
        pluginAction: automation.launch.pluginActions[0]
          ? {
              pluginId: automation.launch.pluginActions[0].pluginId,
              actionId: automation.launch.pluginActions[0].action.id,
              label: automation.launch.pluginActions[0].action.label,
              requiredSkills: [
                ...automation.launch.pluginActions[0].action.requiredSkills,
              ],
              requiredTools: [
                ...automation.launch.pluginActions[0].action.requiredTools,
              ],
              promptBlocks:
                automation.launch.pluginActions[0].action.promptBlocks.map(
                  (block) => ({ ...block })
                ),
              artifactIntent:
                automation.launch.pluginActions[0].action.artifactIntent ??
                null,
            }
          : null,
        projectId: automation.launch.workspace.projectId,
        branch: automation.launch.workspace.branch,
        agentId: automation.launch.agent.agentId,
        executorProfileId: automation.launch.agent.executorProfileId,
        isolation: automation.launch.workspace.isolation,
      });
    },
    [t]
  );

  const previewSchedule = async () => {
    if (!draft || draft.triggerKind !== 'schedule') return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      setPreviewRuns(
        await api.previewNextRuns(
          dailyCron(draft.scheduleTime),
          draft.timezone.trim(),
          5
        )
      );
    } catch (error) {
      setPreviewRuns([]);
      setPreviewError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreviewing(false);
    }
  };

  const toggle = async (automation: AutomationView, enabled: boolean) => {
    try {
      await api.setEnabled(automation.id, enabled);
      setAutomations((current) =>
        current.map((item) =>
          item.id === automation.id ? { ...item, enabled } : item
        )
      );
    } catch (error) {
      toast.error(
        t('automations.toggleFailed', {
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  };

  const remove = async (automation: AutomationView) => {
    try {
      await api.remove(automation.id);
      setAutomations((current) =>
        current.filter((item) => item.id !== automation.id)
      );
    } catch (error) {
      toast.error(
        t('automations.deleteFailed', {
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  };

  const runNow = async (automation: AutomationView) => {
    setRunError(null);
    try {
      const run = await api.runNow(automation.id);
      setRunsByAutomation((current) => ({
        ...current,
        [automation.id]: [
          run,
          ...(current[automation.id] ?? []).filter(
            (existing) => existing.id !== run.id
          ),
        ],
      }));
      setHistoryOpenId(automation.id);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    }
  };

  const showHistory = async (automation: AutomationView) => {
    setHistoryOpenId(automation.id);
    await loadRuns(automation.id);
  };

  const cancelRun = async (run: AutomationRunView) => {
    try {
      await api.cancelRun(run.id);
      await loadRuns(run.automationId);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    }
  };

  const startTemplate = useCallback(
    (template: AutomationTemplateView) => {
      const projectId = projects[0]?.id ?? '';
      const fallbackAgentId = agents[0]?.agent_id ?? 'codex';
      const templateLaunch = template.draft.launch;
      const templateAction = templateLaunch.pluginActions[0];
      setEditingId(null);
      setDraft({
        ...emptyDraft(projectId, fallbackAgentId),
        name: template.draft.name,
        enabled: template.draft.enabled,
        prompt: templateLaunch.displayText,
        triggerKind:
          template.draft.trigger.kind === 'schedule' ? 'schedule' : 'manual',
        scheduleTime:
          template.draft.trigger.kind === 'schedule'
            ? cronToDailyTime(template.draft.trigger.cron)
            : '03:00',
        timezone:
          template.draft.trigger.kind === 'schedule'
            ? template.draft.trigger.timezone
            : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        agentId: templateLaunch.agent.agentId || fallbackAgentId,
        executorProfileId: templateLaunch.agent.executorProfileId ?? {
          executor: templateLaunch.agent.agentId || fallbackAgentId,
          variant: null,
        },
        modeId: templateLaunch.modeId,
        configValues: Object.fromEntries(
          templateLaunch.configValues.map(({ key, value }) => [key, value])
        ),
        pluginAction: templateAction
          ? {
              pluginId: templateAction.pluginId,
              actionId: templateAction.action.id,
              ...templateAction.action,
            }
          : null,
        isolation: templateLaunch.workspace.isolation,
        branch: templateLaunch.workspace.branch,
      });
    },
    [agents, projects]
  );

  useEffect(() => {
    if (!editorOnly || loading || editorInitialized.current) return;
    editorInitialized.current = true;
    if (automationId) {
      const automation = automations.find((item) => item.id === automationId);
      if (automation) startEdit(automation);
      else setLoadError(`Automation ${automationId} was not found`);
      return;
    }
    if (templateId) {
      const template = templates.find((item) => item.id === templateId);
      if (template) startTemplate(template);
      else setLoadError(`Automation template ${templateId} was not found`);
      return;
    }
    startNew();
  }, [
    automationId,
    automations,
    editorOnly,
    loading,
    startEdit,
    startNew,
    startTemplate,
    templateId,
    templates,
  ]);

  return (
    <div className="settings-sections">
      <SettingsPageHeader
        title={t('automations.pageTitle')}
        description={t('automations.pageDescription')}
      />
      <SettingsSection
        icon={CalendarClock}
        title={t('automations.pageTitle')}
        description={t('automations.sectionDescription')}
        descriptionClassName="text-foreground"
        action={
          draft || editorOnly ? null : (
            <Button
              size="sm"
              variant="outline"
              onClick={startNew}
              disabled={!engineActive}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {t('automations.newAutomation')}
            </Button>
          )
        }
      >
        {!engineActive ? (
          <div
            role="status"
            aria-label={t('automations.nonOwnerStatus')}
            className="m-3 flex items-start gap-2 rounded-md border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t('automations.nonOwnerDescription')}</span>
          </div>
        ) : null}
        {loadError ? (
          <div
            role="alert"
            className="flex min-h-32 flex-col items-center justify-center gap-3 px-6 py-8 text-center"
          >
            <p className="max-w-[65ch] text-sm text-destructive">
              {t('automations.loadFailed', { error: loadError })}
            </p>
            <Button variant="outline" size="sm" onClick={() => void reload()}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              {t('automations.retry')}
            </Button>
          </div>
        ) : loading ? (
          <div
            role="status"
            aria-label={t('automations.loading')}
            className="flex min-h-32 items-center justify-center text-sm text-muted-foreground"
          >
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('automations.loading')}
          </div>
        ) : (
          <div
            className={
              editorOnly
                ? 'min-h-[360px]'
                : draft
                  ? 'grid min-h-[360px] lg:grid-cols-[minmax(220px,0.75fr)_minmax(0,1.5fr)]'
                  : 'min-h-32'
            }
          >
            {!editorOnly ? (
              <AutomationList
                automations={automations}
                editingId={editingId}
                onEdit={startEdit}
                onToggle={toggle}
                onRemove={remove}
                onRun={runNow}
                onShowHistory={showHistory}
                onCancelRun={cancelRun}
                runsByAutomation={runsByAutomation}
                historyOpenId={historyOpenId}
                mutable={engineActive}
                t={t}
              />
            ) : null}
            {draft ? (
              <form
                className="space-y-4 border-t border-border/70 p-4 lg:border-l lg:border-t-0"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="automation-name">
                      {t('automations.name')}
                    </Label>
                    <Input
                      id="automation-name"
                      value={draft.name}
                      onChange={(event) =>
                        setDraft({ ...draft, name: event.target.value })
                      }
                      placeholder={t('automations.namePlaceholder')}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('automations.project')}</Label>
                    <Select
                      value={draft.projectId}
                      disabled={projects.length === 0}
                      onValueChange={(projectId) =>
                        setDraft({ ...draft, projectId })
                      }
                    >
                      <SelectTrigger
                        aria-label={t('automations.project')}
                        className="w-full"
                      >
                        <SelectValue
                          placeholder={t('automations.selectProject')}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {projects.map((project) => (
                          <SelectItem key={project.id} value={project.id}>
                            {project.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {projects.length === 0 ? (
                      <div
                        role="status"
                        className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"
                      >
                        <span>{t('automations.noProjects')}</span>
                        <Button asChild variant="link" size="sm">
                          <Link to="/local-projects">
                            {t('automations.addProject')}
                          </Link>
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label>{t('automations.prompt')}</Label>
                  <div className="rounded-lg border border-border bg-background p-2">
                    <SessionComposerInput
                      value={draft.prompt}
                      context={{
                        projectId: draft.projectId,
                        executorProfile: draft.executorProfileId,
                      }}
                      onChange={(prompt) => setDraft({ ...draft, prompt })}
                      onSubmit={() => void save()}
                      onAttachImages={() => {}}
                    />
                  </div>
                </div>

                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>{t('automations.trigger')}</Label>
                      <Select
                        value={draft.triggerKind}
                        onValueChange={(triggerKind: 'manual' | 'schedule') => {
                          setDraft({ ...draft, triggerKind });
                          setPreviewRuns([]);
                          setPreviewError(null);
                        }}
                      >
                        <SelectTrigger
                          aria-label={t('automations.trigger')}
                          className="w-full"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="manual">
                            {t('automations.triggerManual')}
                          </SelectItem>
                          <SelectItem value="schedule">
                            {t('automations.triggerCron')}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {draft.triggerKind === 'schedule' ? (
                      <div className="space-y-1.5">
                        <Label htmlFor="automation-schedule-time">
                          {t('automations.runTime')}
                        </Label>
                        <Input
                          id="automation-schedule-time"
                          type="time"
                          value={draft.scheduleTime}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              scheduleTime: event.target.value,
                            })
                          }
                        />
                      </div>
                    ) : null}
                  </div>
                  {draft.triggerKind === 'schedule' ? (
                    <div className="mt-3 space-y-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="automation-timezone">
                          {t('automations.timezone')}
                        </Label>
                        <Input
                          id="automation-timezone"
                          value={draft.timezone}
                          onChange={(event) =>
                            setDraft({ ...draft, timezone: event.target.value })
                          }
                          placeholder="Area/City"
                        />
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void previewSchedule()}
                          disabled={
                            previewing ||
                            !draft.timezone.trim() ||
                            !draft.scheduleTime
                          }
                        >
                          {previewing ? (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Clock3 className="mr-1.5 h-3.5 w-3.5" />
                          )}
                          {t('automations.previewNextRuns')}
                        </Button>
                        <code className="text-xs text-foreground">
                          {dailyCron(draft.scheduleTime)}
                        </code>
                      </div>
                      {previewError ? (
                        <p role="alert" className="text-xs text-destructive">
                          {t('automations.previewFailed', {
                            error: previewError,
                          })}
                        </p>
                      ) : null}
                      {previewRuns.length > 0 ? (
                        <ol
                          aria-label={t('automations.previewAria')}
                          className="grid gap-1 text-xs text-foreground sm:grid-cols-2"
                        >
                          {previewRuns.map((run) => (
                            <li key={run}>
                              <time dateTime={run}>
                                {formatLocalTime(run) ?? run}
                              </time>
                            </li>
                          ))}
                        </ol>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <Label>{t('automations.agentControls')}</Label>
                  {controlsLoading ? (
                    <p role="status" className="text-xs text-foreground">
                      {t('automations.agentControlsLoading')}
                    </p>
                  ) : controlsError ? (
                    <p role="alert" className="text-xs text-destructive">
                      {t('automations.agentControlsFailed', {
                        error: controlsError,
                      })}
                    </p>
                  ) : controls ? (
                    <SessionControlsFields
                      modes={controls.modes}
                      currentModeId={controls.current_mode ?? null}
                      configOptions={controls.config_options}
                      selectedModeId={draft.modeId}
                      pendingConfigValues={draft.configValues}
                      onSelectMode={(modeId) => setDraft({ ...draft, modeId })}
                      onSelectConfigValue={(key, value) =>
                        setDraft({
                          ...draft,
                          configValues: {
                            ...draft.configValues,
                            [key]: value,
                          },
                        })
                      }
                    />
                  ) : null}
                </div>

                <div className="space-y-2 rounded-lg border border-border p-3">
                  <Label>{t('automations.pluginAction')}</Label>
                  <PluginActionEditor
                    transport={transport}
                    value={draft.pluginAction}
                    onChange={(pluginAction) =>
                      setDraft({ ...draft, pluginAction })
                    }
                    onReadyChange={setPluginActionReady}
                  />
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>{t('automations.agent')}</Label>
                    <Select
                      value={draft.agentId}
                      onValueChange={(agentId) =>
                        setDraft({
                          ...draft,
                          agentId,
                          executorProfileId: {
                            executor: agentId,
                            variant: null,
                          },
                        })
                      }
                    >
                      <SelectTrigger
                        aria-label={t('automations.agent')}
                        className="w-full"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {agents.map((agent) => (
                          <SelectItem
                            key={agent.agent_id}
                            value={agent.agent_id}
                          >
                            {agent.display_name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('automations.isolation')}</Label>
                    <Select
                      value={draft.isolation}
                      onValueChange={(isolation: AutomationIsolation) =>
                        setDraft({ ...draft, isolation })
                      }
                    >
                      <SelectTrigger
                        aria-label={t('automations.isolation')}
                        className="w-full"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="worktree_per_run">
                          {t('automations.worktreePerRun')}
                        </SelectItem>
                        <SelectItem value="shared_in_root">
                          {t('automations.sharedInRoot')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {draft.isolation === 'shared_in_root' ? (
                  <div
                    role="alert"
                    className="flex gap-2 rounded-lg border border-destructive/35 bg-destructive/10 p-3 text-xs text-destructive"
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{t('automations.sharedRootRisk')}</span>
                  </div>
                ) : null}

                <div className="space-y-1.5">
                  <Label>{t('automations.branch')}</Label>
                  <RepoBranchSelector
                    configs={branchConfigs}
                    onBranchChange={setBranch}
                    isLoading={!selectedBranch}
                    showLabel={false}
                  />
                </div>

                <div className="flex items-center justify-between gap-3">
                  <label className="flex items-center gap-2 text-xs text-foreground">
                    <Switch
                      checked={draft.enabled}
                      onCheckedChange={(enabled) =>
                        setDraft({ ...draft, enabled })
                      }
                      aria-label={t('automations.enabled')}
                    />
                    {t('automations.enabled')}
                  </label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => closeDraft()}
                      disabled={saving}
                    >
                      {t('common:cancel')}
                    </Button>
                    <Button
                      type="submit"
                      className="bg-foreground text-background hover:bg-foreground/90"
                      disabled={saving || !pluginActionReady}
                    >
                      {saving ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : null}
                      {t('common:save')}
                    </Button>
                  </div>
                </div>
              </form>
            ) : null}
          </div>
        )}
      </SettingsSection>
      {runError ? (
        <div role="alert" className="text-xs text-destructive">
          {t('automations.runFailed', { error: runError })}
        </div>
      ) : null}
      {templates.length > 0 && !draft && !editorOnly ? (
        <SettingsSection
          icon={LayoutTemplate}
          title={t('automations.templatesTitle')}
          description={t('automations.templatesDescription')}
          descriptionClassName="text-foreground"
        >
          <div className="grid gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3">
            {templates.map((template) => (
              <Button
                key={template.id}
                type="button"
                variant="outline"
                className="h-auto justify-start px-3 py-2 text-left"
                onClick={() => startTemplate(template)}
                disabled={!engineActive}
                aria-label={t('automations.useTemplateNamed', {
                  name: template.draft.name,
                })}
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">
                    {template.draft.name}
                  </span>
                  <span className="mt-0.5 block line-clamp-2 text-[11px] font-normal text-foreground">
                    {template.draft.launch.displayText}
                  </span>
                </span>
              </Button>
            ))}
          </div>
        </SettingsSection>
      ) : null}
    </div>
  );
}

function AutomationList({
  automations,
  editingId,
  onEdit,
  onToggle,
  onRemove,
  onRun,
  onShowHistory,
  onCancelRun,
  runsByAutomation,
  historyOpenId,
  mutable,
  t,
}: {
  automations: AutomationView[];
  editingId: string | null;
  onEdit: (automation: AutomationView) => void;
  onToggle: (automation: AutomationView, enabled: boolean) => void;
  onRemove: (automation: AutomationView) => void;
  onRun: (automation: AutomationView) => void;
  onShowHistory: (automation: AutomationView) => void;
  onCancelRun: (run: AutomationRunView) => void;
  runsByAutomation: Record<string, AutomationRunView[]>;
  historyOpenId: string | null;
  mutable: boolean;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  if (automations.length === 0) {
    return (
      <div className="flex min-h-32 flex-col items-center justify-center gap-1 px-6 py-8 text-center">
        <Clock3 className="h-5 w-5 text-muted-foreground" />
        <p className="text-sm font-medium">{t('automations.emptyTitle')}</p>
        <p className="max-w-[55ch] text-xs text-foreground">
          {t('automations.empty')}
        </p>
      </div>
    );
  }

  return (
    <ul
      aria-label={t('automations.listAria')}
      className="divide-y divide-border"
    >
      {automations.map((automation) => (
        <li
          key={automation.id}
          className={
            editingId === automation.id ? 'bg-accent/35 px-3 py-3' : 'px-3 py-3'
          }
        >
          <div className="flex items-start justify-between gap-3">
            <button
              type="button"
              className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onEdit(automation)}
              disabled={!mutable}
            >
              <span className="block truncate text-sm font-medium">
                {automation.name}
              </span>
              <span className="mt-0.5 block text-[11px] text-foreground">
                {t(
                  automation.target?.kind === 'workflow'
                    ? 'automations.targetWorkflow'
                    : 'automations.targetTurn'
                )}
                {' · '}
                {automation.trigger.kind === 'schedule'
                  ? t('automations.cronSummary', {
                      cron: automation.trigger.cron,
                    })
                  : t('automations.triggerManual')}
                {automation.nextRunAt
                  ? ` · ${t('automations.nextRun', {
                      time: formatLocalTime(automation.nextRunAt),
                    })}`
                  : ''}
                {automation.lastRunStatus
                  ? ` · ${t('automations.lastRunStatus', {
                      status: t(
                        `automations.status.${automation.lastRunStatus}`
                      ),
                    })}`
                  : ''}
              </span>
            </button>
            <Switch
              checked={automation.enabled}
              onCheckedChange={(enabled) => onToggle(automation, enabled)}
              aria-label={t('automations.toggleAria', {
                name: automation.name,
              })}
              disabled={!mutable || automation.target?.kind === 'workflow'}
            />
          </div>
          <div className="mt-2 flex items-center justify-end gap-1">
            {automation.unseenFailureCount > 0 ? (
              <span className="mr-auto text-[11px] font-medium text-destructive">
                {t('automations.unseenFailures', {
                  count: automation.unseenFailureCount,
                })}
              </span>
            ) : automation.migrationRequired ? (
              <span className="mr-auto text-[11px] font-medium text-destructive">
                {t('automations.migrationRequired')}
              </span>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => onEdit(automation)}
              disabled={!mutable || automation.target?.kind === 'workflow'}
              aria-label={t('automations.editNamed', {
                name: automation.name,
              })}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => onRun(automation)}
              disabled={
                !mutable || !automation.enabled || automation.migrationRequired
              }
              aria-label={t('automations.runNamed', {
                name: automation.name,
              })}
            >
              <Play className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => onShowHistory(automation)}
              aria-label={t('automations.historyNamed', {
                name: automation.name,
              })}
            >
              <History className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-destructive"
              onClick={() => onRemove(automation)}
              disabled={!mutable}
              aria-label={t('automations.deleteNamed', {
                name: automation.name,
              })}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
          {historyOpenId === automation.id ? (
            <RunHistory
              runs={runsByAutomation[automation.id] ?? []}
              onCancel={onCancelRun}
              t={t}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function RunHistory({
  runs,
  onCancel,
  t,
}: {
  runs: AutomationRunView[];
  onCancel: (run: AutomationRunView) => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  if (runs.length === 0) {
    return (
      <p className="mt-2 text-[11px] text-foreground">
        {t('automations.noRuns')}
      </p>
    );
  }
  return (
    <ol
      aria-label={t('automations.runHistoryAria')}
      className="mt-2 space-y-1 border-t border-border/70 pt-2"
    >
      {runs.map((run) => (
        <li
          key={run.id}
          className="flex items-start justify-between gap-2 rounded-md bg-muted/35 px-2 py-1.5 text-[11px]"
        >
          <span className="min-w-0">
            <span className="block font-medium">
              {t(`automations.status.${run.status}`)}
            </span>
            {run.summary || run.error || run.stopReason ? (
              <span className="block truncate text-foreground">
                {run.summary ?? run.error ?? run.stopReason}
              </span>
            ) : null}
            {run.workflowRunId ? (
              <Link
                className="mt-0.5 block text-primary underline-offset-2 hover:underline"
                to={`/workflows/${run.workflowRunId}`}
              >
                {t('automations.openWorkflow')}
              </Link>
            ) : null}
          </span>
          {run.status === 'running' ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => onCancel(run)}
            >
              {t('automations.cancelRun')}
            </Button>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
