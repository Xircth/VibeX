import type {
  BotMailboxPolicy,
  EventEnvelope,
  EventSourceKind,
  GroupDispatchMode,
  PresetOrchestratorKind,
  PulseTargetSpec,
  PulseTemporalSpec,
} from '@/lib/api/pulse';

export const BUILT_IN_SAMPLE_EVENTS: EventEnvelope[] = [
  {
    eventId: 'evt_sample_feishu_01',
    deliveryId: 'dlv_feishu_9182',
    source: {
      kind: 'feishu',
      instanceId: 'feishu-ws-main',
      trustLevel: 'verified_external',
    },
    eventType: 'feishu.im.mention',
    occurredAt: '2026-11-15T09:00:00.000Z',
    actor: {
      id: 'ou_dev_lead',
      displayName: 'Lin Chen',
      roles: ['maintainer'],
      isBot: false,
      isSelf: false,
    },
    threadKey: 'feishu:topic:om_9182',
    correlations: ['jira:CORE-128'],
    replyChannels: [
      {
        sourceKind: 'feishu',
        instanceId: 'feishu-ws-main',
        channelId: 'oc_eng_oncall',
        messageId: 'om_9182',
        threadId: 'omt_9182',
      },
    ],
    trace: {
      rootEventId: 'evt_sample_feishu_01',
      parentRunId: null,
      hopCount: 0,
    },
    payload: {
      text: '@SRE-Bot investigate API p99 latency regression in gateway',
      chatType: 'group',
      priority: 'P1',
      service: 'gateway',
    },
  },
  {
    eventId: 'evt_sample_jira_02',
    deliveryId: 'dlv_jira_core_128',
    source: {
      kind: 'jira',
      instanceId: 'jira-prod',
      trustLevel: 'verified_external',
    },
    eventType: 'jira.issue.transitioned',
    occurredAt: '2026-11-15T09:05:00.000Z',
    actor: {
      id: 'jira_pm_01',
      displayName: 'Alex Rivera',
      roles: ['pm'],
      isBot: false,
      isSelf: false,
    },
    threadKey: 'jira:CORE-128',
    correlations: [],
    replyChannels: [
      {
        sourceKind: 'jira',
        instanceId: 'jira-prod',
        channelId: 'CORE-128',
        messageId: null,
        threadId: 'CORE-128',
      },
    ],
    trace: {
      rootEventId: 'evt_sample_jira_02',
      parentRunId: null,
      hopCount: 0,
    },
    payload: {
      issue: {
        key: 'CORE-128',
        summary: 'Fix race condition in worktree checkout lock',
        priority: 'P0',
        status: 'In Progress',
        labels: ['rust', 'concurrency'],
      },
      transition: {
        from: 'To Do',
        to: 'In Progress',
      },
    },
  },
  {
    eventId: 'evt_sample_github_03',
    deliveryId: 'dlv_gh_pr_42',
    source: {
      kind: 'github',
      instanceId: 'github-app',
      trustLevel: 'verified_external',
    },
    eventType: 'github.ci.failed',
    occurredAt: '2026-11-15T09:12:00.000Z',
    actor: {
      id: 'gh_actions',
      displayName: 'GitHub Actions',
      roles: ['ci'],
      isBot: false,
      isSelf: false,
    },
    threadKey: 'github:pr:vibex/core#42',
    correlations: ['jira:CORE-128'],
    replyChannels: [
      {
        sourceKind: 'github',
        instanceId: 'github-app',
        channelId: 'vibex/core',
        messageId: null,
        threadId: '42',
      },
    ],
    trace: {
      rootEventId: 'evt_sample_github_03',
      parentRunId: null,
      hopCount: 0,
    },
    payload: {
      repository: 'vibex/core',
      pullRequest: 42,
      branch: 'feat/pulse-engine',
      failedJob: 'cargo-test-workspace',
      failedStepCount: 2,
    },
  },
  {
    eventId: 'evt_sample_cron_04',
    deliveryId: 'dlv_cron_20261115_0900',
    source: {
      kind: 'time_cron',
      instanceId: 'temporal-host',
      trustLevel: 'trusted_internal',
    },
    eventType: 'time.cron.tick',
    occurredAt: '2026-11-15T09:00:00.000Z',
    actor: {
      id: 'system:temporal',
      displayName: 'Temporal Scheduler',
      roles: ['system'],
      isBot: false,
      isSelf: false,
    },
    threadKey: 'cron:weekday-triage',
    correlations: [],
    replyChannels: [],
    trace: {
      rootEventId: 'evt_sample_cron_04',
      parentRunId: null,
      hopCount: 0,
    },
    payload: {
      schedule: '0 9 * * 1-5',
      timezone: 'Asia/Shanghai',
      windowHours: 24,
    },
  },
];

