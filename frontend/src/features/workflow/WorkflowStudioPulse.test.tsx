import { useState } from 'react';
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import type {
  WorkflowDefinition,
  WorkflowEventRecord,
  WorkflowRunView,
  WorkflowStepView,
} from 'shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CANONICAL_WORKFLOW_STARTERS } from '@/components/kanban/automation/automationAgentBridge';
import { panelComponents } from '@/components/layout/panels/PanelRegistry';
import { WorkspaceTabAddMenu } from '@/components/layout/panels/WorkspaceTabAddMenu';
import { resolveMemberBotAvatar } from '@/features/collaboration/MemberBotAvatar';
import { BUILT_IN_SAMPLE_EVENTS } from '@/features/pulse';
import {
  BackendTransportProvider,
  type BackendTransport,
} from '@/lib/transport';
import { WorkflowInspectorView } from '@/pages/workflows/WorkflowInspector';
import { PANEL_IDS } from '@/stores/useLayoutStore';

import { useGuardedWorkflowRunPolling } from './useGuardedWorkflowRunPolling';
import {
  WORKFLOW_PRESET_TEMPLATES,
  WorkflowStudio,
  toBackendWorkflowDefinition,
  toStudioWorkflowDefinition,
  validateStudioWorkflowExhaustively,
  type StudioWorkflowDefinition,
} from './WorkflowStudio';
import { WorkflowStudioDockPanel } from './WorkflowStudioDockPanel';
import {
  indexWorkflowEventsByStepId,
  layoutNodes,
} from './workflow-studio/workflowGraph';
import { WorkflowStepNode } from './workflow-studio/WorkflowStepNode';

const { openPluginPanel, openOrFocusPanel, runInEditorGroup } = vi.hoisted(
  () => ({
    openPluginPanel: vi.fn(),
    openOrFocusPanel: vi.fn(),
    runInEditorGroup: vi.fn((_groupId: string, action: () => void) => action()),
  })
);

vi.mock('@/components/ConfigProvider', () => ({
  useOptionalUserSystem: () => ({
    config: {
      executor_profile: {
        executor: 'codex',
        variant: null,
      },
    },
  }),
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  usePanelActionsContext: () => ({
    openDiffPreview: vi.fn(),
    openNotes: vi.fn(),
    openOrFocusPanel,
    openTerminalEditorTab: vi.fn(),
    openPluginPanel,
    runInEditorGroup,
  }),
}));

vi.mock('@/hooks/usePluginHostContributions', () => ({
  usePluginHostContributions: () => [],
  contributionMetadata: (item: { metadata?: Record<string, unknown> }) =>
    item.metadata ?? {},
}));

vi.mock('@/features/agents/useSelectableAgents', () => ({
  useSelectableAgents: () => [],
}));

const sevenCategoryWorkflow: StudioWorkflowDefinition = {
  formatVersion: 1,
  name: 'Seven Category Hybrid Graph',
  description: 'Full Dual-Primitive workflow showcase',
  orchestratorPreset: 'hybrid_pipeline',
  inputSchema: { type: 'object' },
  policy: {
    maxConcurrentAgentSteps: 4,
    maxAgentCalls: 12,
    deadlineSeconds: 1800,
    maxOutputBytes: 65536,
  },
  steps: [
    {
      id: 'gh-trigger',
      dependsOn: [],
      phase: null,
      inputBindings: {},
      kind: 'trigger',
      title: 'GitHub CI 失败事件',
      triggerKind: 'platform',
      sourceKind: 'github',
      eventType: 'github.ci.failed',
      evalMode: 'auto',
      temporal: null,
      filter: {
        sourceKinds: ['github'],
        sourceInstanceIds: [],
        eventTypes: ['github.ci.failed'],
        allowedActors: [],
        conditions: [{ op: 'not_bot_actor' }],
      },
    },
    {
      id: 'triage-bot',
      dependsOn: ['gh-trigger'],
      phase: null,
      inputBindings: {},
      kind: 'bot',
      memberId: 'sre-memory-bot',
      conversationScope: 'fixed_primary',
      mailboxPolicy: 'coalesce_batch',
      prompt: '分诊失败任务 {{failedJob}} 并定位责任模块',
    },
    {
      id: 'coder-session',
      dependsOn: ['triage-bot'],
      phase: null,
      inputBindings: {},
      kind: 'session',
      agentId: 'codex',
      prompt: '修复仓库 {{repository}} 中的失败单测 {{failedJob}}',
      workspaceIsolation: 'isolated_worktree',
      executorProfileId: null,
      modeOverride: null,
      configOverrides: {},
      outputLanguage: 'zh-CN',
      outputDescription: null,
      outputSchema: null,
      completionPolicy: 'automatic',
    },
    {
      id: 'council-stage',
      dependsOn: ['coder-session'],
      phase: null,
      inputBindings: {},
      kind: 'group_stage',
      spaceId: 'eng-council',
      dispatchMode: {
        type: 'moderator_triage',
        moderatorMemberId: 'lead-bot',
      },
      rounds: 2,
      prompt: '评审候选补丁 {{threadKey}} 并收敛结论',
    },
    {
      id: 'review-loop',
      dependsOn: ['council-stage'],
      phase: null,
      inputBindings: {},
      kind: 'control',
      controlKind: 'bounded_loop',
      title: '自动评审迭代',
      maxIterations: 4,
      loopTargetStepId: 'coder-session',
    },
    {
      id: 'owner-gate',
      dependsOn: ['review-loop'],
      phase: null,
      inputBindings: {},
      kind: 'user_gate',
      interactionKind: 'approval',
      title: '人工放行确认',
      bodyTemplate: '是否批准合并 {{threadKey}}？',
      slaTimeoutSeconds: 1800,
    },
    {
      id: 'gh-outbox',
      dependsOn: ['owner-gate'],
      phase: null,
      inputBindings: {},
      kind: 'outbox_action',
      actionKind: 'github_comment',
      title: '向原 PR 发表修复摘要',
      destination: '{{threadKey}}',
      payloadTemplate: 'Resolved {{failedJob}} on {{threadKey}}.',
    },
  ],
};

