import type {
  GateFilterAst as SharedGateFilterAst,
  JsonValue,
  WorkflowDefinition,
  WorkflowEventRecord,
  WorkflowStep,
} from 'shared/types';

import {
  formatEventSourceLabel,
  formatGroupDispatchLabel,
  formatMailboxPolicyLabel,
  formatTemporalBadgeLabel,
} from '@/features/pulse';
import type {
  EventSourceKind,
  GateFilterAst as PulseGateFilterAst,
  PresetOrchestratorKind,
  PulseEvalMode,
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
  type StudioWorkflowDefinition,
  type StudioWorkflowStep,
  type TriggerKind,
  type WorkflowStudioDefinitionInput,
} from './types';

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

export function formatOutboxActionLabel(kind: OutboxActionKind): string {
  switch (kind) {
    case 'feishu_reply':
      return 'Feishu Reply';
    case 'jira_comment':
      return 'Jira Comment';
    case 'github_comment':
      return 'GitHub Comment';
    case 'webhook_post':
      return 'Webhook POST';
    case 'emit_event':
      return 'Emit Event';
  }
}

export type StepPresentationMeta = {
  category: StudioNodeCategory;
  categoryBadge: string;
  primarySubtitle: string;
  secondaryBadge?: string;
  tabularBadge?: string;
  accessibleSummary: string;
};

export function describeStepPresentation(
  step: StudioWorkflowStep,
  agentOptions: WorkflowStudioAgentOption[],
  fallbackNotifyLabel = 'Notification'
): StepPresentationMeta {
  switch (step.kind) {
    case 'trigger': {
      const triggerSourceLabel =
        step.triggerKind === 'temporal' && step.temporal
          ? formatTemporalBadgeLabel(step.temporal)
          : `${formatEventSourceLabel(step.sourceKind)} · ${step.eventType || 'event'}`;
      const kindMap = {
        platform: 'Platform Trigger',
        webhook: 'Webhook Trigger',
        temporal: 'Temporal Trigger',
        sdk: 'Custom SDK Trigger',
      } as const;
      return {
        category: 'trigger',
        categoryBadge: kindMap[step.triggerKind],
        primarySubtitle: triggerSourceLabel,
        accessibleSummary: step.title || kindMap[step.triggerKind],
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
        categoryBadge: 'Fresh Session · Context Resets Per Run',
        primarySubtitle: agentLabel,
        secondaryBadge: isolation,
        accessibleSummary: step.agentId,
      };
    }
    case 'bot':
      return {
        category: 'bot',
        categoryBadge: 'Persistent Bot · Fixed Session Memory',
        primarySubtitle: step.memberId || 'unset-bot',
        secondaryBadge: formatMailboxPolicyLabel(step.mailboxPolicy),
        accessibleSummary: step.memberId || 'Persistent Bot',
      };
    case 'group_stage':
      return {
        category: 'group_stage',
        categoryBadge: 'Group Stage',
        primarySubtitle: step.spaceId || 'unset-group',
        secondaryBadge: formatGroupDispatchLabel(step.dispatchMode),
        accessibleSummary: `${step.spaceId || 'Group Stage'}`,
      };
    case 'user_gate': {
      const gateMap = {
        notify: 'Notify',
        approval: 'Approval',
        ask_form: 'Ask Form',
      } as const;
      return {
        category: 'user_gate',
        categoryBadge: `User Gate · ${gateMap[step.interactionKind]}`,
        primarySubtitle: step.title.trim() || gateMap[step.interactionKind],
        tabularBadge: step.slaTimeoutSeconds
          ? `SLA ${step.slaTimeoutSeconds}s`
          : undefined,
        accessibleSummary: step.title || gateMap[step.interactionKind],
      };
    }
    case 'approval':
      return {
        category: 'user_gate',
        categoryBadge: 'User Gate · Approval',
        primarySubtitle: step.title.trim() || 'Approval',
        tabularBadge: step.slaTimeoutSeconds
          ? `SLA ${step.slaTimeoutSeconds}s`
          : undefined,
        accessibleSummary: step.title,
      };
    case 'notify':
      return {
        category: 'user_gate',
        categoryBadge: 'User Gate · Notify',
        primarySubtitle: step.title.trim() || fallbackNotifyLabel,
        tabularBadge: step.slaTimeoutSeconds
          ? `SLA ${step.slaTimeoutSeconds}s`
          : undefined,
        accessibleSummary: step.title,
      };
    case 'control': {
      if (step.controlKind === 'bounded_loop') {
        const maxIter = step.maxIterations ?? 3;
        return {
          category: 'control',
          categoryBadge: 'Flow Control · BoundedLoop',
          primarySubtitle: step.loopTargetStepId
            ? `Loop -> ${step.loopTargetStepId}`
            : step.title || 'Bounded Loop',
          tabularBadge: `Max ${maxIter}x`,
          accessibleSummary: step.title || 'BoundedLoop',
        };
      }
      if (step.controlKind === 'wait_for_event') {
        return {
          category: 'control',
          categoryBadge: 'Flow Control · WaitForEvent',
          primarySubtitle: step.waitEventType || 'event.correlated',
          secondaryBadge: step.threadKeyTemplate || '{{threadKey}}',
          accessibleSummary: step.title || 'WaitForEvent',
        };
      }
      return {
        category: 'control',
        categoryBadge: 'Flow Control · Condition/Switch',
        primarySubtitle: step.expression || step.title || 'Branch condition',
        accessibleSummary: step.title || 'Condition',
      };
    }
    case 'outbox_action':
      return {
        category: 'outbox_action',
        categoryBadge: `Outbox · ${formatOutboxActionLabel(step.actionKind)}`,
        primarySubtitle:
          step.destination || step.title || formatOutboxActionLabel(step.actionKind),
        accessibleSummary: step.title || formatOutboxActionLabel(step.actionKind),
      };
  }
}

