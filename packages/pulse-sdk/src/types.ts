/**
 * Shared wire contracts for VibeX Pulse aligned 1:1 with `crates/api-types/src/pulse.rs`
 * plus Dual-Primitive Workflow step specifications (`SessionStep` vs `BotStep`).
 */

export type EventSourceKind =
  | 'feishu'
  | 'jira'
  | 'github'
  | 'webhook_standard'
  | 'webhook_custom'
  | 'time_cron'
  | 'time_once'
  | 'time_interval'
  | 'time_sla'
  | 'sdk_custom'
  | 'system_internal';

export type EventTrustLevel =
  | 'trusted_human'
  | 'trusted_internal'
  | 'verified_external'
  | 'untrusted_external';

export interface EventSourceMeta {
  kind: EventSourceKind;
  instanceId: string;
  trustLevel: EventTrustLevel;
}

export interface EventActor {
  id: string;
  displayName?: string | null;
  roles: string[];
  isBot: boolean;
  isSelf: boolean;
}

export interface ReplyChannelAddress {
  sourceKind: EventSourceKind;
  instanceId: string;
  channelId: string;
  messageId?: string | null;
  threadId?: string | null;
}

export interface EventTrace {
  rootEventId: string;
  parentRunId?: string | null;
  hopCount: number;
}

export interface EventEnvelope<TPayload = unknown> {
  eventId: string;
  deliveryId: string;
  source: EventSourceMeta;
  eventType: string;
  occurredAt: string;
  actor: EventActor;
  threadKey?: string | null;
  correlations: string[];
  replyChannels: ReplyChannelAddress[];
  trace: EventTrace;
  payload: TPayload;
}

export type PulseEvalMode = 'off' | 'observe' | 'auto';

export type MandateOrigin =
  | 'explicit_human'
  | 'trusted_internal'
  | 'untrusted_external';

export type GateFilterCondition =
  | { op: 'eq'; pointer: string; value: unknown }
  | { op: 'neq'; pointer: string; value: unknown }
  | { op: 'lt'; pointer: string; value: number }
  | { op: 'lte'; pointer: string; value: number }
  | { op: 'gt'; pointer: string; value: number }
  | { op: 'gte'; pointer: string; value: number }
  | { op: 'contains'; pointer: string; needle: string }
  | { op: 'in_set'; pointer: string; values: unknown[] }
  | { op: 'exists'; pointer: string }
  | { op: 'regex'; pointer: string; pattern: string }
  | { op: 'not_bot_actor' };

export interface GateFilterAst {
  sourceKinds: EventSourceKind[];
  sourceInstanceIds: string[];
  eventTypes: string[];
  allowedActors: string[];
  conditions: GateFilterCondition[];
}

export type SessionTargetMode =
  | 'ephemeral_fresh'
  | 'thread_keyed'
  | 'existing_session';

export type PulseWorkspaceIsolation =
  | 'isolated_worktree'
  | 'project_root'
  | 'scratch';

export type SessionDeliveryStrategy = 'queue' | 'steer';

export type BotConversationScope = 'fixed_primary' | 'per_thread_topic';

export type BotMailboxPolicy = 'fifo_serial' | 'coalesce_batch';

export type GroupMentionOrder = 'parallel' | 'sequential';

export type GroupDispatchMode =
  | { type: 'specific_seat'; memberId: string }
  | {
      type: 'mention_seats';
      memberIds: string[];
      order?: GroupMentionOrder;
    }
  | { type: 'moderator_triage'; moderatorMemberId: string }
  | { type: 'broadcast_log_only' };

export type UserInteractionKind =
  | 'notify'
  | 'approval'
  | 'ask_form'
  | 'digest';

export type UserInteractionSeverity = 'info' | 'warning' | 'urgent';

export interface ApprovalOptionSpec {
  id: string;
  label: string;
  destructive?: boolean;
  requireNote?: boolean;
}

export type PulseTargetSpec =
  | {
      kind: 'session';
      mode: SessionTargetMode;
      agentId: string;
      modelOverride?: string | null;
      workspaceIsolation?: PulseWorkspaceIsolation;
      projectId?: string | null;
      existingSessionId?: string | null;
      deliveryStrategy?: SessionDeliveryStrategy;
      subscribeThread?: boolean;
      promptTemplate: string;
    }
  | {
      kind: 'bot';
      memberId: string;
      conversationScope?: BotConversationScope;
      mailboxPolicy?: BotMailboxPolicy;
      subscribeThread?: boolean;
      promptTemplate: string;
    }
  | {
      kind: 'group';
      spaceId: string;
      dispatchMode: GroupDispatchMode;
      messageTemplate: string;
    }
  | {
      kind: 'user';
      interactionKind: UserInteractionKind;
      severity?: UserInteractionSeverity;
      titleTemplate: string;
      bodyTemplate: string;
      mirrorToChannels?: string[];
      approvalOptions?: ApprovalOptionSpec[];
      formSchema?: Record<string, unknown> | null;
      slaTimeoutSeconds?: number | null;
    }
  | {
      kind: 'workflow';
      workflowId: string;
      pinnedVersion: number;
      inputMapping?: Record<string, string>;
    };

