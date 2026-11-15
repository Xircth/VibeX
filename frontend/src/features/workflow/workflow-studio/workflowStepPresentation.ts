import type { WorkflowEventRecord } from 'shared/types';

import i18n from '@/i18n';
import type {
  BotMailboxPolicy,
  EventSourceKind,
  GroupDispatchMode,
  PulseTemporalSpec,
  PulseWorkspaceIsolation,
} from '@/lib/api/pulse';

import type { WorkflowStudioAgentOption } from '../workflowAgent';
import {
  DEFAULT_GATE_FILTER,
  DEFAULT_OUTPUT_SCHEMA,
  type OutboxActionKind,
  type StudioAddableStepKind,
  type StudioNodeCategory,
  type StudioStepCommon,
  type StudioWorkflowStep,
} from './types';

export {
  isStudioOnlyDefinition,
  toBackendWorkflowDefinition,
  toStudioWorkflowDefinition,
} from './workflowStudioCodec';

export type WorkflowTranslateFn = (
  key: string,
  options?: Record<string, unknown>
) => string;

export function getWorkflowTranslator(
  t?: WorkflowTranslateFn
): WorkflowTranslateFn {
  if (t) return t;
  const fixed = i18n.getFixedT(
    i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN',
    'workflow'
  );
  return (key, options) => String(fixed(key, options));
}

export function resolveNodeCategory(
  step: StudioWorkflowStep
): StudioNodeCategory {
  switch (step.kind) {
    case 'trigger':
      return 'trigger';
    case 'session':
    case 'agent':
      return 'session';
    case 'bot':
      return 'bot';
    case 'group_stage':
      return 'group_stage';
    case 'user_gate':
    case 'approval':
    case 'notify':
      return 'user_gate';
    case 'control':
      return 'control';
    case 'outbox_action':
      return 'outbox_action';
  }
}

export function resolveSessionIsolation(
  step: Extract<StudioWorkflowStep, { kind: 'session' | 'agent' }>
): PulseWorkspaceIsolation {
  if (step.workspaceIsolation) {
    return step.workspaceIsolation;
  }
  if (step.kind === 'agent') {
    if (step.workspaceAccess === 'write_isolated') {
      return 'isolated_worktree';
    }
    if (step.workspaceAccess === 'read_only_shared') {
      return 'scratch';
    }
  }
  return 'project_root';
}

export function formatWorkflowEventSource(
  source: EventSourceKind,
  t?: WorkflowTranslateFn
): string {
  const tr = getWorkflowTranslator(t);
  return tr(`sources.${source}`, { defaultValue: source });
}

export function formatWorkflowTemporalBadge(
  temporal: PulseTemporalSpec,
  t?: WorkflowTranslateFn
): string {
  const tr = getWorkflowTranslator(t);
  switch (temporal.kind) {
    case 'cron':
      return temporal.weekdaysOnly
        ? tr('nodes.temporal.cronWeekdays', { expression: temporal.expression })
        : tr('nodes.temporal.cron', { expression: temporal.expression });
    case 'once':
      return tr('nodes.temporal.once', { fireAt: temporal.fireAt });
    case 'interval': {
      const secs = temporal.everySeconds;
      if (secs >= 3600 && secs % 3600 === 0) {
        return tr('nodes.temporal.intervalHours', { count: secs / 3600 });
      }
      if (secs >= 60 && secs % 60 === 0) {
        return tr('nodes.temporal.intervalMinutes', { count: secs / 60 });
      }
      return tr('nodes.temporal.intervalSeconds', { count: secs });
    }
    case 'inactivity_sla':
      return tr('nodes.temporal.slaMinutes', {
        count: Math.round(temporal.timeoutSeconds / 60),
        prefix: temporal.threadKeyPrefix,
      });
  }
}

export function formatWorkflowMailboxPolicy(
  policy: BotMailboxPolicy,
  t?: WorkflowTranslateFn,
  detailed = false
): string {
  const tr = getWorkflowTranslator(t);
  if (detailed) {
    return tr(`inspector.bot.mailboxOptions.${policy}_detail`);
  }
  return tr(`nodes.mailbox.${policy}`);
}

