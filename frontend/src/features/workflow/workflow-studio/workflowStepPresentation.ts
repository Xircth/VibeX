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
  GateFilterAst as PulseGateFilterAst,
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
  if (step.kind === 'agent' && step.workspaceAccess === 'write_isolated') {
    return 'isolated_worktree';
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
  const steps: StudioWorkflowStep[] = input.steps.map((step) => {
    if (isStudioOnlyStep(step)) {
      return step;
    }
    switch (step.kind) {
      case 'agent':
      case 'approval':
      case 'notify':
        return step;
      case 'session':
        return {
          id: step.id,
          dependsOn: step.dependsOn,
          phase: step.phase,
          inputBindings: step.inputBindings,
          subscribeThread: step.subscribeThread,
          kind: 'session',
          agentId: step.agentId,
          prompt: step.promptTemplate,
          workspaceIsolation:
            step.workspaceAccess === 'write_isolated'
              ? 'isolated_worktree'
              : 'project_root',
          executorProfileId: null,
          modeOverride: step.modelOverride,
          configOverrides: {},
          outputLanguage: 'en',
          outputDescription: null,
          outputSchema: step.outputSchema,
          completionPolicy: step.completion,
        };
      case 'bot':
        return {
          id: step.id,
          dependsOn: step.dependsOn,
          phase: step.phase,
          inputBindings: step.inputBindings,
          kind: 'bot',
          memberId: step.memberId,
          conversationScope: step.conversationScope,
          mailboxPolicy: step.mailboxPolicy,
          prompt: step.promptTemplate,
          outputDescription: null,
          outputSchema: step.outputSchema,
        };
      case 'group_stage':
        return {
          id: step.id,
          dependsOn: step.dependsOn,
          phase: step.phase,
          inputBindings: step.inputBindings,
          kind: 'group_stage',
          spaceId: step.spaceId,
          dispatchMode: step.dispatchMode,
          prompt: step.messageTemplate,
        };
      case 'user_gate':
        return {
          id: step.id,
          dependsOn: step.dependsOn,
          phase: step.phase,
          inputBindings: step.inputBindings,
          kind: 'user_gate',
          interactionKind:
            step.interactionKind === 'digest' ? 'notify' : step.interactionKind,
          title: step.titleTemplate,
          bodyTemplate: step.bodyTemplate,
          slaTimeoutSeconds: step.slaTimeoutSeconds,
          formSchema: step.formSchema,
        };
      case 'condition_branch':
        return {
          id: step.id,
          dependsOn: step.dependsOn,
          phase: step.phase,
          inputBindings: step.inputBindings,
          filter: step.filter,
          kind: 'control',
          controlKind: 'condition',
          title: step.id,
          expression: step.thenStepIds.join(', '),
        };
      case 'bounded_loop':
        return {
          id: step.id,
          dependsOn: step.dependsOn,
          phase: step.phase,
          inputBindings: step.inputBindings,
          kind: 'control',
          controlKind: 'bounded_loop',
          title: step.id,
          maxIterations: step.maxIterations,
          loopTargetStepId: step.targetStepIds[0],
        };
      case 'wait_for_event':
        return {
          id: step.id,
          dependsOn: step.dependsOn,
          phase: step.phase,
          inputBindings: step.inputBindings,
          filter: step.filter,
          kind: 'control',
          controlKind: 'wait_for_event',
          title: step.id,
          waitEventType: step.eventTypes[0] ?? 'sdk.custom',
          threadKeyTemplate: step.threadKeyPointer,
          timeoutSeconds: step.timeoutSeconds,
        };
      case 'outbox_action':
        return {
          id: step.id,
          dependsOn: step.dependsOn,
          phase: step.phase,
          inputBindings: step.inputBindings,
          kind: 'outbox_action',
          actionKind:
            step.actionKind === 'reply_channel'
              ? 'github_comment'
              : step.actionKind,
          title: step.id,
          destination: step.targetTemplate,
          payloadTemplate:
            typeof step.payloadTemplate === 'string'
              ? step.payloadTemplate
              : JSON.stringify(step.payloadTemplate),
        };
    }
  });

  return {
    formatVersion: input.formatVersion,
    name: input.name,
    description: input.description,
    inputSchema: input.inputSchema,
    steps,
    policy: input.policy,
    ...('orchestratorPreset' in input
      ? { orchestratorPreset: input.orchestratorPreset }
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
  const steps: WorkflowStep[] = definition.steps.map((step) => {
    const common = {
      id: step.id,
      dependsOn: step.dependsOn,
      phase: step.phase,
      inputBindings: step.inputBindings,
    };
    switch (step.kind) {
      case 'agent':
      case 'approval':
      case 'notify':
        return step;
      case 'session':
        return {
          ...common,
          kind: 'session',
          agentId: step.agentId,
          promptTemplate: step.prompt,
          workspaceAccess:
            step.workspaceIsolation === 'isolated_worktree'
              ? 'write_isolated'
              : 'native',
          modelOverride: step.modeOverride,
          subscribeThread: Boolean(step.subscribeThread),
          completion: step.completionPolicy,
          outputSchema: step.outputSchema,
        };
      case 'bot':
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
      case 'group_stage':
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
      case 'user_gate':
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
      case 'control':
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
            threadKeyPointer: step.threadKeyTemplate ?? null,
            filter: step.filter ? toBackendGateFilter(step.filter) : null,
            timeoutSeconds: step.timeoutSeconds ?? null,
          };
        }
        return {
          ...common,
          kind: 'condition_branch',
          filter: toBackendGateFilter(step.filter ?? DEFAULT_GATE_FILTER),
          thenStepIds: [],
          elseStepIds: [],
        };
      case 'outbox_action':
        return {
          ...common,
          kind: 'outbox_action',
          actionKind:
            step.actionKind === 'webhook_post' ||
            step.actionKind === 'emit_event'
              ? step.actionKind
              : 'reply_channel',
          targetTemplate: step.destination,
          payloadTemplate: step.payloadTemplate,
        };
      case 'trigger':
        return {
          ...common,
          kind: 'notify',
          title: step.title || `trigger:${step.id}`,
        };
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