export function createDefaultStepForKind(
  kind: StudioAddableStepKind,
  common: StudioStepCommon,
  defaultAgentId: string,
  outputLanguage: string,
  defaultNotifyTitle = 'New notification'
): StudioWorkflowStep {
  switch (kind) {
    case 'trigger':
      return {
        ...common,
        dependsOn: [],
        kind: 'trigger',
        title: 'Event Trigger',
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
        prompt: 'Analyze {{event.type}} on {{threadKey}} in a clean worktree.',
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
        prompt: 'Triage {{event.type}} using persistent project memory.',
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
        prompt: 'Review {{threadKey}} and converge on an execution plan.',
      };
    case 'user_gate':
      return {
        ...common,
        kind: 'user_gate',
        interactionKind: 'approval',
        title: 'Release Gate Approval',
        bodyTemplate: 'Approve changes proposed for {{threadKey}}?',
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
        title: 'Approval required',
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
        title: defaultNotifyTitle,
      };
    case 'control':
      return {
        ...common,
        kind: 'control',
        controlKind: 'bounded_loop',
        title: 'Review Bounded Loop',
        maxIterations: 3,
        loopTargetStepId: common.dependsOn[0] ?? '',
      };
    case 'outbox_action':
      return {
        ...common,
        kind: 'outbox_action',
        actionKind: 'github_comment',
        title: 'Reply to Source Thread',
        destination: '{{threadKey}}',
        payloadTemplate: 'Automated workflow completed for {{threadKey}}.',
      };
  }
}

