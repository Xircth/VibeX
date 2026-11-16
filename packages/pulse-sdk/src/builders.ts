import {
  validatePulseRuleSpec,
  validatePulseWorkflowDefinition,
} from './evaluator.ts';
import {
  PulseValidationError,
  type ApprovalOptionSpec,
  type BotConversationScope,
  type BotMailboxPolicy,
  type BotStep,
  type BoundedLoopStep,
  type CompletionPolicy,
  type EventSourceKind,
  type GateFilterAst,
  type GateFilterCondition,
  type GroupDispatchMode,
  type GroupMentionOrder,
  type GroupStageStep,
  type JsonSchemaObject,
  type OutboxActionStep,
  type PresetOrchestratorKind,
  type PulseDryRunViolation,
  type PulseEvalMode,
  type PulseRuleSpec,
  type PulseTargetSpec,
  type PulseTemporalSpec,
  type PulseWorkflowDefinition,
  type PulseWorkflowPolicy,
  type PulseWorkflowStep,
  type PulseWorkspaceIsolation,
  type SessionDeliveryStrategy,
  type SessionStep,
  type SideEffectClass,
  type UserGateStep,
  type UserInteractionSeverity,
  type WaitForEventStep,
  type WorkflowBinding,
  type WorkspaceAccess,
} from './types.ts';

export interface FreshSessionTargetOptions {
  agentId: string;
  promptTemplate: string;
  modelOverride?: string | null;
  workspaceIsolation?: PulseWorkspaceIsolation;
  projectId?: string | null;
  deliveryStrategy?: SessionDeliveryStrategy;
  subscribeThread?: boolean;
}

export interface ThreadSessionTargetOptions {
  agentId: string;
  promptTemplate: string;
  modelOverride?: string | null;
  workspaceIsolation?: PulseWorkspaceIsolation;
  projectId?: string | null;
  deliveryStrategy?: SessionDeliveryStrategy;
  subscribeThread?: boolean;
}

export interface ExistingSessionTargetOptions {
  agentId: string;
  existingSessionId: string;
  promptTemplate: string;
  deliveryStrategy?: SessionDeliveryStrategy;
  subscribeThread?: boolean;
}

export interface PersistentBotTargetOptions {
  memberId: string;
  promptTemplate: string;
  conversationScope?: BotConversationScope;
  mailboxPolicy?: BotMailboxPolicy;
  subscribeThread?: boolean;
}

export interface UserApprovalTargetOptions {
  titleTemplate: string;
  bodyTemplate: string;
  severity?: UserInteractionSeverity;
  approvalOptions?: ApprovalOptionSpec[];
  mirrorToChannels?: string[];
  slaTimeoutSeconds?: number | null;
}

export interface UserNotifyTargetOptions {
  titleTemplate: string;
  bodyTemplate: string;
  severity?: UserInteractionSeverity;
  mirrorToChannels?: string[];
}

export interface CronScheduleOptions {
  timezone?: string;
  weekdaysOnly?: boolean;
  catchUpOnce?: boolean;
}

export interface IntervalScheduleOptions {
  skipIfBusy?: boolean;
}

/**
 * Fluent builder for authoring `PulseRuleSpec` definitions with exhaustive validation.
 */
