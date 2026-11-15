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

import { panelComponents } from '@/components/layout/panels/PanelRegistry';
import { WorkspaceTabAddMenu } from '@/components/layout/panels/WorkspaceTabAddMenu';
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

const {
  openPluginPanel,
  openOrFocusPanel,
  runInEditorGroup,
} = vi.hoisted(() => ({
  openPluginPanel: vi.fn(),
  openOrFocusPanel: vi.fn(),
  runInEditorGroup: vi.fn((_groupId: string, action: () => void) => action()),
}));

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
      title: 'GitHub CI Trigger',
      triggerKind: 'platform',
      sourceKind: 'github',
      eventType: 'github.ci.failed',
      evalMode: 'observe',
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
      prompt: 'Triage {{failedJob}} on {{threadKey}}',
    },
    {
      id: 'coder-session',
      dependsOn: ['triage-bot'],
      phase: null,
      inputBindings: {},
      kind: 'session',
      agentId: 'codex',
      prompt: 'Fix {{failedJob}} in {{repository}}',
      workspaceIsolation: 'isolated_worktree',
      executorProfileId: null,
      modeOverride: null,
      configOverrides: {},
      outputLanguage: 'en',
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
      prompt: 'Review candidate patch for {{threadKey}}',
    },
    {
      id: 'review-loop',
      dependsOn: ['council-stage'],
      phase: null,
      inputBindings: {},
      kind: 'control',
      controlKind: 'bounded_loop',
      title: 'Review Bounded Loop',
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
      title: 'Merge Approval',
      bodyTemplate: 'Approve {{threadKey}} after {{failedJob}} fix?',
      slaTimeoutSeconds: 1800,
    },
    {
      id: 'gh-outbox',
      dependsOn: ['owner-gate'],
      phase: null,
      inputBindings: {},
      kind: 'outbox_action',
      actionKind: 'github_comment',
      title: 'Comment on PR',
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
      definition={definition}
      onDefinitionChange={setDefinition}
      capturedEvents={BUILT_IN_SAMPLE_EVENTS}
    />
  );
}