export function switchExecutionPrimitive(
  step: StudioWorkflowStep,
  targetPrimitive: 'session' | 'bot',
  defaultAgentId: string,
  outputLanguage = 'en'
): StudioWorkflowStep {
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
      : 'Handle {{event.type}}';

  if (targetPrimitive === 'bot') {
    if (step.kind === 'bot') return step;
    return {
      ...base,
      kind: 'bot',
      memberId: 'triage-bot',
      conversationScope: 'fixed_primary',
      mailboxPolicy: 'fifo_serial',
      prompt: currentPrompt || 'Handle {{event.type}} with persistent memory.',
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
    prompt: currentPrompt || 'Execute task in a fresh isolated session.',
    workspaceIsolation: 'isolated_worktree',
    executorProfileId: null,
    modeOverride: null,
    configOverrides: {},
    outputLanguage,
    outputDescription: step.kind === 'bot' ? (step.outputDescription ?? null) : null,
    outputSchema:
      step.kind === 'bot'
        ? (step.outputSchema ?? DEFAULT_OUTPUT_SCHEMA)
        : DEFAULT_OUTPUT_SCHEMA,
    completionPolicy: 'automatic',
  };
}

const STUDIO_PHASE_PREFIX = '[vibex-studio:v1]';
const PULSE_TRIGGER_PREFIX = '[pulse-trigger]';

type StudioPhaseMetadata = {
  userPhase?: string | null;
  hasOrchestratorPreset?: boolean;
  orchestratorPreset?: PresetOrchestratorKind | null;
  hasFilter?: boolean;
  filter?: PulseGateFilterAst | null;
  hasSubscribeThread?: boolean;
  subscribeThread?: boolean;
  hasThreadKeyTemplate?: boolean;
  threadKeyTemplate?: string | null;
  trigger?: {
    title: string;
    triggerKind: TriggerKind;
    sourceKind: EventSourceKind;
    eventType: string;
    evalMode: PulseEvalMode;
    hasTemporal?: boolean;
    temporal?: PulseTemporalSpec | null;
    filter: PulseGateFilterAst;
  };
  session?: {
    workspaceIsolation: PulseWorkspaceIsolation;
    executorProfileId: JsonValue | null;
    modeOverride: string | null;
    configOverrides: { [key in string]?: string };
    outputLanguage: string | null;
    outputDescription: string | null;
    hasAllowSkipOnReview?: boolean;
    allowSkipOnReview?: boolean;
  };
  bot?: {
    hasOutputDescription?: boolean;
    outputDescription?: string | null;
    hasOutputSchema?: boolean;
  };
  userGate?: {
    hasApproverScope?: boolean;
    approverScope?: string;
    hasSlaTimeoutSeconds?: boolean;
    slaTimeoutSeconds?: number | null;
    hasDecisionSchema?: boolean;
    decisionSchema?: JsonValue | null;
    hasFormSchema?: boolean;
    formSchema?: JsonValue | null;
  };
  control?: {
    title: string;
    hasExpression?: boolean;
    expression?: string;
    hasMaxIterations?: boolean;
    maxIterations?: number;
    hasLoopTargetStepId?: boolean;
    loopTargetStepId?: string;
    hasWaitEventType?: boolean;
    waitEventType?: string;
    hasThreadKeyTemplate?: boolean;
    threadKeyTemplate?: string | null;
    hasTimeoutSeconds?: boolean;
    timeoutSeconds?: number | null;
  };
  outbox?: {
    actionKind: OutboxActionKind;
    title: string;
    payloadTemplate: string;
  };
  legacy?: {
    workspaceIsolation?: PulseWorkspaceIsolation;
    slaTimeoutSeconds?: number | null;
  };
};

function encodeStudioPhase(
  userPhase: string | null,
  meta: StudioPhaseMetadata
): string | null {
  const hasPayload = Object.entries(meta).some(
    ([key, value]) => key !== 'userPhase' && value !== undefined
  );
  if (!hasPayload) {
    return userPhase;
  }
  return `${STUDIO_PHASE_PREFIX}${JSON.stringify({
    ...meta,
    userPhase: userPhase ?? null,
  })}`;
}

function decodeStudioPhase(phase: string | null): {
  userPhase: string | null;
  meta: StudioPhaseMetadata | null;
} {
  if (!phase || !phase.startsWith(STUDIO_PHASE_PREFIX)) {
    return { userPhase: phase, meta: null };
  }
  try {
    const parsed = JSON.parse(
      phase.slice(STUDIO_PHASE_PREFIX.length)
    ) as StudioPhaseMetadata;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        userPhase: parsed.userPhase ?? null,
        meta: parsed,
      };
    }
  } catch {
    // Fall back to literal phase if not valid JSON metadata.
  }
  return { userPhase: phase, meta: null };
}

function applyCommonStudioMetadata<T extends StudioStepCommon>(
  common: T,
  meta: StudioPhaseMetadata | null
): T {
  if (!meta) return common;
  const next = { ...common };
  if (meta.hasFilter) {
    next.filter = meta.filter;
  }
  if (meta.hasSubscribeThread) {
    next.subscribeThread = meta.subscribeThread;
  }
  if (meta.hasThreadKeyTemplate) {
    next.threadKeyTemplate = meta.threadKeyTemplate;
  }
  return next;
}

function captureCommonStudioMetadata(
  step: StudioStepCommon,
  options?: { omitFilter?: boolean; omitSubscribeThread?: boolean }
): Partial<StudioPhaseMetadata> {
  const meta: Partial<StudioPhaseMetadata> = {};
  if (!options?.omitFilter && 'filter' in step && step.filter !== undefined) {
    meta.hasFilter = true;
    meta.filter = step.filter;
  }
  if (
    !options?.omitSubscribeThread &&
    'subscribeThread' in step &&
    step.subscribeThread !== undefined
  ) {
    meta.hasSubscribeThread = true;
    meta.subscribeThread = step.subscribeThread;
  }
  if ('threadKeyTemplate' in step && step.threadKeyTemplate !== undefined) {
    meta.hasThreadKeyTemplate = true;
    meta.threadKeyTemplate = step.threadKeyTemplate;
  }
  return meta;
}

