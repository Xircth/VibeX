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

import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { useUserSystem } from '@/components/ConfigProvider';
import { deriveWorkspaceRootPath } from '@/components/panels/workspaceRootPath';
import { useManagedAgentOptions } from '@/features/agent-management';
import {
  loadAgentSessionControlsCatalog,
  sessionControlsQueryKey,
} from '@/features/agents/sessionControlsQuery';
import {
  AutomationWorkspaceConfigPanel,
  type AutomationProjectOption,
  type AutomationWorkspaceMode,
} from '@/features/workflow/AutomationWorkspaceConfigPanel';
import {
  RESEARCH_WORKFLOW,
  SIMPLE_WORKFLOW,
  cronToTimer,
  nextReleaseVersion,
  releaseVersionFromInternal,
  serializeDefinition,
  timerToCron,
  workflowSourceFilePath,
  type ScheduleTimer,
} from '@/features/workflow/automationEditorPresets';
import { useGuardedWorkflowRunPolling } from '@/features/workflow/useGuardedWorkflowRunPolling';
import {
  WorkflowStudio,
  toBackendWorkflowDefinition,
  toStudioWorkflowDefinition,
  validateStudioWorkflowExhaustively,
  type StudioWorkflowDefinition,
  type WorkflowStudioDefinitionInput,
} from '@/features/workflow/WorkflowStudio';
import {
  resolveWorkflowAgentId,
  withDefaultWorkflowAgent,
} from '@/features/workflow/workflowAgent';
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
import { AutomationsSettings } from './AutomationsSettings';

type Repo = {
  id: string;
  name: string;
  path: string;
  display_name: string;
  default_target_branch?: string | null;
};

