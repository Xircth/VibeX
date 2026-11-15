import {
  configuredBackendTransport,
  type BackendTransport,
} from '@/lib/backendTransport';

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

export type EventSourceMeta = {
  kind: EventSourceKind;
  instanceId: string;
  trustLevel: EventTrustLevel;
};

export type EventActor = {
  id: string;
  displayName?: string | null;
  roles: string[];
  isBot: boolean;
  isSelf: boolean;
};

export type ReplyChannelAddress = {
  sourceKind: EventSourceKind;
  instanceId: string;
  channelId: string;
  messageId?: string | null;
  threadId?: string | null;
};

export type EventTrace = {
  rootEventId: string;
  parentRunId?: string | null;
  hopCount: number;
};

export type EventEnvelope = {
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
  payload: unknown;
};

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

export type GateFilterAst = {
  sourceKinds: EventSourceKind[];
  sourceInstanceIds: string[];
  eventTypes: string[];
  allowedActors: string[];
  conditions: GateFilterCondition[];
};

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

export type ApprovalOptionSpec = {
  id: string;
  label: string;
  destructive?: boolean;
  requireNote?: boolean;
};

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

export type PulseRuleSpec = {
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
};

export type PulseRuleView = {
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
};

export type PulseDryRunViolation = {
  path: string;
  code: string;
  message: string;
};

export type PulseDryRunReport = {
  valid: boolean;
  matched: boolean;
  violations: PulseDryRunViolation[];
  unmatchedConditions: number[];
  renderedPreviews: string[];
};

export type PulseSourceView = {
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
};

export type PulseObservedCandidateView = {
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
};

export type PulseUserInteractionView = {
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
};

export type PulseSubscriptionView = {
  id: string;
  threadKey: string;
  subscriberKind: string;
  subscriberId: string;
  active: boolean;
  createdAt: string;
};

export type PulseEventSchemaView = {
  eventType: string;
  summary: string;
  jsonSchema: Record<string, unknown>;
  builtIn: boolean;
  updatedAt: string;
};

export type PulseDeckSnapshot = {
  engineActive: boolean;
  activeTicketCount: number;
  pendingUserInteractionCount: number;
  sources: PulseSourceView[];
  rules: PulseRuleView[];
  observedCandidates: PulseObservedCandidateView[];
  subscriptions: PulseSubscriptionView[];
  pendingInteractions: PulseUserInteractionView[];
};

export type PulseSourceUpsertInput = {
  id?: string | null;
  kind: EventSourceKind;
  title: string;
  enabled: boolean;
  configJson?: Record<string, unknown>;
  signingSecret?: string | null;
};

export type PulseRuleSaveInput = {
  id?: string | null;
  enabled?: boolean;
  spec: PulseRuleSpec;
};

export type PulseEmitCustomEventInput = {
  eventType: string;
  threadKey?: string | null;
  payload: unknown;
};

export type PulseResolveInteractionInput = {
  interactionId: string;
  optionId?: string | null;
  note?: string | null;
  formValues?: Record<string, unknown> | null;
};

export function createPulseApi(transport: BackendTransport) {
  return {
    deckSnapshot: (projectId?: string | null) =>
      transport.call('pulse_deck_snapshot', {
        projectId: projectId ?? null,
      }) as Promise<PulseDeckSnapshot>,

    listSources: () =>
      transport.call('pulse_source_list') as Promise<PulseSourceView[]>,

    upsertSource: (input: PulseSourceUpsertInput) =>
      transport.call('pulse_source_upsert', {
        input,
      }) as Promise<PulseSourceView>,

    deleteSource: (id: string) =>
      transport.call('pulse_source_delete', { id }) as Promise<void>,

    listRules: (projectId?: string | null) =>
      transport.call('pulse_rule_list', {
        projectId: projectId ?? null,
      }) as Promise<PulseRuleView[]>,

    saveRule: (input: PulseRuleSaveInput) =>
      transport.call('pulse_rule_save', {
        input,
      }) as Promise<PulseRuleView>,

    setRuleMode: (id: string, evalMode: PulseEvalMode) =>
      transport.call('pulse_rule_set_mode', {
        id,
        evalMode,
      }) as Promise<PulseRuleView>,

    setRuleEnabled: (id: string, enabled: boolean) =>
      transport.call('pulse_rule_set_enabled', {
        id,
        enabled,
      }) as Promise<PulseRuleView>,

    deleteRule: (id: string) =>
      transport.call('pulse_rule_delete', { id }) as Promise<void>,

    dryRunRule: (spec: PulseRuleSpec, sampleEvent: EventEnvelope) =>
      transport.call('pulse_rule_dry_run', {
        spec,
        sampleEvent,
      }) as Promise<PulseDryRunReport>,

    emitCustomEvent: (input: PulseEmitCustomEventInput) =>
      transport.call('pulse_event_emit', {
        input,
      }) as Promise<EventEnvelope>,

    listCapturedEvents: (limit = 25) =>
      transport.call('pulse_captured_events', {
        limit,
      }) as Promise<EventEnvelope[]>,

    promoteObservedCandidate: (candidateId: string) =>
      transport.call('pulse_candidate_promote', {
        candidateId,
      }) as Promise<void>,

    resolveUserInteraction: (input: PulseResolveInteractionInput) =>
      transport.call('pulse_interaction_resolve', {
        input,
      }) as Promise<PulseUserInteractionView>,

    subscribeThread: (
      threadKey: string,
      subscriberKind: 'session' | 'bot' | 'group',
      subscriberId: string
    ) =>
      transport.call('pulse_thread_subscribe', {
        threadKey,
        subscriberKind,
        subscriberId,
      }) as Promise<PulseSubscriptionView>,

    unsubscribeThread: (subscriptionId: string) =>
      transport.call('pulse_thread_unsubscribe', {
        subscriptionId,
      }) as Promise<void>,

    listEventSchemas: () =>
      transport.call('pulse_event_schema_list') as Promise<
        PulseEventSchemaView[]
      >,

    defineEventSchema: (
      eventType: string,
      summary: string,
      jsonSchema: Record<string, unknown>
    ) =>
      transport.call('pulse_event_schema_define', {
        eventType,
        summary,
        jsonSchema,
      }) as Promise<PulseEventSchemaView>,
  };
}

export const pulseApi = createPulseApi(configuredBackendTransport);
