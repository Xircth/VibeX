import i18n from '@/i18n';
import type { PresetOrchestratorKind } from '@/lib/api/pulse';

import {
  DEFAULT_GATE_FILTER,
  DEFAULT_OUTPUT_SCHEMA,
  type StudioWorkflowDefinition,
} from './types';
import {
  getWorkflowTranslator,
  type WorkflowTranslateFn,
} from './workflowStepPresentation';

export type WorkflowPresetTemplate = {
  id: PresetOrchestratorKind;
  label: string;
  summary: string;
  build: (defaultAgentId: string) => StudioWorkflowDefinition;
};

const BASE_POLICY = {
  maxConcurrentAgentSteps: 4,
  maxAgentCalls: 16,
  deadlineSeconds: 3600,
  maxOutputBytes: 65536,
};

const PRESET_IDS: readonly PresetOrchestratorKind[] = [
  'direct_reflex',
  'superagent_router',
  'hybrid_pipeline',
  'event_saga',
  'window_aggregator',
];

function buildPresetDefinition(
  id: PresetOrchestratorKind,
  defaultAgentId: string,
  t?: WorkflowTranslateFn
): StudioWorkflowDefinition {
  const tr = getWorkflowTranslator(t);
  const outputLanguage = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN';

  switch (id) {
    case 'direct_reflex':
      return {
        formatVersion: 1,
        name: tr('presets.direct_reflex.name'),
        description: tr('presets.direct_reflex.description'),
        inputSchema: { type: 'object' },
        orchestratorPreset: 'direct_reflex',
        policy: BASE_POLICY,
        steps: [
          {
            id: 'intake-trigger',
            dependsOn: [],
            phase: null,
            inputBindings: {},
            kind: 'trigger',
            title: tr('presets.direct_reflex.steps.intakeTrigger'),
            triggerKind: 'platform',
            sourceKind: 'github',
            eventType: 'github.ci.failed',
            evalMode: 'observe',
            temporal: null,
            filter: {
              ...DEFAULT_GATE_FILTER,
              sourceKinds: ['github'],
              eventTypes: ['github.ci.failed'],
              conditions: [{ op: 'not_bot_actor' }],
            },
          },
          {
            id: 'reflex-session',
            dependsOn: ['intake-trigger'],
            phase: null,
            inputBindings: {},
            kind: 'session',
            agentId: defaultAgentId,
            prompt: tr('presets.direct_reflex.steps.reflexPrompt'),
            workspaceIsolation: 'isolated_worktree',
            executorProfileId: null,
            modeOverride: null,
            configOverrides: {},
            outputLanguage,
            outputDescription: null,
            outputSchema: DEFAULT_OUTPUT_SCHEMA,
            completionPolicy: 'automatic',
            subscribeThread: true,
          },
          {
            id: 'reply-pr',
            dependsOn: ['reflex-session'],
            phase: null,
            inputBindings: {},
            kind: 'outbox_action',
            actionKind: 'github_comment',
            title: tr('presets.direct_reflex.steps.replyPrTitle'),
            destination: '{{threadKey}}',
            payloadTemplate: tr('presets.direct_reflex.steps.replyPrPayload'),
          },
        ],
      };

    case 'superagent_router':
      return {
        formatVersion: 1,
        name: tr('presets.superagent_router.name'),
        description: tr('presets.superagent_router.description'),
        inputSchema: { type: 'object' },
        orchestratorPreset: 'superagent_router',
        policy: BASE_POLICY,
        steps: [
          {
            id: 'mention-trigger',
            dependsOn: [],
            phase: null,
            inputBindings: {},
            kind: 'trigger',
            title: tr('presets.superagent_router.steps.mentionTrigger'),
            triggerKind: 'platform',
            sourceKind: 'feishu',
            eventType: 'feishu.im.mention',
            evalMode: 'auto',
            temporal: null,
            filter: {
              ...DEFAULT_GATE_FILTER,
              sourceKinds: ['feishu'],
              eventTypes: ['feishu.im.mention'],
              conditions: [{ op: 'not_bot_actor' }],
            },
          },
          {
            id: 'router-bot',
            dependsOn: ['mention-trigger'],
            phase: null,
            inputBindings: {},
            kind: 'bot',
            memberId: 'sre-router-bot',
            conversationScope: 'fixed_primary',
            mailboxPolicy: 'fifo_serial',
            prompt: tr('presets.superagent_router.steps.routerPrompt'),
            subscribeThread: true,
          },
          {
            id: 'specialist-session',
            dependsOn: ['router-bot'],
            phase: null,
            inputBindings: {
              triage: {
                source: 'step_output',
                step_id: 'router-bot',
                pointer: '',
              },
            },
            kind: 'session',
            agentId: defaultAgentId,
            prompt: tr('presets.superagent_router.steps.specialistPrompt'),
            workspaceIsolation: 'isolated_worktree',
            executorProfileId: null,
            modeOverride: null,
            configOverrides: {},
            outputLanguage,
            outputDescription: null,
            outputSchema: DEFAULT_OUTPUT_SCHEMA,
            completionPolicy: 'automatic',
          },
          {
            id: 'feishu-outbox',
            dependsOn: ['specialist-session'],
            phase: null,
            inputBindings: {},
            kind: 'outbox_action',
            actionKind: 'feishu_reply',
            title: tr('presets.superagent_router.steps.feishuReplyTitle'),
            destination: '{{threadKey}}',
            payloadTemplate: tr(
              'presets.superagent_router.steps.feishuReplyPayload'
            ),
          },
        ],
      };

    case 'hybrid_pipeline':
      return {
        formatVersion: 1,
        name: tr('presets.hybrid_pipeline.name'),
        description: tr('presets.hybrid_pipeline.description'),
        inputSchema: { type: 'object' },
        orchestratorPreset: 'hybrid_pipeline',
        policy: BASE_POLICY,
        steps: [
          {
            id: 'jira-trigger',
            dependsOn: [],
            phase: null,
            inputBindings: {},
            kind: 'trigger',
            title: tr('presets.hybrid_pipeline.steps.jiraTrigger'),
            triggerKind: 'platform',
            sourceKind: 'jira',
            eventType: 'jira.issue.transitioned',
            evalMode: 'observe',
            temporal: null,
            filter: {
              ...DEFAULT_GATE_FILTER,
              sourceKinds: ['jira'],
              eventTypes: ['jira.issue.transitioned'],
              conditions: [
                { op: 'eq', pointer: '/issue/priority', value: 'P0' },
              ],
            },
          },
          {
            id: 'pm-planner-bot',
            dependsOn: ['jira-trigger'],
            phase: null,
            inputBindings: {},
            kind: 'bot',
            memberId: 'pm-lead-bot',
            conversationScope: 'fixed_primary',
            mailboxPolicy: 'fifo_serial',
            prompt: tr('presets.hybrid_pipeline.steps.pmPrompt'),
          },
          {
            id: 'coder-session',
            dependsOn: ['pm-planner-bot'],
            phase: null,
            inputBindings: {},
            kind: 'session',
            agentId: defaultAgentId,
            prompt: tr('presets.hybrid_pipeline.steps.coderPrompt'),
            workspaceIsolation: 'isolated_worktree',
            executorProfileId: null,
            modeOverride: null,
            configOverrides: {},
            outputLanguage,
            outputDescription: null,
            outputSchema: DEFAULT_OUTPUT_SCHEMA,
            completionPolicy: 'automatic',
          },
          {
            id: 'review-loop',
            dependsOn: ['coder-session'],
            phase: null,
            inputBindings: {},
            kind: 'control',
            controlKind: 'bounded_loop',
            title: tr('presets.hybrid_pipeline.steps.reviewLoopTitle'),
            maxIterations: 3,
            loopTargetStepId: 'coder-session',
          },
          {
            id: 'release-approval',
            dependsOn: ['review-loop'],
            phase: null,
            inputBindings: {},
            kind: 'user_gate',
            interactionKind: 'approval',
            title: tr('presets.hybrid_pipeline.steps.releaseGateTitle'),
            bodyTemplate: tr('presets.hybrid_pipeline.steps.releaseGateBody'),
            approverScope: 'maintainer',
            slaTimeoutSeconds: 3600,
          },
          {
            id: 'jira-outbox',
            dependsOn: ['release-approval'],
            phase: null,
            inputBindings: {},
            kind: 'outbox_action',
            actionKind: 'jira_comment',
            title: tr('presets.hybrid_pipeline.steps.jiraOutboxTitle'),
            destination: '{{threadKey}}',
            payloadTemplate: tr(
              'presets.hybrid_pipeline.steps.jiraOutboxPayload'
            ),
          },
        ],
      };

    case 'event_saga':
      return {
        formatVersion: 1,
        name: tr('presets.event_saga.name'),
        description: tr('presets.event_saga.description'),
        inputSchema: { type: 'object' },
        orchestratorPreset: 'event_saga',
        policy: BASE_POLICY,
        steps: [
          {
            id: 'pr-opened-trigger',
            dependsOn: [],
            phase: null,
            inputBindings: {},
            kind: 'trigger',
            title: tr('presets.event_saga.steps.prOpenedTrigger'),
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
          },
          {
            id: 'initial-audit',
            dependsOn: ['pr-opened-trigger'],
            phase: null,
            inputBindings: {},
            kind: 'session',
            agentId: defaultAgentId,
            prompt: tr('presets.event_saga.steps.auditPrompt'),
            workspaceIsolation: 'project_root',
            executorProfileId: null,
            modeOverride: null,
            configOverrides: {},
            outputLanguage,
            outputDescription: null,
            outputSchema: DEFAULT_OUTPUT_SCHEMA,
            completionPolicy: 'automatic',
          },
          {
            id: 'wait-ci-complete',
            dependsOn: ['initial-audit'],
            phase: null,
            inputBindings: {},
            kind: 'control',
            controlKind: 'wait_for_event',
            title: tr('presets.event_saga.steps.waitCiTitle'),
            waitEventType: 'github.ci.completed',
            threadKeyTemplate: '{{threadKey}}',
            timeoutSeconds: 7200,
          },
          {
            id: 'owner-notify',
            dependsOn: ['wait-ci-complete'],
            phase: null,
            inputBindings: {},
            kind: 'user_gate',
            interactionKind: 'notify',
            title: tr('presets.event_saga.steps.ownerNotifyTitle'),
            bodyTemplate: tr('presets.event_saga.steps.ownerNotifyBody'),
            slaTimeoutSeconds: 1800,
          },
        ],
      };

    case 'window_aggregator':
      return {
        formatVersion: 1,
        name: tr('presets.window_aggregator.name'),
        description: tr('presets.window_aggregator.description'),
        inputSchema: { type: 'object' },
        orchestratorPreset: 'window_aggregator',
        policy: BASE_POLICY,
        steps: [
          {
            id: 'digest-schedule',
            dependsOn: [],
            phase: null,
            inputBindings: {},
            kind: 'trigger',
            title: tr('presets.window_aggregator.steps.digestSchedule'),
            triggerKind: 'temporal',
            sourceKind: 'time_cron',
            eventType: 'time.cron.tick',
            evalMode: 'auto',
            temporal: {
              kind: 'cron',
              expression: '0 18 * * 1-5',
              timezone: 'Asia/Shanghai',
              weekdaysOnly: true,
            },
            filter: {
              ...DEFAULT_GATE_FILTER,
              sourceKinds: ['time_cron'],
            },
          },
          {
            id: 'aggregator-bot',
            dependsOn: ['digest-schedule'],
            phase: null,
            inputBindings: {},
            kind: 'bot',
            memberId: 'qa-digest-bot',
            conversationScope: 'fixed_primary',
            mailboxPolicy: 'coalesce_batch',
            prompt: tr('presets.window_aggregator.steps.aggregatorPrompt'),
          },
          {
            id: 'group-sync',
            dependsOn: ['aggregator-bot'],
            phase: null,
            inputBindings: {},
            kind: 'group_stage',
            spaceId: 'release-war-room',
            dispatchMode: {
              type: 'broadcast_log_only',
            },
            prompt: tr('presets.window_aggregator.steps.groupSyncPrompt'),
          },
          {
            id: 'user-digest',
            dependsOn: ['group-sync'],
            phase: null,
            inputBindings: {},
            kind: 'user_gate',
            interactionKind: 'notify',
            title: tr('presets.window_aggregator.steps.userDigestTitle'),
            bodyTemplate: tr('presets.window_aggregator.steps.userDigestBody'),
          },
        ],
      };
  }
}

export function getWorkflowPresetTemplates(
  t?: WorkflowTranslateFn
): readonly WorkflowPresetTemplate[] {
  const tr = getWorkflowTranslator(t);
  return PRESET_IDS.map((id) => ({
    id,
    label: tr(`presets.${id}.label`),
    summary: tr(`presets.${id}.summary`),
    build: (defaultAgentId: string) =>
      buildPresetDefinition(id, defaultAgentId, tr),
  }));
}

export const WORKFLOW_PRESET_TEMPLATES: readonly WorkflowPresetTemplate[] =
  PRESET_IDS.map((id) => ({
    id,
    get label() {
      return getWorkflowTranslator()(`presets.${id}.label`);
    },
    get summary() {
      return getWorkflowTranslator()(`presets.${id}.summary`);
    },
    build: (defaultAgentId: string) =>
      buildPresetDefinition(id, defaultAgentId),
  }));
