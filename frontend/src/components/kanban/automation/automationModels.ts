import type { TFunction } from 'i18next';
import type {
  JsonValue,
  WorkflowDefinition,
  WorkflowDefinitionSummary,
} from 'shared/types';

import type { MemberBotAvatarConfig } from '@/features/collaboration/MemberBotAvatar';
import { formatEventSourceLabel } from '@/features/pulse';
import {
  formatOutboxActionLabel,
  formatWorkflowTemporalBadge,
  toBackendWorkflowDefinition,
  toStudioWorkflowDefinition,
  type OutboxActionKind,
  type StudioWorkflowDefinition,
  type StudioWorkflowStep,
} from '@/features/workflow/WorkflowStudio';
import {
  resolveStaticBotIdentity,
  type CollaborationBotOption,
  type CollaborationSpaceOption,
} from '@/features/workflow/useCollaborationBotRoster';
import type { WorkflowStudioAgentOption } from '@/features/workflow/workflowAgent';
import type {
  EventSourceKind,
  GateFilterAst,
  PulseCallbackKind,
  PulseCallbackSpec,
  PulseRuleSpec,
  PulseRuleView,
  PulseSourceView,
  PulseTargetSpec,
  PulseUserInteractionView,
} from '@/lib/api/pulse';

export type AutomationPrimaryTab = 'tasks' | 'sources';

export type AutomationGovernanceGroup = 'needs_attention' | 'active' | 'paused';

export type AutomationTaskStatus =
  | 'awaiting_approval'
  | 'running'
  | 'active'
  | 'paused'
  | 'draft';

export type TaskChainActor =
  | {
      kind: 'agent';
      agentId: string;
      label: string;
    }
  | {
      kind: 'bot';
      memberId: string;
      label: string;
      avatar: MemberBotAvatarConfig;
    }
  | {
      kind: 'group';
      spaceId: string;
      label: string;
    };

export interface TaskSemanticChain {
  sourceKind: EventSourceKind;
  sourceSummary: string;
  actors: TaskChainActor[];
  outcomeSummary: string;
}

export interface UnifiedAutomationTask {
  key: string;
  id: string;
  workflowId: string | null;
  name: string;
  description: string | null;
  enabled: boolean;
  governanceGroup: AutomationGovernanceGroup;
  status: AutomationTaskStatus;
  recordCount: number;
  versionLabel: string | null;
  updatedAt: string;
  definitionSummary: WorkflowDefinitionSummary | null;
  linkedRule: PulseRuleView | null;
  studioDefinition: StudioWorkflowDefinition;
  chain: TaskSemanticChain;
  pendingInteraction: PulseUserInteractionView | null;
}

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

