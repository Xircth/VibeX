import type { TFunction } from 'i18next';
import type {
  JsonValue,
  WorkflowDefinition,
  WorkflowDefinitionSummary,
} from 'shared/types';
import {
  toBackendWorkflowDefinition,
  type OutboxActionKind,
  type StudioWorkflowDefinition,
  type StudioWorkflowStep,
} from '@/features/workflow/WorkflowStudio';
import {
  BUILT_IN_SAMPLE_EVENTS,
  formatEventSourceLabel,
} from '@/features/pulse';
import type {
  EventEnvelope,
  EventSourceKind,
  GateFilterAst,
  PulseCallbackKind,
  PulseCallbackSpec,
  PulseRuleSpec,
  PulseRuleView,
  PulseSourceView,
  PulseTargetSpec,
} from '@/lib/api/pulse';

export type AutomationPrimaryTab = 'tasks' | 'pending' | 'rules' | 'sources';

export type FastTaskEditorTab =
  | 'event'
  | 'rule'
  | 'target'
  | 'callback'
  | 'records';

export type AutomationTaskStatus =
  | 'running'
  | 'testing'
  | 'publishing'
  | 'published'
  | 'pending_test'
  | 'editing';

export type TaskTypeFilter = 'all' | 'fast_task' | 'workflow';

export type UnifiedAutomationTask =
  | {
      key: string;
      kind: 'fast_task';
      id: string;
      name: string;
      enabled: boolean;
      status: AutomationTaskStatus;
      recordCount: number;
      rule: PulseRuleView;
    }
  | {
      key: string;
      kind: 'workflow';
      id: string;
      workflowId: string;
      name: string;
      enabled: boolean;
      status: AutomationTaskStatus;
      recordCount: number;
      versionLabel: string | null;
      updatedAt: string;
      definition: WorkflowDefinitionSummary | null;
      triggerRule: PulseRuleView | null;
    };

const DEFAULT_STUDIO_OUTPUT_SCHEMA: JsonValue = {
  type: 'object',
  required: ['summary'],
  properties: { summary: { type: 'string' } },
};

export const EMPTY_GATE_FILTER: GateFilterAst = {
  sourceKinds: [],
  sourceInstanceIds: [],
  eventTypes: [],
  allowedActors: [],
  conditions: [],
};

export const PROMPT_VARIABLE_PILLS: readonly string[] = [
  '{{event.eventType}}',
  '{{payload.workflow_run.name}}',
  '{{payload.workflow_run.html_url}}',
  '{{payload.text}}',
];

export function isWorkflowOnlyRule(rule: PulseRuleView): boolean {
  if (rule.spec.taskMeta?.taskKind === 'workflow_trigger') {
    return true;
  }
  return (
    rule.spec.targets.length > 0 &&
    rule.spec.targets.every((target) => target.kind === 'workflow')
  );
}

export function isReusableRuleTemplate(rule: PulseRuleView): boolean {
  return rule.spec.taskMeta?.taskKind === 'reusable_rule';
}

export function resolveRuleTaskStatus(
  rule: PulseRuleView | null,
  options: {
    busyRuleIds?: readonly string[];
    testingTaskKey?: string | null;
    publishingTaskKey?: string | null;
    hasUnsavedChanges?: boolean;
    taskKey: string;
  }
): AutomationTaskStatus {
  if (options.testingTaskKey === options.taskKey) {
    return 'testing';
  }
  if (options.publishingTaskKey === options.taskKey) {
    return 'publishing';
  }
  if (rule && options.busyRuleIds?.includes(rule.id)) {
    return 'running';
  }
  if (!rule || options.hasUnsavedChanges || rule.draftOnly) {
    return 'editing';
  }
  const lifecycle = rule.spec.taskMeta?.lifecycleState ?? null;
  if (lifecycle === 'publishing') {
    return 'publishing';
  }
  if (lifecycle === 'pending_test') {
    return 'pending_test';
  }
  if (lifecycle === 'editing') {
    return 'editing';
  }
  if (lifecycle === 'published') {
    return 'published';
  }
  if (rule.enabled && !rule.draftOnly) {
    return 'published';
  }
  return 'editing';
}

