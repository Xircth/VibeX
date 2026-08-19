import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import type {
  WorkflowDefinition,
  WorkflowEventRecord,
  WorkflowRunView,
  WorkflowStepView,
  WorkflowVersionView,
  Workspace,
} from 'shared/types';

import { toast } from '@/components/ui/toast';
import { useManagedAgentOptions } from '@/features/agent-management';
import {
  loadAgentSessionControlsCatalog,
  sessionControlsQueryKey,
} from '@/features/agents/sessionControlsQuery';
import { useBackendTransport } from '@/lib/transport';

import { WorkflowStudio } from './WorkflowStudio';
import { rememberTestWorkspace } from './workflowTestWorkspaceStore';
import { createWorkflowApi } from './workflowApi';
import {
  loadWorkflowEventsAfter,
  waitForWorkflowStepConversation,
} from './workflowProjection';
import {
  createWorkflowSourceApi,
  resolveWorkflowSourceRevision,
} from './workflowSourceApi';

function serializeDefinition(definition: WorkflowDefinition) {
  return JSON.stringify(
    definition,
    (_key, value) => (typeof value === 'bigint' ? Number(value) : value),
    2
  );
}

function releaseVersion(version: bigint | null | undefined) {
  return (Number(version ?? 0n) / 10).toFixed(1);
}

/**
 * Host adapter for the Workflow Creator artifact opener. The graph, node
 * inspector, native Agent controls, run projection, and conversation surface
 * stay in WorkflowStudio; the plugin contributes only the file type and MCP.
 */
