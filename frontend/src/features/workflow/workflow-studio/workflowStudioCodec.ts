import type {
  GateFilterAst as SharedGateFilterAst,
  JsonValue,
  WorkflowDefinition,
  WorkflowStep,
} from 'shared/types';

import i18n from '@/i18n';
import type {
  EventSourceKind,
  GateFilterAst as PulseGateFilterAst,
  PresetOrchestratorKind,
  PulseEvalMode,
  PulseTemporalSpec,
  PulseWorkspaceIsolation,
} from '@/lib/api/pulse';

import {
  DEFAULT_GATE_FILTER,
  type OutboxActionKind,
  type StudioJoinMode,
  type StudioStepCommon,
  type StudioWorkflowDefinition,
  type StudioWorkflowStep,
  type TriggerKind,
  type UserGateSeverity,
  type WorkflowStudioDefinitionInput,
} from './types';

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
  hasBranchPorts?: boolean;
  branchPorts?: Record<string, string>;
  hasTargetPorts?: boolean;
  targetPorts?: Record<string, string>;
  hasJoinMode?: boolean;
  joinMode?: StudioJoinMode;
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
  groupStage?: {
    hasRounds?: boolean;
    rounds?: number | null;
    hasQuorumCount?: boolean;
    quorumCount?: number | null;
  };
  userGate?: {
    hasSeverity?: boolean;
    severity?: UserGateSeverity;
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
  if (!hasPayload) return userPhase;
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
      return { userPhase: parsed.userPhase ?? null, meta: parsed };
    }
  } catch {
    // Fall back to literal phase if not valid JSON metadata.
  }
  return { userPhase: phase, meta: null };
}