export class PulseRuleBuilder {
  readonly #name: string;
  #description: string | null = null;
  #projectId: string | null = null;
  #workspaceId: string | null = null;
  #evalMode: PulseEvalMode = 'observe';
  #orchestrator: PresetOrchestratorKind = 'direct_reflex';
  #filter: GateFilterAst = {
    sourceKinds: [],
    sourceInstanceIds: [],
    eventTypes: [],
    allowedActors: [],
    conditions: [],
  };
  #temporal: PulseTemporalSpec | null = null;
  #debounceMs = 0;
  #claimExclusive = false;
  #targets: PulseTargetSpec[] = [];

  constructor(name: string) {
    this.#name = name;
  }

  description(text: string): this {
    this.#description = text;
    return this;
  }

  project(projectId: string): this {
    this.#projectId = projectId;
    return this;
  }

  workspace(workspaceId: string): this {
    this.#workspaceId = workspaceId;
    return this;
  }

  mode(evalMode: PulseEvalMode): this {
    this.#evalMode = evalMode;
    return this;
  }

  orchestrator(kind: PresetOrchestratorKind): this {
    this.#orchestrator = kind;
    return this;
  }

  debounce(debounceMs: number): this {
    this.#debounceMs = debounceMs;
    return this;
  }

  claimExclusive(claim = true): this {
    this.#claimExclusive = claim;
    return this;
  }

  fromSources(...kinds: EventSourceKind[]): this {
    this.#filter.sourceKinds.push(...kinds);
    return this;
  }

  fromSourceInstances(...instanceIds: string[]): this {
    this.#filter.sourceInstanceIds.push(...instanceIds);
    return this;
  }

  onEventTypes(...eventTypes: string[]): this {
    this.#filter.eventTypes.push(...eventTypes);
    return this;
  }

  allowActors(...actorIds: string[]): this {
    this.#filter.allowedActors.push(...actorIds);
    return this;
  }

  where(condition: GateFilterCondition): this {
    this.#filter.conditions.push(condition);
    return this;
  }

  whereEq(pointer: string, value: unknown): this {
    return this.where({ op: 'eq', pointer, value });
  }

  whereNeq(pointer: string, value: unknown): this {
    return this.where({ op: 'neq', pointer, value });
  }

  whereLt(pointer: string, value: number): this {
    return this.where({ op: 'lt', pointer, value });
  }

  whereLte(pointer: string, value: number): this {
    return this.where({ op: 'lte', pointer, value });
  }

  whereGt(pointer: string, value: number): this {
    return this.where({ op: 'gt', pointer, value });
  }

  whereGte(pointer: string, value: number): this {
    return this.where({ op: 'gte', pointer, value });
  }

  whereContains(pointer: string, needle: string): this {
    return this.where({ op: 'contains', pointer, needle });
  }

  whereInSet(pointer: string, values: unknown[]): this {
    return this.where({ op: 'in_set', pointer, values });
  }

  whereExists(pointer: string): this {
    return this.where({ op: 'exists', pointer });
  }

  whereRegex(pointer: string, pattern: string): this {
    return this.where({ op: 'regex', pointer, pattern });
  }

  notBotActor(): this {
    return this.where({ op: 'not_bot_actor' });
  }

  onCron(
    expression: string,
    timezone = 'UTC',
    options?: CronScheduleOptions
  ): this {
    if (!this.#filter.sourceKinds.includes('time_cron')) {
      this.#filter.sourceKinds.push('time_cron');
    }
    this.#temporal = {
      kind: 'cron',
      expression,
      timezone: options?.timezone ?? timezone,
      weekdaysOnly: options?.weekdaysOnly ?? false,
      catchUpOnce: options?.catchUpOnce ?? false,
    };
    return this;
  }

  onOnce(fireAt: string): this {
    if (!this.#filter.sourceKinds.includes('time_once')) {
      this.#filter.sourceKinds.push('time_once');
    }
    this.#temporal = {
      kind: 'once',
      fireAt,
    };
    return this;
  }

  onInterval(everySeconds: number, options?: IntervalScheduleOptions): this {
    if (!this.#filter.sourceKinds.includes('time_interval')) {
      this.#filter.sourceKinds.push('time_interval');
    }
    this.#temporal = {
      kind: 'interval',
      everySeconds,
      skipIfBusy: options?.skipIfBusy ?? true,
    };
    return this;
  }

  onInactivitySla(
    threadKeyPrefix: string,
    timeoutSeconds: number,
    expectedEventTypes: string[] = []
  ): this {
    if (!this.#filter.sourceKinds.includes('time_sla')) {
      this.#filter.sourceKinds.push('time_sla');
    }
    this.#temporal = {
      kind: 'inactivity_sla',
      threadKeyPrefix,
      timeoutSeconds,
      expectedEventTypes,
    };
    return this;
  }

  toTarget(target: PulseTargetSpec): this {
    this.#targets.push(target);
    return this;
  }

  toFreshSession(options: FreshSessionTargetOptions): this {
    return this.toTarget({
      kind: 'session',
      mode: 'ephemeral_fresh',
      agentId: options.agentId,
      modelOverride: options.modelOverride ?? null,
      workspaceIsolation: options.workspaceIsolation ?? 'isolated_worktree',
      projectId: options.projectId ?? null,
      existingSessionId: null,
      deliveryStrategy: options.deliveryStrategy ?? 'queue',
      subscribeThread: options.subscribeThread ?? false,
      promptTemplate: options.promptTemplate,
    });
  }

  toThreadSession(options: ThreadSessionTargetOptions): this {
    return this.toTarget({
      kind: 'session',
      mode: 'thread_keyed',
      agentId: options.agentId,
      modelOverride: options.modelOverride ?? null,
      workspaceIsolation: options.workspaceIsolation ?? 'isolated_worktree',
      projectId: options.projectId ?? null,
      existingSessionId: null,
      deliveryStrategy: options.deliveryStrategy ?? 'queue',
      subscribeThread: options.subscribeThread ?? true,
      promptTemplate: options.promptTemplate,
    });
  }

  toExistingSession(options: ExistingSessionTargetOptions): this {
    return this.toTarget({
      kind: 'session',
      mode: 'existing_session',
      agentId: options.agentId,
      existingSessionId: options.existingSessionId,
      deliveryStrategy: options.deliveryStrategy ?? 'queue',
      subscribeThread: options.subscribeThread ?? false,
      promptTemplate: options.promptTemplate,
    });
  }

  toPersistentBot(options: PersistentBotTargetOptions): this {
    return this.toTarget({
      kind: 'bot',
      memberId: options.memberId,
      conversationScope: options.conversationScope ?? 'fixed_primary',
      mailboxPolicy: options.mailboxPolicy ?? 'fifo_serial',
      subscribeThread: options.subscribeThread ?? true,
      promptTemplate: options.promptTemplate,
    });
  }

  toGroupSeat(
    spaceId: string,
    memberId: string,
    messageTemplate: string
  ): this {
    return this.toTarget({
      kind: 'group',
      spaceId,
      dispatchMode: { type: 'specific_seat', memberId },
      messageTemplate,
    });
  }

  toGroupMentions(
    spaceId: string,
    memberIds: string[],
    messageTemplate: string,
    order: GroupMentionOrder = 'parallel'
  ): this {
    return this.toTarget({
      kind: 'group',
      spaceId,
      dispatchMode: { type: 'mention_seats', memberIds, order },
      messageTemplate,
    });
  }

  toGroupModeratorTriage(
    spaceId: string,
    moderatorMemberId: string,
    messageTemplate: string
  ): this {
    return this.toTarget({
      kind: 'group',
      spaceId,
      dispatchMode: { type: 'moderator_triage', moderatorMemberId },
      messageTemplate,
    });
  }

  toGroupBroadcastLog(spaceId: string, messageTemplate: string): this {
    return this.toTarget({
      kind: 'group',
      spaceId,
      dispatchMode: { type: 'broadcast_log_only' },
      messageTemplate,
    });
  }

  toUserApproval(options: UserApprovalTargetOptions): this {
    return this.toTarget({
      kind: 'user',
      interactionKind: 'approval',
      severity: options.severity ?? 'warning',
      titleTemplate: options.titleTemplate,
      bodyTemplate: options.bodyTemplate,
      mirrorToChannels: options.mirrorToChannels ?? [],
      approvalOptions: options.approvalOptions ?? [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject', destructive: true },
      ],
      slaTimeoutSeconds: options.slaTimeoutSeconds ?? null,
    });
  }

  toUserNotify(options: UserNotifyTargetOptions): this {
    return this.toTarget({
      kind: 'user',
      interactionKind: 'notify',
      severity: options.severity ?? 'info',
      titleTemplate: options.titleTemplate,
      bodyTemplate: options.bodyTemplate,
      mirrorToChannels: options.mirrorToChannels ?? [],
    });
  }

  toWorkflow(
    workflowId: string,
    pinnedVersion = 1,
    inputMapping: Record<string, string> = {}
  ): this {
    return this.toTarget({
      kind: 'workflow',
      workflowId,
      pinnedVersion,
      inputMapping,
    });
  }

  toUnvalidatedSpec(): PulseRuleSpec {
    return {
      name: this.#name,
      description: this.#description,
      projectId: this.#projectId,
      workspaceId: this.#workspaceId,
      evalMode: this.#evalMode,
      orchestrator: this.#orchestrator,
      filter: {
        sourceKinds: [...new Set(this.#filter.sourceKinds)],
        sourceInstanceIds: [...new Set(this.#filter.sourceInstanceIds)],
        eventTypes: [...new Set(this.#filter.eventTypes)],
        allowedActors: [...new Set(this.#filter.allowedActors)],
        conditions: [...this.#filter.conditions],
      },
      temporal: this.#temporal,
      debounceMs: this.#debounceMs,
      claimExclusive: this.#claimExclusive,
      targets: [...this.#targets],
    };
  }

  validate(): PulseDryRunViolation[] {
    return validatePulseRuleSpec(this.toUnvalidatedSpec());
  }

  build(): PulseRuleSpec {
    const spec = this.toUnvalidatedSpec();
    const violations = validatePulseRuleSpec(spec);
    if (violations.length > 0) {
      throw new PulseValidationError(
        `Invalid PulseRuleSpec '${this.#name}'`,
        violations
      );
    }
    return spec;
  }
}

export function pulseRule(name: string): PulseRuleBuilder {
  return new PulseRuleBuilder(name);
}

/* -------------------------------------------------------------------------- */
/* Fluent Dual-Primitive `PulseWorkflowBuilder`                               */
/* -------------------------------------------------------------------------- */

export interface SessionStepInput {
  agentId: string;
  prompt: string;
  dependsOn?: string[];
  phase?: string;
  inputBindings?: Record<string, WorkflowBinding>;
  modelOverride?: string;
  workspaceIsolation?: PulseWorkspaceIsolation;
  workspaceAccess?: WorkspaceAccess;
  sideEffectClass?: SideEffectClass;
  completionPolicy?: CompletionPolicy;
  outputDescription?: string;
  outputSchema?: JsonSchemaObject;
  timeoutSeconds?: number;
}

export interface BotStepInput {
  memberId: string;
  prompt: string;
  dependsOn?: string[];
  phase?: string;
  inputBindings?: Record<string, WorkflowBinding>;
  conversationScope?: BotConversationScope;
  mailboxPolicy?: BotMailboxPolicy;
  outputDescription?: string;
  outputSchema?: JsonSchemaObject;
  timeoutSeconds?: number;
}

export interface GroupStageStepInput {
  spaceId: string;
  dispatchMode: GroupDispatchMode;
  prompt: string;
  dependsOn?: string[];
  phase?: string;
  inputBindings?: Record<string, WorkflowBinding>;
  convergenceMode?: 'lead_summary' | 'fixed_rounds';
  maxRounds?: number;
}

export interface UserGateStepInput {
  interactionKind?: 'approval' | 'ask_form' | 'notify';
  title: string;
  body?: string;
  dependsOn?: string[];
  phase?: string;
  inputBindings?: Record<string, WorkflowBinding>;
  approverScope?: string;
  approvalOptions?: ApprovalOptionSpec[];
  decisionSchema?: JsonSchemaObject;
  formSchema?: JsonSchemaObject;
  skippable?: boolean;
  timeoutSeconds?: number;
}

export interface BoundedLoopStepInput {
  bodyStepIds: string[];
  conditionPointer: string;
  exitEquals?: unknown;
  maxIterations: number;
  onExhaustedStepId?: string;
  dependsOn?: string[];
  phase?: string;
  inputBindings?: Record<string, WorkflowBinding>;
}

export interface WaitForEventStepInput {
  eventTypes: string[];
  threadKeyPointer?: string;
  filter?: Partial<GateFilterAst>;
  timeoutSeconds: number;
  onTimeoutStepId?: string;
  dependsOn?: string[];
  phase?: string;
  inputBindings?: Record<string, WorkflowBinding>;
}

export interface OutboxActionStepInput {
  actionKind: 'reply_channel' | 'emit_event' | 'webhook_post' | 'issue_update';
  targetChannelIndex?: number;
  eventType?: string;
  payloadTemplate: Record<string, unknown> | string;
  dependsOn?: string[];
  phase?: string;
  inputBindings?: Record<string, WorkflowBinding>;
}

export class PulseWorkflowBuilder {
  readonly #name: string;
  #description?: string;
  #orchestrator?: PresetOrchestratorKind;
  #inputSchema?: JsonSchemaObject;
  #steps: PulseWorkflowStep[] = [];
  #policy: PulseWorkflowPolicy = {
    maxConcurrentAgentSteps: 4,
    maxAgentCalls: 64,
    deadlineSeconds: 3600,
    maxOutputBytes: 1024 * 1024,
  };

  constructor(name: string) {
    this.#name = name;
  }

  description(text: string): this {
    this.#description = text;
    return this;
  }

  orchestrator(kind: PresetOrchestratorKind): this {
    this.#orchestrator = kind;
    return this;
  }

  inputSchema(schema: JsonSchemaObject): this {
    this.#inputSchema = schema;
    return this;
  }

  policy(overrides: Partial<PulseWorkflowPolicy>): this {
    this.#policy = {
      ...this.#policy,
      ...overrides,
    };
    return this;
  }

  /**
   * Adds an ephemeral `SessionStep` that launches a brand-new session with
   * refreshed clean context on every activation/iteration.
   */
  sessionStep(id: string, input: SessionStepInput): this {
    const step: SessionStep = {
      id,
      kind: 'session',
      dependsOn: input.dependsOn ? [...input.dependsOn] : [],
      phase: input.phase,
      inputBindings: input.inputBindings,
      agentId: input.agentId,
      prompt: input.prompt,
      refreshContext: true,
      modelOverride: input.modelOverride,
      workspaceIsolation: input.workspaceIsolation ?? 'isolated_worktree',
      workspaceAccess: input.workspaceAccess,
      sideEffectClass: input.sideEffectClass,
      completionPolicy: input.completionPolicy,
      outputDescription: input.outputDescription,
      outputSchema: input.outputSchema,
      timeoutSeconds: input.timeoutSeconds,
    };
    this.#steps.push(step);
    return this;
  }

  /**
   * Adds a persistent `BotStep` bound to a long-lived `memberId` and fixed
   * conversation without resetting context across runs.
   */
  botStep(id: string, input: BotStepInput): this {
    const step: BotStep = {
      id,
      kind: 'bot',
      dependsOn: input.dependsOn ? [...input.dependsOn] : [],
      phase: input.phase,
      inputBindings: input.inputBindings,
      memberId: input.memberId,
      prompt: input.prompt,
      preserveContext: true,
      conversationScope: input.conversationScope ?? 'fixed_primary',
      mailboxPolicy: input.mailboxPolicy ?? 'fifo_serial',
      outputDescription: input.outputDescription,
      outputSchema: input.outputSchema,
      timeoutSeconds: input.timeoutSeconds,
    };
    this.#steps.push(step);
    return this;
  }

  groupStageStep(id: string, input: GroupStageStepInput): this {
    const step: GroupStageStep = {
      id,
      kind: 'group_stage',
      dependsOn: input.dependsOn ? [...input.dependsOn] : [],
      phase: input.phase,
      inputBindings: input.inputBindings,
      spaceId: input.spaceId,
      dispatchMode: input.dispatchMode,
      prompt: input.prompt,
      convergenceMode: input.convergenceMode ?? 'lead_summary',
      maxRounds: input.maxRounds,
    };
    this.#steps.push(step);
    return this;
  }

  userGateStep(id: string, input: UserGateStepInput): this {
    const step: UserGateStep = {
      id,
      kind: 'user_gate',
      dependsOn: input.dependsOn ? [...input.dependsOn] : [],
      phase: input.phase,
      inputBindings: input.inputBindings,
      interactionKind: input.interactionKind ?? 'approval',
      title: input.title,
      body: input.body,
      approverScope: input.approverScope ?? 'workspace_owner',
      approvalOptions: input.approvalOptions,
      decisionSchema: input.decisionSchema,
      formSchema: input.formSchema,
      skippable: input.skippable ?? false,
      timeoutSeconds: input.timeoutSeconds,
    };
    this.#steps.push(step);
    return this;
  }

  boundedLoopStep(id: string, input: BoundedLoopStepInput): this {
    const step: BoundedLoopStep = {
      id,
      kind: 'bounded_loop',
      dependsOn: input.dependsOn ? [...input.dependsOn] : [],
      phase: input.phase,
      inputBindings: input.inputBindings,
      bodyStepIds: [...input.bodyStepIds],
      conditionPointer: input.conditionPointer,
      exitEquals: input.exitEquals,
      maxIterations: input.maxIterations,
      onExhaustedStepId: input.onExhaustedStepId,
    };
    this.#steps.push(step);
    return this;
  }

  waitForEventStep(id: string, input: WaitForEventStepInput): this {
    const step: WaitForEventStep = {
      id,
      kind: 'wait_for_event',
      dependsOn: input.dependsOn ? [...input.dependsOn] : [],
      phase: input.phase,
      inputBindings: input.inputBindings,
      eventTypes: [...input.eventTypes],
      threadKeyPointer: input.threadKeyPointer,
      filter: input.filter,
      timeoutSeconds: input.timeoutSeconds,
      onTimeoutStepId: input.onTimeoutStepId,
    };
    this.#steps.push(step);
    return this;
  }

  outboxActionStep(id: string, input: OutboxActionStepInput): this {
    const step: OutboxActionStep = {
      id,
      kind: 'outbox_action',
      dependsOn: input.dependsOn ? [...input.dependsOn] : [],
      phase: input.phase,
      inputBindings: input.inputBindings,
      actionKind: input.actionKind,
      targetChannelIndex: input.targetChannelIndex,
      eventType: input.eventType,
      payloadTemplate: input.payloadTemplate,
    };
    this.#steps.push(step);
    return this;
  }

  connect(fromStepId: string, toStepId: string): this {
    const target = this.#steps.find((step) => step.id === toStepId);
    if (target && !target.dependsOn.includes(fromStepId)) {
      target.dependsOn.push(fromStepId);
    }
    return this;
  }

  toUnvalidatedDefinition(): PulseWorkflowDefinition {
    return {
      formatVersion: 1,
      name: this.#name,
      description: this.#description,
      orchestrator: this.#orchestrator,
      inputSchema: this.#inputSchema,
      steps: this.#steps.map((step) => ({
        ...step,
        dependsOn: [...new Set(step.dependsOn)],
      })),
      policy: { ...this.#policy },
    };
  }

  validate(): PulseDryRunViolation[] {
    return validatePulseWorkflowDefinition(this.toUnvalidatedDefinition());
  }

  build(): PulseWorkflowDefinition {
    const definition = this.toUnvalidatedDefinition();
    const violations = validatePulseWorkflowDefinition(definition);
    if (violations.length > 0) {
      throw new PulseValidationError(
        `Invalid PulseWorkflowDefinition '${this.#name}'`,
        violations
      );
    }
    return definition;
  }
}

export function pulseWorkflow(name: string): PulseWorkflowBuilder {
  return new PulseWorkflowBuilder(name);
}