export function unifyAutomationTasks(
  rules: readonly PulseRuleView[],
  workflows: readonly WorkflowDefinitionSummary[],
  options: {
    busyRuleIds?: readonly string[];
    testingTaskKey?: string | null;
    publishingTaskKey?: string | null;
    dirtyTaskKeys?: ReadonlySet<string>;
  } = {}
): UnifiedAutomationTask[] {
  const workflowRulesByWorkflowId = new Map<string, PulseRuleView>();
  const fastTaskItems: UnifiedAutomationTask[] = [];

  for (const rule of rules) {
    if (isReusableRuleTemplate(rule)) {
      continue;
    }
    if (isWorkflowOnlyRule(rule)) {
      const wfTarget = rule.spec.targets.find(
        (target): target is Extract<PulseTargetSpec, { kind: 'workflow' }> =>
          target.kind === 'workflow'
      );
      if (wfTarget && !workflowRulesByWorkflowId.has(wfTarget.workflowId)) {
        workflowRulesByWorkflowId.set(wfTarget.workflowId, rule);
      }
      continue;
    }
    const key = `fast:${rule.id}`;
    fastTaskItems.push({
      key,
      kind: 'fast_task',
      id: rule.id,
      name: rule.spec.name,
      enabled: rule.enabled,
      status: resolveRuleTaskStatus(rule, {
        busyRuleIds: options.busyRuleIds,
        testingTaskKey: options.testingTaskKey,
        publishingTaskKey: options.publishingTaskKey,
        hasUnsavedChanges: options.dirtyTaskKeys?.has(key) ?? false,
        taskKey: key,
      }),
      recordCount: (rule.matchedCount ?? 0) + (rule.observedCount ?? 0),
      rule,
    });
  }

  const seenWorkflowIds = new Set<string>();
  const workflowItems: UnifiedAutomationTask[] = [];

  for (const def of workflows) {
    seenWorkflowIds.add(def.id);
    const linkedRule = workflowRulesByWorkflowId.get(def.id) ?? null;
    const key = `wf:${def.id}`;
    const versionNum =
      def.latestVersion !== null && def.latestVersion !== undefined
        ? String(def.latestVersion)
        : null;
    const status: AutomationTaskStatus =
      options.testingTaskKey === key
        ? 'testing'
        : options.publishingTaskKey === key
          ? 'publishing'
          : linkedRule && options.busyRuleIds?.includes(linkedRule.id)
            ? 'running'
            : linkedRule
              ? resolveRuleTaskStatus(linkedRule, {
                  busyRuleIds: options.busyRuleIds,
                  testingTaskKey: options.testingTaskKey,
                  publishingTaskKey: options.publishingTaskKey,
                  taskKey: key,
                })
              : versionNum
                ? 'published'
                : 'editing';

    workflowItems.push({
      key,
      kind: 'workflow',
      id: def.id,
      workflowId: def.id,
      name: def.name,
      enabled: linkedRule ? linkedRule.enabled : Boolean(versionNum),
      status,
      recordCount: linkedRule
        ? (linkedRule.matchedCount ?? 0) + (linkedRule.observedCount ?? 0)
        : 0,
      versionLabel: versionNum,
      updatedAt: def.updatedAt,
      definition: def,
      triggerRule: linkedRule,
    });
  }

  // Include orphan workflow-target rules whose definition wasn't in workflow_list yet
  for (const [workflowId, linkedRule] of workflowRulesByWorkflowId.entries()) {
    if (seenWorkflowIds.has(workflowId)) {
      continue;
    }
    const wfTarget = linkedRule.spec.targets.find(
      (target): target is Extract<PulseTargetSpec, { kind: 'workflow' }> =>
        target.kind === 'workflow'
    );
    const key = `wf:${workflowId}`;
    workflowItems.push({
      key,
      kind: 'workflow',
      id: workflowId,
      workflowId,
      name: linkedRule.spec.name || workflowId,
      enabled: linkedRule.enabled,
      status: resolveRuleTaskStatus(linkedRule, {
        busyRuleIds: options.busyRuleIds,
        testingTaskKey: options.testingTaskKey,
        publishingTaskKey: options.publishingTaskKey,
        taskKey: key,
      }),
      recordCount:
        (linkedRule.matchedCount ?? 0) + (linkedRule.observedCount ?? 0),
      versionLabel: wfTarget?.pinnedVersion
        ? String(wfTarget.pinnedVersion)
        : null,
      updatedAt: linkedRule.updatedAt,
      definition: null,
      triggerRule: linkedRule,
    });
  }

  return [...fastTaskItems, ...workflowItems];
}