function applyCommonStudioMetadata<T extends StudioStepCommon>(
  common: T,
  meta: StudioPhaseMetadata | null,
  inferredBranchPorts?: Record<string, string>
): T {
  const next = { ...common };
  if (meta?.hasFilter) next.filter = meta.filter;
  if (meta?.hasSubscribeThread) next.subscribeThread = meta.subscribeThread;
  if (meta?.hasThreadKeyTemplate) {
    next.threadKeyTemplate = meta.threadKeyTemplate;
  }
  if (meta?.hasBranchPorts) {
    if (meta.branchPorts && Object.keys(meta.branchPorts).length > 0) {
      next.branchPorts = meta.branchPorts;
    }
  } else if (
    inferredBranchPorts &&
    Object.keys(inferredBranchPorts).length > 0
  ) {
    next.branchPorts = inferredBranchPorts;
  }
  if (
    meta?.hasTargetPorts &&
    meta.targetPorts &&
    Object.keys(meta.targetPorts).length > 0
  ) {
    next.targetPorts = meta.targetPorts;
  }
  if (meta?.hasJoinMode && meta.joinMode) {
    next.joinMode = meta.joinMode;
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
  if (
    step.branchPorts !== undefined &&
    Object.keys(step.branchPorts).length > 0
  ) {
    meta.hasBranchPorts = true;
    meta.branchPorts = step.branchPorts;
  }
  if (
    step.targetPorts !== undefined &&
    Object.keys(step.targetPorts).length > 0
  ) {
    meta.hasTargetPorts = true;
    meta.targetPorts = step.targetPorts;
  }
  if (step.joinMode !== undefined) {
    meta.hasJoinMode = true;
    meta.joinMode = step.joinMode;
  }
  return meta;
}

function normalizeBackendThreadKeyPointer(
  template: string | null | undefined
): string | null {
  if (!template) return null;
  const trimmed = template.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/') && trimmed !== '/') return trimmed;
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
  if ('branchPorts' in step || 'joinMode' in step) return true;
  if (step.kind === 'trigger' || step.kind === 'control') return true;
  if (step.kind === 'session' && 'prompt' in step) return true;
  if (step.kind === 'bot' && 'prompt' in step) return true;
  if (step.kind === 'group_stage' && 'prompt' in step) return true;
  if (step.kind === 'user_gate' && 'title' in step) return true;
  if (step.kind === 'outbox_action' && 'destination' in step) return true;
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

function inferConditionBranchPorts(
  rawSteps: ReadonlyArray<StudioWorkflowStep | WorkflowStep>,
  stepId: string,
  dependsOn: readonly string[]
): Record<string, string> | undefined {
  const ports: Record<string, string> = {};
  for (const depId of dependsOn) {
    const pred = rawSteps.find((candidate) => candidate.id === depId);
    if (!pred || pred.kind !== 'condition_branch') continue;
    if (pred.elseStepIds.includes(stepId)) {
      ports[depId] = 'branch:false';
    } else if (pred.thenStepIds.includes(stepId)) {
      ports[depId] = 'branch:true';
    }
  }
  return Object.keys(ports).length > 0 ? ports : undefined;
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

  const defaultTriggerTitle = i18n.getFixedT(
    i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN',
    'workflow'
  )('nodes.defaults.triggerTitle');

  const steps: StudioWorkflowStep[] = input.steps.map((step, index) => {
    if (isStudioOnlyStep(step)) {
      return step;
    }
    const { userPhase, meta } = decodeStudioPhase(step.phase);
    if (
      index === 0 &&
      !decodedOrchestratorPreset.present &&
      meta?.hasOrchestratorPreset
    ) {
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
      meta,
      inferConditionBranchPorts(input.steps, step.id, step.dependsOn)
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
            defaultTriggerTitle;
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
        return {
          ...baseCommon,
          ...(meta?.hasSubscribeThread
            ? meta.subscribeThread !== undefined
              ? { subscribeThread: meta.subscribeThread }
              : {}
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
      }
      case 'bot':
        return {
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
            : { outputDescription: null, outputSchema: step.outputSchema }),
        };
      case 'group_stage':
        return {
          ...baseCommon,
          kind: 'group_stage',
          spaceId: step.spaceId,
          dispatchMode: step.dispatchMode,
          prompt: step.messageTemplate,
          ...(meta?.groupStage?.hasRounds
            ? { rounds: meta.groupStage.rounds }
            : {}),
          ...(meta?.groupStage?.hasQuorumCount
            ? { quorumCount: meta.groupStage.quorumCount }
            : step.quorumCount !== null
              ? { quorumCount: step.quorumCount }
              : {}),
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
                ...(meta.userGate.hasSeverity
                  ? { severity: meta.userGate.severity }
                  : {}),
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
            ? meta.filter !== undefined
              ? { filter: meta.filter }
              : {}
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
            ? meta.filter !== undefined
              ? { filter: meta.filter }
              : {}
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
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object' && value !== null) {
    const out: { [key in string]?: JsonValue } = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) out[key] = toJsonValue(entry);
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
  const fixedT = i18n.getFixedT(
    i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN',
    'workflow'
  );

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
        const {
          workspaceIsolation,
          filter: _f,
          subscribeThread: _s,
          threadKeyTemplate: _t,
          branchPorts: _b,
          joinMode: _j,
          ...rest
        } = step;
        return {
          ...rest,
          ...buildCommon(
            workspaceIsolation !== undefined
              ? { legacy: { workspaceIsolation } }
              : {}
          ),
        };
      }
      case 'approval':
      case 'notify': {
        const {
          slaTimeoutSeconds,
          filter: _f,
          subscribeThread: _s,
          threadKeyTemplate: _t,
          branchPorts: _b,
          joinMode: _j,
          ...rest
        } = step;
        return {
          ...rest,
          ...buildCommon(
            slaTimeoutSeconds !== undefined
              ? { legacy: { slaTimeoutSeconds } }
              : {}
          ),
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
        const hasRounds = 'rounds' in step && step.rounds !== undefined;
        const hasQuorumCount =
          'quorumCount' in step && step.quorumCount !== undefined;
        const common = buildCommon(
          hasRounds || hasQuorumCount
            ? {
                groupStage: {
                  ...(hasRounds
                    ? { hasRounds: true, rounds: step.rounds ?? null }
                    : {}),
                  ...(hasQuorumCount
                    ? {
                        hasQuorumCount: true,
                        quorumCount: step.quorumCount ?? null,
                      }
                    : {}),
                },
              }
            : {}
        );
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
          quorumCount: step.quorumCount ?? null,
        };
      }
      case 'user_gate': {
        const common = buildCommon({
          userGate: {
            ...('severity' in step && step.severity !== undefined
              ? { hasSeverity: true, severity: step.severity }
              : {}),
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
                    label: fixedT('inspector.approve'),
                    destructive: false,
                    requireNote: false,
                  },
                  {
                    id: 'reject',
                    label: fixedT('inspector.reject'),
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
        const downstreamSteps = definition.steps.filter(
          (candidate) =>
            candidate.id !== step.id && candidate.dependsOn.includes(step.id)
        );
        const elseStepIds = downstreamSteps
          .filter(
            (candidate) => candidate.branchPorts?.[step.id] === 'branch:false'
          )
          .map((candidate) => candidate.id);
        const thenStepIds = downstreamSteps
          .filter(
            (candidate) => candidate.branchPorts?.[step.id] !== 'branch:false'
          )
          .map((candidate) => candidate.id);
        return {
          ...common,
          kind: 'condition_branch',
          filter: toBackendGateFilter(step.filter ?? DEFAULT_GATE_FILTER),
          thenStepIds,
          elseStepIds,
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
