import type { WorkflowDefinition } from 'shared/types';

import type {
  StudioWorkflowDefinition,
  StudioWorkflowStep,
} from '@/features/workflow/workflow-studio/types';
import { toBackendWorkflowDefinition } from '@/features/workflow/workflow-studio/workflowStudioCodec';
import type { CollaborationBotOption } from '@/features/workflow/useCollaborationBotRoster';
import type { WorkflowStudioAgentOption } from '@/features/workflow/workflowAgent';
import { projectsApi } from '@/lib/api/projects';
import type { PulseRuleSpec, PulseSourceView } from '@/lib/api/pulse';
import { sessionsApi } from '@/lib/api/sessions';
import type { KanbanSessionPlacement } from '@/lib/kanbanSessionLayout';
import {
  dismissCollaborationCreateOverlays,
  dismissCreateSessionOverlays,
} from '@/lib/requestCreateSession';
import { useLayoutStore } from '@/stores/useLayoutStore';

import dailyRepoDigestJson from '../../../../../examples/workflows/daily-repo-digest.vibex-workflow.json';
import feishuMentionTriageJson from '../../../../../examples/workflows/feishu-mention-triage.vibex-workflow.json';
import githubCiAutofixJson from '../../../../../examples/workflows/github-ci-autofix.vibex-workflow.json';
import prReviewGateJson from '../../../../../examples/workflows/pr-review-gate.vibex-workflow.json';

export interface CanonicalWorkflowStarter {
  id:
    | 'github-ci-autofix'
    | 'feishu-mention-triage'
    | 'daily-repo-digest'
    | 'pr-review-gate';
  examplePath: string;
  sourceKind: 'github' | 'feishu' | 'time_cron';
  titleKey: string;
  summaryKey: string;
  promptZh: string;
  promptEn: string;
  definition: WorkflowDefinition;
}

export const CANONICAL_WORKFLOW_STARTERS: readonly CanonicalWorkflowStarter[] = [
  {
    id: 'github-ci-autofix',
    examplePath: 'examples/workflows/github-ci-autofix.vibex-workflow.json',
    sourceKind: 'github',
    titleKey: 'pulseDeck.workbench.agent.starters.ciAutofixTitle',
    summaryKey: 'pulseDeck.workbench.agent.starters.ciAutofixDesc',
    promptZh:
      '参考 examples/workflows/github-ci-autofix.vibex-workflow.json 创建一个自动化工作流：当 GitHub Actions CI 失败时，拉起隔离分支编码会话排查并提交最小修复补丁，随后在原 PR 下回复结论。',
    promptEn:
      'Create an automation workflow modeled on examples/workflows/github-ci-autofix.vibex-workflow.json: when GitHub Actions CI fails, launch an isolated coding session to diagnose and propose a minimal fix, then comment the summary on the PR.',
    definition: githubCiAutofixJson as unknown as WorkflowDefinition,
  },
  {
    id: 'feishu-mention-triage',
    examplePath: 'examples/workflows/feishu-mention-triage.vibex-workflow.json',
    sourceKind: 'feishu',
    titleKey: 'pulseDeck.workbench.agent.starters.feishuTriageTitle',
    summaryKey: 'pulseDeck.workbench.agent.starters.feishuTriageDesc',
    promptZh:
      '参考 examples/workflows/feishu-mention-triage.vibex-workflow.json 创建一个自动化工作流：当飞书群消息 @提及我时，先由值班 Bot 分诊，再核查代码库并在原飞书话题下回复结论。',
    promptEn:
      'Create an automation workflow modeled on examples/workflows/feishu-mention-triage.vibex-workflow.json: when a Feishu group message @mentions us, triage with our duty Bot, inspect the codebase, and reply in the original Feishu thread.',
    definition: feishuMentionTriageJson as unknown as WorkflowDefinition,
  },
  {
    id: 'daily-repo-digest',
    examplePath: 'examples/workflows/daily-repo-digest.vibex-workflow.json',
    sourceKind: 'time_cron',
    titleKey: 'pulseDeck.workbench.agent.starters.dailyDigestTitle',
    summaryKey: 'pulseDeck.workbench.agent.starters.dailyDigestDesc',
    promptZh:
      '参考 examples/workflows/daily-repo-digest.vibex-workflow.json 创建一个自动化工作流：每个工作日早上 09:30 自动汇总过去 24 小时的代码提交与潜在风险，推送通知给我。',
    promptEn:
      'Create an automation workflow modeled on examples/workflows/daily-repo-digest.vibex-workflow.json: every weekday at 09:30, summarize the past 24h commits and risks and send me a desktop notification.',
    definition: dailyRepoDigestJson as unknown as WorkflowDefinition,
  },
  {
    id: 'pr-review-gate',
    examplePath: 'examples/workflows/pr-review-gate.vibex-workflow.json',
    sourceKind: 'github',
    titleKey: 'pulseDeck.workbench.agent.starters.prReviewGateTitle',
    summaryKey: 'pulseDeck.workbench.agent.starters.prReviewGateDesc',
    promptZh:
      '参考 examples/workflows/pr-review-gate.vibex-workflow.json 创建一个自动化工作流：收到新的 GitHub PR 时，先由审查 Bot 检查风险并运行测试验证，等待我人工批准后再向 PR 发送放行评论。',
    promptEn:
      'Create an automation workflow modeled on examples/workflows/pr-review-gate.vibex-workflow.json: when a GitHub PR opens or updates, run Bot review and isolated verification, pause for my approval, then post the sign-off comment.',
    definition: prReviewGateJson as unknown as WorkflowDefinition,
  },
];