export function buildDefaultFastTaskSpec(
  defaultName: string,
  defaultAgentId = 'claude-code',
  projectId?: string | null
): PulseRuleSpec {
  return {
    name: defaultName,
    description: null,
    projectId: projectId ?? null,
    evalMode: 'observe',
    filter: {
      sourceKinds: ['github'],
      sourceInstanceIds: [],
      eventTypes: ['github.workflow_run.completed'],
      allowedActors: [],
      conditions: [{ op: 'eq', pointer: '/workflow_run/conclusion', value: 'failure' }],
    },
    temporal: null,
    targets: [
      {
        kind: 'session',
        mode: 'thread_keyed',
        agentId: defaultAgentId,
        workspaceIsolation: 'isolated_worktree',
        subscribeThread: true,
        promptTemplate:
          'Analyze {{event.eventType}} ({{payload.workflow_run.name}}) at {{payload.workflow_run.html_url}} and propose a minimal fix.',
      },
    ],
    callback: null,
    taskMeta: {
      taskKind: 'fast_task',
      lifecycleState: 'editing',
    },
  };
}

export function summarizeFastTaskSegments(
  spec: PulseRuleSpec,
  sources: readonly PulseSourceView[],
  t: TFunction<'panels'>
): {
  eventSummary: string;
  ruleSummary: string;
  targetSummary: string;
  callbackSummary: string | null;
} {
  const connectedSource =
    spec.filter.sourceInstanceIds.length > 0
      ? sources.find((src) => src.id === spec.filter.sourceInstanceIds[0])
      : undefined;
  const sourceLabel = connectedSource
    ? connectedSource.title
    : spec.temporal
      ? spec.temporal.kind === 'cron'
        ? `Cron ${spec.temporal.expression}`
        : spec.temporal.kind === 'interval'
          ? `${spec.temporal.everySeconds}s`
          : spec.temporal.kind === 'inactivity_sla'
            ? `SLA ${spec.temporal.timeoutSeconds}s`
            : spec.temporal.fireAt
      : spec.filter.sourceKinds[0]
        ? formatEventSourceLabel(spec.filter.sourceKinds[0], t)
        : t('pulseDeck.workbench.tasks.allEvents');
  const eventTypeLabel = spec.filter.eventTypes[0] ?? '';
  const eventSummary = eventTypeLabel
    ? `${sourceLabel} · ${eventTypeLabel}`
    : sourceLabel;

  const conditionCount = spec.filter.conditions.length;
  const ruleSummary =
    conditionCount === 0
      ? t('pulseDeck.workbench.tasks.anyFilter')
      : t('pulseDeck.workbench.tasks.filterCount', { count: conditionCount });

  const primaryTarget = spec.targets[0];
  let targetSummary = t('pulseDeck.workbench.editor.target.kindSession');
  if (primaryTarget) {
    switch (primaryTarget.kind) {
      case 'session':
        targetSummary = primaryTarget.agentId || 'claude-code';
        break;
      case 'bot':
        targetSummary = `Bot · ${primaryTarget.memberId || 'triage-bot'}`;
        break;
      case 'group':
        targetSummary = `${t('pulseDeck.workbench.editor.target.kindGroup')} · ${primaryTarget.spaceId || 'space'}`;
        break;
      case 'user':
        targetSummary = t('pulseDeck.workbench.editor.target.kindUser');
        break;
      case 'workflow':
        targetSummary = `Workflow · ${primaryTarget.workflowId}`;
        break;
    }
  }

  const callback = spec.callback;
  const callbackEnabled = Boolean(callback && callback.enabled !== false);
  let callbackSummary: string | null = null;
  if (callbackEnabled && callback) {
    const kindLabels: Record<PulseCallbackKind, string> = {
      feishu_webhook: t('pulseDeck.sources.feishu'),
      github_comment: 'GitHub',
      webhook_post: 'Webhook',
      reply_channel: t('pulseDeck.workbench.editor.callback.replyTitle'),
    };
    callbackSummary = kindLabels[callback.kind];
  }

  return {
    eventSummary,
    ruleSummary,
    targetSummary,
    callbackSummary,
  };
}