function StatefulStudioHarness({
  initial = sevenCategoryWorkflow,
}: {
  initial?: StudioWorkflowDefinition;
}) {
  const [definition, setDefinition] =
    useState<StudioWorkflowDefinition>(initial);
  return (
    <WorkflowStudio
      studioMode
      definition={definition}
      onDefinitionChange={setDefinition}
      agentOptions={[
        { value: 'codex', label: 'Codex', runnable: true },
        { value: 'claude_code', label: 'Claude Code', runnable: true },
      ]}
      bots={[
        {
          memberId: 'sre-memory-bot',
          displayName: '值班 SRE 助手',
          avatar: resolveMemberBotAvatar({
            identityMemberId: 'sre-memory-bot',
            nickname: '值班 SRE 助手',
          }),
        },
        {
          memberId: 'review-bot',
          displayName: '代码审查 Bot',
          avatar: resolveMemberBotAvatar({
            identityMemberId: 'review-bot',
            nickname: '代码审查 Bot',
          }),
        },
      ]}
      spaces={[
        {
          spaceId: 'eng-council',
          displayName: '研发架构评审群',
        },
      ]}
      capturedEvents={BUILT_IN_SAMPLE_EVENTS}
    />
  );
}

describe('Semantic WorkflowStudio Canvas & Simple 2-Tab Node Side Card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('renders all 7 node categories with human-centric Agent icons, Bot avatars, and zero internal runtime jargon', () => {
    render(<StatefulStudioHarness />);

    // 1. Trigger node shows platform source badge + natural-language headline (no Off|Observe|Auto mode segmented bar)
    const triggerNode = screen.getByTestId('workflow-node-gh-trigger');
    expect(within(triggerNode).getByText('GitHub')).toBeInTheDocument();
    expect(
      within(triggerNode).getByText('GitHub CI 失败事件')
    ).toBeInTheDocument();

    // 2. Bot node shows Bot display name + MemberBotAvatar + clean headline (no "固定会话记忆" / "窗口合并" jargon)
    const botNode = screen.getByTestId('workflow-node-triage-bot');
    expect(within(botNode).getByText('值班 SRE 助手')).toBeInTheDocument();
    expect(
      within(botNode).getByText('分诊失败任务 并定位责任模块')
    ).toBeInTheDocument();
    expect(within(botNode).queryByText('固定会话记忆')).toBeNull();

    // 3. Session node shows Agent brand name ("Codex") + StudioAgentIcon + clean headline (no "临时会话" / "每次运行重置上下文" jargon)
    const sessionNode = screen.getByTestId('workflow-node-coder-session');
    expect(within(sessionNode).getByText('Codex')).toBeInTheDocument();
    expect(
      within(sessionNode).getByText('修复仓库 中的失败单测')
    ).toBeInTheDocument();
    expect(within(sessionNode).queryByText('临时会话')).toBeNull();
    expect(within(sessionNode).queryByText('每次运行重置上下文')).toBeNull();

    // 4. Group Stage node shows human space display name + tabular-nums rounds badge
    const groupNode = screen.getByTestId('workflow-node-council-stage');
    expect(within(groupNode).getByText('研发架构评审群')).toBeInTheDocument();
    expect(within(groupNode).getByText('最多 2 轮')).toHaveClass('tabular-nums');

    // 5. Flow Control BoundedLoop node shows tabular-nums max rounds badge
    const controlNode = screen.getByTestId('workflow-node-review-loop');
    expect(within(controlNode).getByText('循环')).toBeInTheDocument();
    expect(within(controlNode).getByText('最多 4 轮')).toHaveClass(
      'tabular-nums'
    );

    // 6. User Gate node shows human approval badge + title
    const gateNode = screen.getByTestId('workflow-node-owner-gate');
    expect(within(gateNode).getByText('人工审批')).toBeInTheDocument();
    expect(within(gateNode).getByText('人工放行确认')).toBeInTheDocument();

    // 7. Outbox Action node shows channel badge + natural-language summary
    const outboxNode = screen.getByTestId('workflow-node-gh-outbox');
    expect(within(outboxNode).getByText('GitHub 评论')).toBeInTheDocument();
    expect(
      within(outboxNode).getByText('向原 PR 发表修复摘要')
    ).toBeInTheDocument();
  });

  it('supports simple light tweaks in the 2-tab side card (swap Bot, swap Agent, adjust loop max rounds) without exposing JSON/AST editors', () => {
    render(<StatefulStudioHarness />);

    // Swap Bot on triage-bot
    fireEvent.click(screen.getByTestId('workflow-node-deck-triage-bot'));
    expect(screen.queryByTestId('inspector-tier-json')).toBeNull();
    expect(screen.queryByTestId('inspector-tier-advanced')).toBeNull();
    fireEvent.change(screen.getByTestId('inspector-step-bot'), {
      target: { value: 'review-bot' },
    });
    expect(
      within(screen.getByTestId('workflow-node-triage-bot')).getByText(
        '代码审查 Bot'
      )
    ).toBeInTheDocument();

    // Swap Agent on coder-session
    fireEvent.click(screen.getByTestId('workflow-node-deck-coder-session'));
    fireEvent.change(screen.getByTestId('inspector-step-agent'), {
      target: { value: 'claude_code' },
    });
    expect(
      within(screen.getByTestId('workflow-node-coder-session')).getByText(
        'Claude Code'
      )
    ).toBeInTheDocument();

    // Adjust BoundedLoop max rounds
    fireEvent.click(screen.getByTestId('workflow-node-deck-review-loop'));
    fireEvent.change(screen.getByTestId('inspector-loop-max'), {
      target: { value: '5' },
    });
    expect(
      within(screen.getByTestId('workflow-node-review-loop')).getByText(
        '最多 5 轮'
      )
    ).toBeInTheDocument();
  });

  it('validates all 4 canonical example workflows and preset templates cleanly, and reports multiple violations in a single pass', () => {
    for (const starter of CANONICAL_WORKFLOW_STARTERS) {
      const studio = toStudioWorkflowDefinition(starter.definition);
      expect(validateStudioWorkflowExhaustively(studio)).toEqual([]);
      const roundTripped = toStudioWorkflowDefinition(
        toBackendWorkflowDefinition(studio)
      );
      expect(validateStudioWorkflowExhaustively(roundTripped)).toEqual([]);
    }

    for (const preset of WORKFLOW_PRESET_TEMPLATES) {
      const built = preset.build('codex');
      expect(validateStudioWorkflowExhaustively(built)).toEqual([]);
    }

    const brokenWorkflow: StudioWorkflowDefinition = {
      ...sevenCategoryWorkflow,
      name: '',
      steps: [
        {
          id: 'dup-id',
          dependsOn: ['dup-id', 'ghost-step'],
          phase: null,
          inputBindings: {},
          kind: 'control',
          controlKind: 'bounded_loop',
          title: '',
          maxIterations: 0,
        },
        {
          id: 'dup-id',
          dependsOn: [],
          phase: null,
          inputBindings: {},
          kind: 'bot',
          memberId: '',
          conversationScope: 'fixed_primary',
          mailboxPolicy: 'fifo_serial',
          prompt: '',
        },
      ],
    };

    const issues = validateStudioWorkflowExhaustively(brokenWorkflow);
    const codes = issues.map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'empty_workflow_name',
        'self_dependency',
        'unknown_dependency',
        'empty_control_title',
        'invalid_bounded_loop_max_iterations',
        'duplicate_step_id',
        'missing_bot_member_id',
        'empty_bot_prompt',
      ])
    );
  });
});

