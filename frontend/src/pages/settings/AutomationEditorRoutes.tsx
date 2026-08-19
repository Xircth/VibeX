import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Copy, FileInput, Loader2 } from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  WorkflowDefinition,
  WorkflowEventRecord,
  WorkflowRunView,
  WorkflowStepView,
  WorkflowVersionView,
  Workspace,
} from 'shared/types';

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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { deriveWorkspaceRootPath } from '@/components/panels/workspaceRootPath';
import { useManagedAgentOptions } from '@/features/agent-management';
import {
  loadAgentSessionControlsCatalog,
  sessionControlsQueryKey,
} from '@/features/agents/sessionControlsQuery';
import { WorkflowStudio } from '@/features/workflow/WorkflowStudio';
import { WorkflowTestWorkspaceDialog } from '@/features/workflow/WorkflowTestWorkspaceDialog';
import { createWorkflowApi } from '@/features/workflow/workflowApi';
import {
  loadWorkflowTestWorkspace,
  rememberTestWorkspace,
  saveWorkflowTestWorkspace,
  type WorkflowTestWorkspaceMode,
} from '@/features/workflow/workflowTestWorkspaceStore';
import {
  loadWorkflowEventsAfter,
  waitForWorkflowStepConversation,
} from '@/features/workflow/workflowProjection';
import {
  createWorkflowSourceApi,
  resolveWorkflowSourceRevision,
} from '@/features/workflow/workflowSourceApi';
import {
  createAutomationApi,
  type AutomationSchedule,
  type AutomationView,
} from '@/lib/api/automations';
import { useBackendTransport } from '@/lib/transport';
import { getUiLanguage } from '@/lib/uiLanguage';
import { AutomationsSettings } from './AutomationsSettings';

type Project = { id: string; name: string };
type Repo = {
  id: string;
  name: string;
  path: string;
  display_name: string;
  default_target_branch?: string | null;
};

type WorkspaceMode = 'existing' | 'new';

const BASE_AGENT_STEP: Extract<
  WorkflowDefinition['steps'][number],
  { kind: 'agent' }
> = {
  id: 'start',
  dependsOn: [],
  phase: null,
  inputBindings: {},
  kind: 'agent',
  agentId: 'codex',
  prompt: '',
  executorProfileId: null,
  modeOverride: null,
  configOverrides: {},
  outputLanguage: getUiLanguage(),
  outputDescription: null,
  outputSchema: {
    type: 'object',
    required: ['summary'],
    properties: { summary: { type: 'string' } },
  },
  workspaceAccess: 'native',
  sideEffectClass: 'mutating_unknown',
  allowOneRepair: false,
  allowSkipOnReview: false,
  completionPolicy: 'manual',
};

const SIMPLE_WORKFLOW: WorkflowDefinition = {
  formatVersion: 1,
  name: 'New Workflow',
  description: null,
  inputSchema: { type: 'object' },
  steps: [BASE_AGENT_STEP],
  policy: {
    maxConcurrentAgentSteps: 2,
    maxAgentCalls: 20,
    deadlineSeconds: 3600,
    maxOutputBytes: 1048576,
  },
};

const RESEARCH_WORKFLOW: WorkflowDefinition = {
  ...SIMPLE_WORKFLOW,
  name: 'Research brief',
  description:
    'Research in parallel, synthesize the evidence, review, and publish.',
  steps: [
    {
      ...BASE_AGENT_STEP,
      id: 'research-primary',
      prompt:
        'Research primary sources for the requested topic. Return findings with source URLs.',
      outputSchema: {
        type: 'object',
        required: ['findings'],
        properties: { findings: { type: 'array' } },
      },
      completionPolicy: 'automatic',
    },
    {
      ...BASE_AGENT_STEP,
      id: 'research-risks',
      prompt:
        'Challenge the request and identify risks, unknowns, and contradictory evidence.',
      outputSchema: {
        type: 'object',
        required: ['risks'],
        properties: { risks: { type: 'array' } },
      },
      completionPolicy: 'automatic',
    },
    {
      ...BASE_AGENT_STEP,
      id: 'synthesize',
      dependsOn: ['research-primary', 'research-risks'],
      prompt:
        'Synthesize the accepted upstream results into a decision-ready brief.',
      completionPolicy: 'manual',
    },
    {
      id: 'approve',
      dependsOn: ['synthesize'],
      phase: null,
      inputBindings: {},
      kind: 'approval',
      title: 'Approve publication',
      decisionSchema: {
        type: 'object',
        required: ['approved'],
        properties: { approved: { type: 'boolean' } },
      },
      approverScope: 'workflow.approve',
      skippable: false,
    },
  ],
};

function serializeDefinition(definition: WorkflowDefinition) {
  return JSON.stringify(
    definition,
    (_key, value) => (typeof value === 'bigint' ? Number(value) : value),
    2
  );
}

function joinPath(root: string, relative: string) {
  return `${root.replace(/\/$/, '')}/${relative.replace(/^\//, '')}`;
}

function workflowSourceFilePath(root: string, sourcePath: string) {
  return sourcePath.startsWith('~/') || sourcePath.startsWith('/')
    ? sourcePath
    : joinPath(root, sourcePath);
}

function releaseVersionFromInternal(version: bigint | null | undefined) {
  return (Number(version ?? 0n) / 10).toFixed(1);
}

function nextReleaseVersion(version: bigint | null | undefined) {
  return (Number(version ?? 0n) / 10 + 0.1).toFixed(1);
}

