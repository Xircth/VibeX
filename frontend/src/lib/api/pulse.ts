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

export type PulseCallbackKind =
  | 'feishu_webhook'
  | 'github_comment'
  | 'webhook_post'
  | 'reply_channel';

export type PulseCallbackSpec = {
  kind: PulseCallbackKind;
  destination: string;
  payloadTemplate?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
};

export type PulseTaskLifecycleState =
  | 'editing'
  | 'pending_test'
  | 'publishing'
  | 'published';

export type PulseTaskKind =
  | 'fast_task'
  | 'reusable_rule'
  | 'workflow_trigger';

export type PulseTaskMeta = {
  taskKind?: PulseTaskKind | null;
  lifecycleState?: PulseTaskLifecycleState | null;
  boundRuleTemplateId?: string | null;
  lastTestedAt?: string | null;
  lastTestPassed?: boolean | null;
  lastRunAt?: string | null;
  lastRunStatus?: string | null;
  lastRunSummary?: string | null;
};

export type PulseOutboxEntryView = {
  id: string;
  ruleId?: string | null;
  targetKind: string;
  destination?: string | null;
  status: string;
  attempts: number;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PulseSourceTestResult = {
  ok: boolean;
  sourceId: string;
  mode: string;
  message: string;
  webhookPath?: string | null;
  sampleEnvelope?: EventEnvelope | null;
};

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
  callback?: PulseCallbackSpec | null;
  taskMeta?: PulseTaskMeta | null;
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
  configJson?: Record<string, unknown>;
  hasSigningSecret?: boolean;
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

export type PulseSubscriberKind = 'session' | 'bot' | 'group' | 'workflow';

export type PulseSubscriptionView = {
  id: string;
  threadKey: string;
  subscriberKind: PulseSubscriberKind | (string & NonNullable<unknown>);
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
  busyRuleIds?: string[];
  recentOutbox?: PulseOutboxEntryView[];
};

export type PulseSourceUpsertInput = {
  id?: string | null;
  kind: EventSourceKind;
  title: string;
  enabled: boolean;
  configJson?: Record<string, unknown>;
  signingSecret?: string | null;
  clearSigningSecret?: boolean;
};

export type PulseRuleSaveInput = {
  id?: string | null;
  enabled?: boolean;
  draftOnly?: boolean;
  mandateOrigin?: MandateOrigin;
  webhookRouteId?: string | null;
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

export const PULSE_REQUEST_TIMEOUT_MS = 15_000;

export function extractPulseErrorMessage(
  error: unknown,
  fallback = 'Pulse request failed.'
): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message.trim();
    }
    if (typeof record.error === 'string' && record.error.trim()) {
      return record.error.trim();
    }
    if (
      record.error &&
      typeof record.error === 'object' &&
      typeof (record.error as Record<string, unknown>).message === 'string'
    ) {
      const nested = (
        (record.error as Record<string, unknown>).message as string
      ).trim();
      if (nested) return nested;
    }
  }
  return fallback;
}