export function stripTemplateNoise(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/^\[pulse-trigger\]\s*/i, '')
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, expr: string) => {
      const leaf = expr.trim().split(/[./]/).filter(Boolean).at(-1) ?? '';
      return leaf ? `‹${leaf}›` : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

const FRIENDLY_EVENT_TYPE_LABELS: Record<
  string,
  { zh: string; en: string }
> = {
  'github.workflow_run.completed': {
    zh: 'GitHub CI 检查完成时',
    en: 'When GitHub CI finishes',
  },
  'github.pull_request.opened': {
    zh: 'GitHub 新建 PR 时',
    en: 'When a GitHub PR opens',
  },
  'github.pull_request.synchronize': {
    zh: 'GitHub PR 更新提交时',
    en: 'When a GitHub PR updates',
  },
  'github.pr.opened': {
    zh: 'GitHub 新建 PR 时',
    en: 'When a GitHub PR opens',
  },
  'feishu.im.mention': {
    zh: '飞书群消息 @提及我时',
    en: 'When @mentioned in Feishu',
  },
  'feishu.im.message': {
    zh: '收到飞书消息时',
    en: 'When a Feishu message arrives',
  },
  'pulse.timer.fired': {
    zh: '按计划时间触发',
    en: 'On scheduled timer',
  },
  'workflow.trigger': {
    zh: '外部事件触发时',
    en: 'When external event arrives',
  },
};

export function humanizeEventTriggerSummary(input: {
  customTitle?: string | null;
  sourceKind: EventSourceKind;
  eventType?: string | null;
  temporal?: PulseRuleSpec['temporal'];
  sources?: readonly PulseSourceView[];
  sourceInstanceIds?: readonly string[];
  t: TFunction<'panels'>;
  language?: string;
}): string {
  const isZh = (input.language ?? 'zh-CN').startsWith('zh');
  const cleanedCustom = stripTemplateNoise(input.customTitle);
  if (
    cleanedCustom &&
    cleanedCustom.toLowerCase() !== 'trigger' &&
    cleanedCustom.toLowerCase() !== 'intake-trigger' &&
    !/^[a-z0-9_.-]+$/i.test(cleanedCustom)
  ) {
    return cleanedCustom;
  }

  if (input.temporal) {
    return formatWorkflowTemporalBadge(input.temporal);
  }

  const eventKey = (input.eventType ?? '').trim();
  const friendlyEvent = FRIENDLY_EVENT_TYPE_LABELS[eventKey];
  if (friendlyEvent) {
    return isZh ? friendlyEvent.zh : friendlyEvent.en;
  }

  const connectedSource =
    input.sourceInstanceIds && input.sourceInstanceIds.length > 0
      ? input.sources?.find((src) => src.id === input.sourceInstanceIds?.[0])
      : undefined;
  const sourceLabel = connectedSource
    ? connectedSource.title
    : formatEventSourceLabel(input.sourceKind, input.t);

  if (!eventKey || eventKey === 'event.inbound') {
    return isZh ? `来自 ${sourceLabel}` : `From ${sourceLabel}`;
  }
  return `${sourceLabel} · ${eventKey}`;
}

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

function mapCallbackKindToOutbox(
  kind: PulseCallbackKind | (string & {})
): OutboxActionKind {
  switch (kind) {
    case 'github_comment':
      return 'github_comment';
    case 'webhook_post':
      return 'webhook_post';
    case 'feishu_webhook':
    case 'reply_channel':
    case 'feishu_reply':
    default:
      return 'feishu_reply';
  }
}

export function convertRuleSpecToStudioWorkflow(
  spec: PulseRuleSpec,
  outputLanguage = 'zh-CN'
): StudioWorkflowDefinition {
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
      title: '',
      destination: callback.destination || '{{threadKey}}',
      payloadTemplate:
        callback.payloadTemplate ||
        'Completed {{event.eventType}}: {{output.summary}}',
    });
  }

  return {
    formatVersion: 1,
    name: spec.name.trim() || 'Automation Workflow',
    description: spec.description ?? null,
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
}

export function convertFastTaskToWorkflowDefinition(
  spec: PulseRuleSpec,
  outputLanguage = 'zh-CN'
): WorkflowDefinition {
  return toBackendWorkflowDefinition(
    convertRuleSpecToStudioWorkflow(spec, outputLanguage)
  );
}