export function formatEventSourceLabel(kind: EventSourceKind): string {
  switch (kind) {
    case 'feishu':
      return 'Feishu';
    case 'jira':
      return 'Jira';
    case 'github':
      return 'GitHub';
    case 'webhook_standard':
      return 'Webhook';
    case 'webhook_custom':
      return 'Custom Webhook';
    case 'time_cron':
      return 'Cron';
    case 'time_once':
      return 'Once';
    case 'time_interval':
      return 'Interval';
    case 'time_sla':
      return 'SLA';
    case 'sdk_custom':
      return 'SDK';
    case 'system_internal':
      return 'Internal';
  }
}

export function formatTemporalBadgeLabel(temporal: PulseTemporalSpec): string {
  switch (temporal.kind) {
    case 'cron':
      return `Cron · ${temporal.expression}`;
    case 'once':
      return `Once · ${temporal.fireAt}`;
    case 'interval':
      return `Interval · ${temporal.everySeconds}s`;
    case 'inactivity_sla':
      return `SLA · ${temporal.timeoutSeconds}s`;
  }
}

export function formatOrchestratorLabel(
  orchestrator?: PresetOrchestratorKind | null
): string {
  switch (orchestrator) {
    case 'superagent_router':
      return 'Superagent Router';
    case 'hybrid_pipeline':
      return 'Hybrid Pipeline';
    case 'event_saga':
      return 'Event Saga';
    case 'window_aggregator':
      return 'Window Aggregator';
    case 'direct_reflex':
    default:
      return 'Direct Reflex';
  }
}

export function formatMailboxPolicyLabel(policy?: BotMailboxPolicy): string {
  return policy === 'coalesce_batch' ? 'Coalesce Batch' : 'FIFO Serial';
}

export function formatGroupDispatchLabel(mode: GroupDispatchMode): string {
  switch (mode.type) {
    case 'specific_seat':
      return `Specific Seat · ${mode.memberId || 'unset'}`;
    case 'mention_seats':
      return `Mention Seats (${mode.memberIds.length})`;
    case 'moderator_triage':
      return `Moderator Triage · ${mode.moderatorMemberId || 'unset'}`;
    case 'broadcast_log_only':
      return 'Broadcast Log';
  }
}

export type FormattedTargetBadge = {
  category: string;
  detail: string;
  memoryModel?: 'ephemeral' | 'persistent';
};

export function formatPulseTargetBadge(
  target: PulseTargetSpec
): FormattedTargetBadge {
  switch (target.kind) {
    case 'session': {
      const modeLabel =
        target.mode === 'ephemeral_fresh'
          ? 'Ephemeral Session · Fresh Context'
          : target.mode === 'thread_keyed'
            ? 'Thread Session · Correlated'
            : 'Bound Session';
      const isolation = target.workspaceIsolation ?? 'isolated_worktree';
      return {
        category: modeLabel,
        detail: `${target.agentId || 'agent'} · ${isolation}`,
        memoryModel: 'ephemeral',
      };
    }
    case 'bot':
      return {
        category: 'Persistent Bot · Fixed Memory',
        detail: `${target.memberId || 'bot'} · ${formatMailboxPolicyLabel(target.mailboxPolicy)}`,
        memoryModel: 'persistent',
      };
    case 'group':
      return {
        category: 'Group Seat',
        detail: `${target.spaceId || 'group'} · ${formatGroupDispatchLabel(target.dispatchMode)}`,
      };
    case 'user': {
      const kindMap = {
        notify: 'User Notify',
        approval: 'User Approval',
        ask_form: 'User Ask Form',
        digest: 'User Digest',
      } as const;
      const sla = target.slaTimeoutSeconds
        ? ` · SLA ${target.slaTimeoutSeconds}s`
        : '';
      return {
        category: kindMap[target.interactionKind],
        detail: `${target.titleTemplate || 'Untitled'}${sla}`,
      };
    }
    case 'workflow':
      return {
        category: 'Workflow',
        detail: `${target.workflowId}@v${target.pinnedVersion}`,
      };
  }
}