export function formatWorkflowGroupDispatch(
  mode: GroupDispatchMode,
  t?: WorkflowTranslateFn
): string {
  const tr = getWorkflowTranslator(t);
  switch (mode.type) {
    case 'specific_seat':
      return tr('nodes.groupDispatch.specific_seat', {
        memberId: mode.memberId,
      });
    case 'mention_seats':
      return tr('nodes.groupDispatch.mention_seats', {
        count: mode.memberIds.length,
      });
    case 'moderator_triage':
      return tr('nodes.groupDispatch.moderator_triage', {
        memberId: mode.moderatorMemberId,
      });
    case 'broadcast_log_only':
      return tr('nodes.groupDispatch.broadcast_log_only');
  }
}

export function formatOutboxActionLabel(
  kind: OutboxActionKind,
  t?: WorkflowTranslateFn
): string {
  const tr = getWorkflowTranslator(t);
  return tr(`nodes.outboxKinds.${kind}`);
}

export function formatWorkflowOrchestratorLabel(
  preset: string,
  t?: WorkflowTranslateFn
): string {
  const tr = getWorkflowTranslator(t);
  return tr(`studio.orchestrators.${preset}`, { defaultValue: preset });
}

export type StepPresentationMeta = {
  category: StudioNodeCategory;
  categoryBadge: string;
  detailBadge?: string;
  primarySubtitle: string;
  secondaryBadge?: string;
  tabularBadge?: string;
  accessibleSummary: string;
};

