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
      operationId?: string
    ) =>
      callApplicationCommand(
        transport,
        'workflow_publish',
        { request: { definitionId, definition } },
        operationId ? { operationId } : undefined
      ),
    start: (
      definitionVersionId: string,
      workspaceId: string,
      input: unknown,
      policyOverride?: WorkflowPolicy,
      operationId?: string
    ) =>
      callApplicationCommand(
        transport,
        'workflow_start',
        {
          request: { definitionVersionId, workspaceId, input, policyOverride },
        },
        operationId ? { operationId } : undefined
      ),
    show: (runId: string) =>
      callApplicationCommand(transport, 'workflow_show', { runId }),
    version: (versionId: string) =>
      callApplicationCommand(transport, 'workflow_version', { versionId }),
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
  };
}