export function extractSemanticChain(
  studio: StudioWorkflowDefinition,
  linkedRule: PulseRuleView | null,
  options: {
    sources?: readonly PulseSourceView[];
    agentOptions?: readonly WorkflowStudioAgentOption[];
    bots?: readonly CollaborationBotOption[];
    spaces?: readonly CollaborationSpaceOption[];
    t: TFunction<'panels'>;
    language?: string;
  }
): TaskSemanticChain {
  const language = options.language ?? 'zh-CN';
  const isZh = language.startsWith('zh');
  const triggerStep = studio.steps.find(
    (step): step is Extract<StudioWorkflowStep, { kind: 'trigger' }> =>
      step.kind === 'trigger'
  );

  const sourceKind: EventSourceKind =
    triggerStep?.sourceKind ??
    linkedRule?.spec.filter.sourceKinds[0] ??
    (linkedRule?.spec.temporal ? 'time_cron' : 'github');

  const sourceSummary = triggerStep
    ? humanizeEventTriggerSummary({
        customTitle:
          triggerStep.title !== studio.name ? triggerStep.title : null,
        sourceKind: triggerStep.sourceKind,
        eventType: triggerStep.eventType,
        temporal: triggerStep.temporal,
        sources: options.sources,
        sourceInstanceIds: triggerStep.filter.sourceInstanceIds,
        t: options.t,
        language,
      })
    : linkedRule
      ? humanizeEventTriggerSummary({
          customTitle: null,
          sourceKind,
          eventType: linkedRule.spec.filter.eventTypes[0],
          temporal: linkedRule.spec.temporal,
          sources: options.sources,
          sourceInstanceIds: linkedRule.spec.filter.sourceInstanceIds,
          t: options.t,
          language,
        })
      : isZh
        ? '手动或事件触发'
        : 'Manual or event trigger';

  const actors: TaskChainActor[] = [];
  const seenActorKey = new Set<string>();
  for (const step of studio.steps) {
    if (step.kind === 'session' || step.kind === 'agent') {
      const key = `agent:${step.agentId}`;
      if (seenActorKey.has(key)) continue;
      seenActorKey.add(key);
      const label =
        options.agentOptions?.find((opt) => opt.value === step.agentId)
          ?.label ?? step.agentId;
      actors.push({
        kind: 'agent',
        agentId: step.agentId,
        label,
      });
    } else if (step.kind === 'bot') {
      const botIdentity = resolveStaticBotIdentity(
        step.memberId,
        options.bots ?? [],
        language
      );
      const key = `bot:${botIdentity.memberId}`;
      if (seenActorKey.has(key)) continue;
      seenActorKey.add(key);
      actors.push({
        kind: 'bot',
        memberId: botIdentity.memberId,
        label: botIdentity.displayName,
        avatar: botIdentity.avatar,
      });
    } else if (step.kind === 'group_stage') {
      const key = `group:${step.spaceId}`;
      if (seenActorKey.has(key)) continue;
      seenActorKey.add(key);
      const label =
        options.spaces?.find((sp) => sp.spaceId === step.spaceId)
          ?.displayName ??
        (step.spaceId || (isZh ? '协作群组' : 'Group'));
      actors.push({
        kind: 'group',
        spaceId: step.spaceId,
        label,
      });
    }
  }

  let outcomeSummary = isZh ? '记录运行结果' : 'Record run output';
  for (let idx = studio.steps.length - 1; idx >= 0; idx -= 1) {
    const step = studio.steps[idx]!;
    if (step.kind === 'outbox_action') {
      const cleaned = stripTemplateNoise(step.title);
      outcomeSummary =
        cleaned &&
        cleaned.toLowerCase() !== step.id.toLowerCase() &&
        cleaned.toLowerCase() !== 'callback delivery'
          ? cleaned
          : formatOutboxActionLabel(step.actionKind);
      break;
    }
    if (step.kind === 'user_gate') {
      const cleaned = stripTemplateNoise(step.title);
      if (cleaned && cleaned.toLowerCase() !== step.id.toLowerCase()) {
        outcomeSummary = cleaned;
      } else if (step.interactionKind === 'approval') {
        outcomeSummary = isZh ? '等待我审批' : 'Await my approval';
      } else {
        outcomeSummary = isZh ? '发送通知给我' : 'Notify me';
      }
      break;
    }
    if (step.kind === 'approval') {
      outcomeSummary =
        stripTemplateNoise(step.title) ||
        (isZh ? '等待我审批' : 'Await my approval');
      break;
    }
    if (step.kind === 'notify') {
      outcomeSummary =
        stripTemplateNoise(step.title) ||
        (isZh ? '发送通知给我' : 'Notify me');
      break;
    }
  }

  return {
    sourceKind,
    sourceSummary,
    actors,
    outcomeSummary,
  };
}