export function describeStepPresentation(
  step: StudioWorkflowStep,
  agentOptions: WorkflowStudioAgentOption[],
  fallbackNotifyLabel?: string,
  t?: WorkflowTranslateFn
): StepPresentationMeta {
  const tr = getWorkflowTranslator(t);
  const notifyFallback = fallbackNotifyLabel ?? tr('studio.notify');

  switch (step.kind) {
    case 'trigger': {
      const triggerSourceLabel =
        step.triggerKind === 'temporal' && step.temporal
          ? formatWorkflowTemporalBadge(step.temporal, tr)
          : `${formatWorkflowEventSource(step.sourceKind, tr)} · ${step.eventType || tr('nodes.eventFallback')}`;
      const triggerDetail = tr(`nodes.triggerKinds.${step.triggerKind}`);
      return {
        category: 'trigger',
        categoryBadge: tr('nodes.badges.trigger'),
        detailBadge: triggerDetail,
        primarySubtitle: triggerSourceLabel,
        accessibleSummary: step.title || triggerDetail,
      };
    }
    case 'session':
    case 'agent': {
      const agentLabel =
        agentOptions.find((agent) => agent.value === step.agentId)?.label ??
        step.agentId;
      const isolation = resolveSessionIsolation(step);
      return {
        category: 'session',
        categoryBadge: tr('nodes.badges.session'),
        detailBadge: tr('nodes.sessionResetDetail'),
        primarySubtitle: agentLabel,
        secondaryBadge: tr(`nodes.isolation.${isolation}`),
        accessibleSummary: step.agentId,
      };
    }
    case 'bot':
      return {
        category: 'bot',
        categoryBadge: tr('nodes.badges.bot'),
        detailBadge: tr('nodes.botMemoryDetail'),
        primarySubtitle: step.memberId || tr('nodes.unsetBot'),
        secondaryBadge: formatWorkflowMailboxPolicy(step.mailboxPolicy, tr),
        accessibleSummary: step.memberId || tr('nodes.badges.bot'),
      };
    case 'group_stage': {
      const parts = [
        step.rounds != null && step.rounds > 0
          ? tr('nodes.maxRounds', { count: step.rounds })
          : null,
        step.quorumCount != null && step.quorumCount > 0
          ? tr('nodes.quorumCount', { count: step.quorumCount })
          : null,
      ].filter((item): item is string => Boolean(item));
      return {
        category: 'group_stage',
        categoryBadge: tr('nodes.badges.group'),
        primarySubtitle: step.spaceId || tr('nodes.unsetGroup'),
        secondaryBadge: formatWorkflowGroupDispatch(step.dispatchMode, tr),
        tabularBadge: parts.length > 0 ? parts.join(' · ') : undefined,
        accessibleSummary: step.spaceId || tr('nodes.badges.group'),
      };
    }
    case 'user_gate': {
      const gateKindLabel = tr(`nodes.gateKinds.${step.interactionKind}`);
      return {
        category: 'user_gate',
        categoryBadge: tr('nodes.badges.gate'),
        detailBadge: gateKindLabel,
        primarySubtitle: step.title.trim() || gateKindLabel,
        secondaryBadge: step.severity
          ? tr(`inspector.userGate.severities.${step.severity}`)
          : undefined,
        tabularBadge: step.slaTimeoutSeconds
          ? tr('nodes.slaSeconds', { seconds: step.slaTimeoutSeconds })
          : undefined,
        accessibleSummary: step.title || gateKindLabel,
      };
    }
    case 'approval': {
      const approvalLabel = tr('nodes.gateKinds.approval');
      return {
        category: 'user_gate',
        categoryBadge: tr('nodes.badges.gate'),
        detailBadge: approvalLabel,
        primarySubtitle: step.title.trim() || approvalLabel,
        tabularBadge: step.slaTimeoutSeconds
          ? tr('nodes.slaSeconds', { seconds: step.slaTimeoutSeconds })
          : undefined,
        accessibleSummary: step.title || approvalLabel,
      };
    }
    case 'notify': {
      const notifyKindLabel = tr('nodes.gateKinds.notify');
      return {
        category: 'user_gate',
        categoryBadge: tr('nodes.badges.gate'),
        detailBadge: notifyKindLabel,
        primarySubtitle: step.title.trim() || notifyFallback,
        tabularBadge: step.slaTimeoutSeconds
          ? tr('nodes.slaSeconds', { seconds: step.slaTimeoutSeconds })
          : undefined,
        accessibleSummary: step.title || notifyFallback,
      };
    }
    case 'control': {
      if (step.controlKind === 'bounded_loop') {
        const maxIter = step.maxIterations ?? 3;
        return {
          category: 'control',
          categoryBadge: tr('nodes.badges.loop'),
          primarySubtitle: step.loopTargetStepId
            ? tr('nodes.loopTarget', { target: step.loopTargetStepId })
            : step.title || tr('studio.nodeTypes.bounded_loop'),
          tabularBadge: tr('nodes.maxRounds', { count: maxIter }),
          accessibleSummary: step.title || tr('studio.nodeTypes.bounded_loop'),
        };
      }
      if (step.controlKind === 'wait_for_event') {
        return {
          category: 'control',
          categoryBadge: tr('nodes.badges.wait'),
          primarySubtitle: step.waitEventType || 'event.correlated',
          secondaryBadge: step.threadKeyTemplate || '{{threadKey}}',
          tabularBadge: step.timeoutSeconds
            ? tr('nodes.slaSeconds', { seconds: step.timeoutSeconds })
            : undefined,
          accessibleSummary: step.title || tr('studio.nodeTypes.wait_for_event'),
        };
      }
      return {
        category: 'control',
        categoryBadge: tr('nodes.badges.branch'),
        primarySubtitle:
          step.expression || step.title || tr('nodes.branchCondition'),
        accessibleSummary:
          step.title || tr('studio.nodeTypes.condition_branch'),
      };
    }
    case 'outbox_action': {
      const outboxLabel = formatOutboxActionLabel(step.actionKind, tr);
      return {
        category: 'outbox_action',
        categoryBadge: tr('nodes.badges.outbox'),
        detailBadge: outboxLabel,
        primarySubtitle: step.destination || step.title || outboxLabel,
        accessibleSummary: step.title || outboxLabel,
      };
    }
  }
}