type ScheduleTimer = {
  mode: 'once' | 'repeat';
  repeatKind: 'daily' | 'monthly';
  // once schedule date
  onceYear: number;
  onceMonth: number;
  onceDay: number;
  // monthly repeat day of month
  repeatDay: number;
  // HH:MM
  time: string;
};

function defaultTimer(): ScheduleTimer {
  const now = new Date();
  return {
    mode: 'repeat',
    repeatKind: 'daily',
    onceYear: now.getFullYear(),
    onceMonth: now.getMonth() + 1,
    onceDay: now.getDate(),
    repeatDay: 1,
    time: '09:00',
  };
}

function timerToCron(timer: ScheduleTimer): string {
  const [hour = '0', minute = '0'] = timer.time.split(':');
  const h = Number(hour);
  const m = Number(minute);
  if (timer.mode === 'once') {
    return `${m} ${h} ${timer.onceDay} ${timer.onceMonth} * ${timer.onceYear}`;
  }
  if (timer.repeatKind === 'monthly') {
    return `${m} ${h} ${timer.repeatDay} * *`;
  }
  return `${m} ${h} * * *`;
}

function cronToTimer(cron: string): ScheduleTimer {
  const fields = cron.trim().split(/\s+/);
  const minute = Number(fields[0] ?? 0);
  const hour = Number(fields[1] ?? 9);
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const now = new Date();
  const base = {
    ...defaultTimer(),
    time,
  };
  if (fields.length === 6) {
    return {
      ...base,
      mode: 'once',
      onceYear: Number(fields[5] ?? now.getFullYear()),
      onceMonth: Number(fields[3] ?? 1),
      onceDay: Number(fields[2] ?? 1),
    };
  }
  if (fields.length === 5 && fields[2] !== '*' && fields[4] === '*') {
    return {
      ...base,
      mode: 'repeat',
      repeatKind: 'monthly',
      repeatDay: Number(fields[2] ?? 1),
    };
  }
  return {
    ...base,
    mode: 'repeat',
    repeatKind: 'daily',
  };
}

function daysInMonth(year: number, month: number) {
  return new Date(year, month, 0).getDate();
}

export function TurnAutomationEditorRoute() {
  const navigate = useNavigate();
  const { t } = useTranslation('settings');
  const { automationId } = useParams<{ automationId: string }>();
  const [search] = useSearchParams();
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/settings/automations')}
        >
          <ArrowLeft className="mr-1.5 size-3.5" /> {t('automations.pageTitle')}
        </Button>
        <AutomationJsonActions automationId={automationId} />
      </div>
      <AutomationsSettings
        editorOnly
        automationId={automationId ?? null}
        templateId={search.get('template')}
        onSaved={() => navigate('/settings/automations')}
        onCancel={() => navigate('/settings/automations')}
      />
    </div>
  );
}