export function buildSampleEnvelopeForRule(spec: PulseRuleSpec): EventEnvelope {
  const primaryKind: EventSourceKind =
    spec.filter.sourceKinds[0] ??
    (spec.temporal ? 'time_cron' : 'github');
  const eventType =
    spec.filter.eventTypes[0] ??
    (primaryKind === 'feishu'
      ? 'feishu.im.mention'
      : primaryKind === 'github'
        ? 'github.workflow_run.completed'
        : 'webhook.inbound');

  const payload: Record<string, unknown> =
    primaryKind === 'github'
      ? {
          ref: 'refs/heads/main',
          branch: 'main',
          title: 'CI failure on main',
          workflow_run: {
            name: 'CICheck',
            conclusion: 'failure',
            head_branch: 'main',
            html_url: 'https://github.com/org/repo/actions/runs/1024',
          },
        }
      : primaryKind === 'feishu'
        ? {
            text: 'urgent: production latency spike on api-gateway',
            chat_id: 'oc_feishu_ops',
          }
        : {
            summary: 'Sample automation trigger payload',
            priority: 'P0',
            text: 'Sample webhook payload',
          };

  // Ensure eq conditions in the rule have matching sample values when testing syntax/pipeline
  for (const cond of spec.filter.conditions) {
    if (cond.op === 'eq' && cond.pointer.startsWith('/')) {
      const segments = cond.pointer
        .slice(1)
        .split('/')
        .filter(Boolean);
      if (segments.length === 1) {
        payload[segments[0]!] = cond.value;
      } else if (segments.length === 2) {
        const parentKey = segments[0]!;
        const childKey = segments[1]!;
        const existing =
          payload[parentKey] && typeof payload[parentKey] === 'object'
            ? (payload[parentKey] as Record<string, unknown>)
            : {};
        payload[parentKey] = { ...existing, [childKey]: cond.value };
      }
    }
  }

  const baseSample = BUILT_IN_SAMPLE_EVENTS[0];
  return {
    eventId: `evt-sample-${ primaryKind }`,
    deliveryId: `dlv-sample-${ primaryKind }`,
    source: {
      kind: primaryKind,
      instanceId: spec.filter.sourceInstanceIds[0] ?? `${primaryKind}-default`,
      trustLevel: 'verified_external',
    },
    eventType,
    occurredAt: baseSample?.occurredAt ?? '2026-11-16T00:00:00Z',
    actor: {
      id: 'dev-user',
      displayName: 'Developer',
      roles: ['maintainer'],
      isBot: false,
      isSelf: false,
    },
    threadKey: `${primaryKind}:sample-thread`,
    correlations: [],
    replyChannels: [
      {
        sourceKind: primaryKind,
        instanceId: spec.filter.sourceInstanceIds[0] ?? `${primaryKind}-default`,
        channelId: 'ch-ops',
      },
    ],
    trace: {
      rootEventId: `evt-sample-${primaryKind}`,
      parentRunId: null,
      hopCount: 0,
    },
    payload,
  };
}

export function renderTemplatePreview(
  template: string,
  envelope: EventEnvelope
): string {
  const payloadRecord =
    envelope.payload && typeof envelope.payload === 'object'
      ? (envelope.payload as Record<string, unknown>)
      : {};
  const workflowRun =
    payloadRecord.workflow_run && typeof payloadRecord.workflow_run === 'object'
      ? (payloadRecord.workflow_run as Record<string, unknown>)
      : {};

  const lookup: Record<string, string> = {
    'event.id': envelope.eventId,
    'event.eventType': envelope.eventType,
    'event.occurredAt': envelope.occurredAt,
    threadKey: envelope.threadKey ?? '',
    'payload.text': String(payloadRecord.text ?? payloadRecord.summary ?? ''),
    'payload.title': String(payloadRecord.title ?? ''),
    'payload.summary': String(payloadRecord.summary ?? ''),
    'payload.workflow_run.name': String(workflowRun.name ?? 'CI'),
    'payload.workflow_run.html_url': String(
      workflowRun.html_url ?? 'https://github.com/org/repo/actions'
    ),
  };

  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, rawKey: string) => {
    const key = rawKey.trim();
    return lookup[key] ?? `<${key}>`;
  });
}