function normalizeBackendThreadKeyPointer(
  template: string | null | undefined
): string | null {
  if (!template) return null;
  const trimmed = template.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/') && trimmed !== '/') {
    return trimmed;
  }
  const match = /^\{\{\s*([a-zA-Z0-9_./-]+)\s*\}\}$/.exec(trimmed);
  if (match?.[1]) {
    const pointer = `/${match[1].replace(/\./g, '/').replace(/^\/+/, '')}`;
    return pointer !== '/' ? pointer : '/threadKey';
  }
  return null;
}

function inferOutboxChannelActionKind(
  step: Extract<WorkflowStep, { kind: 'outbox_action' }>
): OutboxActionKind {
  if (step.actionKind === 'webhook_post' || step.actionKind === 'emit_event') {
    return step.actionKind;
  }
  if (
    step.payloadTemplate &&
    typeof step.payloadTemplate === 'object' &&
    !Array.isArray(step.payloadTemplate) &&
    typeof step.payloadTemplate.channelHint === 'string'
  ) {
    const hint = step.payloadTemplate.channelHint;
    if (
      hint === 'feishu_reply' ||
      hint === 'jira_comment' ||
      hint === 'github_comment' ||
      hint === 'webhook_post' ||
      hint === 'emit_event'
    ) {
      return hint;
    }
  }
  const target = step.targetTemplate.toLowerCase();
  if (target.startsWith('feishu:')) return 'feishu_reply';
  if (target.startsWith('jira:')) return 'jira_comment';
  return 'github_comment';
}

function isStudioOnlyStep(
  step: StudioWorkflowStep | WorkflowStep
): step is StudioWorkflowStep {
  if (step.kind === 'trigger' || step.kind === 'control') {
    return true;
  }
  if (step.kind === 'session' && 'prompt' in step) {
    return true;
  }
  if (step.kind === 'bot' && 'prompt' in step) {
    return true;
  }
  if (step.kind === 'group_stage' && 'prompt' in step) {
    return true;
  }
  if (step.kind === 'user_gate' && 'title' in step) {
    return true;
  }
  if (step.kind === 'outbox_action' && 'destination' in step) {
    return true;
  }
  return false;
}

export function isStudioOnlyDefinition(
  input: WorkflowStudioDefinitionInput
): input is StudioWorkflowDefinition {
  if ('orchestratorPreset' in input && input.orchestratorPreset !== undefined) {
    return true;
  }
  return input.steps.some(isStudioOnlyStep);
}