describe('WorkspaceTabAddMenu Workflow Studio quick entry', () => {
  it('exposes Workflow Studio under Features without hardcoding an official plugin ID', () => {
    const props = {
      api: { setActive: vi.fn() },
      group: {
        id: 'group-editor-1',
        panels: [{ id: 'welcome' }],
      },
      panels: [],
      activePanel: undefined,
      isGroupActive: true,
      headerPosition: 'top',
      containerApi: {},
    } as unknown as IDockviewHeaderActionsProps;

    render(<WorkspaceTabAddMenu {...props} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: '新建标签页' }), {
      button: 0,
      ctrlKey: false,
    });

    const item = screen.getByTestId('workspace-tab-add-workflow-studio');
    expect(item).toBeVisible();
    fireEvent.click(item);

    expect(openOrFocusPanel).toHaveBeenCalledWith(
      PANEL_IDS.WORKFLOW_STUDIO,
      '工作流编排室'
    );
  });
});

describe('Built-in Dockview Panel & WorkflowStudioDockPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('registers PANEL_IDS.WORKFLOW_STUDIO, hydrates workflows, and auto-syncs Pulse trigger rules on Save Changes', async () => {
    expect(PANEL_IDS.WORKFLOW_STUDIO).toBe('workflow-studio');
    expect(panelComponents[PANEL_IDS.WORKFLOW_STUDIO]).toBeDefined();

    const storedBackendDef = toBackendWorkflowDefinition(sevenCategoryWorkflow);
    const callSpy = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        switch (command) {
          case 'workflow_list':
            return [
              {
                id: 'wf-hybrid-1',
                name: 'Seven Category Hybrid Graph',
                latestVersionId: 'wf-ver-10',
                latestVersion: 10n,
                createdAt: '2026-11-15T10:00:00Z',
                updatedAt: '2026-11-15T10:00:00Z',
              },
            ];
          case 'workflow_version':
            return {
              id: 'wf-ver-10',
              definitionId: 'wf-hybrid-1',
              version: 10n,
              normalizedJson: JSON.stringify(storedBackendDef),
              digest: 'sha256:abc123',
              createdAt: '2026-11-15T10:00:00Z',
            };
          case 'pulse_captured_events':
            throw new Error('Pulse daemon offline');
          case 'pulse_sources_list':
            return [];
          case 'workflow_validate':
            return { valid: true, issues: [] };
          case 'workflow_publish': {
            const req = (args?.request ?? {}) as {
              definitionId?: string;
              definition: WorkflowDefinition;
            };
            return {
              id: 'wf-ver-20',
              definitionId: req.definitionId ?? 'wf-hybrid-1',
              version: 20n,
              normalizedJson: JSON.stringify(req.definition),
              digest: 'sha256:def456',
              createdAt: '2026-11-15T10:05:00Z',
            };
          }
          case 'pulse_rule_save':
            return {
              id: 'pulse-rule-1',
              projectId: null,
              enabled: true,
              draftOnly: false,
              mandateOrigin: 'explicit_human',
              matchedCount: 0,
              observedCount: 0,
              spec: (args?.input as { spec: unknown })?.spec,
              createdAt: '2026-11-15T10:05:00Z',
              updatedAt: '2026-11-15T10:05:00Z',
            };
          default:
            return null;
        }
      }
    );

    const mockTransport: BackendTransport = {
      environment: 'desktop',
      call: callSpy,
    };

    render(
      <BackendTransportProvider transport={mockTransport}>
        <WorkflowStudioDockPanel />
      </BackendTransportProvider>
    );

    await waitFor(() => {
      expect(
        screen.getByTestId('workflow-node-gh-trigger')
      ).toBeInTheDocument();
    });
    expect(callSpy).toHaveBeenCalledWith('workflow_list', { limit: 100 });

    // Lightly rename the workflow and click "保存修改" -> validates, publishes, and auto-syncs trigger rule
    const nameInput = screen.getByRole('textbox', {
      name: /名称|Name/i,
    });
    fireEvent.change(nameInput, {
      target: { value: 'Updated Hybrid Automation' },
    });

    fireEvent.click(screen.getByTestId('workflow-toolbar-save-btn'));
    await waitFor(() => {
      expect(callSpy).toHaveBeenCalledWith(
        'workflow_validate',
        expect.objectContaining({
          request: expect.objectContaining({
            definition: expect.objectContaining({
              name: 'Updated Hybrid Automation',
            }),
          }),
        })
      );
      expect(callSpy).toHaveBeenCalledWith(
        'workflow_publish',
        expect.objectContaining({
          request: expect.objectContaining({
            definitionId: 'wf-hybrid-1',
            definition: expect.objectContaining({
              name: 'Updated Hybrid Automation',
            }),
          }),
        })
      );
      expect(callSpy).toHaveBeenCalledWith(
        'pulse_rule_save',
        expect.objectContaining({
          input: expect.objectContaining({
            enabled: true,
            spec: expect.objectContaining({
              targets: [
                expect.objectContaining({
                  kind: 'workflow',
                  workflowId: 'wf-hybrid-1',
                  pinnedVersion: 20,
                }),
              ],
            }),
          }),
        })
      );
    });
  });

  it('consumes pending/live vibex:open-workflow-studio handoff events (including initialDefinition) and supports embedded mode', async () => {
    const firstBackend = toBackendWorkflowDefinition(
      WORKFLOW_PRESET_TEMPLATES[0].build('codex')
    );
    const secondBackend = toBackendWorkflowDefinition(sevenCategoryWorkflow);
    const callSpy = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === 'workflow_list') {
          return [
            {
              id: 'wf-first',
              name: 'First Workflow',
              latestVersionId: 'ver-first',
              latestVersion: 10n,
              createdAt: '2026-11-15T10:00:00Z',
              updatedAt: '2026-11-15T10:00:00Z',
            },
            {
              id: 'wf-second',
              name: 'Seven Category Hybrid Graph',
              latestVersionId: 'ver-second',
              latestVersion: 20n,
              createdAt: '2026-11-15T10:05:00Z',
              updatedAt: '2026-11-15T10:05:00Z',
            },
          ];
        }
        if (command === 'workflow_version') {
          const versionId = (args as { versionId?: string })?.versionId;
          return {
            id: versionId,
            definitionId: versionId === 'ver-second' ? 'wf-second' : 'wf-first',
            version: versionId === 'ver-second' ? 20n : 10n,
            normalizedJson: JSON.stringify(
              versionId === 'ver-second' ? secondBackend : firstBackend
            ),
            digest: 'sha256:handoff',
            createdAt: '2026-11-15T10:05:00Z',
          };
        }
        if (command === 'pulse_captured_events') return [];
        if (command === 'pulse_sources_list') return [];
        return null;
      }
    );

    const win = window as unknown as {
      __VIBEX_PENDING_WORKFLOW_STUDIO_OPEN__?: {
        definitionId?: string | null;
        presetId?: string | null;
        initialDefinition?: StudioWorkflowDefinition | null;
        sourceRuleId?: string | null;
      } | null;
    };
    win.__VIBEX_PENDING_WORKFLOW_STUDIO_OPEN__ = {
      definitionId: 'Seven Category Hybrid Graph',
    };

    const pulseDeckEvents: CustomEvent[] = [];
    const onPulseDeck = (event: Event) =>
      pulseDeckEvents.push(event as CustomEvent);
    window.addEventListener('vibex:open-pulse-deck', onPulseDeck);

    try {
      const { rerender } = render(
        <BackendTransportProvider
          transport={{ environment: 'desktop', call: callSpy }}
        >
          <WorkflowStudioDockPanel />
        </BackendTransportProvider>
      );

      await waitFor(() => {
        expect(
          screen.getByTestId('workflow-node-council-stage')
        ).toBeInTheDocument();
      });
      const selector = screen.getByRole('combobox', {
        name: /选择工作流|Select workflow/i,
      }) as HTMLSelectElement;
      expect(selector.value).toBe('wf-second');
      expect(win.__VIBEX_PENDING_WORKFLOW_STUDIO_OPEN__).toBeNull();

      // Quick return shortcut dispatches vibex:open-pulse-deck
      fireEvent.click(screen.getByTestId('workflow-studio-open-pulse-deck'));
      expect(pulseDeckEvents).toHaveLength(1);

      // Embedded mode hides standalone header selector bar
      rerender(
        <BackendTransportProvider
          transport={{ environment: 'desktop', call: callSpy }}
        >
          <WorkflowStudioDockPanel embedded />
        </BackendTransportProvider>
      );
      expect(
        screen.queryByTestId('workflow-studio-open-pulse-deck')
      ).toBeNull();
    } finally {
      window.removeEventListener('vibex:open-pulse-deck', onPulseDeck);
      win.__VIBEX_PENDING_WORKFLOW_STUDIO_OPEN__ = null;
    }
  });
});

