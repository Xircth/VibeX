import type {
  EventEnvelope,
  EventSourceKind,
  GroupDispatchMode,
  PulseEvalMode,
  PulseRuleSpec,
  PulseTemporalSpec,
} from '@/lib/api/pulse';

export const COLLABORATION_PULSE_PROPOSAL_EVENT =
  'vibex:collaboration-pulse-proposal';

export type CollaborationPulseProposalDetail =
  | {
      kind: 'spec';
      spec: PulseRuleSpec;
      contextLabel?: string;
    }
  | {
      kind: 'bot';
      memberId: string;
      botName: string;
      mode?: 'event' | 'schedule';
      workspaceId?: string | null;
      projectId?: string | null;
    }
  | {
      kind: 'group-seat';
      spaceId?: string | null;
      spaceName?: string | null;
      memberId?: string | null;
      nickname: string;
      workspaceId?: string | null;
      projectId?: string | null;
    };

export function requestCollaborationPulseProposal(
  detail: CollaborationPulseProposalDetail
) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<CollaborationPulseProposalDetail>(
      COLLABORATION_PULSE_PROPOSAL_EVENT,
      { detail }
    )
  );
}

export function defaultTemporalSpecForSource(
  sourceKind: EventSourceKind
): PulseTemporalSpec | null {
  switch (sourceKind) {
    case 'time_cron':
      return {
        kind: 'cron',
        expression: '0 9 * * 1-5',
        timezone: 'UTC',
        weekdaysOnly: true,
        catchUpOnce: true,
      };
    case 'time_once':
      return {
        kind: 'once',
        fireAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
    case 'time_interval':
      return {
        kind: 'interval',
        everySeconds: 900,
        skipIfBusy: true,
      };
    case 'time_sla':
      return {
        kind: 'inactivity_sla',
        threadKeyPrefix: 'group:',
        timeoutSeconds: 1800,
        expectedEventTypes: ['message.replied'],
      };
    default:
      return null;
  }
}

export function isTemporalSourceKind(sourceKind: EventSourceKind): boolean {
  return (
    sourceKind === 'time_cron' ||
    sourceKind === 'time_once' ||
    sourceKind === 'time_interval' ||
    sourceKind === 'time_sla'
  );
}

export function defaultEventTypeForSource(sourceKind: EventSourceKind): string {
  switch (sourceKind) {
    case 'feishu':
      return 'feishu.im.message.receive_v1';
    case 'jira':
      return 'jira.issue.updated';
    case 'github':
      return 'github.pull_request.opened';
    case 'webhook_standard':
    case 'webhook_custom':
      return 'webhook.event';
    case 'time_cron':
      return 'pulse.cron.tick';
    case 'time_once':
      return 'pulse.once.fire';
    case 'time_interval':
      return 'pulse.interval.tick';
    case 'time_sla':
      return 'pulse.sla.expired';
    default:
      return 'custom.event';
  }
}

export function buildBotPulseProposalSpec({
  memberId,
  botName,
  sourceKind = 'webhook_standard',
  evalMode = 'observe',
  description = '',
  workspaceId = null,
  projectId = null,
}: {
  memberId: string;
  botName: string;
  sourceKind?: EventSourceKind;
  evalMode?: PulseEvalMode;
  description?: string;
  workspaceId?: string | null;
  projectId?: string | null;
}): PulseRuleSpec {
  const trimmed = description.trim();
  const temporal = defaultTemporalSpecForSource(sourceKind);
  const eventType = defaultEventTypeForSource(sourceKind);
  return {
    name: trimmed ? trimmed.slice(0, 64) : `${botName} Event Trigger`,
    description: trimmed || null,
    projectId,
    workspaceId,
    evalMode,
    orchestrator: 'direct_reflex',
    filter: {
      sourceKinds: [sourceKind],
      sourceInstanceIds: [],
      eventTypes: eventType ? [eventType] : [],
      allowedActors: [],
      conditions: isTemporalSourceKind(sourceKind)
        ? []
        : [{ op: 'not_bot_actor' }],
    },
    temporal,
    targets: [
      {
        kind: 'bot',
        memberId,
        conversationScope: 'fixed_primary',
        mailboxPolicy: 'fifo_serial',
        subscribeThread: true,
        promptTemplate: trimmed
          ? `${trimmed}\n\nEvent {{event.type}} ({{threadKey}}):\n{{summary}}`
          : `Handle {{event.type}} from {{actor.displayName}} on {{threadKey}}:\n{{summary}}`,
      },
    ],
  };
}

export function buildGroupPulseProposalSpec({
  spaceId,
  spaceName,
  dispatchMode,
  sourceKind = 'webhook_standard',
  evalMode = 'observe',
  description = '',
  workspaceId = null,
  projectId = null,
}: {
  spaceId: string;
  spaceName: string;
  dispatchMode: GroupDispatchMode;
  sourceKind?: EventSourceKind;
  evalMode?: PulseEvalMode;
  description?: string;
  workspaceId?: string | null;
  projectId?: string | null;
}): PulseRuleSpec {
  const trimmed = description.trim();
  const temporal = defaultTemporalSpecForSource(sourceKind);
  const eventType = defaultEventTypeForSource(sourceKind);
  return {
    name: trimmed ? trimmed.slice(0, 64) : `${spaceName} Group Trigger`,
    description: trimmed || null,
    projectId,
    workspaceId,
    evalMode,
    orchestrator: 'direct_reflex',
    filter: {
      sourceKinds: [sourceKind],
      sourceInstanceIds: [],
      eventTypes: eventType ? [eventType] : [],
      allowedActors: [],
      conditions: isTemporalSourceKind(sourceKind)
        ? []
        : [{ op: 'not_bot_actor' }],
    },
    temporal,
    targets: [
      {
        kind: 'group',
        spaceId,
        dispatchMode,
        messageTemplate: trimmed
          ? `${trimmed}\n\n[{{event.type}}] {{summary}}`
          : `[{{event.type}}] {{actor.displayName}}: {{summary}}`,
      },
    ],
  };
}

export function buildSampleEnvelopeForSource(
  sourceKind: EventSourceKind,
  eventType?: string,
  payloadOverride?: unknown
): EventEnvelope {
  const resolvedType = eventType?.trim() || defaultEventTypeForSource(sourceKind);
  const defaultPayload =
    payloadOverride !== undefined
      ? payloadOverride
      : {
          summary: 'High-priority P0 regression reported on checkout service',
          issue: { key: 'PROJ-128', priority: 'High', status: 'Open' },
          pr: { number: 42, branch: 'feat/pulse-engine' },
          message: { text: 'Please triage this incident' },
        };

  return {
    eventId: 'evt-sample-01',
    deliveryId: 'dlv-sample-01',
    source: {
      kind: sourceKind,
      instanceId: `${sourceKind}-primary`,
      trustLevel: isTemporalSourceKind(sourceKind)
        ? 'trusted_internal'
        : 'verified_external',
    },
    eventType: resolvedType,
    occurredAt: new Date().toISOString(),
    actor: {
      id: 'user-alex',
      displayName: 'Alex Chen',
      roles: ['maintainer'],
      isBot: false,
      isSelf: false,
    },
    threadKey:
      sourceKind === 'jira'
        ? 'jira:PROJ-128'
        : sourceKind === 'github'
          ? 'github:vibex/core#42'
          : sourceKind === 'feishu'
            ? 'feishu:oc_chat_01'
            : 'webhook:inc-01',
    correlations: [],
    replyChannels: [],
    trace: {
      rootEventId: 'evt-sample-01',
      parentRunId: null,
      hopCount: 0,
    },
    payload: defaultPayload,
  };
}