export function toStudioWorkflowDefinition(
  input: WorkflowStudioDefinitionInput
): StudioWorkflowDefinition {
  let decodedOrchestratorPreset:
    | { present: true; value: PresetOrchestratorKind | null | undefined }
    | { present: false } =
    'orchestratorPreset' in input
      ? { present: true, value: input.orchestratorPreset }
      : { present: false };

  const steps: StudioWorkflowStep[] = input.steps.map((step, index) => {
    if (isStudioOnlyStep(step)) {
      return step;
    }
    const { userPhase, meta } = decodeStudioPhase(step.phase);
    if (index === 0 && !decodedOrchestratorPreset.present && meta?.hasOrchestratorPreset) {
      decodedOrchestratorPreset = {
        present: true,
        value: meta.orchestratorPreset ?? null,
      };
    }

    const baseCommon: StudioStepCommon = applyCommonStudioMetadata(
      {
        id: step.id,
        dependsOn: step.dependsOn,
        phase: userPhase,
        inputBindings: step.inputBindings,
      },
      meta
    );

    switch (step.kind) {
      case 'agent':
        return {
          ...step,
          ...baseCommon,
          ...(meta?.legacy?.workspaceIsolation !== undefined
            ? { workspaceIsolation: meta.legacy.workspaceIsolation }
            : {}),
        };
      case 'approval':
        return {
          ...step,
          ...baseCommon,
          ...(meta?.legacy?.slaTimeoutSeconds !== undefined
            ? { slaTimeoutSeconds: meta.legacy.slaTimeoutSeconds }
            : {}),
        };
      case 'notify': {
        if (meta?.trigger) {
          const { hasTemporal, temporal, ...triggerRest } = meta.trigger;
          return {
            ...baseCommon,
            kind: 'trigger',
            ...triggerRest,
            ...(hasTemporal ? { temporal: temporal ?? null } : {}),
          };
        }
        if (step.title.startsWith(PULSE_TRIGGER_PREFIX)) {
          const parsedTitle =
            step.title.slice(PULSE_TRIGGER_PREFIX.length).trim() ||
            'Event Trigger';
          return {
            ...baseCommon,
            kind: 'trigger',
            title: parsedTitle,
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
        }
        return {
          ...step,
          ...baseCommon,
          ...(meta?.legacy?.slaTimeoutSeconds !== undefined
            ? { slaTimeoutSeconds: meta.legacy.slaTimeoutSeconds }
            : {}),
        };
      }
      case 'session': {
        const inferredIsolation: PulseWorkspaceIsolation =
          step.workspaceAccess === 'write_isolated'
            ? 'isolated_worktree'
            : step.workspaceAccess === 'read_only_shared'
              ? 'scratch'
              : 'project_root';
        const sessionStep: StudioWorkflowStep = {
          ...baseCommon,
          ...(meta?.hasSubscribeThread
            ? (meta.subscribeThread !== undefined
                ? { subscribeThread: meta.subscribeThread }
                : {})
            : step.subscribeThread
              ? { subscribeThread: true }
              : {}),
          kind: 'session',
          agentId: step.agentId,
          prompt: step.promptTemplate,
          workspaceIsolation:
            meta?.session?.workspaceIsolation ?? inferredIsolation,
          executorProfileId: meta?.session?.executorProfileId ?? null,
          modeOverride:
            meta?.session !== undefined
              ? meta.session.modeOverride
              : step.modelOverride,
          configOverrides: meta?.session?.configOverrides ?? {},
          outputLanguage:
            meta?.session !== undefined ? meta.session.outputLanguage : 'en',
          outputDescription: meta?.session?.outputDescription ?? null,
          outputSchema: step.outputSchema,
          completionPolicy: step.completion,
          ...(meta?.session?.hasAllowSkipOnReview
            ? { allowSkipOnReview: meta.session.allowSkipOnReview }
            : {}),
        };
        return sessionStep;
      }
      case 'bot': {
        const botStep: StudioWorkflowStep = {
          ...baseCommon,
          kind: 'bot',
          memberId: step.memberId,
          conversationScope: step.conversationScope,
          mailboxPolicy: step.mailboxPolicy,
          prompt: step.promptTemplate,
          ...(meta?.bot
            ? {
                ...(meta.bot.hasOutputDescription
                  ? { outputDescription: meta.bot.outputDescription }
                  : {}),
                ...(meta.bot.hasOutputSchema
                  ? { outputSchema: step.outputSchema }
                  : {}),
              }
            : {
                outputDescription: null,
                outputSchema: step.outputSchema,
              }),
        };
        return botStep;
      }
      case 'group_stage':
        return {
          ...baseCommon,
          kind: 'group_stage',
          spaceId: step.spaceId,
          dispatchMode: step.dispatchMode,
          prompt: step.messageTemplate,
        };
      case 'user_gate':
        return {
          ...baseCommon,
          kind: 'user_gate',
          interactionKind:
            step.interactionKind === 'digest' ? 'notify' : step.interactionKind,
          title: step.titleTemplate,
          bodyTemplate: step.bodyTemplate,
          ...(meta?.userGate
            ? {
                ...(meta.userGate.hasApproverScope
                  ? { approverScope: meta.userGate.approverScope }
                  : {}),
                ...(meta.userGate.hasSlaTimeoutSeconds
                  ? { slaTimeoutSeconds: meta.userGate.slaTimeoutSeconds }
                  : {}),
                ...(meta.userGate.hasDecisionSchema
                  ? { decisionSchema: meta.userGate.decisionSchema }
                  : {}),
                ...(meta.userGate.hasFormSchema
                  ? { formSchema: meta.userGate.formSchema }
                  : {}),
              }
            : {
                slaTimeoutSeconds: step.slaTimeoutSeconds,
                formSchema: step.formSchema,
              }),
        };
      case 'condition_branch':
        return {
          ...baseCommon,
          ...(meta?.hasFilter
            ? (meta.filter !== undefined ? { filter: meta.filter } : {})
            : { filter: step.filter }),
          kind: 'control',
          controlKind: 'condition',
          title: meta?.control?.title ?? step.id,
          ...(meta?.control
            ? meta.control.hasExpression
              ? { expression: meta.control.expression }
              : {}
            : { expression: step.thenStepIds.join(', ') }),
        };
      case 'bounded_loop':
        return {
          ...baseCommon,
          kind: 'control',
          controlKind: 'bounded_loop',
          title: meta?.control?.title ?? step.id,
          ...(meta?.control
            ? {
                ...(meta.control.hasMaxIterations
                  ? { maxIterations: meta.control.maxIterations }
                  : {}),
                ...(meta.control.hasLoopTargetStepId
                  ? { loopTargetStepId: meta.control.loopTargetStepId }
                  : {}),
              }
            : {
                maxIterations: step.maxIterations,
                loopTargetStepId: step.targetStepIds[0],
              }),
        };
      case 'wait_for_event':
        return {
          ...baseCommon,
          ...(meta?.hasFilter
            ? (meta.filter !== undefined ? { filter: meta.filter } : {})
            : step.filter !== null
              ? { filter: step.filter }
              : {}),
          kind: 'control',
          controlKind: 'wait_for_event',
          title: meta?.control?.title ?? step.id,
          ...(meta?.control
            ? {
                ...(meta.control.hasWaitEventType
                  ? { waitEventType: meta.control.waitEventType }
                  : {}),
                ...(meta.control.hasThreadKeyTemplate
                  ? { threadKeyTemplate: meta.control.threadKeyTemplate }
                  : {}),
                ...(meta.control.hasTimeoutSeconds
                  ? { timeoutSeconds: meta.control.timeoutSeconds }
                  : {}),
              }
            : {
                waitEventType: step.eventTypes[0] ?? 'sdk.custom',
                threadKeyTemplate: step.threadKeyPointer,
                timeoutSeconds: step.timeoutSeconds,
              }),
        };
      case 'outbox_action': {
        const extractedPayload =
          meta?.outbox?.payloadTemplate ??
          (typeof step.payloadTemplate === 'string'
            ? step.payloadTemplate
            : step.payloadTemplate &&
                typeof step.payloadTemplate === 'object' &&
                !Array.isArray(step.payloadTemplate) &&
                typeof step.payloadTemplate.message === 'string'
              ? step.payloadTemplate.message
              : JSON.stringify(step.payloadTemplate));
        return {
          ...baseCommon,
          kind: 'outbox_action',
          actionKind:
            meta?.outbox?.actionKind ?? inferOutboxChannelActionKind(step),
          title: meta?.outbox?.title ?? step.id,
          destination: step.targetTemplate,
          payloadTemplate: extractedPayload,
        };
      }
    }
  });

  return {
    formatVersion: input.formatVersion,
    name: input.name,
    description: input.description,
    inputSchema: input.inputSchema,
    steps,
    policy: input.policy,
    ...(decodedOrchestratorPreset.present
      ? { orchestratorPreset: decodedOrchestratorPreset.value }
      : {}),
  };
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (typeof value === 'object' && value !== null) {
    const out: { [key in string]?: JsonValue } = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        out[key] = toJsonValue(entry);
      }
    }
    return out;
  }
  return null;
}

