import type {
  WorkflowDefinition,
  WorkflowPolicy,
  WorkflowRunView,
  WorkflowReviewDecision,
} from 'shared/types';
import {
  callApplicationCommand,
  type BackendTransport,
} from '@/lib/backendTransport';

export function createWorkflowApi(transport: BackendTransport) {
  return {
    validate: (definition: WorkflowDefinition) =>
      callApplicationCommand(transport, 'workflow_validate', {
        request: { definition },
      }),
    publish: (
      definition: WorkflowDefinition,
      definitionId?: string,
      operationId?: string,
      sourcePath?: string
    ) =>
      callApplicationCommand(
        transport,
        'workflow_publish',
        { request: { definitionId, definition, sourcePath } },
        operationId ? { operationId } : undefined
      ),
    start: (
      definitionVersionId: string,
      workspaceId: string,
      input: unknown,
      policyOverride?: WorkflowPolicy,
      operationId?: string,
      debugStepId?: string
    ) =>
      callApplicationCommand(
        transport,
        'workflow_start',
        {
          request: {
            definitionVersionId,
            workspaceId,
            input,
            policyOverride,
            debugStepId,
          },
        },
        operationId ? { operationId } : undefined
      ),
    debug: (
      definition: WorkflowDefinition,
      stepId: string,
      options: {
        definitionId?: string;
        sourcePath?: string;
        workspaceId?: string;
        input?: unknown;
        policyOverride?: WorkflowPolicy;
        parentRunId?: string;
        scope?: 'node' | 'downstream';
        operationId?: string;
      } = {}
    ) =>
      callApplicationCommand(
        transport,
        'workflow_debug',
        {
          request: {
            definitionId: options.definitionId,
            definition,
            sourcePath: options.sourcePath,
            workspaceId: options.workspaceId,
            input: options.input ?? {},
            policyOverride: options.policyOverride,
            stepId,
            parentRunId: options.parentRunId,
            scope: options.scope ?? 'node',
          },
        },
        options.operationId ? { operationId: options.operationId } : undefined
      ),
    show: (runId: string) =>
      callApplicationCommand(transport, 'workflow_show', { runId }),
    version: (versionId: string) =>
      callApplicationCommand(transport, 'workflow_version', { versionId }),
    list: (limit = 100) =>
      callApplicationCommand(transport, 'workflow_list', { limit }),
    versions: (definitionId: string, limit = 100) =>
      callApplicationCommand(transport, 'workflow_versions', {
        definitionId,
        limit,
      }),
    steps: (runId: string) =>
      callApplicationCommand(transport, 'workflow_steps', { runId }),
    events: (runId: string, afterSequence = 0, limit = 200) =>
      callApplicationCommand(transport, 'workflow_events', {
        runId,
        afterSequence,
        limit,
      }),
    decide: (
      runId: string,
      stepId: string,
      decision: unknown,
      operationId?: string
    ): Promise<WorkflowRunView> =>
      callApplicationCommand(
        transport,
        'workflow_decide',
        { request: { runId, stepId, decision } },
        operationId ? { operationId } : undefined
      ),
    cancel: (runId: string, reason?: string, operationId?: string) =>
      callApplicationCommand(
        transport,
        'workflow_cancel',
        { request: { runId, reason } },
        operationId ? { operationId } : undefined
      ),
    resume: (
      runId: string,
      decision: WorkflowReviewDecision,
      operationId?: string
    ) =>
      callApplicationCommand(
        transport,
        'workflow_resume',
        { request: { runId, decision } },
        operationId ? { operationId } : undefined
      ),
    pause: (runId: string, reason?: string, operationId?: string) =>
      callApplicationCommand(
        transport,
        'workflow_pause',
        { request: { runId, reason } },
        operationId ? { operationId } : undefined
      ),
    resumeRun: (runId: string, operationId?: string) =>
      callApplicationCommand(
        transport,
        'workflow_resume_run',
        { request: { runId } },
        operationId ? { operationId } : undefined
      ),
    acceptCandidate: (runId: string, stepId: string, operationId?: string) =>
      callApplicationCommand(
        transport,
        'workflow_accept_candidate',
        { request: { runId, stepId } },
        operationId ? { operationId } : undefined
      ),
    pauseStep: (
      runId: string,
      stepId: string,
      reason?: string,
      operationId?: string
    ) =>
      callApplicationCommand(
        transport,
        'workflow_pause_step',
        { request: { runId, stepId, reason } },
        operationId ? { operationId } : undefined
      ),
    submitStepInput: (
      runId: string,
      stepId: string,
      text: string,
      operationId?: string
    ) =>
      callApplicationCommand(
        transport,
        'workflow_step_input',
        { request: { runId, stepId, text } },
        operationId ? { operationId } : undefined
      ),
    fork: (
      parentRunId: string,
      definitionVersionId: string,
      stepId: string,
      scope: 'node' | 'downstream',
      operationId?: string
    ) =>
      callApplicationCommand(
        transport,
        'workflow_fork',
        {
          request: { parentRunId, definitionVersionId, stepId, scope },
        },
        operationId ? { operationId } : undefined
      ),
  };
}
