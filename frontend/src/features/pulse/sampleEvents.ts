import i18n from '@/i18n';
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

export type PulseTranslateFn = (
  key: string,
  options?: Record<string, unknown>
) => string;

function resolvePanelsTranslator(tFn?: PulseTranslateFn): PulseTranslateFn {
  if (typeof tFn === 'function') {
    return (key, options) => tFn(key, { ns: 'panels', ...options });
  }
  return (key, options) => i18n.t(key, { ns: 'panels', ...options });
}

export function pulseI18nKey(raw: string): string {
  return raw.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

export function formatEventSourceLabel(
  kind: EventSourceKind,
  tFn?: PulseTranslateFn
): string {
  const tr = resolvePanelsTranslator(tFn);
  return tr(`pulseFilter.sources.${pulseI18nKey(kind)}`);
}

export function formatTemporalBadgeLabel(
  temporal: PulseTemporalSpec,
  tFn?: PulseTranslateFn
): string {
  const tr = resolvePanelsTranslator(tFn);
  switch (temporal.kind) {
    case 'cron':
      return tr('pulseFilter.temporal.cron', {
        expression: temporal.expression,
      });
    case 'once':
      return tr('pulseFilter.temporal.once', {
        fireAt: temporal.fireAt,
      });
    case 'interval':
      return tr('pulseFilter.temporal.interval', {
        seconds: temporal.everySeconds,
      });
    case 'inactivity_sla':
      return tr('pulseFilter.temporal.sla', {
        seconds: temporal.timeoutSeconds,
      });
  }
}

export function formatOrchestratorLabel(
  orchestrator?: PresetOrchestratorKind | null,
  tFn?: PulseTranslateFn
): string {
  const tr = resolvePanelsTranslator(tFn);
  const key = orchestrator ?? 'direct_reflex';
  return tr(`pulseFilter.orchestrators.${pulseI18nKey(key)}`);
}

export function formatMailboxPolicyLabel(
  policy?: BotMailboxPolicy,
  tFn?: PulseTranslateFn
): string {
  const tr = resolvePanelsTranslator(tFn);
  return policy === 'coalesce_batch'
    ? tr('pulseFilter.mailbox.coalesceBatch')
    : tr('pulseFilter.mailbox.fifoSerial');
}

export function formatGroupDispatchLabel(
  mode: GroupDispatchMode,
  tFn?: PulseTranslateFn
): string {
  const tr = resolvePanelsTranslator(tFn);
  const unset = tr('pulseFilter.groupDispatch.unset');
  switch (mode.type) {
    case 'specific_seat':
      return tr('pulseFilter.groupDispatch.specificSeat', {
        member: mode.memberId || unset,
      });
    case 'mention_seats':
      return tr('pulseFilter.groupDispatch.mentionSeats', {
        count: mode.memberIds.length,
      });
    case 'moderator_triage':
      return tr('pulseFilter.groupDispatch.moderatorTriage', {
        member: mode.moderatorMemberId || unset,
      });
    case 'broadcast_log_only':
      return tr('pulseFilter.groupDispatch.broadcastLog');
  }
}

export type FormattedTargetBadge = {
  category: string;
  detail: string;
  memoryModel?: 'ephemeral' | 'persistent';
};

export function formatPulseTargetBadge(
  target: PulseTargetSpec,
  tFn?: PulseTranslateFn
): FormattedTargetBadge {
  const tr = resolvePanelsTranslator(tFn);
  switch (target.kind) {
    case 'session': {
      const modeLabel =
        target.mode === 'ephemeral_fresh'
          ? tr('pulseFilter.targetBadge.ephemeralSession')
          : target.mode === 'thread_keyed'
            ? tr('pulseFilter.targetBadge.threadSession')
            : tr('pulseFilter.targetBadge.boundSession');
      const isolation = target.workspaceIsolation ?? 'isolated_worktree';
      return {
        category: modeLabel,
        detail: `${target.agentId || 'agent'} · ${isolation}`,
        memoryModel: 'ephemeral',
      };
    }
    case 'bot':
      return {
        category: tr('pulseFilter.targetBadge.persistentBot'),
        detail: `${target.memberId || 'bot'} · ${formatMailboxPolicyLabel(target.mailboxPolicy, tr)}`,
        memoryModel: 'persistent',
      };
    case 'group':
      return {
        category: tr('pulseFilter.targetBadge.groupSeat'),
        detail: `${target.spaceId || 'group'} · ${formatGroupDispatchLabel(target.dispatchMode, tr)}`,
      };
    case 'user': {
      const kindMap = {
        notify: tr('pulseFilter.targetBadge.userNotify'),
        approval: tr('pulseFilter.targetBadge.userApproval'),
        ask_form: tr('pulseFilter.targetBadge.userAskForm'),
        digest: tr('pulseFilter.targetBadge.userDigest'),
      } as const;
      const sla = target.slaTimeoutSeconds
        ? tr('pulseFilter.targetBadge.slaSuffix', {
            seconds: target.slaTimeoutSeconds,
          })
        : '';
      return {
        category: kindMap[target.interactionKind],
        detail: `${target.titleTemplate || tr('pulseFilter.targetBadge.untitled')}${sla}`,
      };
    }
    case 'workflow':
      return {
        category: tr('pulseFilter.targetBadge.workflow'),
        detail: `${target.workflowId}@v${target.pinnedVersion}`,
      };
  }
}