export function buildWorkflowTriggerRuleSpec(input: {
  studio: StudioWorkflowDefinition;
  workflowId: string;
  pinnedVersion?: number | null;
  projectId?: string | null;
  enabled?: boolean;
}): PulseRuleSpec {
  const triggerStep = input.studio.steps.find(
    (step): step is Extract<StudioWorkflowStep, { kind: 'trigger' }> =>
      step.kind === 'trigger'
  );
  const enabled = input.enabled !== false;

  if (triggerStep) {
    const isTemporal =
      triggerStep.triggerKind === 'temporal' && Boolean(triggerStep.temporal);
    const normalizedTemporal =
      isTemporal && triggerStep.temporal
        ? triggerStep.temporal.kind === 'cron'
          ? {
              ...triggerStep.temporal,
              timezone:
                triggerStep.temporal.timezone?.trim() ||
                Intl.DateTimeFormat().resolvedOptions().timeZone ||
                'UTC',
            }
          : triggerStep.temporal
        : null;
    return {
      name: input.studio.name,
      description: input.studio.description ?? null,
      projectId: input.projectId ?? null,
      evalMode: enabled ? 'auto' : 'off',
      filter: {
        sourceKinds: isTemporal
          ? ['time_cron']
          : triggerStep.filter.sourceKinds.length > 0
            ? triggerStep.filter.sourceKinds
            : [triggerStep.sourceKind],
        sourceInstanceIds: triggerStep.filter.sourceInstanceIds ?? [],
        eventTypes: isTemporal
          ? []
          : triggerStep.filter.eventTypes.length > 0
            ? triggerStep.filter.eventTypes
            : triggerStep.eventType
              ? [triggerStep.eventType]
              : [],
        allowedActors: triggerStep.filter.allowedActors ?? [],
        conditions: triggerStep.filter.conditions ?? [],
      },
      temporal: normalizedTemporal,
      targets: [
        {
          kind: 'workflow',
          workflowId: input.workflowId,
          pinnedVersion: input.pinnedVersion ?? 1,
        },
      ],
      taskMeta: {
        taskKind: 'workflow_trigger',
        lifecycleState: 'published',
      },
    };
  }

  return {
    name: input.studio.name,
    description: input.studio.description ?? null,
    projectId: input.projectId ?? null,
    evalMode: enabled ? 'auto' : 'off',
    filter: {
      sourceKinds: ['webhook_standard'],
      sourceInstanceIds: [],
      eventTypes: ['workflow.trigger'],
      allowedActors: [],
      conditions: [],
    },
    targets: [
      {
        kind: 'workflow',
        workflowId: input.workflowId,
        pinnedVersion: input.pinnedVersion ?? 1,
      },
    ],
    taskMeta: {
      taskKind: 'workflow_trigger',
      lifecycleState: 'published',
    },
  };
}

export interface AutomationAgentDispatchInput {
  mode: 'create' | 'edit_workflow' | 'edit_step';
  instruction: string;
  agentId: string;
  projectId?: string | null;
  workspaceId?: string | null;
  definitionId?: string | null;
  sourceRuleId?: string | null;
  targetStepId?: string | null;
  currentDefinition?: StudioWorkflowDefinition | null;
  sources?: readonly PulseSourceView[];
  agentOptions?: readonly WorkflowStudioAgentOption[];
  bots?: readonly CollaborationBotOption[];
}

export interface DispatchedAutomationAgentSession {
  sessionId: string;
  workspaceId: string;
  projectId: string;
  title: string;
}