function parseStudioFromSummary(
  summary: WorkflowDefinitionSummary,
  linkedRule: PulseRuleView | null,
  language = 'zh-CN'
): StudioWorkflowDefinition {
  if (summary.latestNormalizedJson) {
    try {
      const parsed = JSON.parse(
        summary.latestNormalizedJson
      ) as WorkflowDefinition;
      const hydrated = toStudioWorkflowDefinition(parsed);
      const hasTrigger = hydrated.steps.some((step) => step.kind === 'trigger');
      if (!hasTrigger && linkedRule) {
        const projected = convertRuleSpecToStudioWorkflow(
          linkedRule.spec,
          language
        );
        const projectedTrigger = projected.steps[0];
        if (projectedTrigger && projectedTrigger.kind === 'trigger') {
          const rootSteps = hydrated.steps.map((step) =>
            step.dependsOn.length === 0
              ? { ...step, dependsOn: [projectedTrigger.id] }
              : step
          );
          return {
            ...hydrated,
            steps: [projectedTrigger, ...rootSteps],
          };
        }
      }
      return hydrated;
    } catch {
      // Fallback below if JSON is malformed
    }
  }

  if (linkedRule) {
    const projected = convertRuleSpecToStudioWorkflow(linkedRule.spec, language);
    return {
      ...projected,
      name: summary.name || projected.name,
    };
  }

  return {
    formatVersion: 1,
    name: summary.name,
    description: null,
    inputSchema: { type: 'object' },
    policy: {
      maxConcurrentAgentSteps: 4,
      maxAgentCalls: 16,
      deadlineSeconds: 3600,
      maxOutputBytes: 65536,
    },
    steps: [],
  };
}