describe('Lossless Persistence & Non-Lossy Studio Editing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('preserves all 7 node categories, Condition.expression, Outbox.actionKind, titles, and scratch workspaceIsolation across round-trips and light edits', () => {
    const fullShowcaseWorkflow: StudioWorkflowDefinition = {
      ...sevenCategoryWorkflow,
      steps: [
        sevenCategoryWorkflow.steps[0],
        sevenCategoryWorkflow.steps[1],
        {
          ...(sevenCategoryWorkflow.steps[2] as Extract<
            StudioWorkflowDefinition['steps'][number],
            { kind: 'session' }
          >),
          workspaceIsolation: 'scratch',
        },
        sevenCategoryWorkflow.steps[3],
        {
          id: 'severity-branch',
          dependsOn: ['council-stage'],
          phase: 'routing',
          inputBindings: {},
          kind: 'control',
          controlKind: 'condition',
          title: 'Check P0 Severity',
          expression: 'event.payload.priority == "P0" && !actor.isBot',
          filter: {
            sourceKinds: ['github'],
            sourceInstanceIds: [],
            eventTypes: ['github.ci.failed'],
            allowedActors: [],
            conditions: [{ op: 'eq', pointer: '/priority', value: 'P0' }],
          },
        },
        {
          ...(sevenCategoryWorkflow.steps[4] as Extract<
            StudioWorkflowDefinition['steps'][number],
            { kind: 'control' }
          >),
          dependsOn: ['severity-branch'],
        },
        sevenCategoryWorkflow.steps[5],
        {
          id: 'feishu-outbox',
          dependsOn: ['owner-gate'],
          phase: null,
          inputBindings: {},
          kind: 'outbox_action',
          actionKind: 'feishu_reply',
          title: 'Reply in Feishu Thread',
          destination: '{{threadKey}}',
          payloadTemplate: 'Feishu summary for {{failedJob}}',
        },
        sevenCategoryWorkflow.steps[6],
      ],
    };

    const roundTripped = toStudioWorkflowDefinition(
      toBackendWorkflowDefinition(fullShowcaseWorkflow)
    );
    expect(roundTripped.name).toBe(fullShowcaseWorkflow.name);
    expect(roundTripped.orchestratorPreset).toBe('hybrid_pipeline');

    let latestState = roundTripped;
    function EditorSimulationHarness() {
      const [state, setState] = useState(roundTripped);
      latestState = state;
      return (
        <WorkflowStudio
          studioMode
          definition={state}
          onDefinitionChange={setState}
          dirty
          onSave={vi.fn()}
        />
      );
    }

    render(<EditorSimulationHarness />);

    fireEvent.click(screen.getByTestId('workflow-node-deck-severity-branch'));
    fireEvent.change(screen.getByTestId('inspector-control-title'), {
      target: { value: 'High Confidence Gate' },
    });

    expect(latestState.steps[0].kind).toBe('trigger');
    const sessionStep = latestState.steps[2];
    expect(
      sessionStep.kind === 'session' ? sessionStep.workspaceIsolation : null
    ).toBe('scratch');
    const condStep = latestState.steps[4];
    expect(condStep.kind === 'control' ? condStep.expression : null).toBe(
      'event.payload.priority == "P0" && !actor.isBot'
    );
    expect(condStep.kind === 'control' ? condStep.title : null).toBe(
      'High Confidence Gate'
    );
    const feishuOutbox = latestState.steps[7];
    expect(
      feishuOutbox.kind === 'outbox_action' ? feishuOutbox.actionKind : null
    ).toBe('feishu_reply');
    expect(validateStudioWorkflowExhaustively(latestState)).toEqual([]);
  });
});

