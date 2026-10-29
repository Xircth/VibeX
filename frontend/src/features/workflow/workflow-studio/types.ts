import type { ReactNode } from 'react';
import type { Node } from '@xyflow/react';
import type {
  AgentSessionControlsSnapshot,
  JsonValue,
  WorkflowDefinition,
  WorkflowEventRecord,
  WorkflowReviewDecision,
  WorkflowRunView,
  WorkflowStep,
  WorkflowStepView,
} from 'shared/types';

import type { WorkflowStudioAgentOption } from '../workflowAgent';

export type StudioMode = 'edit' | 'run';

export const DEFAULT_OUTPUT_SCHEMA: JsonValue = {
  type: 'object',
  required: ['summary'],
  properties: { summary: { type: 'string' } },
};

export type StudioNodeData = {
  step: WorkflowStep;
  confirmationFor?: string;
  stepRun?: WorkflowStepView;
  predecessorRuns: WorkflowStepView[];
  events: WorkflowEventRecord[];
  agentOptions: WorkflowStudioAgentOption[];
  selected: boolean;
  logExpanded: boolean;
  mode: StudioMode;
  onSelect: (stepId: string) => void;
  onToggleLog: (stepId: string) => void;
};

export type StudioNode = Node<StudioNodeData, 'workflowStep'>;

export type WorkflowStudioProps = {
  definition: WorkflowDefinition;
  onDefinitionChange?: (definition: WorkflowDefinition) => void;
  run?: WorkflowRunView | null;
  steps?: WorkflowStepView[];
  events?: WorkflowEventRecord[];
  dirty?: boolean;
  saving?: boolean;
  publishing?: boolean;
  onSave?: () => void;
  onPublish?: () => void;
  releaseVersion?: string;
  canUndo?: boolean;
  onUndo?: () => void;
  workspaceConfig?: ReactNode;
  workspaceSummary?: string;
  onBack?: () => void;
  editorName?: string;
  onEditorNameChange?: (name: string) => void;
  agentOptions?: WorkflowStudioAgentOption[];
  loadAgentSessionControls?: (
    agentId: string
  ) => Promise<AgentSessionControlsSnapshot | null>;
  onStopRun?: () => void;
  onTerminateRun?: () => void;
  onReset?: () => void;
  showStopActions?: boolean;
  stopActionsDisabled?: boolean;
  resetDisabled?: boolean;
  onPauseRun?: () => void;
  onResumeRun?: () => void;
  onTestNode?: (stepId: string) => void;
  onRerunFromNode?: (stepId: string) => void;
  onAcceptCandidate?: (stepId: string) => void;
  onPauseStep?: (stepId: string) => void;
  onSubmitStepInput?: (stepId: string, text: string) => Promise<void> | void;
  onDecideApproval?: (
    stepId: string,
    decision: JsonValue
  ) => Promise<void> | void;
  onReview?: (decision: WorkflowReviewDecision) => Promise<void> | void;
  activeWorktree?: { name: string; path: string } | null;
  notifyContext?: { projectId: string; workspaceId: string } | null;
  className?: string;
};

export const CONFIRMATION_OFFSET = { x: 276, y: 23 };

export function confirmationParentId(nodeId: string) {
  return nodeId.startsWith('confirmation:')
    ? nodeId.slice('confirmation:'.length)
    : null;
}

export const EMPTY_STEPS: WorkflowStepView[] = [];
export const EMPTY_EVENTS: WorkflowEventRecord[] = [];
export const EMPTY_AGENT_OPTIONS: WorkflowStudioAgentOption[] = [];