export type PulseTemporalSpec =
  | {
      kind: 'cron';
      expression: string;
      timezone: string;
      weekdaysOnly?: boolean;
      catchUpOnce?: boolean;
    }
  | {
      kind: 'once';
      fireAt: string;
    }
  | {
      kind: 'interval';
      everySeconds: number;
      skipIfBusy?: boolean;
    }
  | {
      kind: 'inactivity_sla';
      threadKeyPrefix: string;
      timeoutSeconds: number;
      expectedEventTypes?: string[];
    };

export type PresetOrchestratorKind =
  | 'direct_reflex'
  | 'superagent_router'
  | 'hybrid_pipeline'
  | 'event_saga'
  | 'window_aggregator';

export interface PulseRuleSpec {
  name: string;
  description?: string | null;
  projectId?: string | null;
  workspaceId?: string | null;
  evalMode: PulseEvalMode;
  orchestrator?: PresetOrchestratorKind;
  filter: GateFilterAst;
  temporal?: PulseTemporalSpec | null;
  debounceMs?: number;
  claimExclusive?: boolean;
  targets: PulseTargetSpec[];
}

export interface PulseRuleView {
  id: string;
  revision: number;
  enabled: boolean;
  draftOnly: boolean;
  mandateOrigin: MandateOrigin;
  spec: PulseRuleSpec;
  webhookRouteId?: string | null;
  nextFireAt?: string | null;
  matchedCount: number;
  observedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PulseDryRunViolation {
  path: string;
  code: string;
  message: string;
}

export interface PulseDryRunReport {
  valid: boolean;
  matched: boolean;
  violations: PulseDryRunViolation[];
  unmatchedConditions: number[];
  renderedPreviews: string[];
}

export interface PulseSourceView {
  id: string;
  kind: EventSourceKind;
  title: string;
  enabled: boolean;
  healthy: boolean;
  statusMessage?: string | null;
  cursorWatermark?: string | null;
  publicWebhookPath?: string | null;
  receivedCount24h: number;
  rejectedCount24h: number;
  updatedAt: string;
}

export interface PulseObservedCandidateView {
  id: string;
  ruleId: string;
  ruleName: string;
  eventId: string;
  eventType: string;
  sourceKind: EventSourceKind;
  threadKey?: string | null;
  summary: string;
  occurredAt: string;
  promoted: boolean;
}

export interface PulseUserInteractionView {
  id: string;
  ruleId?: string | null;
  workflowRunId?: string | null;
  stepId?: string | null;
  kind: UserInteractionKind;
  severity: UserInteractionSeverity;
  title: string;
  body: string;
  approvalOptions: ApprovalOptionSpec[];
  formSchema?: Record<string, unknown> | null;
  status: string;
  createdAt: string;
  resolvedAt?: string | null;
}

export type PulseSubscriberKind = 'session' | 'bot' | 'group';

export interface PulseSubscriptionView {
  id: string;
  threadKey: string;
  subscriberKind: string;
  subscriberId: string;
  active: boolean;
  createdAt: string;
}

export interface JsonSchemaObject {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  description?: string;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchemaObject>;
  items?: JsonSchemaObject;
  additionalProperties?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
}

export interface PulseEventSchemaView {
  eventType: string;
  summary: string;
  jsonSchema: JsonSchemaObject | Record<string, unknown>;
  builtIn: boolean;
  updatedAt: string;
}

export interface PulseDeckSnapshot {
  engineActive: boolean;
  activeTicketCount: number;
  pendingUserInteractionCount: number;
  sources: PulseSourceView[];
  rules: PulseRuleView[];
  observedCandidates: PulseObservedCandidateView[];
  subscriptions: PulseSubscriptionView[];
  pendingInteractions: PulseUserInteractionView[];
}

export interface PulseRuleSaveInput {
  id?: string | null;
  enabled?: boolean;
  draftOnly?: boolean;
  mandateOrigin?: MandateOrigin;
  spec: PulseRuleSpec;
}

export interface PulseEmitCustomEventInput<TPayload = unknown> {
  eventType: string;
  deliveryId?: string;
  sourceInstanceId?: string;
  trustLevel?: EventTrustLevel;
  actor?: Partial<EventActor>;
  threadKey?: string | null;
  correlations?: string[];
  replyChannels?: ReplyChannelAddress[];
  trace?: Partial<EventTrace>;
  payload: TPayload;
}

/* -------------------------------------------------------------------------- */
/* Dual-Primitive Workflow Step Specifications (`SessionStep` vs `BotStep`)   */
/* -------------------------------------------------------------------------- */

export type WorkflowBinding =
  | { source: 'run_input'; pointer: string }
  | { source: 'step_output'; stepId: string; pointer: string };

export type WorkspaceAccess =
  | 'native'
  | 'read_only_shared'
  | 'write_serialized'
  | 'write_isolated';

export type SideEffectClass =
  | 'read_only'
  | 'idempotent'
  | 'mutating_unknown';

export type CompletionPolicy = 'automatic' | 'manual';

export interface WorkflowStepBase {
  id: string;
  dependsOn: string[];
  phase?: string;
  inputBindings?: Record<string, WorkflowBinding>;
}

/**
 * Ephemeral Session unit: starts a brand-new Conversation with refreshed clean
 * context on every activation, retry, and loop iteration.
 */
export interface SessionStep extends WorkflowStepBase {
  kind: 'session';
  agentId: string;
  prompt: string;
  refreshContext: true;
  modelOverride?: string;
  workspaceIsolation: PulseWorkspaceIsolation;
  workspaceAccess?: WorkspaceAccess;
  sideEffectClass?: SideEffectClass;
  completionPolicy?: CompletionPolicy;
  outputDescription?: string;
  outputSchema?: JsonSchemaObject;
  timeoutSeconds?: number;
}

/**
 * Persistent Bot unit: binds a long-lived `collaboration_members` identity and
 * fixed session (`fixed_primary` or `per_thread_topic`) without resetting
 * context across runs, serialized by `BotTurnMailbox`.
 */
export interface BotStep extends WorkflowStepBase {
  kind: 'bot';
  memberId: string;
  prompt: string;
  preserveContext: true;
  conversationScope: BotConversationScope;
  mailboxPolicy: BotMailboxPolicy;
  outputDescription?: string;
  outputSchema?: JsonSchemaObject;
  timeoutSeconds?: number;
}

export interface GroupStageStep extends WorkflowStepBase {
  kind: 'group_stage';
  spaceId: string;
  dispatchMode: GroupDispatchMode;
  prompt: string;
  convergenceMode?: 'lead_summary' | 'fixed_rounds';
  maxRounds?: number;
}

export interface UserGateStep extends WorkflowStepBase {
  kind: 'user_gate';
  interactionKind: 'approval' | 'ask_form' | 'notify';
  title: string;
  body?: string;
  approverScope?: string;
  approvalOptions?: ApprovalOptionSpec[];
  decisionSchema?: JsonSchemaObject;
  formSchema?: JsonSchemaObject;
  skippable?: boolean;
  timeoutSeconds?: number;
}

export interface BoundedLoopStep extends WorkflowStepBase {
  kind: 'bounded_loop';
  bodyStepIds: string[];
  conditionPointer: string;
  exitEquals?: unknown;
  maxIterations: number;
  onExhaustedStepId?: string;
}

export interface WaitForEventStep extends WorkflowStepBase {
  kind: 'wait_for_event';
  eventTypes: string[];
  threadKeyPointer?: string;
  filter?: Partial<GateFilterAst>;
  timeoutSeconds: number;
  onTimeoutStepId?: string;
}

export interface OutboxActionStep extends WorkflowStepBase {
  kind: 'outbox_action';
  actionKind: 'reply_channel' | 'emit_event' | 'webhook_post' | 'issue_update';
  targetChannelIndex?: number;
  eventType?: string;
  payloadTemplate: Record<string, unknown> | string;
}

export type PulseWorkflowStep =
  | SessionStep
  | BotStep
  | GroupStageStep
  | UserGateStep
  | BoundedLoopStep
  | WaitForEventStep
  | OutboxActionStep;

export interface PulseWorkflowPolicy {
  maxConcurrentAgentSteps: number;
  maxAgentCalls: number;
  deadlineSeconds: number;
  maxOutputBytes: number;
}

export interface PulseWorkflowDefinition {
  formatVersion: 1;
  name: string;
  description?: string;
  orchestrator?: PresetOrchestratorKind;
  inputSchema?: JsonSchemaObject;
  steps: PulseWorkflowStep[];
  policy: PulseWorkflowPolicy;
}

export class PulseValidationError extends Error {
  readonly violations: PulseDryRunViolation[];

  constructor(summary: string, violations: PulseDryRunViolation[]) {
    const details = violations
      .map((v) => `[${v.code}] ${v.path}: ${v.message}`)
      .join('; ');
    super(details ? `${summary}: ${details}` : summary);
    this.name = 'PulseValidationError';
    this.violations = violations;
  }
}