async function callPulseTransport<T>(
  transport: BackendTransport,
  command: string,
  args?: Record<string, unknown>,
  timeoutMs = PULSE_REQUEST_TIMEOUT_MS
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(
          `Pulse request "${command}" timed out after ${Math.round(timeoutMs / 1000)}s.`
        )
      );
    }, timeoutMs);
  });

  try {
    const requestPromise =
      args === undefined
        ? transport.call(command)
        : transport.call(command, args);
    return (await Promise.race([requestPromise, timeoutPromise])) as T;
  } catch (error) {
    throw new Error(
      extractPulseErrorMessage(error, `Pulse request "${command}" failed.`)
    );
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

export function createPulseApi(transport: BackendTransport) {
  return {
    deckSnapshot: (projectId?: string | null) =>
      callPulseTransport<PulseDeckSnapshot>(transport, 'pulse_deck_snapshot', {
        projectId: projectId ?? null,
      }),

    listSources: () =>
      callPulseTransport<PulseSourceView[]>(transport, 'pulse_source_list'),

    upsertSource: (input: PulseSourceUpsertInput) =>
      callPulseTransport<PulseSourceView>(transport, 'pulse_source_upsert', {
        input,
      }),

    deleteSource: (id: string) =>
      callPulseTransport<void>(transport, 'pulse_source_delete', { id }),

    testSource: async (
      id: string,
      ingest = false
    ): Promise<PulseSourceTestResult> => {
      try {
        return await callPulseTransport<PulseSourceTestResult>(
          transport,
          'pulse_source_test',
          { input: { id, ingest } }
        );
      } catch (error) {
        const msg = extractPulseErrorMessage(error, '');
        const isUnknownCommand =
          /unknown|not found|unrecognized|unsupported|not implemented/i.test(
            msg
          );
        if (!isUnknownCommand) {
          throw error;
        }
        const fallbackSample: EventEnvelope = {
          eventId: `evt-test-${id}`,
          deliveryId: `dlv-test-${id}`,
          source: {
            kind: 'webhook_standard',
            instanceId: id,
            trustLevel: 'verified_external',
          },
          eventType: 'pulse.source.self_test',
          occurredAt: new Date().toISOString(),
          actor: {
            id: 'self-test',
            displayName: 'Source Self-Test',
            roles: [],
            isBot: false,
            isSelf: false,
          },
          threadKey: `source-test:${id}`,
          correlations: [],
          replyChannels: [],
          trace: {
            rootEventId: `evt-test-${id}`,
            parentRunId: null,
            hopCount: 0,
          },
          payload: { sourceId: id, ok: true },
        };
        if (ingest) {
          const emitted = await callPulseTransport<EventEnvelope>(
            transport,
            'pulse_event_emit',
            {
              input: {
                eventType: 'pulse.source.self_test',
                threadKey: `source-test:${id}`,
                payload: { sourceId: id, selfTest: true },
              },
            }
          );
          return {
            ok: true,
            sourceId: id,
            mode: 'fallback_emit',
            message: 'Self-test event emitted into automation engine.',
            webhookPath: `/api/pulse/webhooks/${id}`,
            sampleEnvelope: emitted,
          };
        }
        await callPulseTransport<PulseDryRunReport>(
          transport,
          'pulse_rule_dry_run',
          {
            spec: {
              name: 'Source Connectivity Probe',
              evalMode: 'observe',
              filter: {
                sourceKinds: [],
                sourceInstanceIds: [],
                eventTypes: [],
                allowedActors: [],
                conditions: [],
              },
              targets: [],
            },
            sampleEvent: fallbackSample,
          }
        ).catch(() => null);
        return {
          ok: true,
          sourceId: id,
          mode: 'fallback_dry_run',
          message: 'Connectivity probe succeeded.',
          webhookPath: `/api/pulse/webhooks/${id}`,
          sampleEnvelope: fallbackSample,
        };
      }
    },

    listRules: (projectId?: string | null) =>
      callPulseTransport<PulseRuleView[]>(transport, 'pulse_rule_list', {
        projectId: projectId ?? null,
      }),

    saveRule: (input: PulseRuleSaveInput) =>
      callPulseTransport<PulseRuleView>(transport, 'pulse_rule_save', {
        input,
      }),

    setRuleMode: (id: string, evalMode: PulseEvalMode) =>
      callPulseTransport<PulseRuleView>(transport, 'pulse_rule_set_mode', {
        id,
        evalMode,
      }),

    setRuleEnabled: (id: string, enabled: boolean) =>
      callPulseTransport<PulseRuleView>(transport, 'pulse_rule_set_enabled', {
        id,
        enabled,
      }),

    deleteRule: (id: string) =>
      callPulseTransport<void>(transport, 'pulse_rule_delete', { id }),

    dryRunRule: (spec: PulseRuleSpec, sampleEvent: EventEnvelope) =>
      callPulseTransport<PulseDryRunReport>(transport, 'pulse_rule_dry_run', {
        spec,
        sampleEvent,
      }),

    emitCustomEvent: (input: PulseEmitCustomEventInput) =>
      callPulseTransport<EventEnvelope>(transport, 'pulse_event_emit', {
        input,
      }),

    listCapturedEvents: (limit = 25) =>
      callPulseTransport<EventEnvelope[]>(transport, 'pulse_captured_events', {
        limit,
      }),

    promoteObservedCandidate: (candidateId: string) =>
      callPulseTransport<void>(transport, 'pulse_candidate_promote', {
        candidateId,
      }),

    resolveUserInteraction: (input: PulseResolveInteractionInput) =>
      callPulseTransport<PulseUserInteractionView>(
        transport,
        'pulse_interaction_resolve',
        {
          input,
        }
      ),

    subscribeThread: (
      threadKey: string,
      subscriberKind: 'session' | 'bot' | 'group' | 'workflow',
      subscriberId: string
    ) =>
      callPulseTransport<PulseSubscriptionView>(
        transport,
        'pulse_thread_subscribe',
        {
          threadKey,
          subscriberKind,
          subscriberId,
        }
      ),

    unsubscribeThread: (subscriptionId: string) =>
      callPulseTransport<void>(transport, 'pulse_thread_unsubscribe', {
        subscriptionId,
      }),

    listEventSchemas: () =>
      callPulseTransport<PulseEventSchemaView[]>(
        transport,
        'pulse_event_schema_list'
      ),

    defineEventSchema: (
      eventType: string,
      summary: string,
      jsonSchema: Record<string, unknown>
    ) =>
      callPulseTransport<PulseEventSchemaView>(
        transport,
        'pulse_event_schema_define',
        {
          eventType,
          summary,
          jsonSchema,
        }
      ),
  };
}

export const pulseApi = createPulseApi(configuredBackendTransport);