function toBackendGateFilter(filter: PulseGateFilterAst): SharedGateFilterAst {
  return {
    sourceKinds: filter.sourceKinds,
    sourceInstanceIds: filter.sourceInstanceIds,
    eventTypes: filter.eventTypes,
    allowedActors: filter.allowedActors,
    conditions: filter.conditions.map((condition) => {
      if (condition.op === 'eq' || condition.op === 'neq') {
        return {
          op: condition.op,
          pointer: condition.pointer,
          value: toJsonValue(condition.value),
        };
      }
      if (condition.op === 'in_set') {
        return {
          op: 'in_set',
          pointer: condition.pointer,
          values: condition.values.map(toJsonValue),
        };
      }
      return condition;
    }),
  };
}

export function toBackendWorkflowDefinition(
  definition: StudioWorkflowDefinition
): WorkflowDefinition {
  const hasPreset =
    'orchestratorPreset' in definition &&
    definition.orchestratorPreset !== undefined;

  const steps: WorkflowStep[] = definition.steps.map((step, index) => {
    const presetMeta: Partial<StudioPhaseMetadata> =
      index === 0 && hasPreset
        ? {
            hasOrchestratorPreset: true,
            orchestratorPreset: definition.orchestratorPreset ?? null,
          }
        : {};

    const buildCommon = (
      stepMeta: StudioPhaseMetadata,
      options?: { omitFilter?: boolean; omitSubscribeThread?: boolean }
    ) => ({
      id: step.id,
      dependsOn: step.dependsOn,
      phase: encodeStudioPhase(step.phase, {
        ...presetMeta,
        ...captureCommonStudioMetadata(step, options),
        ...stepMeta,
      }),
      inputBindings: step.inputBindings,
    });

    switch (step.kind) {
      case 'agent': {
        const legacyMeta: StudioPhaseMetadata =
          step.workspaceIsolation !== undefined
            ? { legacy: { workspaceIsolation: step.workspaceIsolation } }
            : {};
        const common = buildCommon(legacyMeta);
        const {
          workspaceIsolation: _wsIso,
          filter: _filter,
          subscribeThread: _sub,
          threadKeyTemplate: _tk,
          ...agentRest
        } = step;
        return {
          ...agentRest,
          ...common,
        };
      }
      case 'approval': {
        const legacyMeta: StudioPhaseMetadata =
          step.slaTimeoutSeconds !== undefined
            ? { legacy: { slaTimeoutSeconds: step.slaTimeoutSeconds } }
            : {};
        const common = buildCommon(legacyMeta);
        const {
          slaTimeoutSeconds: _sla,
          filter: _filter,
          subscribeThread: _sub,
          threadKeyTemplate: _tk,
          ...approvalRest
        } = step;
        return {
          ...approvalRest,
          ...common,
        };
      }
      case 'notify': {
        const legacyMeta: StudioPhaseMetadata =
          step.slaTimeoutSeconds !== undefined
            ? { legacy: { slaTimeoutSeconds: step.slaTimeoutSeconds } }
            : {};
        const common = buildCommon(legacyMeta);
        const {
          slaTimeoutSeconds: _sla,
          filter: _filter,
          subscribeThread: _sub,
          threadKeyTemplate: _tk,
          ...notifyRest
        } = step;
        return {
          ...notifyRest,
          ...common,
        };
      }
      case 'session': {
        const common = buildCommon({
          session: {
            workspaceIsolation: step.workspaceIsolation,
            executorProfileId: step.executorProfileId,
            modeOverride: step.modeOverride,
            configOverrides: step.configOverrides,
            outputLanguage: step.outputLanguage,
            outputDescription: step.outputDescription,
            ...('allowSkipOnReview' in step &&
            step.allowSkipOnReview !== undefined
              ? {
                  hasAllowSkipOnReview: true,
                  allowSkipOnReview: step.allowSkipOnReview,
                }
              : {}),
          },
        });
        return {
          ...common,
          kind: 'session',
          agentId: step.agentId,
          promptTemplate: step.prompt,
          workspaceAccess:
            step.workspaceIsolation === 'isolated_worktree'
              ? 'write_isolated'
              : step.workspaceIsolation === 'scratch'
                ? 'read_only_shared'
                : 'native',
          modelOverride: step.modeOverride?.trim() ? step.modeOverride : null,
          subscribeThread: Boolean(step.subscribeThread),
          completion: step.completionPolicy,
          outputSchema: step.outputSchema,
        };
      }
      case 'bot': {
        const common = buildCommon({
          bot: {
            ...('outputDescription' in step &&
            step.outputDescription !== undefined
              ? {
                  hasOutputDescription: true,
                  outputDescription: step.outputDescription,
                }
              : {}),
            ...('outputSchema' in step && step.outputSchema !== undefined
              ? { hasOutputSchema: true }
              : {}),
          },
        });
        return {
          ...common,
          kind: 'bot',
          memberId: step.memberId || 'codex',
          conversationScope: step.conversationScope,
          mailboxPolicy: step.mailboxPolicy,
          promptTemplate: step.prompt,
          completion: 'automatic',
          outputSchema: step.outputSchema ?? null,
        };
      }
      case 'group_stage': {
        const common = buildCommon({});
        return {
          ...common,
          kind: 'group_stage',
          spaceId: step.spaceId,
          dispatchMode:
            step.dispatchMode.type === 'mention_seats'
              ? {
                  type: 'mention_seats',
                  memberIds: step.dispatchMode.memberIds,
                  order: step.dispatchMode.order ?? 'parallel',
                }
              : step.dispatchMode,
          messageTemplate: step.prompt,
          quorumCount: null,
        };
      }
      case 'user_gate': {
        const common = buildCommon({
          userGate: {
            ...('approverScope' in step && step.approverScope !== undefined
              ? { hasApproverScope: true, approverScope: step.approverScope }
              : {}),
            ...('slaTimeoutSeconds' in step &&
            step.slaTimeoutSeconds !== undefined
              ? {
                  hasSlaTimeoutSeconds: true,
                  slaTimeoutSeconds: step.slaTimeoutSeconds,
                }
              : {}),
            ...('decisionSchema' in step && step.decisionSchema !== undefined
              ? { hasDecisionSchema: true, decisionSchema: step.decisionSchema }
              : {}),
            ...('formSchema' in step && step.formSchema !== undefined
              ? { hasFormSchema: true, formSchema: step.formSchema }
              : {}),
          },
        });
        return {
          ...common,
          kind: 'user_gate',
          interactionKind: step.interactionKind,
          titleTemplate: step.title,
          bodyTemplate: step.bodyTemplate,
          approvalOptions:
            step.interactionKind === 'approval'
              ? [
                  {
                    id: 'approve',
                    label: 'Approve',
                    destructive: false,
                    requireNote: false,
                  },
                  {
                    id: 'reject',
                    label: 'Reject',
                    destructive: true,
                    requireNote: true,
                  },
                ]
              : [],
          formSchema: step.formSchema ?? null,
          slaTimeoutSeconds: step.slaTimeoutSeconds ?? null,
        };
      }
      case 'control': {
        const controlMeta: StudioPhaseMetadata['control'] = {
          title: step.title,
          ...('expression' in step && step.expression !== undefined
            ? { hasExpression: true, expression: step.expression }
            : {}),
          ...('maxIterations' in step && step.maxIterations !== undefined
            ? { hasMaxIterations: true, maxIterations: step.maxIterations }
            : {}),
          ...('loopTargetStepId' in step && step.loopTargetStepId !== undefined
            ? {
                hasLoopTargetStepId: true,
                loopTargetStepId: step.loopTargetStepId,
              }
            : {}),
          ...('waitEventType' in step && step.waitEventType !== undefined
            ? { hasWaitEventType: true, waitEventType: step.waitEventType }
            : {}),
          ...('threadKeyTemplate' in step &&
          step.threadKeyTemplate !== undefined
            ? {
                hasThreadKeyTemplate: true,
                threadKeyTemplate: step.threadKeyTemplate,
              }
            : {}),
          ...('timeoutSeconds' in step && step.timeoutSeconds !== undefined
            ? { hasTimeoutSeconds: true, timeoutSeconds: step.timeoutSeconds }
            : {}),
        };
        const common = buildCommon({ control: controlMeta });

        if (step.controlKind === 'bounded_loop') {
          return {
            ...common,
            kind: 'bounded_loop',
            targetStepIds: step.loopTargetStepId
              ? [step.loopTargetStepId]
              : step.dependsOn.slice(0, 1),
            maxIterations: step.maxIterations ?? 3,
            untilCondition: null,
          };
        }
        if (step.controlKind === 'wait_for_event') {
          return {
            ...common,
            kind: 'wait_for_event',
            eventTypes: step.waitEventType
              ? [step.waitEventType]
              : ['sdk.custom'],
            threadKeyPointer: normalizeBackendThreadKeyPointer(
              step.threadKeyTemplate
            ),
            filter: step.filter ? toBackendGateFilter(step.filter) : null,
            timeoutSeconds: step.timeoutSeconds ?? null,
          };
        }
        const downstreamIds = definition.steps
          .filter(
            (candidate) =>
              candidate.id !== step.id && candidate.dependsOn.includes(step.id)
          )
          .map((candidate) => candidate.id);
        return {
          ...common,
          kind: 'condition_branch',
          filter: toBackendGateFilter(step.filter ?? DEFAULT_GATE_FILTER),
          thenStepIds: downstreamIds,
          elseStepIds: [],
        };
      }
      case 'outbox_action': {
        const common = buildCommon({
          outbox: {
            actionKind: step.actionKind,
            title: step.title,
            payloadTemplate: step.payloadTemplate,
          },
        });
        if (
          step.actionKind === 'webhook_post' ||
          step.actionKind === 'emit_event'
        ) {
          return {
            ...common,
            kind: 'outbox_action',
            actionKind: step.actionKind,
            targetTemplate: step.destination,
            payloadTemplate: step.payloadTemplate,
          };
        }
        return {
          ...common,
          kind: 'outbox_action',
          actionKind: 'reply_channel',
          targetTemplate: step.destination,
          payloadTemplate: {
            channelHint: step.actionKind,
            message: step.payloadTemplate,
          },
        };
      }
      case 'trigger': {
        const common = buildCommon(
          {
            trigger: {
              title: step.title,
              triggerKind: step.triggerKind,
              sourceKind: step.sourceKind,
              eventType: step.eventType,
              evalMode: step.evalMode,
              ...('temporal' in step && step.temporal !== undefined
                ? { hasTemporal: true, temporal: step.temporal ?? null }
                : {}),
              filter: step.filter,
            },
          },
          { omitFilter: true }
        );
        const rawTitle = step.title || step.id;
        return {
          ...common,
          kind: 'notify',
          title: `${PULSE_TRIGGER_PREFIX} ${rawTitle}`.slice(0, 200),
        };
      }
    }
  });

  return {
    formatVersion: definition.formatVersion,
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    steps,
    policy: definition.policy,
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