/**
 * Exhaustive validation (Maiden Rule #1: No Fail-Fast — collects all violations in 1 pass).
 */
export function validateFastTaskForPublish(
  spec: PulseRuleSpec,
  t: TFunction<'panels'>
): string[] {
  const errors: string[] = [];

  if (!spec.name.trim()) {
    errors.push(t('pulseDeck.workbench.editor.errNameRequired'));
  }

  const hasEventSource =
    spec.filter.sourceKinds.length > 0 ||
    spec.filter.sourceInstanceIds.length > 0 ||
    spec.filter.eventTypes.length > 0 ||
    Boolean(spec.temporal);
  if (!hasEventSource) {
    errors.push(t('pulseDeck.workbench.editor.errEventRequired'));
  }

  const target = spec.targets[0];
  if (!target) {
    errors.push(t('pulseDeck.workbench.editor.errPromptRequired'));
  } else if (target.kind === 'session') {
    if (!target.agentId.trim()) {
      errors.push(t('pulseDeck.workbench.editor.errAgentRequired'));
    }
    if (!target.promptTemplate.trim()) {
      errors.push(t('pulseDeck.workbench.editor.errPromptRequired'));
    }
  } else if (target.kind === 'bot') {
    if (!target.memberId.trim()) {
      errors.push(t('pulseDeck.workbench.editor.errBotRequired'));
    }
    if (!target.promptTemplate.trim()) {
      errors.push(t('pulseDeck.workbench.editor.errPromptRequired'));
    }
  } else if (target.kind === 'group') {
    if (!target.spaceId.trim()) {
      errors.push(t('pulseDeck.workbench.editor.errSpaceRequired'));
    }
    if (!target.messageTemplate.trim()) {
      errors.push(t('pulseDeck.workbench.editor.errPromptRequired'));
    }
  } else if (target.kind === 'user') {
    if (!target.titleTemplate.trim()) {
      errors.push(t('pulseDeck.workbench.editor.errUserTitleRequired'));
    }
  }

  if (spec.callback && spec.callback.enabled !== false) {
    if (
      spec.callback.kind !== 'reply_channel' &&
      !spec.callback.destination.trim()
    ) {
      errors.push(t('pulseDeck.workbench.editor.errCallbackDestRequired'));
    }
  }

  return errors;
}

function mapCallbackKindToOutbox(kind: PulseCallbackKind): OutboxActionKind {
  switch (kind) {
    case 'feishu_webhook':
      return 'feishu_reply';
    case 'github_comment':
      return 'github_comment';
    case 'webhook_post':
      return 'webhook_post';
    case 'reply_channel':
      return 'feishu_reply';
  }
}