describe('Validation Gate, WorkflowInspector Dual-Primitive Upgrade & Keyboard Accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('disables Save Changes with tabular-nums issue badge and accessible tooltip when validationIssues.length > 0', () => {
    const onSave = vi.fn();
    const invalidWorkflow: StudioWorkflowDefinition = {
      ...sevenCategoryWorkflow,
      steps: sevenCategoryWorkflow.steps.map((step) =>
        step.id === 'review-loop' && step.kind === 'control'
          ? { ...step, maxIterations: 99 }
          : step
      ),
    };

    const { rerender } = render(
      <WorkflowStudio
        studioMode
        definition={invalidWorkflow}
        onDefinitionChange={vi.fn()}
        dirty
        onSave={onSave}
      />
    );

    const badge = screen.getByTestId('workflow-toolbar-validation-badge');
    expect(badge).toHaveClass('tabular-nums');
    const saveBtn = screen.getByTestId('workflow-toolbar-save-btn');
    expect(saveBtn).toBeDisabled();

    rerender(
      <WorkflowStudio
        studioMode
        definition={sevenCategoryWorkflow}
        onDefinitionChange={vi.fn()}
        dirty
        onSave={onSave}
      />
    );
    expect(
      screen.queryByTestId('workflow-toolbar-validation-badge')
    ).toBeNull();
    expect(screen.getByTestId('workflow-toolbar-save-btn')).not.toBeDisabled();
  });

  it('renders Dual-Primitive step badges and quick Approve/Reject + note + custom JSON decision in WorkflowInspectorView', async () => {
    const onDecideApproval = vi.fn().mockResolvedValue(undefined);
    const dualPrimitiveDef: WorkflowDefinition = {
      formatVersion: 1,
      name: 'Inspector Showcase',
      description: null,
      inputSchema: { type: 'object' },
      policy: {
        maxConcurrentAgentSteps: 2,
        maxAgentCalls: 8,
        deadlineSeconds: 600,
        maxOutputBytes: 32768,
      },
      steps: [
        {
          id: 's-session',
          dependsOn: [],
          phase: null,
          inputBindings: {},
          kind: 'session',
          agentId: 'codex',
          promptTemplate: 'Run patch',
          workspaceAccess: 'write_isolated',
          modelOverride: null,
          subscribeThread: false,
          completion: 'automatic',
          outputSchema: null,
        },
        {
          id: 's-bot',
          dependsOn: ['s-session'],
          phase: null,
          inputBindings: {},
          kind: 'bot',
          memberId: 'sre-bot',
          conversationScope: 'fixed_primary',
          mailboxPolicy: 'fifo_serial',
          promptTemplate: 'Log triage',
          completion: 'automatic',
          outputSchema: null,
        },
        {
          id: 's-group',
          dependsOn: ['s-bot'],
          phase: null,
          inputBindings: {},
          kind: 'group_stage',
          spaceId: 'council',
          dispatchMode: { type: 'broadcast_log_only' },
          messageTemplate: 'Broadcast',
          quorumCount: null,
        },
        {
          id: 's-cond',
          dependsOn: ['s-group'],
          phase: null,
          inputBindings: {},
          kind: 'condition_branch',
          filter: {
            sourceKinds: [],
            sourceInstanceIds: [],
            eventTypes: [],
            allowedActors: [],
            conditions: [],
          },
          thenStepIds: ['s-loop'],
          elseStepIds: [],
        },
        {
          id: 's-loop',
          dependsOn: ['s-cond'],
          phase: null,
          inputBindings: {},
          kind: 'bounded_loop',
          targetStepIds: ['s-session'],
          maxIterations: 3,
          untilCondition: null,
        },
        {
          id: 's-wait',
          dependsOn: ['s-loop'],
          phase: null,
          inputBindings: {},
          kind: 'wait_for_event',
          eventTypes: ['github.ci.completed'],
          threadKeyPointer: '/threadKey',
          filter: null,
          timeoutSeconds: 300,
        },
        {
          id: 's-gate',
          dependsOn: ['s-wait'],
          phase: null,
          inputBindings: {},
          kind: 'user_gate',
          interactionKind: 'approval',
          titleTemplate: 'Approve Prod Deploy',
          bodyTemplate: 'Ship to prod?',
          approvalOptions: [],
          formSchema: null,
          slaTimeoutSeconds: 600,
        },
        {
          id: 's-outbox',
          dependsOn: ['s-gate'],
          phase: null,
          inputBindings: {},
          kind: 'outbox_action',
          actionKind: 'reply_channel',
          targetTemplate: '{{threadKey}}',
          payloadTemplate: 'Shipped',
        },
      ],
    };

    const run: WorkflowRunView = {
      id: 'run-dual-01',
      definitionVersionId: 'ver-01',
      workspaceId: 'ws-01',
      status: 'waiting_approval',
      controlState: 'active',
      pauseReason: null,
      pausedAt: null,
      parentRunId: null,
      forkStepId: null,
      runMode: 'normal',
      inputJson: '{}',
      policyJson: '{}',
      deadlineAt: '2026-11-15T12:00:00Z',
      agentCallsStarted: 1n,
      lastSequence: 2n,
      createdAt: '2026-11-15T10:00:00Z',
      updatedAt: '2026-11-15T10:01:00Z',
    };

    const steps: WorkflowStepView[] = [
      {
        id: 'step-view-gate',
        runId: 'run-dual-01',
        stepId: 's-gate',
        attempt: 1n,
        status: 'waiting_approval',
        conversationId: null,
        turnId: null,
        outputJson: null,
        outputSchemaDigest: null,
        candidateOutputJson: null,
        candidateSchemaDigest: null,
        awaitingAcceptance: false,
        awaitingInput: false,
        executionMode: 'normal',
        resolvedInputJson: null,
        resolvedInputDigest: null,
        executionEvidenceJson: null,
        workspaceId: 'ws-01',
        waitingInteraction: true,
        repairCount: 0n,
        claimToken: null,
        claimDeadline: null,
        startedAt: '2026-11-15T10:00:30Z',
        completedAt: null,
        updatedAt: '2026-11-15T10:01:00Z',
      },
    ];

    render(
      <WorkflowInspectorView
        run={run}
        version={{
          id: 'ver-01',
          definitionId: 'def-01',
          version: 10n,
          digest: 'sha256:01',
          normalizedJson: JSON.stringify(dualPrimitiveDef),
          sourcePath: null,
          createdAt: '2026-11-15T10:00:00Z',
        }}
        definition={dualPrimitiveDef}
        steps={steps}
        events={[]}
        onPauseRun={vi.fn()}
        onResumeRun={vi.fn()}
        onTestNode={vi.fn()}
        onRerunFromNode={vi.fn()}
        onAcceptCandidate={vi.fn()}
        onPauseStep={vi.fn()}
        onSubmitStepInput={vi.fn()}
        onDecideApproval={onDecideApproval}
        onReview={vi.fn()}
      />
    );

    const badgeBar = screen.getByTestId('workflow-inspector-step-badges');
    for (const kind of [
      'session',
      'bot',
      'group_stage',
      'condition_branch',
      'bounded_loop',
      'wait_for_event',
      'user_gate',
      'outbox_action',
    ]) {
      expect(
        badgeBar.querySelector(`[data-step-kind="${kind}"]`)
      ).toBeInTheDocument();
    }

    const banner = screen.getByTestId('waiting-approval-banner-s-gate');
    const noteInput = within(banner).getByRole('textbox', {
      name: /审批备注|Approval note/i,
    });
    fireEvent.change(noteInput, { target: { value: 'LGTM ship it' } });
    fireEvent.click(
      within(banner).getByRole('button', { name: /批准|Approve/i })
    );

    await waitFor(() => {
      expect(onDecideApproval).toHaveBeenCalledWith('s-gate', {
        approved: true,
        optionId: 'approve',
        note: 'LGTM ship it',
      });
    });
  });

  it('supports ArrowLeft/ArrowRight keyboard navigation in the 2-tab side card tablist without !h-7', () => {
    render(<StatefulStudioHarness />);

    fireEvent.click(screen.getByTestId('workflow-node-deck-coder-session'));

    const infoTab = screen.getByTestId('inspector-tab-info');
    expect(infoTab.className).not.toContain('!h-7');
    expect(infoTab).toHaveClass('h-7');
    expect(infoTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(infoTab, { key: 'ArrowRight' });
    const convTab = screen.getByTestId('inspector-tab-conversation');
    expect(convTab).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(convTab);

    fireEvent.keyDown(convTab, { key: 'ArrowLeft' });
    expect(screen.getByTestId('inspector-tab-info')).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });
});