describe('Dual-Primitive WorkflowStudio & 3-Tier Inspector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('renders all 7 Dual-Primitive node categories with distinct memory, mailbox, SLA, and BoundedLoop badges', () => {
    render(<StatefulStudioHarness />);

    // 1. Trigger with inline Off | Observe | Auto pill
    const triggerNode = screen.getByTestId('workflow-node-gh-trigger');
    expect(within(triggerNode).getByText('触发器')).toBeInTheDocument();
    expect(within(triggerNode).getByText('平台事件')).toBeInTheDocument();
    const inlineModeGroup = within(triggerNode).getByRole('group', {
      name: /触发器 gh-trigger 评估模式|Trigger gh-trigger evaluation mode/i,
    });
    const autoBtn = within(inlineModeGroup).getByRole('button', {
      name: /^Auto$|^自动$/i,
    });
    fireEvent.click(autoBtn);
    expect(autoBtn).toHaveAttribute('aria-pressed', 'true');

    // 2. Persistent Bot node
    const botNode = screen.getByTestId('workflow-node-triage-bot');
    expect(within(botNode).getByText('Bot 助手')).toBeInTheDocument();
    expect(within(botNode).getByText('固定会话记忆')).toBeInTheDocument();
    expect(within(botNode).getByText('窗口合并')).toBeInTheDocument();

    // 3. Ephemeral Session node
    const sessionNode = screen.getByTestId('workflow-node-coder-session');
    expect(within(sessionNode).getByText('临时会话')).toBeInTheDocument();
    expect(
      within(sessionNode).getByText('每次运行重置上下文')
    ).toBeInTheDocument();
    expect(within(sessionNode).getByText('独立 Worktree')).toBeInTheDocument();

    // 4. Group Stage node
    const groupNode = screen.getByTestId('workflow-node-council-stage');
    expect(within(groupNode).getByText('群组协作')).toBeInTheDocument();
    expect(
      within(groupNode).getByText(/主持人分诊 · lead-bot/)
    ).toBeInTheDocument();

    // 5. Flow Control BoundedLoop node with tabular-nums badge
    const controlNode = screen.getByTestId('workflow-node-review-loop');
    expect(within(controlNode).getByText('循环')).toBeInTheDocument();
    const loopBadge = within(controlNode).getByText('最多 4 轮');
    expect(loopBadge).toHaveClass('tabular-nums');

    // 6. User Gate node with tabular-nums SLA badge
    const gateNode = screen.getByTestId('workflow-node-owner-gate');
    expect(within(gateNode).getByText('人工门控')).toBeInTheDocument();
    expect(within(gateNode).getByText('人工审批')).toBeInTheDocument();
    expect(within(gateNode).getByText('SLA 1800s')).toHaveClass('tabular-nums');

    // 7. Outbox Action node
    const outboxNode = screen.getByTestId('workflow-node-gh-outbox');
    expect(within(outboxNode).getByText('回写动作')).toBeInTheDocument();
    expect(within(outboxNode).getByText('GitHub 评论')).toBeInTheDocument();
  });

  it('switches execution primitive between Fresh Session and Persistent Bot in the Visual inspector', () => {
    render(<StatefulStudioHarness />);

    fireEvent.click(
      within(screen.getByTestId('workflow-node-coder-session')).getByRole(
        'button',
        { name: /coder-session/i }
      )
    );

    // Switch Ephemeral Session -> Persistent Bot
    fireEvent.click(screen.getByTestId('inspector-primitive-bot'));
    expect(
      within(screen.getByTestId('workflow-node-coder-session')).getByText(
        'Bot 助手'
      )
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('workflow-node-coder-session')).getByText(
        '固定会话记忆'
      )
    ).toBeInTheDocument();

    // Switch Persistent Bot -> Ephemeral Session
    fireEvent.click(screen.getByTestId('inspector-primitive-session'));
    expect(
      within(screen.getByTestId('workflow-node-coder-session')).getByText(
        '临时会话'
      )
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('workflow-node-coder-session')).getByText(
        '每次运行重置上下文'
      )
    ).toBeInTheDocument();
  });

  it('supports 3-Tier Visual | Advanced | JSON inspection and reports exhaustive BoundedLoop & workflow violations', () => {
    render(<StatefulStudioHarness />);

    // Select BoundedLoop control node
    fireEvent.click(
      within(screen.getByTestId('workflow-node-review-loop')).getByRole(
        'button',
        { name: /review-loop/i }
      )
    );

    const maxInput = screen.getByTestId('inspector-bounded-loop-max-iterations');
    fireEvent.change(maxInput, { target: { value: '75' } });
    expect(screen.getByTestId('inspector-bounded-loop-error')).toBeVisible();

    // Switch to Advanced tier
    fireEvent.click(screen.getByTestId('inspector-tier-advanced'));
    expect(screen.getByTestId('inspector-advanced-panel')).toBeVisible();

    // Switch to JSON tier: verify live exhaustive validation flags 75 (> 50)
    fireEvent.click(screen.getByTestId('inspector-tier-json'));
    expect(screen.getByTestId('inspector-json-panel')).toBeVisible();
    expect(
      within(screen.getByTestId('inspector-json-issues-list')).getByText(
        /1 <= maxIterations <= 50/
      )
    ).toBeVisible();

    // Co-edit JSON back to valid maxIterations: 5 and apply
    const jsonEditor = screen.getByTestId(
      'inspector-json-editor'
    ) as HTMLTextAreaElement;
    const updatedJson = jsonEditor.value.replace(
      '"maxIterations": 75',
      '"maxIterations": 5'
    );
    fireEvent.change(jsonEditor, { target: { value: updatedJson } });
    fireEvent.click(screen.getByTestId('inspector-json-apply'));

    expect(
      within(screen.getByTestId('workflow-node-review-loop')).getByText(
        '最多 5 轮'
      )
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('inspector-json-validation')).getByText(
        '0 项问题'
      )
    ).toBeVisible();
  });

  it('validates multiple workflow errors exhaustively in a single pass without fail-fast', () => {
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

  it('instantiates all 5 Preset Orchestrator templates cleanly and replays captured events', () => {
    render(<StatefulStudioHarness />);

    for (const preset of WORKFLOW_PRESET_TEMPLATES) {
      const built = preset.build('codex');
      expect(validateStudioWorkflowExhaustively(built)).toEqual([]);
    }

    // Open Replay Event popover and select GitHub CI failure sample
    fireEvent.click(screen.getByTestId('workflow-replay-trigger'));
    const ghSample = BUILT_IN_SAMPLE_EVENTS[2];
    fireEvent.click(
      screen.getByTestId(`workflow-replay-sample-${ghSample.eventId}`)
    );

    expect(
      within(screen.getByTestId('workflow-trigger-replay-gh-trigger')).getByText(
        '命中'
      )
    ).toBeVisible();
    expect(
      within(
        screen.getByTestId('workflow-replay-preview-coder-session')
      ).getByText('Fix cargo-test-workspace in vibex/core')
    ).toBeVisible();
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

describe('Track R3: Built-in Dockview Panel & WorkflowStudioDockPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('registers PANEL_IDS.WORKFLOW_STUDIO in PanelRegistry and loads/saves workflows + Pulse trigger rules with offline event fallback', async () => {
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
          case 'workflow_validate':
            return { valid: true, issues: [] };
          case 'workflow_publish': {
            const req = (args?.request ?? {}) as {
              definitionId?: string;
              definition: WorkflowDefinition;
            };
            return {
              id: 'wf-ver-20',
              definitionId: req.definitionId ?? 'wf-new-1',
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

    // Hydrates saved workflow via workflow_list + workflow_version and falls back gracefully to BUILT_IN_SAMPLE_EVENTS
    await waitFor(() => {
      expect(
        screen.getByTestId('workflow-node-gh-trigger')
      ).toBeInTheDocument();
    });
    expect(callSpy).toHaveBeenCalledWith('workflow_list', { limit: 100 });
    expect(callSpy).toHaveBeenCalledWith('pulse_captured_events', {
      limit: 25,
    });
    expect(
      screen.getByTitle(/离线模式|Offline/i)
    ).toHaveTextContent(String(BUILT_IN_SAMPLE_EVENTS.length));

    // Clicking "Save Trigger Rule" syncs the Trigger step to pulseApi.saveRule
    fireEvent.click(
      screen.getByRole('button', { name: /保存触发器规则|Save Trigger Rule/i })
    );
    await waitFor(() => {
      expect(callSpy).toHaveBeenCalledWith(
        'pulse_rule_save',
        expect.objectContaining({
          input: expect.objectContaining({
            enabled: true,
            spec: expect.objectContaining({
              name: 'GitHub CI Trigger',
              targets: [
                expect.objectContaining({
                  kind: 'workflow',
                  workflowId: 'wf-hybrid-1',
                  pinnedVersion: 10,
                }),
              ],
            }),
          }),
        })
      );
    });

    // Clicking "New Workflow" resets to a clean draft, and Sync Trigger Rule + Save publishes both workflow and trigger rule
    fireEvent.click(
      screen.getByRole('button', { name: /新建工作流|New Workflow/i })
    );
    const workflowSelector = screen.getByRole('combobox', {
      name: /选择工作流|Select workflow/i,
    }) as HTMLSelectElement;
    expect(workflowSelector.value).toBe('__draft__');

    // Make an edit and check "Sync Trigger Rule", then Save
    const syncCheckbox = screen.getByRole('checkbox', {
      name: /同步触发器规则|Sync Trigger Rule/i,
    });
    fireEvent.click(syncCheckbox);

    fireEvent.click(screen.getByRole('button', { name: '发布' }));
    await waitFor(() => {
      expect(callSpy).toHaveBeenCalledWith(
        'workflow_validate',
        expect.objectContaining({
          request: expect.objectContaining({
            definition: expect.objectContaining({ name: '新建工作流' }),
          }),
        })
      );
      expect(callSpy).toHaveBeenCalledWith(
        'workflow_publish',
        expect.objectContaining({
          request: expect.objectContaining({
            definition: expect.objectContaining({ name: '新建工作流' }),
          }),
        })
      );
    });
  });

  it('consumes pending/live vibex:open-workflow-studio handoff events and dispatches vibex:open-pulse-deck on shortcut click', async () => {
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
        return null;
      }
    );

    const win = window as unknown as {
      __VIBEX_PENDING_WORKFLOW_STUDIO_OPEN__?: {
        definitionId?: string | null;
        presetId?: string | null;
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
      render(
        <BackendTransportProvider
          transport={{ environment: 'desktop', call: callSpy }}
        >
          <WorkflowStudioDockPanel />
        </BackendTransportProvider>
      );

      // 1. Consumes pending open by workflow name (skipping wf-first) and clears global slot
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

      // 2. Live vibex:open-workflow-studio with presetId applies preset template cleanly
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('vibex:open-workflow-studio', {
            detail: { presetId: 'event_saga' },
          })
        );
      });
      expect(selector.value).toBe('__draft__');
      expect(
        screen.getByTestId('workflow-node-wait-ci-complete')
      ).toBeInTheDocument();

      // 3. Live vibex:open-workflow-studio with definitionId selects and loads wf-first
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('vibex:open-workflow-studio', {
            detail: { definitionId: 'wf-first' },
          })
        );
      });
      await waitFor(() => {
        expect(selector.value).toBe('wf-first');
      });

      // 4. Quick return shortcut dispatches vibex:open-pulse-deck
      fireEvent.click(screen.getByTestId('workflow-studio-open-pulse-deck'));
      expect(pulseDeckEvents).toHaveLength(1);
      expect(pulseDeckEvents[0].bubbles).toBe(true);
      expect(pulseDeckEvents[0].cancelable).toBe(true);
    } finally {
      window.removeEventListener('vibex:open-pulse-deck', onPulseDeck);
      win.__VIBEX_PENDING_WORKFLOW_STUDIO_OPEN__ = null;
    }
  });
});

