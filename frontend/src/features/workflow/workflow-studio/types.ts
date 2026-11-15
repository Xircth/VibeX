import type { ReactNode } from 'react';
import type { Node } from '@xyflow/react';
import type {
  AgentSessionControlsSnapshot,
  AgentStepSpec,
  ApprovalStepSpec,
  CompletionPolicy,
  JsonValue,
  NotifyStepSpec,
  WorkflowBinding,
  WorkflowDefinition,
  WorkflowEventRecord,
  WorkflowReviewDecision,
  WorkflowRunView,
  WorkflowStep,
  WorkflowStepView,
} from 'shared/types';

import type {
  BotConversationScope,
  BotMailboxPolicy,
  EventEnvelope,
  EventSourceKind,
  GateFilterAst,
  GroupDispatchMode,
  PresetOrchestratorKind,
  PulseEvalMode,
  PulseSourceView,
  PulseTemporalSpec,
  PulseWorkspaceIsolation,
} from '@/lib/api/pulse';

import type {
  CollaborationBotOption,
  CollaborationSpaceOption,
} from '../useCollaborationBotRoster';
import type { WorkflowStudioAgentOption } from '../workflowAgent';

export type StudioMode = 'edit' | 'run';

export type StudioInspectorTier = 'visual' | 'advanced' | 'json';

export type StudioNodeCategory =
  | 'trigger'
  | 'session'
  | 'bot'
  | 'group_stage'
  | 'user_gate'
  | 'control'
  | 'outbox_action';

export type StudioAddableStepKind =
  | StudioNodeCategory
  | 'condition_branch'
  | 'bounded_loop'
  | 'wait_for_event'
  | 'agent'
  | 'notify'
  | 'approval';

export type StudioJoinMode = 'all' | 'any';

export type StudioStepCommon = {
  id: string;
  dependsOn: string[];
  phase: string | null;
  inputBindings: { [key in string]?: WorkflowBinding };
  filter?: GateFilterAst | null;
  subscribeThread?: boolean;
  threadKeyTemplate?: string | null;
  branchPorts?: Record<string, string>;
  joinMode?: StudioJoinMode;
};

export type TriggerKind = 'platform' | 'webhook' | 'temporal' | 'sdk';

export type TriggerStepSpec = {
  kind: 'trigger';
  title: string;
  triggerKind: TriggerKind;
  sourceKind: EventSourceKind;
  eventType: string;
  evalMode: PulseEvalMode;
  temporal?: PulseTemporalSpec | null;
  filter: GateFilterAst;
};

export type SessionStepSpec = {
  kind: 'session';
  agentId: string;
  prompt: string;
  workspaceIsolation: PulseWorkspaceIsolation;
  executorProfileId: JsonValue | null;
  modeOverride: string | null;
  configOverrides: { [key in string]?: string };
  outputLanguage: string | null;
  outputDescription: string | null;
  outputSchema: JsonValue | null;
  completionPolicy: CompletionPolicy;
  allowSkipOnReview?: boolean;
};

export type BotStepSpec = {
  kind: 'bot';
  memberId: string;
  conversationScope: BotConversationScope;
  mailboxPolicy: BotMailboxPolicy;
  prompt: string;
  outputDescription?: string | null;
  outputSchema?: JsonValue | null;
};

export type GroupStageStepSpec = {
  kind: 'group_stage';
  spaceId: string;
  dispatchMode: GroupDispatchMode;
  prompt: string;
  rounds?: number | null;
  quorumCount?: number | null;
};

export type UserGateInteractionKind = 'notify' | 'approval' | 'ask_form';

export type UserGateSeverity = 'info' | 'warning' | 'urgent';

export type UserGateStepSpec = {
  kind: 'user_gate';
  interactionKind: UserGateInteractionKind;
  title: string;
  bodyTemplate: string;
  severity?: UserGateSeverity;
  approverScope?: string;
  slaTimeoutSeconds?: number | null;
  decisionSchema?: JsonValue | null;
  formSchema?: JsonValue | null;
};

export type ControlNodeKind = 'condition' | 'bounded_loop' | 'wait_for_event';

export type ControlStepSpec = {
  kind: 'control';
  controlKind: ControlNodeKind;
  title: string;
  expression?: string;
  maxIterations?: number;
  loopTargetStepId?: string;
  waitEventType?: string;
  threadKeyTemplate?: string | null;
  timeoutSeconds?: number | null;
};