function AutomationJsonActions({ automationId }: { automationId?: string }) {
  const navigate = useNavigate();
  const { t } = useTranslation('settings');
  const transport = useBackendTransport();
  const api = useMemo(() => createAutomationApi(transport), [transport]);
  const [open, setOpen] = useState(false);
  const [json, setJson] = useState('');
  const [importing, setImporting] = useState(false);

  return (
    <>
      <div className="flex items-center gap-1.5">
        {automationId ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void api
                .exportSpec(automationId)
                .then((value) => navigator.clipboard.writeText(value))
                .then(() => toast.success(t('automations.jsonCopied')))
                .catch((error) =>
                  toast.error(
                    error instanceof Error ? error.message : String(error)
                  )
                );
            }}
          >
            <Copy className="mr-1.5 size-3.5" />{' '}
            {t('automations.copyJsonShort')}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          <FileInput className="mr-1.5 size-3.5" />{' '}
          {t('automations.importJson')}
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogHeader>
          <DialogTitle>{t('automations.importTitle')}</DialogTitle>
          <DialogDescription>
            {t('automations.importEditorDescription')}
          </DialogDescription>
        </DialogHeader>
        <DialogContent>
          <Textarea
            className="min-h-72 font-mono text-xs"
            value={json}
            onChange={(event) => setJson(event.target.value)}
            placeholder={'{\n  "formatVersion": 1,\n  …\n}'}
          />
        </DialogContent>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            {t('automations.cancel')}
          </Button>
          <Button
            disabled={!json.trim() || importing}
            onClick={() => {
              setImporting(true);
              void api
                .importSpec(json)
                .then((created) => {
                  setOpen(false);
                  navigate(`/settings/automations/${created.id}/edit`);
                  toast.success(t('automations.importedDisabled'));
                })
                .catch((error) =>
                  toast.error(
                    error instanceof Error ? error.message : String(error)
                  )
                )
                .finally(() => setImporting(false));
            }}
          >
            {importing ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : null}
            {t('automations.importDisabled')}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

export function AutomationEditRoute() {
  const { t } = useTranslation('settings');
  const { automationId } = useParams<{ automationId: string }>();
  const transport = useBackendTransport();
  const api = useMemo(() => createAutomationApi(transport), [transport]);
  const [automation, setAutomation] = useState<AutomationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!automationId) return;
    void api
      .list()
      .then((items) => {
        const found = items.find((item) => item.id === automationId);
        if (!found)
          throw new Error(
            t('automations.automationNotFound', { id: automationId })
          );
        setAutomation(found);
      })
      .catch((loadError) =>
        setError(
          loadError instanceof Error ? loadError.message : String(loadError)
        )
      );
  }, [api, automationId, t]);
  if (error)
    return (
      <p role="alert" className="p-6 text-sm text-destructive">
        {error}
      </p>
    );
  if (!automation) {
    return (
      <div className="grid min-h-52 place-items-center text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }
  return automation.target.kind === 'workflow' ? (
    <WorkflowAutomationEditor automation={automation} />
  ) : (
    <TurnAutomationEditorRoute />
  );
}

export function WorkflowAutomationEditorRoute() {
  const [search] = useSearchParams();
  return <WorkflowAutomationEditor template={search.get('template')} />;
}

function WorkflowAutomationEditor({
  automation: initialAutomation = null,
  template = null,
}: {
  automation?: AutomationView | null;
  template?: string | null;
}) {
  const navigate = useNavigate();
  const { t } = useTranslation(['settings', 'common']);
  const transport = useBackendTransport();
  const queryClient = useQueryClient();
  const automationApi = useMemo(
    () => createAutomationApi(transport),
    [transport]
  );
  const workflowApi = useMemo(() => createWorkflowApi(transport), [transport]);
  const sourceApi = useMemo(
    () => createWorkflowSourceApi(transport),
    [transport]
  );
  const agentOptions = useManagedAgentOptions(undefined, true);
  const loadAgentSessionControls = useCallback(
    (agentId: string) =>
      queryClient.fetchQuery({
        queryKey: sessionControlsQueryKey(agentId, null),
        queryFn: () => loadAgentSessionControlsCatalog(agentId),
        staleTime: 60_000,
        gcTime: Infinity,
      }),
    [queryClient]
  );
  const [automation, setAutomation] = useState(initialAutomation);
  const [definition, setDefinition] = useState<WorkflowDefinition>(() => {
    const next = structuredClone(
      template === 'research-brief' ? RESEARCH_WORKFLOW : SIMPLE_WORKFLOW
    );
    if (!initialAutomation) {
      next.name =
        template === 'research-brief'
          ? t('automations.researchTemplateTitle')
          : t('automations.newWorkflowName');
    }
    return next;
  });
  const [savedDefinition, setSavedDefinition] = useState(definition);
  const [version, setVersion] = useState<WorkflowVersionView | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [projectId, setProjectId] = useState(
    initialAutomation?.target.kind === 'workflow'
      ? initialAutomation.target.spec.workspace.projectId
      : ''
  );
  const [repo, setRepo] = useState<Repo | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(
    initialAutomation?.target.kind === 'workflow' &&
      initialAutomation.target.spec.workspace.isolation === 'shared_in_root'
      ? 'existing'
      : 'new'
  );
  const [workspaceId, setWorkspaceId] = useState('project-root');
  const [sourcePath, setSourcePath] = useState(
    '~/.vibex/workflows/new-workflow.vibex-workflow.json'
  );
  const [sourceRevision, setSourceRevision] = useState<string | null>(null);
  const [name, setName] = useState(initialAutomation?.name ?? definition.name);
  const [enabled, setEnabled] = useState(initialAutomation?.enabled ?? true);
  const [triggerKind, setTriggerKind] = useState<'manual' | 'schedule'>(
    initialAutomation?.trigger.kind ?? 'manual'
  );
  const [timer, setTimer] = useState<ScheduleTimer>(() =>
    cronToTimer(
      initialAutomation?.trigger.kind === 'schedule'
        ? initialAutomation.trigger.cron
        : '0 9 * * *'
    )
  );
  const [timezone, setTimezone] = useState(
    initialAutomation?.trigger.kind === 'schedule'
      ? initialAutomation.trigger.timezone
      : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  );
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishVersion, setPublishVersion] = useState(() =>
    nextReleaseVersion(null)
  );
  const [undoStack, setUndoStack] = useState<WorkflowDefinition[]>([]);
  const [debugRun, setDebugRun] = useState<WorkflowRunView | null>(null);
  const [debugWorkspace, setDebugWorkspace] = useState<Workspace | null>(null);
  const [testWorkspaceMode, setTestWorkspaceMode] =
    useState<WorkflowTestWorkspaceMode | null>(null);
  const [testWorkspaceId, setTestWorkspaceId] = useState<string | null>(null);
  const [testWorktrees, setTestWorktrees] = useState<Workspace[]>([]);
  const [testPickerOpen, setTestPickerOpen] = useState(false);
  const [pendingTestStepId, setPendingTestStepId] = useState<string | null>(
    null
  );
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleaningWorktrees, setCleaningWorktrees] = useState(false);
  const [debugSteps, setDebugSteps] = useState<WorkflowStepView[]>([]);
  const [debugEvents, setDebugEvents] = useState<WorkflowEventRecord[]>([]);
  const debugEventRunIdRef = useRef<string | null>(null);
  const debugEventHistoryRef = useRef<WorkflowEventRecord[]>([]);
  const dirty =
    serializeDefinition(definition) !== serializeDefinition(savedDefinition);
  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const workspaceRoot =
    workspaceMode === 'existing' && selectedWorkspace
      ? (deriveWorkspaceRootPath(selectedWorkspace, repos) ?? repo?.path ?? '')
      : (repo?.path ?? '');
  const workspaceBranch =
    workspaceMode === 'existing' && selectedWorkspace
      ? selectedWorkspace.branch
      : (repo?.default_target_branch ?? null);
  const testWorkspaceScope = automation?.id ?? sourcePath;

  const persistTestWorkspace = useCallback(
    (
      mode: WorkflowTestWorkspaceMode | null,
      workspaceId: string | null,
      workspaceIds: string[]
    ) => {
      saveWorkflowTestWorkspace(testWorkspaceScope, {
        mode,
        workspaceId,
        workspaceIds,
      });
    },
    [testWorkspaceScope]
  );

  const applyDefinition = useCallback((next: WorkflowDefinition) => {
    setDefinition((current) => {
      if (serializeDefinition(current) === serializeDefinition(next))
        return current;
      setUndoStack((stack) => [...stack.slice(-39), current]);
      return next;
    });
  }, []);

  const undoDefinition = useCallback(() => {
    setUndoStack((stack) => {
      const previous = stack.at(-1);
      if (!previous) return stack;
      setDefinition(previous);
      setName(previous.name);
      return stack.slice(0, -1);
    });
  }, []);

  useEffect(() => {
    void transport.call('get_projects').then((value) => {
      const loaded = Array.isArray(value) ? (value as Project[]) : [];
      setProjects(loaded);
      setProjectId((current) => current || loaded[0]?.id || '');
    });
  }, [transport]);

  useEffect(() => {
    if (!projectId) return;
    void Promise.all([
      transport.call('get_project_repositories', { id: projectId }),
      transport.call('get_project_workspaces', { projectId }),
    ]).then(([repositoryValue, workspaceValue]) => {
      const loaded = Array.isArray(repositoryValue)
        ? (repositoryValue as Repo[])
        : [];
      const loadedWorkspaces = Array.isArray(workspaceValue)
        ? (workspaceValue as Workspace[])
        : [];
      setRepos(loaded);
      setWorkspaces(loadedWorkspaces);
      const saved = loadWorkflowTestWorkspace(testWorkspaceScope);
      const known = new Map(
        loadedWorkspaces.map((workspace) => [workspace.id, workspace])
      );
      const remembered = saved.workspaceIds
        .map((id) => known.get(id))
        .filter((workspace): workspace is Workspace => Boolean(workspace));
      const extras = loadedWorkspaces.filter(
        (workspace) =>
          workspace.use_worktree &&
          Boolean(workspace.name?.trim().endsWith(' Debug'))
      );
      const merged = [
        ...new Map(
          [...remembered, ...extras].map((workspace) => [
            workspace.id,
            workspace,
          ])
        ).values(),
      ];
      setTestWorktrees(merged);
      setTestWorkspaceMode(saved.mode);
      const restoredId =
        saved.workspaceId && known.has(saved.workspaceId)
          ? saved.workspaceId
          : (merged[0]?.id ?? null);
      setTestWorkspaceId(restoredId);
      if (restoredId) {
        setDebugWorkspace(known.get(restoredId) ?? null);
      }
      setRepo((current) => {
        if (current && loaded.some((item) => item.id === current.id))
          return current;
        if (initialAutomation?.target.kind === 'workflow') {
          return (
            loaded.find(
              (item) =>
                item.path === initialAutomation.target.spec.workspace.rootFolder
            ) ??
            loaded[0] ??
            null
          );
        }
        return loaded[0] ?? null;
      });
      if (
        initialAutomation?.target.kind === 'workflow' &&
        initialAutomation.target.spec.workspace.isolation === 'shared_in_root'
      ) {
        const root = initialAutomation.target.spec.workspace.rootFolder;
        const matching = loadedWorkspaces.find(
          (workspace) => deriveWorkspaceRootPath(workspace, loaded) === root
        );
        setWorkspaceId(matching?.id ?? 'project-root');
      }
    });
  }, [initialAutomation, projectId, testWorkspaceScope, transport]);

  useEffect(() => {
    if (initialAutomation?.target.kind !== 'workflow') return;
    let active = true;
    void workflowApi
      .version(initialAutomation.target.spec.definitionVersionId)
      .then(async (loadedVersion) => {
        if (!active) return;
        setVersion(loadedVersion);
        const published = JSON.parse(
          loadedVersion.normalizedJson
        ) as WorkflowDefinition;
        const authoredPath =
          loadedVersion.sourcePath ??
          '~/.vibex/workflows/workflow.vibex-workflow.json';
        setSourcePath(authoredPath);
        const root = initialAutomation.target.spec.workspace.rootFolder;
        try {
          const source = await sourceApi.read(
            workflowSourceFilePath(root, authoredPath)
          );
          if (!active) return;
          const authored = JSON.parse(source.content) as WorkflowDefinition;
          setDefinition(authored);
          setSavedDefinition(authored);
          setUndoStack([]);
          setSourceRevision(source.revision);
        } catch {
          if (!active) return;
          setDefinition(published);
          setSavedDefinition(published);
          setUndoStack([]);
          setSourceRevision(null);
        }
      })
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : String(error))
      );
    return () => {
      active = false;
    };
  }, [initialAutomation, sourceApi, workflowApi]);

  const saveSource = useCallback(async () => {
    if (!repo) throw new Error(t('automations.selectRepository'));
    setSaving(true);
    try {
      await workflowApi.validate(definition);
      const filePath = workflowSourceFilePath(repo.path, sourcePath);
      const expectedRevision = await resolveWorkflowSourceRevision(
        sourceApi,
        filePath,
        sourceRevision
      );
      const result = await sourceApi.write(
        filePath,
        serializeDefinition(definition),
        expectedRevision ?? undefined
      );
      setSourceRevision(result.revision);
      setSavedDefinition(definition);
      toast.success(t('automations.sourceSaved'));
    } finally {
      setSaving(false);
    }
  }, [definition, repo, sourceApi, sourcePath, sourceRevision, t, workflowApi]);

  const publishAndApply = useCallback(async () => {
    if (!repo || !projectId)
      throw new Error(t('automations.selectProjectRepository'));
    if (dirty || !sourceRevision) await saveSource();
    const input: unknown = {};
    setPublishing(true);
    try {
      const published = await workflowApi.publish(
        definition,
        version?.definitionId,
        undefined,
        sourcePath
      );
      const trigger: AutomationSchedule =
        triggerKind === 'schedule'
          ? { kind: 'schedule', cron: timerToCron(timer), timezone }
          : { kind: 'manual' };
      const draft = {
        name: name.trim() || definition.name,
        enabled,
        trigger,
        launch: {
          specVersion: 1,
          definitionVersionId: published.id,
          input,
          policyOverride: null,
          workspace: {
            projectId,
            rootFolder: workspaceRoot,
            branch: workspaceBranch,
            isolation:
              workspaceMode === 'new'
                ? ('worktree_per_run' as const)
                : ('shared_in_root' as const),
          },
        },
      };
      const applied = automation
        ? await automationApi.updateWorkflow(automation.id, draft)
        : await automationApi.createWorkflow(draft);
      setAutomation(applied);
      setVersion(published);
      toast.success(t('automations.published'));
      if (!automation) {
        navigate(`/settings/automations/${applied.id}/edit`, { replace: true });
      }
      return { applied, published };
    } finally {
      setPublishing(false);
    }
  }, [
    automation,
    automationApi,
    definition,
    dirty,
    enabled,
    name,
    navigate,
    projectId,
    repo,
    saveSource,
    sourcePath,
    sourceRevision,
    timer,
    timezone,
    triggerKind,
    version?.definitionId,
    workspaceBranch,
    workspaceMode,
    workspaceRoot,
    t,
    workflowApi,
  ]);

  const refreshDebugRun = useCallback(
    async (runId: string) => {
      const existing =
        debugEventRunIdRef.current === runId
          ? debugEventHistoryRef.current
          : [];
      const cursor = existing.at(-1)?.sequence ?? 0n;
      const [nextRun, nextSteps, nextEvents] = await Promise.all([
        workflowApi.show(runId),
        workflowApi.steps(runId),
        loadWorkflowEventsAfter(workflowApi, runId, cursor),
      ]);
      const mergedEvents = [...existing, ...nextEvents];
      debugEventRunIdRef.current = runId;
      debugEventHistoryRef.current = mergedEvents;
      setDebugRun(nextRun);
      setDebugSteps(nextSteps);
      setDebugEvents(mergedEvents);
      return nextRun;
    },
    [workflowApi]
  );

  useEffect(() => {
    if (!debugRun?.id) return;
    if (
      ['completed', 'failed', 'cancelled', 'interrupted'].includes(
        debugRun.status
      )
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshDebugRun(debugRun.id).catch((error) =>
        toast.error(error instanceof Error ? error.message : String(error))
      );
    }, 1000);
    return () => window.clearInterval(timer);
  }, [debugRun?.id, debugRun?.status, refreshDebugRun]);

  const recordTestWorkspace = useCallback(
    (workspace: Workspace, mode: WorkflowTestWorkspaceMode = 'existing') => {
      setDebugWorkspace(workspace);
      setTestWorkspaceMode(mode);
      setTestWorkspaceId(workspace.id);
      setTestWorktrees((current) => {
        const next = current.some((item) => item.id === workspace.id)
          ? current
          : [...current, workspace];
        persistTestWorkspace(
          mode,
          workspace.id,
          next.map((item) => item.id)
        );
        return next;
      });
      rememberTestWorkspace(testWorkspaceScope, workspace.id, mode);
    },
    [persistTestWorkspace, testWorkspaceScope]
  );

  const createTestWorkspace = useCallback(async () => {
    const workspace = (await transport.call('create_workflow_debug_workspace', {
      projectId,
      name: `${name.trim() || definition.name} Debug`,
      repos: repos.map((item) => ({
        repo_id: item.id,
        target_branch: workspaceBranch ?? item.default_target_branch ?? '',
      })),
    })) as Workspace;
    recordTestWorkspace(workspace, 'existing');
    return workspace;
  }, [
    definition.name,
    name,
    projectId,
    recordTestWorkspace,
    repos,
    transport,
    workspaceBranch,
  ]);

  const startDebugRun = useCallback(
    async (
      stepId: string,
      choice?: { kind: 'existing'; id: string } | { kind: 'new' }
    ) => {
      if (!repo || !projectId)
        throw new Error(t('automations.selectProjectRepository'));
      if (dirty || !sourceRevision) await saveSource();
      const input: unknown = {};

      let targetWorkspaceId: string | undefined;
      if (!debugRun) {
        const mode = choice?.kind ?? testWorkspaceMode;
        const existingId =
          choice?.kind === 'existing' ? choice.id : testWorkspaceId;
        if (mode === 'new') {
          targetWorkspaceId = (await createTestWorkspace()).id;
        } else if (existingId) {
          const known =
            testWorktrees.find((item) => item.id === existingId) ??
            workspaces.find((item) => item.id === existingId) ??
            null;
          targetWorkspaceId = existingId;
          if (known) recordTestWorkspace(known);
        } else {
          targetWorkspaceId = (await createTestWorkspace()).id;
        }
      } else {
        targetWorkspaceId = debugWorkspace?.id;
      }

      const nextRun = await workflowApi.debug(definition, stepId, {
        definitionId: version?.definitionId,
        sourcePath,
        workspaceId: targetWorkspaceId,
        input,
        parentRunId: debugRun?.id,
        scope: 'node',
      });
      const runView = await refreshDebugRun(nextRun.id);
      toast.success(
        t(
          debugRun ? 'automations.debugRestarted' : 'automations.debugStarted',
          {
            step: stepId,
          }
        )
      );
      return runView;
    },
    [
      createTestWorkspace,
      debugRun,
      debugWorkspace,
      definition,
      dirty,
      projectId,
      recordTestWorkspace,
      refreshDebugRun,
      repo,
      saveSource,
      sourcePath,
      sourceRevision,
      t,
      testWorkspaceId,
      testWorkspaceMode,
      testWorktrees,
      version?.definitionId,
      workflowApi,
      workspaces,
    ]
  );

  const workspaceConfig = (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>{t('automations.project')}</Label>
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger>
            <SelectValue placeholder={t('automations.selectProject')} />
          </SelectTrigger>
          <SelectContent>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label>{t('automations.runtimeWorkspace')}</Label>
        <Select
          value={workspaceMode}
          onValueChange={(value: WorkspaceMode) => setWorkspaceMode(value)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="existing">
              {t('automations.existingWorkspace')}
            </SelectItem>
            <SelectItem value="new">{t('automations.newWorkspace')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {workspaceMode === 'existing' ? (
        <div className="space-y-1.5">
          <Label>{t('automations.workspaceLocation')}</Label>
          <Select value={workspaceId} onValueChange={setWorkspaceId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="project-root">
                {t('automations.projectDirectory')}
              </SelectItem>
              {workspaces
                .filter((workspace) => workspace.use_worktree)
                .map((workspace) => (
                  <SelectItem key={workspace.id} value={workspace.id}>
                    {workspace.name || workspace.branch}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label>{t('automations.workspaceLocation')}</Label>
          <div className="flex h-8 items-center rounded-lg bg-[var(--surface-control)] px-2.5 text-xs text-muted-foreground">
            {t('automations.worktreePerRun')}
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <Label>{t('automations.testWorkspace')}</Label>
        <Select
          value={testWorkspaceMode ?? undefined}
          onValueChange={(value: WorkflowTestWorkspaceMode) => {
            setTestWorkspaceMode(value);
            persistTestWorkspace(
              value,
              testWorkspaceId,
              testWorktrees.map((item) => item.id)
            );
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder={t('automations.chooseTestWorkspace')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="existing">
              {t('automations.existingWorkspace')}
            </SelectItem>
            <SelectItem value="new">{t('automations.newWorkspace')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {testWorkspaceMode === 'existing' ? (
        <div className="space-y-1.5">
          <Label>{t('automations.workspaceLocation')}</Label>
          <Select
            value={testWorkspaceId ?? undefined}
            onValueChange={(value) => {
              setTestWorkspaceId(value);
              const known =
                testWorktrees.find((item) => item.id === value) ??
                workspaces.find((item) => item.id === value);
              if (known) recordTestWorkspace(known);
              else
                persistTestWorkspace(
                  'existing',
                  value,
                  testWorktrees.map((item) => item.id)
                );
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {testWorktrees.map((workspace) => (
                <SelectItem key={workspace.id} value={workspace.id}>
                  {workspace.name?.trim() || workspace.branch}
                </SelectItem>
              ))}
              {workspaces
                .filter(
                  (workspace) =>
                    workspace.use_worktree &&
                    !testWorktrees.some((item) => item.id === workspace.id)
                )
                .map((workspace) => (
                  <SelectItem key={workspace.id} value={workspace.id}>
                    {workspace.name || workspace.branch}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label>{t('automations.sourceArtifact')}</Label>
        <Input
          className="font-mono text-[11px]"
          value={sourcePath}
          onChange={(event) => setSourcePath(event.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label>{t('automations.trigger')}</Label>
        <Select
          value={triggerKind}
          onValueChange={(value: 'manual' | 'schedule') =>
            setTriggerKind(value)
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="manual">
              {t('automations.triggerManual')}
            </SelectItem>
            <SelectItem value="schedule">
              {t('automations.schedule')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {triggerKind === 'schedule' ? (
        <>
          <div className="space-y-1.5">
            <Label>{t('automations.scheduleMode')}</Label>
            <Select
              value={timer.mode}
              onValueChange={(value: ScheduleTimer['mode']) =>
                setTimer((current) => ({ ...current, mode: value }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="once">
                  {t('automations.scheduleOnce')}
                </SelectItem>
                <SelectItem value="repeat">
                  {t('automations.scheduleRepeat')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {timer.mode === 'once' ? (
            <div className="space-y-1.5">
              <Label>{t('automations.scheduleDate')}</Label>
              <div className="grid grid-cols-3 gap-1.5">
                <Select
                  value={String(timer.onceYear)}
                  onValueChange={(value) =>
                    setTimer((current) => ({
                      ...current,
                      onceYear: Number(value),
                    }))
                  }
                >
                  <SelectTrigger aria-label={t('automations.year')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from(
                      { length: 8 },
                      (_, index) => new Date().getFullYear() + index
                    ).map((year) => (
                      <SelectItem key={year} value={String(year)}>
                        {year}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={String(timer.onceMonth)}
                  onValueChange={(value) =>
                    setTimer((current) => ({
                      ...current,
                      onceMonth: Number(value),
                    }))
                  }
                >
                  <SelectTrigger aria-label={t('automations.month')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 12 }, (_, index) => index + 1).map(
                      (month) => (
                        <SelectItem key={month} value={String(month)}>
                          {month}
                        </SelectItem>
                      )
                    )}
                  </SelectContent>
                </Select>
                <Select
                  value={String(timer.onceDay)}
                  onValueChange={(value) =>
                    setTimer((current) => ({
                      ...current,
                      onceDay: Number(value),
                    }))
                  }
                >
                  <SelectTrigger aria-label={t('automations.day')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from(
                      { length: daysInMonth(timer.onceYear, timer.onceMonth) },
                      (_, index) => index + 1
                    ).map((day) => (
                      <SelectItem key={day} value={String(day)}>
                        {day}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>{t('automations.repeatKind')}</Label>
              <Select
                value={timer.repeatKind}
                onValueChange={(value: ScheduleTimer['repeatKind']) =>
                  setTimer((current) => ({ ...current, repeatKind: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">
                    {t('automations.repeatDaily')}
                  </SelectItem>
                  <SelectItem value="monthly">
                    {t('automations.repeatMonthly')}
                  </SelectItem>
                </SelectContent>
              </Select>
              {timer.repeatKind === 'monthly' ? (
                <Select
                  value={String(timer.repeatDay)}
                  onValueChange={(value) =>
                    setTimer((current) => ({
                      ...current,
                      repeatDay: Number(value),
                    }))
                  }
                >
                  <SelectTrigger aria-label={t('automations.day')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 31 }, (_, index) => index + 1).map(
                      (day) => (
                        <SelectItem key={day} value={String(day)}>
                          {day}
                        </SelectItem>
                      )
                    )}
                  </SelectContent>
                </Select>
              ) : null}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="automation-schedule-time">
              {t('automations.runTime')}
            </Label>
            <Input
              id="automation-schedule-time"
              type="time"
              value={timer.time}
              onChange={(event) =>
                setTimer((current) => ({
                  ...current,
                  time: event.target.value,
                }))
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t('automations.timezone')}</Label>
            <Input
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            />
          </div>
        </>
      ) : null}

      <label className="flex items-center gap-2 py-1 text-xs">
        <Switch checked={enabled} onCheckedChange={setEnabled} />
        {t('automations.enabled')}
      </label>
    </div>
  );

  return (
    <>
      <div className="flex h-[calc(100dvh-32px)] min-h-[560px] flex-col overflow-hidden rounded-lg border bg-card">
        <WorkflowStudio
          definition={definition}
          onDefinitionChange={applyDefinition}
          run={debugRun}
          steps={debugSteps}
          events={debugEvents}
          dirty={dirty || !sourceRevision}
          saving={saving}
          publishing={publishing}
          editorName={name}
          onEditorNameChange={(nextName) => {
            setName(nextName);
            applyDefinition({ ...definition, name: nextName });
          }}
          releaseVersion={releaseVersionFromInternal(version?.version)}
          agentOptions={agentOptions}
          loadAgentSessionControls={loadAgentSessionControls}
          workspaceConfig={workspaceConfig}
          workspaceSummary={t('automations.workspace')}
          notifyContext={
            projectId && (debugWorkspace?.id || selectedWorkspace?.id)
              ? {
                  projectId,
                  workspaceId:
                    debugWorkspace?.id ?? selectedWorkspace?.id ?? '',
                }
              : null
          }
          activeWorktree={
            debugWorkspace
              ? {
                  name: debugWorkspace.name?.trim() || debugWorkspace.branch,
                  path: debugWorkspace.container_ref ?? '',
                }
              : selectedWorkspace && workspaceMode === 'existing'
                ? {
                    name:
                      selectedWorkspace.name?.trim() ||
                      selectedWorkspace.branch,
                    path:
                      deriveWorkspaceRootPath(selectedWorkspace, repos) ??
                      repo?.path ??
                      '',
                  }
                : null
          }
          onBack={() => navigate('/settings/automations')}
          canUndo={undoStack.length > 0}
          onUndo={undoDefinition}
          showStopActions
          stopActionsDisabled={!debugRun}
          resetDisabled={!debugRun}
          onReset={() => {
            if (
              debugRun &&
              !['completed', 'failed', 'cancelled', 'interrupted'].includes(
                debugRun.status
              )
            ) {
              void workflowApi
                .cancel(debugRun.id, 'Reset from the Workflow editor')
                .catch((error) =>
                  toast.error(
                    error instanceof Error ? error.message : String(error)
                  )
                );
            }
            setDebugRun(null);
            setDebugSteps([]);
            setDebugEvents([]);
            debugEventRunIdRef.current = null;
            debugEventHistoryRef.current = [];
          }}
          onStopRun={() => {
            if (!debugRun) return;
            void workflowApi
              .pause(debugRun.id, 'Paused from the Workflow editor')
              .then(() => refreshDebugRun(debugRun.id))
              .catch((error) =>
                toast.error(
                  error instanceof Error ? error.message : String(error)
                )
              );
          }}
          onTerminateRun={() => {
            if (!debugRun) return;
            void workflowApi
              .cancel(debugRun.id, 'Terminated from the Workflow editor')
              .then(() => refreshDebugRun(debugRun.id))
              .catch((error) =>
                toast.error(
                  error instanceof Error ? error.message : String(error)
                )
              );
          }}
          onPauseStep={(stepId) => {
            if (!debugRun) return;
            void workflowApi
              .pauseStep(debugRun.id, stepId, 'Paused in node conversation')
              .then(() => refreshDebugRun(debugRun.id))
              .catch((error) =>
                toast.error(
                  error instanceof Error ? error.message : String(error)
                )
              );
          }}
          onTestNode={async (stepId) => {
            if (!testWorkspaceMode) {
              setPendingTestStepId(stepId);
              setTestPickerOpen(true);
              return;
            }
            await startDebugRun(stepId).catch((error) =>
              toast.error(
                error instanceof Error ? error.message : String(error)
              )
            );
          }}
          onSubmitStepInput={async (stepId, text) => {
            const run = debugRun ?? (await startDebugRun(stepId));
            const latestStep = await waitForWorkflowStepConversation(
              workflowApi,
              run.id,
              stepId
            );
            if (latestStep?.status === 'running' && !latestStep.awaitingInput) {
              await workflowApi.pauseStep(
                run.id,
                stepId,
                'Paused for user guidance'
              );
            }
            await workflowApi.submitStepInput(run.id, stepId, text);
            await refreshDebugRun(run.id);
          }}
          onAcceptCandidate={(stepId) => {
            if (!debugRun) return;
            void workflowApi
              .acceptCandidate(debugRun.id, stepId)
              .then(() => refreshDebugRun(debugRun.id))
              .catch((error) =>
                toast.error(
                  error instanceof Error ? error.message : String(error)
                )
              );
          }}
          onSave={() =>
            void saveSource().catch((error) =>
              toast.error(
                error instanceof Error ? error.message : String(error)
              )
            )
          }
          onPublish={() => {
            setPublishVersion(nextReleaseVersion(version?.version));
            setPublishOpen(true);
          }}
        />
      </div>

      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogHeader>
          <DialogTitle>{t('automations.publishWorkflow')}</DialogTitle>
          <DialogDescription>
            {t('automations.publishWorkflowDescription')}
          </DialogDescription>
        </DialogHeader>
        <DialogContent>
          <div className="space-y-1.5">
            <Label htmlFor="workflow-release-version">
              {t('automations.version')}
            </Label>
            <Input
              id="workflow-release-version"
              className="font-mono"
              value={publishVersion}
              onChange={(event) => setPublishVersion(event.target.value)}
            />
          </div>
        </DialogContent>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setPublishOpen(false)}>
            {t('automations.cancel')}
          </Button>
          <Button
            disabled={publishing || !/^\d+\.\d+$/.test(publishVersion)}
            onClick={() => {
              const expected = nextReleaseVersion(version?.version);
              if (publishVersion !== expected) {
                toast.error(
                  t('automations.versionMustBeNext', { version: expected })
                );
                return;
              }
              void publishAndApply()
                .then(() => {
                  setPublishOpen(false);
                  if (testWorktrees.length) setCleanupOpen(true);
                })
                .catch((error) =>
                  toast.error(
                    error instanceof Error ? error.message : String(error)
                  )
                );
            }}
          >
            {publishing ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : null}
            {t('automations.publishVersion', { version: publishVersion })}
          </Button>
        </DialogFooter>
      </Dialog>

      <WorkflowTestWorkspaceDialog
        open={testPickerOpen}
        workspaces={[
          ...new Map(
            [
              ...testWorktrees,
              ...workspaces.filter((item) => item.use_worktree),
            ].map((workspace) => [workspace.id, workspace])
          ).values(),
        ]}
        defaultWorkspaceId={testWorkspaceId ?? debugWorkspace?.id}
        onOpenChange={(open) => {
          setTestPickerOpen(open);
          if (!open) setPendingTestStepId(null);
        }}
        onConfirm={(choice) => {
          setTestPickerOpen(false);
          const stepId = pendingTestStepId;
          setPendingTestStepId(null);
          if (choice.kind === 'existing') {
            const known =
              testWorktrees.find((item) => item.id === choice.id) ??
              workspaces.find((item) => item.id === choice.id);
            if (known) recordTestWorkspace(known);
            else {
              setTestWorkspaceMode('existing');
              setTestWorkspaceId(choice.id);
            }
          } else {
            setTestWorkspaceMode('new');
          }
          if (!stepId) return;
          void startDebugRun(stepId, choice).catch((error) =>
            toast.error(error instanceof Error ? error.message : String(error))
          );
        }}
      />

      <Dialog open={cleanupOpen} onOpenChange={setCleanupOpen}>
        <DialogHeader>
          <DialogTitle>{t('automations.deleteTestWorktreesTitle')}</DialogTitle>
          <DialogDescription>
            {t('automations.deleteTestWorktreesDescription')}
          </DialogDescription>
        </DialogHeader>
        <DialogContent>
          <ul className="max-h-56 space-y-2 overflow-auto text-sm">
            {testWorktrees.map((workspace) => (
              <li
                key={workspace.id}
                className="rounded-lg bg-muted/55 px-2.5 py-2"
              >
                <div className="truncate font-medium">
                  {workspace.name?.trim() || workspace.branch}
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {workspace.container_ref ?? workspace.branch}
                </div>
              </li>
            ))}
          </ul>
        </DialogContent>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setCleanupOpen(false)}>
            {t('automations.keepTestWorktrees')}
          </Button>
          <Button
            variant="destructive"
            disabled={cleaningWorktrees || testWorktrees.length === 0}
            onClick={() => {
              setCleaningWorktrees(true);
              void Promise.all(
                testWorktrees.map((workspace) =>
                  transport.call('delete_workspace', {
                    workspaceId: workspace.id,
                    deleteBranches: null,
                  })
                )
              )
                .then(() => {
                  setTestWorktrees([]);
                  setDebugWorkspace(null);
                  setCleanupOpen(false);
                })
                .catch((error) =>
                  toast.error(
                    t('automations.deleteTestWorktreesFailed', {
                      error:
                        error instanceof Error ? error.message : String(error),
                    })
                  )
                )
                .finally(() => setCleaningWorktrees(false));
            }}
          >
            {cleaningWorktrees ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : null}
            {t('automations.deleteTestWorktreesConfirm')}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