function hydrateStudioDefinition(
  input: WorkflowStudioDefinitionInput
): StudioWorkflowDefinition {
  const hydrated = toStudioWorkflowDefinition(input);
  return {
    ...hydrated,
    orchestratorPreset: hydrated.orchestratorPreset ?? null,
  };
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
  const { t } = useTranslation(['settings', 'common', 'workflow']);
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
  const { config } = useUserSystem();
  const agentOptions = useManagedAgentOptions(undefined, true);
  const defaultAgentApplied = useRef(initialAutomation != null);
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
  const [definition, setDefinition] = useState<StudioWorkflowDefinition>(() => {
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
  const [savedDefinition, setSavedDefinition] =
    useState<StudioWorkflowDefinition>(definition);

  useEffect(() => {
    if (defaultAgentApplied.current || agentOptions.length === 0) return;
    const agentId = resolveWorkflowAgentId(
      agentOptions,
      config?.executor_profile?.executor
    );
    defaultAgentApplied.current = true;
    setDefinition((current) => withDefaultWorkflowAgent(current, agentId));
    setSavedDefinition((current) => withDefaultWorkflowAgent(current, agentId));
  }, [agentOptions, config?.executor_profile?.executor]);

  const [version, setVersion] = useState<WorkflowVersionView | null>(null);
  const [projects, setProjects] = useState<AutomationProjectOption[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [projectId, setProjectId] = useState(
    initialAutomation?.target.kind === 'workflow'
      ? initialAutomation.target.spec.workspace.projectId
      : ''
  );
  const [repo, setRepo] = useState<Repo | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<AutomationWorkspaceMode>(
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
  const [undoStack, setUndoStack] = useState<StudioWorkflowDefinition[]>([]);
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
      nextWorkspaceId: string | null,
      workspaceIds: string[]
    ) => {
      saveWorkflowTestWorkspace(testWorkspaceScope, {
        mode,
        workspaceId: nextWorkspaceId,
        workspaceIds,
      });
    },
    [testWorkspaceScope]
  );

  const applyDefinition = useCallback((next: StudioWorkflowDefinition) => {
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
      const loaded = Array.isArray(value)
        ? (value as AutomationProjectOption[])
        : [];
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
        const published = hydrateStudioDefinition(
          JSON.parse(loadedVersion.normalizedJson) as WorkflowDefinition
        );
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
          const authored = hydrateStudioDefinition(
            JSON.parse(source.content) as WorkflowStudioDefinitionInput
          );
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

  const assertGraphValid = useCallback(
    (target: StudioWorkflowDefinition) => {
      const issues = validateStudioWorkflowExhaustively(target);
      if (issues.length > 0) {
        const summary = t('workflow:studio.validationBlockedSave', {
          count: issues.length,
          defaultValue: `Fix ${issues.length} validation issue(s) before saving.`,
        });
        throw new Error(`${summary} (${issues[0].message})`);
      }
    },
    [t]
  );

  const saveSource = useCallback(async () => {
    assertGraphValid(definition);
    if (!repo) throw new Error(t('automations.selectRepository'));
    setSaving(true);
    try {
      const backendDefinition = toBackendWorkflowDefinition(definition);
      await workflowApi.validate(backendDefinition);
      const filePath = workflowSourceFilePath(repo.path, sourcePath);
      const expectedRevision = await resolveWorkflowSourceRevision(
        sourceApi,
        filePath,
        sourceRevision
      );
      const result = await sourceApi.write(
        filePath,
        serializeDefinition(backendDefinition),
        expectedRevision ?? undefined
      );
      setSourceRevision(result.revision);
      setSavedDefinition(definition);
      toast.success(t('automations.sourceSaved'));
    } finally {
      setSaving(false);
    }
  }, [
    assertGraphValid,
    definition,
    repo,
    sourceApi,
    sourcePath,
    sourceRevision,
    t,
    workflowApi,
  ]);

  const publishAndApply = useCallback(async () => {
    assertGraphValid(definition);
    if (!repo || !projectId)
      throw new Error(t('automations.selectProjectRepository'));
    if (dirty || !sourceRevision) await saveSource();
    const input: unknown = {};
    setPublishing(true);
    try {
      const backendDefinition = toBackendWorkflowDefinition(definition);
      const published = await workflowApi.publish(
        backendDefinition,
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
    assertGraphValid,
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

  useGuardedWorkflowRunPolling({
    runId: debugRun?.id,
    status: debugRun?.status,
    refresh: refreshDebugRun,
    intervalMs: 1500,
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : String(error)),
  });

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

      const backendDefinition = toBackendWorkflowDefinition(definition);
      const nextRun = await workflowApi.debug(backendDefinition, stepId, {
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
    <AutomationWorkspaceConfigPanel
      projectId={projectId}
      setProjectId={setProjectId}
      projects={projects}
      workspaceMode={workspaceMode}
      setWorkspaceMode={setWorkspaceMode}
      workspaceId={workspaceId}
      setWorkspaceId={setWorkspaceId}
      workspaces={workspaces}
      testWorkspaceMode={testWorkspaceMode}
      setTestWorkspaceMode={setTestWorkspaceMode}
      testWorkspaceId={testWorkspaceId}
      setTestWorkspaceId={setTestWorkspaceId}
      testWorktrees={testWorktrees}
      persistTestWorkspace={persistTestWorkspace}
      recordTestWorkspace={recordTestWorkspace}
      sourcePath={sourcePath}
      setSourcePath={setSourcePath}
      triggerKind={triggerKind}
      setTriggerKind={setTriggerKind}
      timer={timer}
      setTimer={setTimer}
      timezone={timezone}
      setTimezone={setTimezone}
      enabled={enabled}
      setEnabled={setEnabled}
    />
  );

  return (
    <>
      <div className="flex h-[calc(100dvh-32px)] min-h-[560px] flex-col overflow-hidden rounded-lg border bg-card">
        <WorkflowStudio
          studioMode
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
            try {
              assertGraphValid(definition);
              setPublishVersion(nextReleaseVersion(version?.version));
              setPublishOpen(true);
            } catch (error) {
              toast.error(
                error instanceof Error ? error.message : String(error)
              );
            }
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
            <Label>{t('automations.version')}</Label>
            <TextInput
              label={t('automations.version')}
              isLabelHidden
              value={publishVersion}
              onChange={setPublishVersion}
              width="100%"
              className="[&_input]:font-mono [&_input]:text-sm"
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
                <div className="truncate font-mono text-xs text-muted-foreground">
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
