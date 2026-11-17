import type { WorkflowEventRecord } from 'shared/types';

import type { MemberBotAvatarConfig } from '@/features/collaboration/MemberBotAvatar';
import i18n from '@/i18n';
import type {
  BotMailboxPolicy,
  EventSourceKind,
  GroupDispatchMode,
  PulseTemporalSpec,
  PulseWorkspaceIsolation,
} from '@/lib/api/pulse';

import {
  resolveStaticBotIdentity,
  type CollaborationBotOption,
  type CollaborationSpaceOption,
} from '../useCollaborationBotRoster';
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
  kind: OutboxActionKind | (string & NonNullable<unknown>) | undefined,
  t?: WorkflowTranslateFn
): string {
  const tr = getWorkflowTranslator(t);
  const safeKind =
    kind && String(kind).trim() ? String(kind).trim() : 'feishu_reply';
  return tr(`nodes.outboxKinds.${safeKind}`, {
    defaultValue: tr('nodes.defaults.outboxTitle'),
  });
}

export function formatWorkflowOrchestratorLabel(
  preset: string,
  t?: WorkflowTranslateFn
): string {
  const tr = getWorkflowTranslator(t);
  return tr(`studio.orchestrators.${preset}`, { defaultValue: preset });
}

export type StepTextSegment = string | { tag: string };

export function tokenizeStepSegments(text: string): StepTextSegment[] {
  if (!text) return [];
  const parts = text.split(/(\{\{[^{}]+\}\})/g);
  const segments: StepTextSegment[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('{{') && part.endsWith('}}')) {
      const inner = part.slice(2, -2).trim();
      segments.push({ tag: inner || part });
    } else {
      segments.push(part);
    }
  }
  return segments;
}

function distinctFromId(
  candidate: string | undefined | null,
  stepId: string
): string | undefined {
  const trimmed = candidate?.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() === stepId.trim().toLowerCase()) {
    return undefined;
  }
  return trimmed;
}

export function cleanHumanStepSummary(
  candidate: string | undefined | null,
  stepId: string
): string | undefined {
  if (!candidate) return undefined;
  const firstLine = candidate
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^#+\s*/, '')
        .replace(/["“”]?\{\{[^{}]+\}\}["“”]?/g, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\s·—\-:：,，]+|[\s·—\-:：,，]+$/g, '')
        .trim()
    )
    .find((line) => line.length >= 2);
  return distinctFromId(firstLine, stepId);
}

export type StepPresentationRoster = {
  bots?: readonly CollaborationBotOption[];
  spaces?: readonly CollaborationSpaceOption[];
  language?: string;
};

export type StepPresentationMeta = {
  category: StudioNodeCategory;
  categoryBadge: string;
  identityBadge: string;
  botAvatar?: MemberBotAvatarConfig;
  detailBadge?: string;
  headline: string;
  headlineHint?: string;
  primarySubtitle: string;
  subline?: string;
  secondaryBadge?: string;
  tabularBadge?: string;
  humanRoleSummary: string;
  accessibleSummary: string;
};