export function buildAutomationAgentPrompt(
  input: AutomationAgentDispatchInput
): string {
  const activeSources = (input.sources ?? []).filter(
    (src) => !src.id.startsWith('placeholder-')
  );
  const sourcesLine =
    activeSources.length > 0
      ? activeSources
          .map(
            (src) =>
              `${src.title} (id=${src.id}, kind=${src.kind}, enabled=${src.enabled})`
          )
          .join('; ')
      : '尚未连接真实外部事件源（可先按平台类型配置默认 filter）';

  const agentsLine =
    (input.agentOptions ?? []).length > 0
      ? (input.agentOptions ?? [])
          .map((item) => `${item.label} (${item.value})`)
          .join(', ')
      : input.agentId;

  const botsLine =
    (input.bots ?? []).length > 0
      ? (input.bots ?? [])
          .map((bot) => `${bot.displayName} (memberId=${bot.memberId})`)
          .join(', ')
      : 'triage-bot, release-bot, reviewer-bot';

  const lines: string[] = [
    '请使用 `pulse-workflow-author` 与 `pulse-automation-architect` 技能处理以下自动化编排请求。',
    '',
    `## 用户诉求`,
    input.instruction.trim(),
    '',
    `## 当前可用上下文`,
    `- 已连接事件源: ${sourcesLine}`,
    `- 可用编码 Agent: ${agentsLine}`,
    `- 可用持久 Bot: ${botsLine}`,
    `- 标准范例参考: examples/workflows/*.vibex-workflow.json`,
  ];

  if (input.mode !== 'create' && input.currentDefinition) {
    const backendDef = toBackendWorkflowDefinition(input.currentDefinition);
    lines.push(
      '',
      '## 目标工作流上下文',
      `- workflow definitionId: ${input.definitionId ?? '(尚未持久化草稿，首次发布后自动生成)'}`,
      ...(input.sourceRuleId
        ? [`- 关联存量 PulseRule ID: ${input.sourceRuleId}`]
        : []),
      ...(input.targetStepId
        ? [
            `- 用户指定重点修改节点 stepId: ${input.targetStepId}（除非满足诉求必须调整上下游连线，否则保持其余节点稳定）`,
          ]
        : []),
      '```json',
      JSON.stringify(backendDef, null, 2),
      '```'
    );
  }

  lines.push(
    '',
    '## 执行要求',
    '1. 统一以标准 WorkflowDefinition 表达任务（哪怕只有 2~3 个节点），在 `[vibex-studio:v1]` 元数据中填写简洁自然的人类语言标题与一句话摘要，不要把原始 `{{payload.*}}` 暴露在卡片标题中。',
    '2. 调用 `workflow_publish` 发布工作流（修改已有工作流时务必传入原 `definitionId`），并同步调用 `pulse_rule_propose_or_save` 更新 `taskKind: "workflow_trigger"` 触发路由（外部平台事件需保留 `not_bot_actor` 防环条件）。',
    '3. 完成后用两三句话简明告知已创建或更新的自动化链路摘要。'
  );

  return lines.join('\n');
}

export async function dispatchAutomationAgentRequest(
  input: AutomationAgentDispatchInput
): Promise<DispatchedAutomationAgentSession> {
  let resolvedProjectId = input.projectId?.trim() || '';
  if (!resolvedProjectId) {
    const projects = await projectsApi.getAll();
    resolvedProjectId = projects[0]?.id ?? '';
  }
  if (!resolvedProjectId) {
    throw new Error('当前没有可用项目，请先打开或创建一个项目后再由 Agent 编排自动化。');
  }

  const executor = (input.agentId || 'claude-code')
    .trim()
    .toUpperCase()
    .replace(/-/g, '_');
  const titlePrefix =
    input.mode === 'create'
      ? '新建自动化 · '
      : input.targetStepId
        ? `修改节点(${input.targetStepId}) · `
        : '修改自动化 · ';
  const sessionTitle = `${titlePrefix}${input.instruction.trim()}`.slice(0, 60);
  const fullPrompt = buildAutomationAgentPrompt(input);

  const created = await sessionsApi.createProject({
    project_id: resolvedProjectId,
    workspace_id: input.workspaceId ?? null,
    executor,
    name: sessionTitle,
    initial_prompt: fullPrompt,
  });

  return {
    sessionId: created.id,
    workspaceId: created.workspace_id,
    projectId: resolvedProjectId,
    title: sessionTitle,
  };
}

export function extractPulseErrorMessage(
  err: unknown,
  fallback: string
): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  if (typeof err === 'string' && err.trim()) {
    return err;
  }
  if (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { message?: unknown }).message === 'string' &&
    (err as { message: string }).message.trim()
  ) {
    return (err as { message: string }).message;
  }
  return fallback;
}

export function activateAutomationSessionInRightSidebar(
  dispatched: DispatchedAutomationAgentSession,
  activateExecutionSession?: (placement: KanbanSessionPlacement) => void
): void {
  const layout = useLayoutStore.getState();
  layout.setRightPanelVisible(true);
  layout.setKanbanSessionVisible(true);
  dismissCreateSessionOverlays();
  if (dispatched.sessionId && dispatched.workspaceId) {
    activateExecutionSession?.({
      sessionId: dispatched.sessionId,
      workspaceId: dispatched.workspaceId,
    });
  }
}

export function ensureRightSessionSidebarOpen(): void {
  dismissCollaborationCreateOverlays();
  dismissCreateSessionOverlays();
  const layout = useLayoutStore.getState();
  layout.setRightPanelVisible(true);
  layout.setKanbanSessionVisible(true);
}