export function createDefaultStepForKind(
  kind: StudioAddableStepKind,
  common: StudioStepCommon,
  defaultAgentId: string,
  outputLanguage: string,
  defaultNotifyTitle?: string,
  t?: WorkflowTranslateFn
): StudioWorkflowStep {
  const tr = getWorkflowTranslator(t);
  const resolvedNotifyTitle = defaultNotifyTitle ?? tr('studio.newNotify');

  switch (kind) {
    case 'trigger':
      return {
        ...common,
        dependsOn: [],
        kind: 'trigger',
        title: tr('nodes.defaults.triggerTitle'),
        triggerKind: 'platform',
        sourceKind: 'github',
        eventType: 'github.pr.opened',
        evalMode: 'observe',
        temporal: null,
        filter: {
          ...DEFAULT_GATE_FILTER,
          sourceKinds: ['github'],
          eventTypes: ['github.pr.opened'],
        },
      };
    case 'session':
      return {
        ...common,
        kind: 'session',
        agentId: defaultAgentId,
        prompt: tr('nodes.defaults.sessionPrompt'),
        workspaceIsolation: 'isolated_worktree',
        executorProfileId: null,
        modeOverride: null,
        configOverrides: {},
        outputLanguage,
        outputDescription: null,
        outputSchema: DEFAULT_OUTPUT_SCHEMA,
        completionPolicy: 'automatic',
      };
    case 'agent':
      return {
        ...common,
        kind: 'agent',
        agentId: defaultAgentId,
        prompt: '',
        executorProfileId: null,
        modeOverride: null,
        configOverrides: {},
        outputLanguage,
        outputDescription: null,
        outputSchema: DEFAULT_OUTPUT_SCHEMA,
        workspaceAccess: 'native',
        sideEffectClass: 'mutating_unknown',
        allowOneRepair: false,
        allowSkipOnReview: false,
        completionPolicy: 'automatic',
      };
    case 'bot':
      return {
        ...common,
        kind: 'bot',
        memberId: 'triage-bot',
        conversationScope: 'fixed_primary',
        mailboxPolicy: 'fifo_serial',
        prompt: tr('nodes.defaults.botPrompt'),
        outputDescription: null,
        outputSchema: DEFAULT_OUTPUT_SCHEMA,
      };
    case 'group_stage':
      return {
        ...common,
        kind: 'group_stage',
        spaceId: 'eng-council',
        dispatchMode: {
          type: 'moderator_triage',
          moderatorMemberId: 'lead-bot',
        },
        prompt: tr('nodes.defaults.groupPrompt'),
      };
    case 'user_gate':
      return {
        ...common,
        kind: 'user_gate',
        interactionKind: 'approval',
        severity: 'warning',
        title: tr('nodes.defaults.userGateTitle'),
        bodyTemplate: tr('nodes.defaults.userGateBody'),
        approverScope: 'workspace_owner',
        slaTimeoutSeconds: 1800,
        decisionSchema: {
          type: 'object',
          required: ['approved'],
          properties: { approved: { type: 'boolean' } },
        },
      };
    case 'approval':
      return {
        ...common,
        kind: 'approval',
        title: tr('nodes.defaults.approvalTitle'),
        approverScope: 'workspace_owner',
        skippable: false,
        decisionSchema: {
          type: 'object',
          required: ['approved'],
          properties: { approved: { type: 'boolean' } },
        },
      };
    case 'notify':
      return {
        ...common,
        kind: 'notify',
        title: resolvedNotifyTitle,
      };
    case 'condition_branch':
      return {
        ...common,
        kind: 'control',
        controlKind: 'condition',
        title: tr('nodes.defaults.conditionTitle'),
        expression: 'output.approved == true',
      };
    case 'control':
    case 'bounded_loop':
      return {
        ...common,
        kind: 'control',
        controlKind: 'bounded_loop',
        title: tr('nodes.defaults.boundedLoopTitle'),
        maxIterations: 3,
        loopTargetStepId: common.dependsOn[0] ?? '',
      };
    case 'wait_for_event':
      return {
        ...common,
        kind: 'control',
        controlKind: 'wait_for_event',
        title: tr('nodes.defaults.waitForEventTitle'),
        waitEventType: 'github.ci.completed',
        threadKeyTemplate: '{{threadKey}}',
        timeoutSeconds: 3600,
      };
    case 'outbox_action':
      return {
        ...common,
        kind: 'outbox_action',
        actionKind: 'github_comment',
        title: tr('nodes.defaults.outboxTitle'),
        destination: '{{threadKey}}',
        payloadTemplate: tr('nodes.defaults.outboxPayload'),
      };
  }
}