export type OutboxActionKind =
  | 'feishu_reply'
  | 'jira_comment'
  | 'github_comment'
  | 'webhook_post'
  | 'emit_event';

export type OutboxActionStepSpec = {
  kind: 'outbox_action';
  actionKind: OutboxActionKind;
  title: string;
  destination: string;
  payloadTemplate: string;
};

export type LegacyAgentStep = StudioStepCommon & {
  kind: 'agent';
  workspaceIsolation?: PulseWorkspaceIsolation;
} & AgentStepSpec;

export type LegacyApprovalStep = StudioStepCommon & {
  kind: 'approval';
  slaTimeoutSeconds?: number | null;
} & ApprovalStepSpec;

export type LegacyNotifyStep = StudioStepCommon & {
  kind: 'notify';
  slaTimeoutSeconds?: number | null;
} & NotifyStepSpec;

export type StudioWorkflowStep =
  | LegacyAgentStep
  | LegacyApprovalStep
  | LegacyNotifyStep
  | (StudioStepCommon & TriggerStepSpec)
  | (StudioStepCommon & SessionStepSpec)
  | (StudioStepCommon & BotStepSpec)
  | (StudioStepCommon & GroupStageStepSpec)
  | (StudioStepCommon & UserGateStepSpec)
  | (StudioStepCommon & ControlStepSpec)
  | (StudioStepCommon & OutboxActionStepSpec);

export type StudioWorkflowDefinition = Omit<WorkflowDefinition, 'steps'> & {
  steps: StudioWorkflowStep[];
  orchestratorPreset?: PresetOrchestratorKind | null;
};

export const DEFAULT_OUTPUT_SCHEMA: JsonValue = {
  type: 'object',
  required: ['summary'],
  properties: { summary: { type: 'string' } },
};

export const DEFAULT_GATE_FILTER: GateFilterAst = {
  sourceKinds: [],
  sourceInstanceIds: [],
  eventTypes: [],
  allowedActors: [],
  conditions: [],
};

export type StudioNodeData = {
  step: StudioWorkflowStep;
  confirmationFor?: string;
  stepRun?: WorkflowStepView;
  predecessorRuns: WorkflowStepView[];
  events: WorkflowEventRecord[];
  agentOptions: WorkflowStudioAgentOption[];
  bots?: readonly CollaborationBotOption[];
  spaces?: readonly CollaborationSpaceOption[];
  selected: boolean;
  logExpanded: boolean;
  mode: StudioMode;
  replayEnvelope?: EventEnvelope | null;
  outgoingCounts?: Record<string, number>;
  totalOutgoingCount?: number;
  onSelect: (stepId: string) => void;
  onToggleLog: (stepId: string) => void;
  onTriggerEvalModeChange?: (stepId: string, evalMode: PulseEvalMode) => void;
  onQuickAddStep?: (parentStepId: string) => void;
};

export type StudioNode = Node<StudioNodeData, 'workflowStep'>;

export type WorkflowStudioDefinitionInput =
  | StudioWorkflowDefinition
  | WorkflowDefinition;

export type WorkflowStudioProps<
  TDef extends WorkflowStudioDefinitionInput = StudioWorkflowDefinition,
> = {
  definition: TDef;
  onDefinitionChange?: (definition: TDef) => void;
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
  bots?: readonly CollaborationBotOption[];
  spaces?: readonly CollaborationSpaceOption[];
  sources?: readonly PulseSourceView[];
  projectId?: string | null;
  definitionId?: string | null;
  sourceRuleId?: string | null;
  onAgentDispatched?: () => void;
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
  capturedEvents?: EventEnvelope[];
  studioMode?: boolean;
  className?: string;
};

export const WORKFLOW_NODE_WIDTH = 280;
export const CONFIRMATION_NODE_WIDTH = 148;
export const CONFIRMATION_NODE_HEIGHT = 44;
export const CONFIRMATION_OFFSET = { x: 324, y: 20 };

export function confirmationParentId(nodeId: string) {
  return nodeId.startsWith('confirmation:')
    ? nodeId.slice('confirmation:'.length)
    : null;
}

export const EMPTY_STEPS: WorkflowStepView[] = [];
export const EMPTY_EVENTS: WorkflowEventRecord[] = [];
export const EMPTY_AGENT_OPTIONS: WorkflowStudioAgentOption[] = [];

export type { WorkflowStep };