describe('Track R3: Lossless Persistence & Non-Lossy Studio Editing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('preserves all 7 node categories, Condition.expression, Outbox.actionKind, titles, and scratch workspaceIsolation across round-trips', () => {
    const fullShowcaseWorkflow: StudioWorkflowDefinition = {
      ...sevenCategoryWorkflow,
      steps: [
        sevenCategoryWorkflow.steps[0], // trigger
        sevenCategoryWorkflow.steps[1], // bot
        {
          ...(sevenCategoryWorkflow.steps[2] as Extract<
            StudioWorkflowDefinition['steps'][number],
            { kind: 'session' }
          >),
          workspaceIsolation: 'scratch',
        },
        sevenCategoryWorkflow.steps[3], // group_stage
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
        sevenCategoryWorkflow.steps[5], // user_gate
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
        {
          id: 'jira-outbox',
          dependsOn: ['owner-gate'],
          phase: null,
          inputBindings: {},
          kind: 'outbox_action',
          actionKind: 'jira_comment',
          title: 'Post Jira Ticket Update',
          destination: '{{issue.key}}',
          payloadTemplate: 'Jira update for {{failedJob}}',
        },
        sevenCategoryWorkflow.steps[6], // github_comment outbox
      ],
    };

    const backend = toBackendWorkflowDefinition(fullShowcaseWorkflow);
    const roundTripped = toStudioWorkflowDefinition(backend);

    expect(roundTripped.name).toBe(fullShowcaseWorkflow.name);
    expect(roundTripped.orchestratorPreset).toBe('hybrid_pipeline');
    expect(roundTripped.steps.map((s) => s.kind)).toEqual([
      'trigger',
      'bot',
      'session',
      'group_stage',
      'control',
      'control',
      'user_gate',
      'outbox_action',
      'outbox_action',
      'outbox_action',
    ]);

    const trigger = roundTripped.steps[0];
    expect(trigger.kind).toBe('trigger');
    if (trigger.kind === 'trigger') {
      expect(trigger.title).toBe('GitHub CI Trigger');
      expect(trigger.sourceKind).toBe('github');
      expect(trigger.eventType).toBe('github.ci.failed');
      expect(trigger.evalMode).toBe('observe');
    }

    const session = roundTripped.steps[2];
    expect(session.kind).toBe('session');
    if (session.kind === 'session') {
      expect(session.workspaceIsolation).toBe('scratch');
    }

    const condition = roundTripped.steps[4];
    expect(condition.kind).toBe('control');
    if (condition.kind === 'control') {
      expect(condition.phase).toBe('routing');
      expect(condition.controlKind).toBe('condition');
      expect(condition.title).toBe('Check P0 Severity');
      expect(condition.expression).toBe(
        'event.payload.priority == "P0" && !actor.isBot'
      );
    }

    const feishuOutbox = roundTripped.steps[7];
    const jiraOutbox = roundTripped.steps[8];
    const ghOutbox = roundTripped.steps[9];
    if (
      feishuOutbox.kind === 'outbox_action' &&
      jiraOutbox.kind === 'outbox_action' &&
      ghOutbox.kind === 'outbox_action'
    ) {
      expect(feishuOutbox.actionKind).toBe('feishu_reply');
      expect(feishuOutbox.title).toBe('Reply in Feishu Thread');
      expect(feishuOutbox.payloadTemplate).toBe(
        'Feishu summary for {{failedJob}}'
      );
      expect(jiraOutbox.actionKind).toBe('jira_comment');
      expect(jiraOutbox.title).toBe('Post Jira Ticket Update');
      expect(ghOutbox.actionKind).toBe('github_comment');
      expect(ghOutbox.title).toBe('Comment on PR');
    }
  });

  it('keeps Trigger, Condition.expression, feishu_reply, titles, and scratch isolation intact on every keystroke in studioMode', () => {
    const hydratedFromBackend = toStudioWorkflowDefinition(
      toBackendWorkflowDefinition({
        ...sevenCategoryWorkflow,
        steps: [
          sevenCategoryWorkflow.steps[0],
          {
            ...(sevenCategoryWorkflow.steps[2] as Extract<
              StudioWorkflowDefinition['steps'][number],
              { kind: 'session' }
            >),
            dependsOn: ['gh-trigger'],
            workspaceIsolation: 'scratch',
          },
          {
            id: 'cond-step',
            dependsOn: ['coder-session'],
            phase: null,
            inputBindings: {},
            kind: 'control',
            controlKind: 'condition',
            title: 'Gate Condition',
            expression: 'initial.ok == true',
          },
          {
            id: 'feishu-step',
            dependsOn: ['cond-step'],
            phase: null,
            inputBindings: {},
            kind: 'outbox_action',
            actionKind: 'feishu_reply',
            title: 'Feishu Alert',
            destination: '{{threadKey}}',
            payloadTemplate: 'Alert body',
          },
        ],
      })
    );

    let latestState = hydratedFromBackend;
    function EditorSimulationHarness() {
      const [state, setState] = useState(hydratedFromBackend);
      latestState = state;
      return (
        <WorkflowStudio
          studioMode
          definition={state}
          onDefinitionChange={setState}
          dirty
          onSave={vi.fn()}
          onPublish={vi.fn()}
        />
      );
    }

    render(<EditorSimulationHarness />);

    // Select Condition step and type into Branch Expression + Title
    fireEvent.click(
      within(screen.getByTestId('workflow-node-cond-step')).getByRole(
        'button',
        { name: /cond-step/i }
      )
    );
    const exprInput = document.getElementById(
      'workflow-condition-expr'
    ) as HTMLInputElement;
    fireEvent.change(exprInput, {
      target: { value: 'output.score >= 95 && !actor.isBot' },
    });
    const controlTitleInput = document.getElementById(
      'workflow-control-title'
    ) as HTMLInputElement;
    fireEvent.change(controlTitleInput, {
      target: { value: 'High Confidence Gate' },
    });

    // Verify Trigger did NOT turn into Notify, scratch did NOT reset, feishu_reply did NOT snap to github_comment, and Condition.expression stayed intact!
    expect(latestState.steps[0].kind).toBe('trigger');
    const sessionStep = latestState.steps[1];
    expect(
      sessionStep.kind === 'session' ? sessionStep.workspaceIsolation : null
    ).toBe('scratch');
    const condStep = latestState.steps[2];
    expect(condStep.kind === 'control' ? condStep.expression : null).toBe(
      'output.score >= 95 && !actor.isBot'
    );
    expect(condStep.kind === 'control' ? condStep.title : null).toBe(
      'High Confidence Gate'
    );
    const outboxStep = latestState.steps[3];
    expect(
      outboxStep.kind === 'outbox_action' ? outboxStep.actionKind : null
    ).toBe('feishu_reply');
    expect(outboxStep.kind === 'outbox_action' ? outboxStep.title : null).toBe(
      'Feishu Alert'
    );
    expect(validateStudioWorkflowExhaustively(latestState)).toEqual([]);
  });
});