describe('Guarded Run Polling & ReactFlow O(N) Event Indexing + React.memo', () => {
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  it('guards 1500ms run polling against overlapping inFlight requests and pauses while hidden', async () => {
    vi.useFakeTimers();
    let resolveFirst!: () => void;
    const refresh = vi
      .fn<(runId: string) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValue(undefined);

    renderHook(() =>
      useGuardedWorkflowRunPolling({
        runId: 'run-live-1',
        status: 'running',
        refresh,
      })
    );

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(refresh).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    await act(async () => {
      vi.advanceTimersByTime(4500);
    });
    expect(refresh).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('wraps WorkflowStepNode in React.memo and pre-indexes events by stepId once per graph layout', () => {
    expect(
      (WorkflowStepNode as unknown as { $$typeof?: symbol }).$$typeof
    ).toBe(Symbol.for('react.memo'));

    const mkEv = (
      id: string,
      sequence: bigint,
      eventKind: string,
      step_id: string,
      createdAt: string
    ): WorkflowEventRecord => ({
      id,
      runId: 'run-1',
      sequence,
      eventVersion: 1n,
      eventKind,
      payloadJson: JSON.stringify({ step_id }),
      operationId: null,
      createdAt,
    });
    const events: WorkflowEventRecord[] = [
      mkEv('ev-2', 5n, 'step_completed', 'triage-bot', '2026-11-15T10:00:05Z'),
      mkEv('ev-1', 2n, 'step_started', 'triage-bot', '2026-11-15T10:00:01Z'),
      mkEv('ev-3', 8n, 'step_started', 'coder-session', '2026-11-15T10:00:08Z'),
    ];

    const indexed = indexWorkflowEventsByStepId(events);
    expect(indexed.get('triage-bot')?.map((e) => e.id)).toEqual(['ev-1', 'ev-2']);
    expect(indexed.get('coder-session')?.map((e) => e.id)).toEqual(['ev-3']);

    const nodes = layoutNodes(
      sevenCategoryWorkflow,
      new Map(),
      null,
      'edit',
      vi.fn(),
      indexed,
      [],
      null,
      vi.fn()
    );

    const botNode = nodes.find((n) => n.id === 'triage-bot');
    const sessionNode = nodes.find((n) => n.id === 'coder-session');
    const triggerNode = nodes.find((n) => n.id === 'gh-trigger');
    const gateNode = nodes.find((n) => n.id === 'owner-gate');

    expect(botNode?.data.events.map((e) => e.id)).toEqual(['ev-1', 'ev-2']);
    expect(sessionNode?.data.events.map((e) => e.id)).toEqual(['ev-3']);
    expect(triggerNode?.data.events).toHaveLength(0);
    expect(triggerNode?.data.events).toBe(gateNode?.data.events);
  });
});