export function unifyAutomationTasks(
  rules: readonly PulseRuleView[],
  workflows: readonly WorkflowDefinitionSummary[],
  options: {
    busyRuleIds?: readonly string[];
    pendingInteractions?: readonly PulseUserInteractionView[];
    sources?: readonly PulseSourceView[];
    agentOptions?: readonly WorkflowStudioAgentOption[];
    bots?: readonly CollaborationBotOption[];
    spaces?: readonly CollaborationSpaceOption[];
    t: TFunction<'panels'>;
    language?: string;
  }
): UnifiedAutomationTask[] {
  const language = options.language ?? 'zh-CN';
  const workflowRulesByWorkflowId = new Map<string, PulseRuleView>();
  const standaloneRules: PulseRuleView[] = [];

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
    standaloneRules.push(rule);
  }

  const interactions = options.pendingInteractions ?? [];
  const seenWorkflowIds = new Set<string>();
  const items: UnifiedAutomationTask[] = [];

  for (const def of workflows) {
    seenWorkflowIds.add(def.id);
    const linkedRule = workflowRulesByWorkflowId.get(def.id) ?? null;
    const studioDefinition = parseStudioFromSummary(def, linkedRule, language);
    const enabled = linkedRule
      ? linkedRule.enabled
      : Boolean(def.latestVersion !== null && def.latestVersion !== undefined);
    const matchedInteraction =
      interactions.find(
        (item) =>
          (linkedRule && item.ruleId === linkedRule.id) ||
          item.title.includes(def.name)
      ) ?? null;

    const isBusy = Boolean(
      linkedRule && options.busyRuleIds?.includes(linkedRule.id)
    );
    const isDraftOnly = Boolean(linkedRule?.draftOnly);
    const status: AutomationTaskStatus = matchedInteraction
      ? 'awaiting_approval'
      : isBusy
        ? 'running'
        : isDraftOnly
          ? 'draft'
          : enabled
            ? 'active'
            : 'paused';
    const governanceGroup: AutomationGovernanceGroup =
      matchedInteraction || isDraftOnly
        ? 'needs_attention'
        : enabled
          ? 'active'
          : 'paused';

    items.push({
      key: `wf:${def.id}`,
      id: def.id,
      workflowId: def.id,
      name: def.name,
      description: studioDefinition.description ?? linkedRule?.spec.description ?? null,
      enabled,
      governanceGroup,
      status,
      recordCount: linkedRule
        ? (linkedRule.matchedCount ?? 0) + (linkedRule.observedCount ?? 0)
        : 0,
      versionLabel:
        def.latestVersion !== null && def.latestVersion !== undefined
          ? String(def.latestVersion)
          : null,
      updatedAt: def.updatedAt,
      definitionSummary: def,
      linkedRule,
      studioDefinition,
      chain: extractSemanticChain(studioDefinition, linkedRule, options),
      pendingInteraction: matchedInteraction,
    });
  }

  // Include workflow-target rules whose definition wasn't in workflow_list yet
  for (const [workflowId, linkedRule] of workflowRulesByWorkflowId.entries()) {
    if (seenWorkflowIds.has(workflowId)) continue;
    const studioDefinition = convertRuleSpecToStudioWorkflow(
      linkedRule.spec,
      language
    );
    const matchedInteraction =
      interactions.find((item) => item.ruleId === linkedRule.id) ?? null;
    const isBusy = Boolean(options.busyRuleIds?.includes(linkedRule.id));
    const status: AutomationTaskStatus = matchedInteraction
      ? 'awaiting_approval'
      : isBusy
        ? 'running'
        : linkedRule.draftOnly
          ? 'draft'
          : linkedRule.enabled
            ? 'active'
            : 'paused';
    const governanceGroup: AutomationGovernanceGroup =
      matchedInteraction || linkedRule.draftOnly
        ? 'needs_attention'
        : linkedRule.enabled
          ? 'active'
          : 'paused';

    items.push({
      key: `wf:${workflowId}`,
      id: workflowId,
      workflowId,
      name: linkedRule.spec.name || workflowId,
      description: linkedRule.spec.description ?? null,
      enabled: linkedRule.enabled,
      governanceGroup,
      status,
      recordCount:
        (linkedRule.matchedCount ?? 0) + (linkedRule.observedCount ?? 0),
      versionLabel: null,
      updatedAt: linkedRule.updatedAt,
      definitionSummary: null,
      linkedRule,
      studioDefinition,
      chain: extractSemanticChain(studioDefinition, linkedRule, options),
      pendingInteraction: matchedInteraction,
    });
  }

  // Project standalone PulseRules smoothly into unified Workflow tasks
  for (const rule of standaloneRules) {
    const studioDefinition = convertRuleSpecToStudioWorkflow(rule.spec, language);
    const matchedInteraction =
      interactions.find((item) => item.ruleId === rule.id) ?? null;
    const isBusy = Boolean(options.busyRuleIds?.includes(rule.id));
    const status: AutomationTaskStatus = matchedInteraction
      ? 'awaiting_approval'
      : isBusy
        ? 'running'
        : rule.draftOnly
          ? 'draft'
          : rule.enabled
            ? 'active'
            : 'paused';
    const governanceGroup: AutomationGovernanceGroup =
      matchedInteraction || rule.draftOnly
        ? 'needs_attention'
        : rule.enabled
          ? 'active'
          : 'paused';

    items.push({
      key: `rule:${rule.id}`,
      id: rule.id,
      workflowId: null,
      name: rule.spec.name,
      description: rule.spec.description ?? null,
      enabled: rule.enabled,
      governanceGroup,
      status,
      recordCount: (rule.matchedCount ?? 0) + (rule.observedCount ?? 0),
      versionLabel: null,
      updatedAt: rule.updatedAt,
      definitionSummary: null,
      linkedRule: rule,
      studioDefinition,
      chain: extractSemanticChain(studioDefinition, rule, options),
      pendingInteraction: matchedInteraction,
    });
  }

  return items;
}

export function generateWebhookSecret(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(24);
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.getRandomValues === 'function'
  ) {
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