export function describeStepPresentation(
  step: StudioWorkflowStep,
  agentOptions: WorkflowStudioAgentOption[],
  fallbackNotifyLabel?: string,
  t?: WorkflowTranslateFn,
  roster?: StepPresentationRoster
): StepPresentationMeta {
  const tr = getWorkflowTranslator(t);
  const notifyFallback = fallbackNotifyLabel ?? tr('studio.notify');
  const lang =
    roster?.language ?? i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN';

  switch (step.kind) {
    case 'trigger': {
      const isTemporal =
        step.triggerKind === 'temporal' && Boolean(step.temporal);
      const sourceBadge = isTemporal
        ? tr('nodes.triggerKinds.temporal')
        : formatWorkflowEventSource(step.sourceKind, tr);
      const scheduleOrEvent =
        isTemporal && step.temporal
          ? formatWorkflowTemporalBadge(step.temporal, tr)
          : step.eventType || tr('nodes.eventFallback');
      const customTitle = cleanHumanStepSummary(step.title, step.id);
      const headline = customTitle ?? scheduleOrEvent;
      return {
        category: 'trigger',
        categoryBadge: sourceBadge,
        identityBadge: sourceBadge,
        detailBadge: isTemporal ? scheduleOrEvent : undefined,
        headline,
        primarySubtitle: scheduleOrEvent,
        humanRoleSummary: isTemporal
          ? tr('inspector.summaries.triggerTemporal', {
              schedule: scheduleOrEvent,
            })
          : tr('inspector.summaries.triggerEvent', {
              source: sourceBadge,
              event: scheduleOrEvent,
            }),
        accessibleSummary: headline,
      };
    }
    case 'session':
    case 'agent': {
      const agentLabel =
        agentOptions.find((agent) => agent.value === step.agentId)?.label ??
        step.agentId;
      const actionSummary =
        cleanHumanStepSummary(step.outputDescription, step.id) ??
        cleanHumanStepSummary(step.prompt, step.id) ??
        tr('inspector.summaries.defaultAgentAction');
      return {
        category: 'session',
        categoryBadge: agentLabel,
        identityBadge: agentLabel,
        headline: actionSummary,
        primarySubtitle: agentLabel,
        humanRoleSummary: tr('inspector.summaries.session', {
          agent: agentLabel,
        }),
        accessibleSummary: `${agentLabel} ${actionSummary}`,
      };
    }
    case 'bot': {
      const botIdentity = resolveStaticBotIdentity(
        step.memberId || 'triage-bot',
        roster?.bots,
        lang
      );
      const actionSummary =
        cleanHumanStepSummary(step.outputDescription, step.id) ??
        cleanHumanStepSummary(step.prompt, step.id) ??
        tr('inspector.summaries.defaultBotAction');
      return {
        category: 'bot',
        categoryBadge: botIdentity.displayName,
        identityBadge: botIdentity.displayName,
        botAvatar: botIdentity.avatar,
        headline: actionSummary,
        primarySubtitle: botIdentity.displayName,
        humanRoleSummary: tr('inspector.summaries.bot', {
          bot: botIdentity.displayName,
        }),
        accessibleSummary: `${botIdentity.displayName} ${actionSummary}`,
      };
    }
    case 'group_stage': {
      const spaceLabel =
        roster?.spaces?.find((item) => item.spaceId === step.spaceId)
          ?.displayName ||
        step.spaceId ||
        tr('nodes.unsetGroup');
      const actionSummary =
        cleanHumanStepSummary(step.prompt, step.id) ?? spaceLabel;
      const parts = [
        step.rounds != null && step.rounds > 0
          ? tr('nodes.maxRounds', { count: step.rounds })
          : null,
      ].filter((item): item is string => Boolean(item));
      return {
        category: 'group_stage',
        categoryBadge: spaceLabel,
        identityBadge: spaceLabel,
        headline: actionSummary,
        primarySubtitle: spaceLabel,
        tabularBadge: parts.length > 0 ? parts.join(' · ') : undefined,
        humanRoleSummary: tr('inspector.summaries.group', {
          space: spaceLabel,
        }),
        accessibleSummary: `${spaceLabel} ${actionSummary}`,
      };
    }
    case 'user_gate': {
      const gateKindLabel = tr(`nodes.gateKinds.${step.interactionKind}`);
      const headline =
        cleanHumanStepSummary(step.title, step.id) ?? gateKindLabel;
      return {
        category: 'user_gate',
        categoryBadge: gateKindLabel,
        identityBadge: gateKindLabel,
        headline,
        primarySubtitle: headline,
        humanRoleSummary:
          step.interactionKind === 'notify'
            ? tr('inspector.summaries.notify')
            : tr('inspector.summaries.approval'),
        accessibleSummary: headline,
      };
    }
    case 'approval': {
      const approvalLabel = tr('nodes.gateKinds.approval');
      const headline =
        cleanHumanStepSummary(step.title, step.id) ?? approvalLabel;
      return {
        category: 'user_gate',
        categoryBadge: approvalLabel,
        identityBadge: approvalLabel,
        headline,
        primarySubtitle: headline,
        humanRoleSummary: tr('inspector.summaries.approval'),
        accessibleSummary: headline,
      };
    }
    case 'notify': {
      const notifyKindLabel = tr('nodes.gateKinds.notify');
      const headline =
        cleanHumanStepSummary(step.title, step.id) ?? notifyFallback;
      return {
        category: 'user_gate',
        categoryBadge: notifyKindLabel,
        identityBadge: notifyKindLabel,
        headline,
        primarySubtitle: headline,
        humanRoleSummary: tr('inspector.summaries.notify'),
        accessibleSummary: headline,
      };
    }
    case 'control': {
      if (step.controlKind === 'bounded_loop') {
        const maxIter = step.maxIterations ?? 3;
        const badge = tr('nodes.badges.loop');
        const headline =
          cleanHumanStepSummary(step.title, step.id) ??
          tr('studio.nodeTypes.bounded_loop');
        return {
          category: 'control',
          categoryBadge: badge,
          identityBadge: badge,
          headline,
          primarySubtitle: headline,
          tabularBadge: tr('nodes.maxRounds', { count: maxIter }),
          humanRoleSummary: tr('inspector.summaries.boundedLoop', {
            count: maxIter,
          }),
          accessibleSummary: headline,
        };
      }
      if (step.controlKind === 'wait_for_event') {
        const badge = tr('nodes.badges.wait');
        const waitEvent = step.waitEventType || 'event.correlated';
        const headline =
          cleanHumanStepSummary(step.title, step.id) ?? waitEvent;
        return {
          category: 'control',
          categoryBadge: badge,
          identityBadge: badge,
          headline,
          primarySubtitle: waitEvent,
          humanRoleSummary: tr('inspector.summaries.waitForEvent', {
            event: waitEvent,
          }),
          accessibleSummary: headline,
        };
      }
      const badge = tr('nodes.badges.branch');
      const headline =
        cleanHumanStepSummary(step.title, step.id) ??
        tr('nodes.branchCondition');
      return {
        category: 'control',
        categoryBadge: badge,
        identityBadge: badge,
        headline,
        primarySubtitle: step.expression || headline,
        humanRoleSummary: tr('inspector.summaries.condition'),
        accessibleSummary: headline,
      };
    }
    case 'outbox_action': {
      const outboxLabel = formatOutboxActionLabel(step.actionKind, tr);
      const headline =
        cleanHumanStepSummary(step.title, step.id) ?? outboxLabel;
      return {
        category: 'outbox_action',
        categoryBadge: outboxLabel,
        identityBadge: outboxLabel,
        headline,
        primarySubtitle: outboxLabel,
        humanRoleSummary: tr('inspector.summaries.outbox', {
          target: outboxLabel,
        }),
        accessibleSummary: headline,
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
        evalMode: 'auto',
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
    ...(step.branchPorts ? { branchPorts: step.branchPorts } : {}),
    ...(step.joinMode ? { joinMode: step.joinMode } : {}),
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