describe('Track R3: Validation Gate, WorkflowInspector Dual-Primitive Upgrade & Keyboard Accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('disables Save and Publish with tabular-nums issue badge and accessible tooltip when validationIssues.length > 0', () => {
    const onSave = vi.fn();
    const onPublish = vi.fn();
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
        onPublish={onPublish}
      />
    );

    const badge = screen.getByTestId('workflow-toolbar-validation-badge');
    expect(badge).toHaveClass('tabular-nums');
    expect(badge.getAttribute('title')).toMatch(
      /保存或发布前请先修复|Fix .* validation issue/i
    );

    const saveBtn = screen.getByRole('button', { name: '保存' });
    const publishBtn = screen.getByRole('button', { name: '发布' });
    expect(saveBtn).toBeDisabled();
    expect(publishBtn).toBeDisabled();
    expect(saveBtn.getAttribute('title')).toMatch(
      /保存或发布前请先修复|Fix .* validation issue/i
    );

    // Rerender with valid workflow: Save & Publish re-enable
    rerender(
      <WorkflowStudio
        studioMode
        definition={sevenCategoryWorkflow}
        onDefinitionChange={vi.fn()}
        dirty
        onSave={onSave}
        onPublish={onPublish}
      />
    );
    expect(
      screen.queryByTestId('workflow-toolbar-validation-badge')
    ).toBeNull();
    expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: '发布' })).not.toBeDisabled();
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

    fireEvent.change(noteInput, { target: { value: 'Needs rollback plan' } });
    fireEvent.click(
      within(banner).getByRole('button', { name: /拒绝|Reject/i })
    );
    await waitFor(() => {
      expect(onDecideApproval).toHaveBeenCalledWith('s-gate', {
        approved: false,
        optionId: 'reject',
        note: 'Needs rollback plan',
      });
    });

    // Custom JSON decision mode
    fireEvent.click(
      within(banner).getByRole('button', { name: /自定义 JSON|Custom JSON/i })
    );
    const jsonArea = within(banner).getByRole('textbox', {
      name: /决定 JSON|Decision JSON/i,
    });
    fireEvent.change(jsonArea, {
      target: { value: '{"approved":true,"ticket":"REL-42"}' },
    });
    fireEvent.click(
      within(banner).getByRole('button', { name: /提交决定|Submit decision/i })
    );
    await waitFor(() => {
      expect(onDecideApproval).toHaveBeenCalledWith('s-gate', {
        approved: true,
        ticket: 'REL-42',
      });
    });
  });

  it('supports ArrowLeft/ArrowRight keyboard navigation in Inspector tablist (without !h-7) and Execution Primitive radiogroup', () => {
    render(<StatefulStudioHarness />);

    fireEvent.click(
      within(screen.getByTestId('workflow-node-coder-session')).getByRole(
        'button',
        { name: /coder-session/i }
      )
    );

    const visualTab = screen.getByTestId('inspector-tier-visual');
    expect(visualTab.className).not.toContain('!h-7');
    expect(visualTab).toHaveClass('h-7');

    // ArrowRight on Execution Primitive radiogroup switches Fresh Session -> Persistent Bot
    const sessionRadio = screen.getByTestId('inspector-primitive-session');
    fireEvent.keyDown(sessionRadio, { key: 'ArrowRight' });
    expect(screen.getByTestId('inspector-primitive-bot')).toHaveAttribute(
      'aria-checked',
      'true'
    );

    // ArrowLeft switches Persistent Bot -> Fresh Session
    fireEvent.keyDown(screen.getByTestId('inspector-primitive-bot'), {
      key: 'ArrowLeft',
    });
    expect(screen.getByTestId('inspector-primitive-session')).toHaveAttribute(
      'aria-checked',
      'true'
    );

    // ArrowRight on Inspector tier tablist cycles Visual -> Advanced -> JSON -> Visual
    fireEvent.keyDown(visualTab, { key: 'ArrowRight' });
    const advancedTab = screen.getByTestId('inspector-tier-advanced');
    expect(advancedTab).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(advancedTab);

    fireEvent.keyDown(advancedTab, { key: 'ArrowRight' });
    const jsonTab = screen.getByTestId('inspector-tier-json');
    expect(jsonTab).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(jsonTab);

    fireEvent.keyDown(jsonTab, { key: 'ArrowRight' });
    expect(screen.getByTestId('inspector-tier-visual')).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });
});

describe('Track R3: Guarded Run Polling & ReactFlow O(N) Event Indexing + React.memo', () => {
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

    // First tick at 1500ms starts request #1
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    // Next ticks at 3000ms and 4500ms are skipped while request #1 is still in flight
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    // Resolve request #1 -> next 1500ms tick triggers request #2
    await act(async () => {
      resolveFirst();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(refresh).toHaveBeenCalledTimes(2);

    // Hide document -> polling pauses
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    await act(async () => {
      vi.advanceTimersByTime(4500);
    });
    expect(refresh).toHaveBeenCalledTimes(2);

    // Return document to visible -> refreshes immediately without waiting 1500ms
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