export function WorkflowArtifactStudio({ filePath }: { filePath: string }) {
  const { t } = useTranslation('workflow');
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const transport = useBackendTransport();
  const queryClient = useQueryClient();
  const eventRunIdRef = useRef<string | null>(null);
  const eventHistoryRef = useRef<WorkflowEventRecord[]>([]);
  const workflowApi = useMemo(() => createWorkflowApi(transport), [transport]);
  const sourceApi = useMemo(
    () => createWorkflowSourceApi(transport),
    [transport]
  );
  const agentOptions = useManagedAgentOptions(undefined, true);
  const loadAgentSessionControls = useCallback(
    (agentId: string) =>
      queryClient.fetchQuery({
        queryKey: sessionControlsQueryKey(agentId, workspaceId ?? null),
        queryFn: () => loadAgentSessionControlsCatalog(agentId),
        staleTime: 60_000,
        gcTime: Infinity,
      }),
    [queryClient, workspaceId]
  );
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null);
  const [savedDefinition, setSavedDefinition] =
    useState<WorkflowDefinition | null>(null);
  const [sourceRevision, setSourceRevision] = useState<string | null>(null);
  const [version, setVersion] = useState<WorkflowVersionView | null>(null);
  const [undoStack, setUndoStack] = useState<WorkflowDefinition[]>([]);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [run, setRun] = useState<WorkflowRunView | null>(null);
  const [steps, setSteps] = useState<WorkflowStepView[]>([]);
  const [events, setEvents] = useState<WorkflowEventRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setWorkspace(null);
      return;
    }
    let active = true;
    void transport
      .call('get_workspace', { workspaceId })
      .then((value) => {
        if (active) setWorkspace(value as Workspace);
      })
      .catch(() => {
        if (active) setWorkspace(null);
      });
    return () => {
      active = false;
    };
  }, [transport, workspaceId]);

  useEffect(() => {
    let active = true;
    setLoadError(null);
    void sourceApi
      .read(filePath)
      .then((source) => {
        const parsed = JSON.parse(source.content) as WorkflowDefinition;
        if (!active) return;
        setDefinition(parsed);
        setSavedDefinition(parsed);
        setSourceRevision(source.revision);
        setUndoStack([]);
      })
      .catch((error) => {
        if (!active) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [filePath, sourceApi]);

  const applyDefinition = useCallback((next: WorkflowDefinition) => {
    setDefinition((current) => {
      if (
        !current ||
        serializeDefinition(current) === serializeDefinition(next)
      )
        return current;
      setUndoStack((stack) => [...stack.slice(-39), current]);
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    setUndoStack((stack) => {
      const previous = stack.at(-1);
      if (!previous) return stack;
      setDefinition(previous);
      return stack.slice(0, -1);
    });
  }, []);

  const save = useCallback(async () => {
    if (!definition) return;
    setSaving(true);
    try {
      await workflowApi.validate(definition);
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
      toast.success(t('studio.sourceSaved'));
    } finally {
      setSaving(false);
    }
  }, [definition, filePath, sourceApi, sourceRevision, t, workflowApi]);

  const publish = useCallback(async () => {
    if (!definition) throw new Error(t('studio.sourceNotLoaded'));
    if (
      !sourceRevision ||
      !savedDefinition ||
      serializeDefinition(definition) !== serializeDefinition(savedDefinition)
    ) {
      await save();
    }
    setPublishing(true);
    try {
      const published = await workflowApi.publish(
        definition,
        version?.definitionId,
        undefined,
        filePath
      );
      setVersion(published);
      toast.success(
        t('studio.publishedVersion', {
          version: releaseVersion(published.version),
        })
      );
      return published;
    } finally {
      setPublishing(false);
    }
  }, [
    definition,
    filePath,
    save,
    savedDefinition,
    sourceRevision,
    t,
    version,
    workflowApi,
  ]);

  const refreshRun = useCallback(
    async (runId: string) => {
      const existing =
        eventRunIdRef.current === runId ? eventHistoryRef.current : [];
      const cursor = existing.at(-1)?.sequence ?? 0n;
      const [nextRun, nextSteps, nextEvents] = await Promise.all([
        workflowApi.show(runId),
        workflowApi.steps(runId),
        loadWorkflowEventsAfter(workflowApi, runId, cursor),
      ]);
      const mergedEvents = [...existing, ...nextEvents];
      eventRunIdRef.current = runId;
      eventHistoryRef.current = mergedEvents;
      setRun(nextRun);
      setSteps(nextSteps);
      setEvents(mergedEvents);
      return nextRun;
    },
    [workflowApi]
  );

  useEffect(() => {
    if (
      !run?.id ||
      ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)
    )
      return;
    const timer = window.setInterval(() => {
      void refreshRun(run.id).catch((error) =>
        toast.error(error instanceof Error ? error.message : String(error))
      );
    }, 1000);
    return () => window.clearInterval(timer);
  }, [refreshRun, run?.id, run?.status]);

  const startNode = useCallback(
    async (stepId: string) => {
      if (!definition) {
        throw new Error(t('studio.sourceLoading'));
      }
      if (!workspaceId) {
        throw new Error(t('studio.needWorkspaceToTest'));
      }
      if (
        !sourceRevision ||
        !savedDefinition ||
        serializeDefinition(definition) !== serializeDefinition(savedDefinition)
      ) {
        await save();
      }
      const nextRun = await workflowApi.debug(definition, stepId, {
        definitionId: version?.definitionId,
        sourcePath: filePath,
        workspaceId: run ? undefined : workspaceId,
        input: {},
        parentRunId: run?.id,
        scope: 'node',
      });
      await refreshRun(nextRun.id);
      if (workspaceId) rememberTestWorkspace(filePath, workspaceId);
      toast.success(
        t(run ? 'studio.debugRestarted' : 'studio.debugStarted', {
          step: stepId,
        })
      );
      return nextRun;
    },
    [
      definition,
      filePath,
      refreshRun,
      run,
      save,
      savedDefinition,
      sourceRevision,
      t,
      version?.definitionId,
      workflowApi,
      workspaceId,
    ]
  );

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-6 text-sm text-destructive">
        {loadError}
      </div>
    );
  }
  if (!definition || !savedDefinition) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-xs text-muted-foreground">
        {t('studio.loadingStudio')}
      </div>
    );
  }

  const dirty =
    serializeDefinition(definition) !== serializeDefinition(savedDefinition);

  return (
    <WorkflowStudio
      className="h-full"
      definition={definition}
      onDefinitionChange={applyDefinition}
      run={run}
      steps={steps}
      events={events}
      dirty={dirty}
      saving={saving}
      publishing={publishing}
      onSave={() => void save()}
      onPublish={() => void publish()}
      editorName={definition.name}
      onEditorNameChange={(name) => applyDefinition({ ...definition, name })}
      releaseVersion={releaseVersion(version?.version)}
      canUndo={undoStack.length > 0}
      onUndo={undo}
      workspaceSummary={
        workspaceId
          ? t('studio.currentWorkspace')
          : t('studio.workspaceRequired')
      }
      activeWorktree={
        workspace
          ? {
              name: workspace.name?.trim() || workspace.branch,
              path: workspace.container_ref ?? workspace.branch,
            }
          : null
      }
      notifyContext={
        workspace
          ? { projectId: workspace.project_id, workspaceId: workspace.id }
          : null
      }
      workspaceConfig={
        <div className="space-y-2 text-xs">
          <div className="font-medium">{t('studio.sourceArtifact')}</div>
          <div className="break-all rounded-lg bg-muted/60 p-2 font-mono text-[11px]">
            {filePath}
          </div>
          <div className="font-medium">{t('studio.executionWorkspace')}</div>
          <div className="rounded-lg bg-muted/60 p-2 font-mono text-[11px]">
            {workspaceId ?? t('studio.openInWorkspace')}
          </div>
        </div>
      }
      agentOptions={agentOptions}
      loadAgentSessionControls={loadAgentSessionControls}
      showStopActions
      stopActionsDisabled={!run}
      resetDisabled={!run}
      onReset={() => {
        if (
          run &&
          !['completed', 'failed', 'cancelled', 'interrupted'].includes(
            run.status
          )
        ) {
          void workflowApi
            .cancel(run.id, 'Reset from Workflow artifact editor')
            .catch((error) =>
              toast.error(
                error instanceof Error ? error.message : String(error)
              )
            );
        }
        setRun(null);
        setSteps([]);
        setEvents([]);
        eventRunIdRef.current = null;
        eventHistoryRef.current = [];
      }}
      onStopRun={() => {
        if (!run) return;
        void workflowApi
          .pause(run.id, 'Paused from Workflow artifact editor')
          .then(() => refreshRun(run.id));
      }}
      onTerminateRun={() => {
        if (!run) return;
        void workflowApi
          .cancel(run.id, 'Terminated from Workflow artifact editor')
          .then(() => refreshRun(run.id));
      }}
      onTestNode={(stepId) => {
        void startNode(stepId).catch((error) =>
          toast.error(error instanceof Error ? error.message : String(error))
        );
      }}
      onRerunFromNode={(stepId) => {
        void startNode(stepId).catch((error) =>
          toast.error(error instanceof Error ? error.message : String(error))
        );
      }}
      onPauseStep={(stepId) => {
        if (!run) return;
        void workflowApi
          .pauseStep(run.id, stepId, 'Paused in node conversation')
          .then(() => refreshRun(run.id));
      }}
      onSubmitStepInput={async (stepId, text) => {
        const activeRun = run ?? (await startNode(stepId));
        const latest = await waitForWorkflowStepConversation(
          workflowApi,
          activeRun.id,
          stepId
        );
        if (latest?.status === 'running' && !latest.awaitingInput) {
          await workflowApi.pauseStep(
            activeRun.id,
            stepId,
            'Paused for user guidance'
          );
        }
        await workflowApi.submitStepInput(activeRun.id, stepId, text);
        await refreshRun(activeRun.id);
      }}
      onAcceptCandidate={(stepId) => {
        if (!run) return;
        void workflowApi
          .acceptCandidate(run.id, stepId)
          .then(() => refreshRun(run.id));
      }}
      onDecideApproval={async (stepId, decision) => {
        if (!run) return;
        await workflowApi.decide(run.id, stepId, decision);
        await refreshRun(run.id);
      }}
      onReview={async (decision) => {
        if (!run) return;
        await workflowApi.resume(run.id, decision);
        await refreshRun(run.id);
      }}
    />
  );
}