export function convertFastTaskToWorkflowDefinition(
  spec: PulseRuleSpec,
  outputLanguage = 'zh-CN'
): WorkflowDefinition {
  const sourceKind: EventSourceKind =
    spec.filter.sourceKinds[0] ?? (spec.temporal ? 'time_cron' : 'github');
  const triggerKind = spec.temporal
    ? 'temporal'
    : sourceKind === 'webhook_standard' || sourceKind === 'webhook_custom'
      ? 'webhook'
      : sourceKind === 'sdk_custom'
        ? 'sdk'
        : 'platform';

  const triggerStep: StudioWorkflowStep = {
    id: 'intake-trigger',
    dependsOn: [],
    phase: null,
    inputBindings: {},
    kind: 'trigger',
    title: spec.name.trim() || 'Trigger',
    triggerKind,
    sourceKind,
    eventType: spec.filter.eventTypes[0] ?? 'event.inbound',
    evalMode: spec.evalMode === 'off' ? 'observe' : spec.evalMode,
    temporal: spec.temporal ?? null,
    filter: spec.filter,
  };

  const target = spec.targets[0];
  let executionStep: StudioWorkflowStep;
  if (target?.kind === 'bot') {
    executionStep = {
      id: 'execute-bot',
      dependsOn: ['intake-trigger'],
      phase: null,
      inputBindings: {},
      kind: 'bot',
      memberId: target.memberId || 'triage-bot',
      conversationScope: target.conversationScope ?? 'fixed_primary',
      mailboxPolicy: target.mailboxPolicy ?? 'fifo_serial',
      prompt: target.promptTemplate,
      outputDescription: null,
      outputSchema: DEFAULT_STUDIO_OUTPUT_SCHEMA,
    };
  } else if (target?.kind === 'group') {
    executionStep = {
      id: 'execute-group',
      dependsOn: ['intake-trigger'],
      phase: null,
      inputBindings: {},
      kind: 'group_stage',
      spaceId: target.spaceId || 'eng-space',
      dispatchMode: target.dispatchMode,
      prompt: target.messageTemplate,
    };
  } else if (target?.kind === 'user') {
    executionStep = {
      id: 'execute-gate',
      dependsOn: ['intake-trigger'],
      phase: null,
      inputBindings: {},
      kind: 'user_gate',
      interactionKind:
        target.interactionKind === 'digest' ? 'notify' : target.interactionKind,
      severity: target.severity ?? 'info',
      title: target.titleTemplate || spec.name,
      bodyTemplate: target.bodyTemplate || '{{payload.text}}',
    };
  } else {
    const sessionTarget = target?.kind === 'session' ? target : null;
    executionStep = {
      id: 'execute-session',
      dependsOn: ['intake-trigger'],
      phase: null,
      inputBindings: {},
      kind: 'session',
      agentId: sessionTarget?.agentId || 'claude-code',
      prompt:
        sessionTarget?.promptTemplate ||
        'Handle {{event.eventType}} on {{threadKey}}',
      workspaceIsolation:
        sessionTarget?.workspaceIsolation ?? 'isolated_worktree',
      executorProfileId: null,
      modeOverride: null,
      configOverrides: {},
      outputLanguage,
      outputDescription: null,
      outputSchema: DEFAULT_STUDIO_OUTPUT_SCHEMA,
      completionPolicy: 'automatic',
      subscribeThread: sessionTarget?.subscribeThread ?? true,
    };
  }

  const steps: StudioWorkflowStep[] = [triggerStep, executionStep];
  const callback: PulseCallbackSpec | null | undefined = spec.callback;
  if (callback && callback.enabled !== false) {
    steps.push({
      id: 'deliver-callback',
      dependsOn: [executionStep.id],
      phase: null,
      inputBindings: {},
      kind: 'outbox_action',
      actionKind: mapCallbackKindToOutbox(callback.kind),
      title: 'Callback Delivery',
      destination: callback.destination || '{{threadKey}}',
      payloadTemplate:
        callback.payloadTemplate ||
        'Completed {{event.eventType}}: {{output.summary}}',
    });
  }

  const studioDef: StudioWorkflowDefinition = {
    formatVersion: 1,
    name: spec.name.trim() || 'Converted Workflow',
    description: spec.description ?? '',
    inputSchema: { type: 'object' },
    orchestratorPreset: 'direct_reflex',
    policy: {
      maxConcurrentAgentSteps: 4,
      maxAgentCalls: 16,
      deadlineSeconds: 3600,
      maxOutputBytes: 65536,
    },
    steps,
  };

  return toBackendWorkflowDefinition(studioDef);
}

export function generateWebhookSecret(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(24);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let idx = 0; idx < bytes.length; idx += 1) {
      bytes[idx] = Math.floor(Math.random() * 256);
    }
  }
  let token = 'whsec_';
  for (const byte of bytes) {
    token += alphabet[byte % alphabet.length];
  }
  return token;
}

export function buildWebhookCurlSnippet(
  webhookUrl: string,
  secret: string,
  kind: EventSourceKind
): string {
  const trimmedSecret = secret.trim();
  const headerLine = trimmedSecret
    ? ` \\\n  -H "X-Pulse-Signature: ${trimmedSecret}"`
    : '';
  const eventHeader =
    kind === 'github'
      ? ' \\\n  -H "X-GitHub-Event: workflow_run"'
      : '';
  return `curl -X POST "${webhookUrl}" \\\n  -H "Content-Type: application/json"${eventHeader}${headerLine} \\\n  -d '{"eventType":"webhook.test","text":"hello from curl"}'`;
}