export function switchExecutionPrimitive(
  step: StudioWorkflowStep,
  targetPrimitive: 'session' | 'bot',
  defaultAgentId: string,
  outputLanguage = 'en',
  t?: WorkflowTranslateFn
): StudioWorkflowStep {
  const tr = getWorkflowTranslator(t);
  const base: StudioStepCommon = {
    id: step.id,
    dependsOn: step.dependsOn,
    phase: step.phase,
    inputBindings: step.inputBindings,
    filter: step.filter,
    subscribeThread: step.subscribeThread,
    threadKeyTemplate: step.threadKeyTemplate,
  };
  const currentPrompt =
    'prompt' in step && typeof step.prompt === 'string'
      ? step.prompt
      : tr('nodes.defaults.fallbackPrompt');

  if (targetPrimitive === 'bot') {
    if (step.kind === 'bot') return step;
    return {
      ...base,
      kind: 'bot',
      memberId: 'triage-bot',
      conversationScope: 'fixed_primary',
      mailboxPolicy: 'fifo_serial',
      prompt: currentPrompt || tr('nodes.defaults.fallbackBotPrompt'),
      outputDescription:
        'outputDescription' in step ? step.outputDescription : null,
      outputSchema:
        'outputSchema' in step ? step.outputSchema : DEFAULT_OUTPUT_SCHEMA,
    };
  }

  if (step.kind === 'session' || step.kind === 'agent') return step;
  return {
    ...base,
    kind: 'session',
    agentId: defaultAgentId,
    prompt: currentPrompt || tr('nodes.defaults.fallbackSessionPrompt'),
    workspaceIsolation: 'isolated_worktree',
    executorProfileId: null,
    modeOverride: null,
    configOverrides: {},
    outputLanguage,
    outputDescription:
      step.kind === 'bot' ? (step.outputDescription ?? null) : null,
    outputSchema:
      step.kind === 'bot'
        ? (step.outputSchema ?? DEFAULT_OUTPUT_SCHEMA)
        : DEFAULT_OUTPUT_SCHEMA,
    completionPolicy: 'automatic',
  };
}

export function flameSpans(events: WorkflowEventRecord[]) {
  const sorted = [...events].sort(
    (left, right) => Number(left.sequence) - Number(right.sequence)
  );
  return sorted.map((event, index) => {
    const start = Date.parse(event.createdAt);
    const next = sorted[index + 1];
    const end = next ? Date.parse(next.createdAt) : start + 1;
    const duration = end - start;
    return {
      event,
      durationMs: Number.isFinite(duration) && duration > 0 ? duration : 1,
    };
  });
}

export function previewMarkdown(output: string) {
  const trimmed = output.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return `\`\`\`json\n${trimmed}\n\`\`\``;
  }
  return trimmed;
}

export function statusClass(status?: string) {
  if (status === 'running' || status === 'claimed')
    return 'workflow-node-running';
  if (status === 'completed') return 'workflow-node-completed';
  if (status === 'failed' || status === 'cancelled')
    return 'workflow-node-failed';
  if (
    status === 'waiting_approval' ||
    status === 'needs_review' ||
    status === 'interrupted'
  ) {
    return 'workflow-node-waiting';
  }
  return '';
}

export function statusDotClass(status?: string) {
  if (status === 'running' || status === 'claimed')
    return 'workflow-status-dot-running';
  if (status === 'completed') return 'workflow-status-dot-completed';
  if (status === 'failed' || status === 'cancelled')
    return 'workflow-status-dot-failed';
  if (
    status === 'waiting_approval' ||
    status === 'needs_review' ||
    status === 'interrupted' ||
    status === 'awaiting_acceptance' ||
    status === 'awaiting_input'
  ) {
    return 'workflow-status-dot-waiting';
  }
  return 'workflow-status-dot-standby';
}
