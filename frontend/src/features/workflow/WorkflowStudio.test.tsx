import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowDefinition } from 'shared/types';

import { resolveMemberBotAvatar } from '@/features/collaboration/MemberBotAvatar';
import { sessionsApi } from '@/lib/api/sessions';
import { WorkflowStudio } from './WorkflowStudio';

const userSystem = vi.hoisted(() => ({
  defaultAgentId: 'grok' as string | null,
}));

vi.mock('@/components/ConfigProvider', () => ({
  useOptionalUserSystem: () =>
    userSystem.defaultAgentId
      ? {
          config: {
            executor_profile: {
              executor: userSystem.defaultAgentId,
              variant: null,
            },
          },
        }
      : null,
}));

vi.mock('@/lib/api/sessions', () => ({
  sessionsApi: {
    createProject: vi.fn().mockResolvedValue({
      conversation: { id: 'conv-step-edit-1' },
    }),
  },
}));

const embeddedSessionPropsSpy = vi.hoisted(() => vi.fn());

vi.mock('@/components/kanban/KanbanSessionConversationView', () => ({
  KanbanSessionConversationView: (props: Record<string, unknown>) => {
    embeddedSessionPropsSpy(props);
    return (
      <div
        data-testid="mock-kanban-session-conversation"
        data-workspace-id={String(props.workspaceId ?? '')}
        data-session-id={String(props.sessionId ?? '')}
      />
    );
  },
}));

vi.mock('@/lib/api/projects', () => ({
  projectsApi: {
    getAll: vi.fn().mockResolvedValue([
      {
        id: 'proj-1',
        name: 'VibeX',
        default_agent_working_dir: '/repo/vibex',
      },
    ]),
  },
}));

const definition: WorkflowDefinition = {
  formatVersion: 1,
  name: 'Visible workflow',
  description: null,
  inputSchema: { type: 'object' },
  steps: [
    {
      id: 'start',
      dependsOn: [],
      phase: null,
      inputBindings: {},
      kind: 'agent',
      agentId: 'codex',
      prompt: 'Inspect repository modules',
      executorProfileId: null,
      modeOverride: null,
      configOverrides: {},
      outputLanguage: 'zh-CN',
      outputDescription: null,
      outputSchema: null,
      workspaceAccess: 'native',
      sideEffectClass: 'mutating_unknown',
      allowOneRepair: false,
      allowSkipOnReview: false,
      completionPolicy: 'manual',
    },
  ],
  policy: {
    maxConcurrentAgentSteps: 1,
    maxAgentCalls: 2,
    deadlineSeconds: 60,
    maxOutputBytes: 4096,
  },
};

const connectedDefinition: WorkflowDefinition = {
  ...definition,
  steps: [
    definition.steps[0],
    {
      ...(definition.steps[0] as Extract<
        WorkflowDefinition['steps'][number],
        { kind: 'agent' }
      >),
      id: 'finish',
      prompt: 'Summarize verified findings',
      dependsOn: ['start'],
      inputBindings: {
        predecessor: {
          source: 'step_output',
          step_id: 'start',
          pointer: '',
        },
      },
      completionPolicy: 'automatic',
    },
  ],
};

describe('WorkflowStudio (Semantic Human-Centric Canvas & Simple Side Card)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userSystem.defaultAgentId = 'grok';
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('fills the available editor stage instead of fixing the graph to 560px', () => {
    const { container } = render(
      <WorkflowStudio
        definition={definition}
        onDefinitionChange={() => undefined}
      />
    );

    expect(screen.getByText('Inspect repository modules')).toBeInTheDocument();
    expect(container.querySelector('.react-flow')?.parentElement).toHaveClass(
      'min-h-0',
      'flex-1'
    );
    expect(
      container.querySelector('.react-flow')?.parentElement
    ).not.toHaveClass('h-[560px]');
    expect(container.querySelector('.react-flow__node')).toHaveClass(
      'draggable'
    );
  });

  it('selects a node, opens the divider-free floating 2-tab side card without tether clutter, and supports AstryxSelect light tweaks + Agent step edits', async () => {
    const user = userEvent.setup();
    const onDefinitionChange = vi.fn();
    render(
      <WorkflowStudio
        definition={definition}
        onDefinitionChange={onDefinitionChange}
        projectId="proj-1"
        agentOptions={[
          { value: 'codex', label: 'Codex', runnable: true },
          { value: 'grok', label: 'Grok', runnable: true },
        ]}
      />
    );

    const deckBtn = screen.getByTestId('workflow-node-deck-start');
    fireEvent.click(deckBtn);

    expect(deckBtn).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('workflow-inspector-tether')).toBeNull();
    const inspector = screen.getByTestId('workflow-node-inspector');
    expect(inspector.querySelector('hr')).toBeNull();
    expect(inspector.innerHTML).not.toMatch(/\bborder-[bt]\b/);
    expect(inspector).not.toHaveTextContent(/干净隔离会话|isolated session/i);
    expect(screen.getByTestId('inspector-simple-overview')).toBeInTheDocument();
    expect(screen.getByTestId('inspector-tab-info')).toHaveTextContent(
      /节点概览|Overview/
    );
    expect(screen.getByTestId('inspector-tab-conversation')).toHaveTextContent(
      /执行记录|Records/
    );

    // Light tweak 1: swap Execution Agent via AstryxSelect combobox
    await user.click(screen.getByTestId('inspector-step-agent'));
    await user.click(screen.getByRole('option', { name: /Grok/i }));
    expect(onDefinitionChange).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [expect.objectContaining({ id: 'start', agentId: 'grok' })],
      })
    );

    // Light tweak 2: edit natural-language task instructions
    fireEvent.change(screen.getByTestId('inspector-step-prompt'), {
      target: { value: 'Check failing unit tests and propose fix' },
    });
    expect(onDefinitionChange).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [
          expect.objectContaining({
            id: 'start',
            prompt: 'Check failing unit tests and propose fix',
          }),
        ],
      })
    );

    // Pinned inline Agent bar dispatches a contextual Agent session without verbose label header
    await user.type(
      screen.getByTestId('inspector-agent-step-input'),
      '在此步完成后增加我的人工审批门控'
    );
    await user.click(screen.getByTestId('inspector-agent-step-submit'));
    expect(sessionsApi.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'proj-1',
        initial_prompt: expect.stringContaining('start'),
      })
    );
  });

  it('shows live graph metrics and exposes undo as an editor action without manual node-add clutter', async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    render(
      <WorkflowStudio
        definition={definition}
        onDefinitionChange={() => undefined}
        releaseVersion="0.4"
        canUndo
        onUndo={onUndo}
      />
    );

    expect(screen.getByText(/1.*节点|1.*node/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /添加节点|add node/i })
    ).toBeNull();

    await user.hover(
      screen.getByRole('button', { name: /预览信息|preview information/i })
    );
    expect(screen.getByText(/1.*Agent/i)).toBeInTheDocument();
    expect(screen.getByText('v0.4')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /撤销|undo/i }));
    expect(onUndo).toHaveBeenCalledOnce();
  });

  it('floats editor controls over the canvas and opens workspace settings on the right', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <WorkflowStudio
        definition={definition}
        onDefinitionChange={() => undefined}
        workspaceConfig={<div>Workspace form</div>}
      />
    );

    expect(container.querySelector('.workflow-studio-toolbar')).toBeNull();
    expect(
      container.querySelector('.workflow-studio-floating-controls')
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /工作区|workspace/i }));
    expect(screen.getByTestId('workflow-workspace-panel')).toHaveTextContent(
      'Workspace form'
    );
  });

  it('renders Agent brand artwork (Kimi / Grok) on semantic node chips instead of generic bot glyphs', () => {
    const kimiDefinition: WorkflowDefinition = {
      ...definition,
      steps: [
        {
          ...(definition.steps[0] as Extract<
            WorkflowDefinition['steps'][number],
            { kind: 'agent' }
          >),
          agentId: 'kimi_code',
        },
      ],
    };
    render(
      <WorkflowStudio
        definition={kimiDefinition}
        onDefinitionChange={() => undefined}
        agentOptions={[{ value: 'kimi_code', label: 'Kimi Code' }]}
      />
    );

    expect(
      screen.getByTestId('workflow-node-category-badge-start')
    ).toHaveTextContent('Kimi Code');
    expect(
      screen.getAllByRole('img', { name: 'Kimi Code' })[0]
    ).toHaveAttribute('src', '/agents/kimi.svg');
    expect(document.querySelector('.lucide-bot')).not.toBeInTheDocument();
  });

  it('opens a visual execution log from the node status control', async () => {
    const user = userEvent.setup();
    render(
      <WorkflowStudio
        definition={definition}
        onDefinitionChange={() => undefined}
      />
    );

    await user.click(
      screen.getByRole('button', { name: /待命|standby|draft/i })
    );
    expect(screen.getByTestId('workflow-node-log-start')).toBeInTheDocument();
  });

  it('keeps the confirmation edge after the Agent step is confirmed', () => {
    const { container } = render(
      <WorkflowStudio
        definition={definition}
        onDefinitionChange={() => undefined}
        steps={[
          {
            id: 'sr-1',
            runId: 'run-1',
            stepId: 'start',
            attempt: 1n,
            status: 'completed',
            conversationId: 'conv-1',
            turnId: 'turn-1',
            outputJson: 'ok',
            outputSchemaDigest: null,
            candidateOutputJson: null,
            candidateSchemaDigest: null,
            awaitingAcceptance: false,
            awaitingInput: false,
            executionMode: 'debug',
            resolvedInputJson: null,
            resolvedInputDigest: null,
            executionEvidenceJson: null,
            workspaceId: 'ws-1',
            waitingInteraction: false,
            repairCount: 0n,
            claimToken: null,
            claimDeadline: null,
            startedAt: '2026-08-18T00:00:00.000Z',
            completedAt: '2026-08-18T00:00:02.000Z',
            updatedAt: '2026-08-18T00:00:02.000Z',
          },
        ]}
      />
    );

    expect(
      container.querySelector(
        '.react-flow__edge[data-testid="rf__edge-start->confirmation:start"], .react-flow__edge[data-id="start->confirmation:start"]'
      ) ?? container.querySelector('[data-id="start->confirmation:start"]')
    ).toBeTruthy();
    expect(
      container.querySelector('.react-flow__node[data-id="confirmation:start"]')
    ).toBeInTheDocument();
  });

  it('merges stop with its menu and resets run state without touching Worktree', async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    render(
      <WorkflowStudio
        definition={definition}
        onDefinitionChange={() => undefined}
        showStopActions
        onStopRun={() => undefined}
        onTerminateRun={() => undefined}
        onReset={onReset}
        activeWorktree={{ name: 'Debug', path: '/tmp/debug' }}
      />
    );

    expect(
      screen.getByRole('button', { name: /^停止$|^stop$/i })
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: /选择停止方式|choose stop action/i })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /重置|reset/i }));
    expect(onReset).toHaveBeenCalledOnce();
    expect(screen.getByTestId('workflow-active-worktree')).toHaveTextContent(
      'Debug'
    );
  });

  it('opens overview or records from the lightweight node context menu without manual duplicate clutter', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <WorkflowStudio
        definition={connectedDefinition}
        onDefinitionChange={() => undefined}
      />
    );

    fireEvent.contextMenu(screen.getByTestId('workflow-node-deck-start'));
    expect(
      screen.queryByRole('menuitem', { name: /复制|duplicate/i })
    ).toBeNull();
    await user.click(
      screen.getByRole('menuitem', { name: /显示记录|show records/i })
    );
    expect(screen.getByTestId('workflow-node-log-start')).toBeInTheDocument();

    fireEvent.contextMenu(
      container.querySelector('.workflow-confirmation-node')!
    );
    expect(
      screen.getByRole('menuitem', { name: /显示记录|show records/i })
    ).toBeInTheDocument();
  });

  it('lets confirmation nodes be dragged independently', () => {
    const { container } = render(
      <WorkflowStudio
        definition={definition}
        onDefinitionChange={() => undefined}
      />
    );

    const confirmation = container.querySelector(
      '.react-flow__node[data-id="confirmation:start"]'
    );
    expect(confirmation).toHaveClass('draggable');
    expect(
      container.querySelector('.workflow-confirmation-node')
    ).not.toHaveClass('nodrag');
    expect(
      container.querySelector('.workflow-confirmation-node')?.tagName
    ).toBe('ARTICLE');
  });

  it('renders the execution log as a flame graph and can preview the result', async () => {
    const user = userEvent.setup();
    render(
      <WorkflowStudio
        definition={definition}
        onDefinitionChange={() => undefined}
        events={[
          {
            id: 'e1',
            runId: 'run-1',
            sequence: 2n,
            eventVersion: 1n,
            eventKind: 'step_ready',
            payloadJson: '{"step_id":"start"}',
            operationId: null,
            createdAt: '2026-08-18T00:00:00.000Z',
          },
          {
            id: 'e2',
            runId: 'run-1',
            sequence: 3n,
            eventVersion: 1n,
            eventKind: 'step_started',
            payloadJson: '{"step_id":"start"}',
            operationId: null,
            createdAt: '2026-08-18T00:00:01.000Z',
          },
        ]}
        steps={[
          {
            id: 'sr-1',
            runId: 'run-1',
            stepId: 'start',
            attempt: 1n,
            status: 'completed',
            conversationId: 'conv-1',
            turnId: 'turn-1',
            outputJson: 'Done with the inventory.',
            outputSchemaDigest: null,
            candidateOutputJson: null,
            candidateSchemaDigest: null,
            awaitingAcceptance: false,
            awaitingInput: false,
            executionMode: 'debug',
            resolvedInputJson: null,
            resolvedInputDigest: null,
            executionEvidenceJson: null,
            workspaceId: 'ws-1',
            waitingInteraction: false,
            repairCount: 0n,
            claimToken: null,
            claimDeadline: null,
            startedAt: '2026-08-18T00:00:00.000Z',
            completedAt: '2026-08-18T00:00:02.000Z',
            updatedAt: '2026-08-18T00:00:02.000Z',
          },
        ]}
      />
    );

    await user.click(screen.getByRole('button', { name: /已完成|completed/i }));
    expect(screen.getByTestId('workflow-node-flame-start')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /预览结果|preview/i }));
    expect(screen.getByTestId('workflow-node-preview-start')).toHaveTextContent(
      'Done with the inventory.'
    );
  });

  it('shows the active Worktree instead of the React Flow mark', () => {
    const { container } = render(
      <WorkflowStudio
        definition={definition}
        onDefinitionChange={() => undefined}
        activeWorktree={{
          name: 'New Workflow Debug',
          path: '/tmp/new-workflow-debug',
        }}
      />
    );

    expect(screen.getByTestId('workflow-active-worktree')).toHaveTextContent(
      'New Workflow Debug'
    );
    expect(screen.getByTestId('workflow-active-worktree')).toHaveTextContent(
      '/tmp/new-workflow-debug'
    );
    expect(container.querySelector('.react-flow__attribution')).toBeNull();
  });

  it('renders the conversation stream in the Records tab with the shared chat composer', () => {
    const { container } = render(
      <WorkflowStudio
        definition={definition}
        onDefinitionChange={() => undefined}
      />
    );

    fireEvent.click(screen.getByTestId('workflow-node-deck-start'));
    fireEvent.click(screen.getByTestId('inspector-tab-conversation'));

    expect(
      container.querySelector('.workflow-step-chat-composer')
    ).toBeInTheDocument();
  });

  it('removes a dependency when its edge is double-clicked', () => {
    const onDefinitionChange = vi.fn();
    const { container } = render(
      <WorkflowStudio
        definition={connectedDefinition}
        onDefinitionChange={onDefinitionChange}
      />
    );

    const edge = container.querySelector('.react-flow__edge');
    expect(edge).toBeInTheDocument();
    fireEvent.doubleClick(edge!);

    expect(onDefinitionChange).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({
            id: 'finish',
            dependsOn: [],
            inputBindings: {},
          }),
        ]),
      })
    );
  });
});

describe('Bilingual zh-CN/en Localization & Semantic Node Presentation', () => {
  it('switches cleanly between en and zh-CN across Toolbar, all 9 semantic node cards, Simple Side Card, and DockPanel', async () => {
    const i18n = (await import('@/i18n')).default;
    const { act, within, waitFor } = await import('@testing-library/react');
    const { BackendTransportProvider } = await import('@/lib/transport');
    const { WorkflowStudioDockPanel } = await import(
      './WorkflowStudioDockPanel'
    );
    const { toBackendWorkflowDefinition, toStudioWorkflowDefinition } =
      await import('./WorkflowStudio');

    const showcase: import('./WorkflowStudio').StudioWorkflowDefinition = {
      formatVersion: 1,
      name: 'Bilingual Graph',
      description: null,
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
          id: 'n-trigger',
          dependsOn: [],
          phase: null,
          inputBindings: {},
          kind: 'trigger',
          title: 'CI Trigger',
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
            conditions: [],
          },
        },
        {
          id: 'n-session',
          dependsOn: ['n-trigger'],
          phase: null,
          inputBindings: {},
          kind: 'session',
          agentId: 'codex',
          prompt: 'Analyze {{threadKey}} root cause',
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
          id: 'n-bot',
          dependsOn: ['n-session'],
          phase: null,
          inputBindings: {},
          kind: 'bot',
          memberId: 'sre-bot',
          conversationScope: 'fixed_primary',
          mailboxPolicy: 'coalesce_batch',
          prompt: 'Summarize {{threadKey}} service impact',
        },
        {
          id: 'n-group',
          dependsOn: ['n-bot'],
          phase: null,
          inputBindings: {},
          kind: 'group_stage',
          spaceId: 'eng-council',
          dispatchMode: { type: 'specific_seat', memberId: 'lead-bot' },
          rounds: 3,
          quorumCount: 2,
          prompt: 'Converge on rollout plan',
        },
        {
          id: 'n-loop',
          dependsOn: ['n-group'],
          phase: null,
          inputBindings: {},
          kind: 'control',
          controlKind: 'bounded_loop',
          title: 'Review Loop',
          maxIterations: 4,
          loopTargetStepId: 'n-session',
        },
        {
          id: 'n-wait',
          dependsOn: ['n-loop'],
          phase: null,
          inputBindings: {},
          kind: 'control',
          controlKind: 'wait_for_event',
          title: 'Wait CI',
          waitEventType: 'github.ci.completed',
          threadKeyTemplate: '{{threadKey}}',
          timeoutSeconds: 600,
        },
        {
          id: 'n-branch',
          dependsOn: ['n-wait'],
          phase: null,
          inputBindings: {},
          kind: 'control',
          controlKind: 'condition',
          title: 'Check Severity',
          expression: 'output.ok == true',
        },
        {
          id: 'n-gate',
          dependsOn: ['n-branch'],
          phase: null,
          inputBindings: {},
          kind: 'user_gate',
          interactionKind: 'approval',
          severity: 'urgent',
          title: 'Ship Gate',
          bodyTemplate: 'Approve {{threadKey}}?',
          slaTimeoutSeconds: 90,
        },
        {
          id: 'n-outbox',
          dependsOn: ['n-gate'],
          phase: null,
          inputBindings: {},
          kind: 'outbox_action',
          actionKind: 'github_comment',
          title: 'Reply PR',
          destination: '{{threadKey}}',
          payloadTemplate: 'Done {{threadKey}}',
        },
      ],
    };

    // Lossless round-trip of group_stage.rounds/quorumCount and user_gate.severity
    const roundTripped = toStudioWorkflowDefinition(
      toBackendWorkflowDefinition(showcase)
    );
    const rtGroup = roundTripped.steps.find((s) => s.id === 'n-group');
    expect(rtGroup?.kind === 'group_stage' ? rtGroup.rounds : null).toBe(3);
    expect(rtGroup?.kind === 'group_stage' ? rtGroup.quorumCount : null).toBe(
      2
    );
    const rtGate = roundTripped.steps.find((s) => s.id === 'n-gate');
    expect(rtGate?.kind === 'user_gate' ? rtGate.severity : null).toBe(
      'urgent'
    );

    try {
      await act(async () => {
        await i18n.changeLanguage('en');
      });

      const { unmount } = render(
        <WorkflowStudio
          studioMode
          dirty
          definition={showcase}
          onDefinitionChange={vi.fn()}
          onSave={vi.fn()}
          agentOptions={[{ value: 'codex', label: 'Codex' }]}
          bots={[
            {
              memberId: 'sre-bot',
              displayName: 'SRE Duty Bot',
              avatar: resolveMemberBotAvatar({
                identityMemberId: 'sre-bot',
                nickname: 'SRE Duty Bot',
              }),
            },
          ]}
        />
      );

      expect(screen.getByTestId('workflow-toolbar-save-btn')).toHaveTextContent(
        'Save changes'
      );

      for (const [id, badge] of [
        ['n-trigger', 'GitHub'],
        ['n-session', 'Codex'],
        ['n-bot', 'SRE Duty Bot'],
        ['n-group', 'eng-council'],
        ['n-loop', 'LOOP'],
        ['n-wait', 'WAIT'],
        ['n-branch', 'BRANCH'],
        ['n-gate', 'Approval'],
        ['n-outbox', 'GitHub Comment'],
      ] as const) {
        expect(
          screen.getByTestId(`workflow-node-category-badge-${id}`)
        ).toHaveTextContent(badge);
      }

      // Raw {{threadKey}} noise is stripped from card headlines
      expect(
        within(screen.getByTestId('workflow-node-n-session')).getByText(
          'Analyze root cause'
        )
      ).toBeInTheDocument();
      expect(
        within(screen.getByTestId('workflow-node-n-loop')).getByText('Max 4x')
      ).toHaveClass('tabular-nums');

      fireEvent.click(screen.getByTestId('workflow-node-deck-n-session'));
      expect(screen.getByTestId('inspector-tab-info')).toHaveTextContent(
        'Overview'
      );
      expect(
        screen.getByTestId('inspector-tab-conversation')
      ).toHaveTextContent('Records');

      // Switch live to zh-CN
      await act(async () => {
        await i18n.changeLanguage('zh-CN');
      });

      expect(screen.getByTestId('workflow-toolbar-save-btn')).toHaveTextContent(
        '保存修改'
      );
      for (const [id, badge] of [
        ['n-trigger', 'GitHub'],
        ['n-session', 'Codex'],
        ['n-bot', 'SRE Duty Bot'],
        ['n-group', 'eng-council'],
        ['n-loop', '循环'],
        ['n-wait', '等待事件'],
        ['n-branch', '条件分支'],
        ['n-gate', '人工审批'],
        ['n-outbox', 'GitHub 评论'],
      ] as const) {
        expect(
          screen.getByTestId(`workflow-node-category-badge-${id}`)
        ).toHaveTextContent(badge);
      }
      expect(
        within(screen.getByTestId('workflow-node-n-loop')).getByText(
          '最多 4 轮'
        )
      ).toBeInTheDocument();
      expect(screen.getByTestId('inspector-tab-info')).toHaveTextContent(
        '节点概览'
      );

      unmount();

      // Verify DockPanel bilingual starter workflow name & Automation Tasks shortcut
      await act(async () => {
        await i18n.changeLanguage('en');
      });
      const mockTransport = {
        environment: 'desktop' as const,
        call: vi.fn(async (cmd: string) => {
          if (cmd === 'workflow_list') return [];
          if (cmd === 'pulse_captured_events') return [];
          if (cmd === 'pulse_sources_list') return [];
          return null;
        }),
      };
      render(
        <BackendTransportProvider transport={mockTransport}>
          <WorkflowStudioDockPanel />
        </BackendTransportProvider>
      );
      await waitFor(() => {
        expect(
          screen.getByTestId('workflow-studio-open-pulse-deck')
        ).toHaveTextContent('Automation Tasks');
      });
      expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue(
        'New Task'
      );

      await act(async () => {
        await i18n.changeLanguage('zh-CN');
      });
      expect(
        screen.getByTestId('workflow-studio-open-pulse-deck')
      ).toHaveTextContent('自动化任务');
    } finally {
      await act(async () => {
        await i18n.changeLanguage('zh-CN');
      });
    }
  });
});

describe('Multi-Port Semantic Branching & Fan-In/Fan-Out Badges', () => {
  it('renders semantic multi-port handles, tabular-nums fan-in/fan-out badges, and Delete-key edge removal', async () => {
    const i18n = (await import('@/i18n')).default;
    const { act, waitFor } = await import('@testing-library/react');

    const initialGraph: import('./WorkflowStudio').StudioWorkflowDefinition = {
      formatVersion: 1,
      name: 'DAG Multi-Port Studio',
      description: null,
      inputSchema: { type: 'object' },
      policy: {
        maxConcurrentAgentSteps: 4,
        maxAgentCalls: 12,
        deadlineSeconds: 1800,
        maxOutputBytes: 65536,
      },
      steps: [
        {
          id: 'intake',
          dependsOn: [],
          phase: null,
          inputBindings: {},
          kind: 'trigger',
          title: 'GitHub Trigger',
          triggerKind: 'platform',
          sourceKind: 'github',
          eventType: 'github.pr.opened',
          evalMode: 'auto',
          temporal: null,
          filter: {
            sourceKinds: ['github'],
            sourceInstanceIds: [],
            eventTypes: ['github.pr.opened'],
            allowedActors: [],
            conditions: [],
          },
        },
        {
          id: 'cond-1',
          dependsOn: ['intake'],
          phase: null,
          inputBindings: {},
          kind: 'control',
          controlKind: 'condition',
          title: 'Risk Branch',
          expression: 'event.risk == "high"',
        },
        {
          id: 'gate-1',
          dependsOn: ['intake', 'cond-1'],
          branchPorts: { 'cond-1': 'branch:true' },
          joinMode: 'all',
          phase: null,
          inputBindings: {},
          kind: 'user_gate',
          interactionKind: 'approval',
          severity: 'warning',
          title: 'Owner Gate',
          bodyTemplate: 'Approve?',
        },
        {
          id: 'loop-1',
          dependsOn: ['cond-1'],
          branchPorts: { 'cond-1': 'branch:false' },
          phase: null,
          inputBindings: {},
          kind: 'control',
          controlKind: 'bounded_loop',
          title: 'Verify Loop',
          maxIterations: 3,
          loopTargetStepId: '',
        },
      ],
    };

    function StatefulHarness() {
      const [def, setDef] = useState(initialGraph);
      return (
        <WorkflowStudio
          studioMode
          definition={def}
          onDefinitionChange={setDef}
        />
      );
    }

    await act(async () => {
      await i18n.changeLanguage('zh-CN');
    });

    const { container } = render(<StatefulHarness />);

    expect(
      screen.queryByTestId('workflow-port-intake-target')
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('workflow-port-intake-source')).toHaveClass(
      'nodrag',
      'nopan',
      'workflow-port-handle'
    );

    const fanOutBadge = screen.getByTestId('workflow-fan-out-badge-intake');
    expect(fanOutBadge).toHaveTextContent('×2');
    expect(fanOutBadge).toHaveClass('tabular-nums');

    expect(
      screen.getByTestId('workflow-port-pill-cond-1-branch:true')
    ).toHaveTextContent('满足 (True)');
    expect(
      screen.getByTestId('workflow-port-pill-cond-1-branch:false')
    ).toHaveTextContent('不满足 (False)');
    expect(
      screen.getByTestId('workflow-port-pill-gate-1-branch:approved')
    ).toHaveTextContent('批准 (Approved)');
    expect(
      screen.getByTestId('workflow-port-pill-gate-1-branch:rejected')
    ).toHaveTextContent('驳回 (Rejected)');
    expect(
      screen.getByTestId('workflow-port-pill-loop-1-branch:loop_body')
    ).toHaveTextContent('循环体 (Loop)');
    expect(
      screen.getByTestId('workflow-port-pill-loop-1-branch:loop_exit')
    ).toHaveTextContent('完成退出 (Exit)');

    const fanInBadge = screen.getByTestId('workflow-fan-in-badge-gate-1');
    expect(fanInBadge).toHaveTextContent('汇合 ×2 · 全部');
    expect(fanInBadge).toHaveClass('tabular-nums');

    expect(
      screen.getByTestId('workflow-edge-label-cond-1->gate-1')
    ).toHaveTextContent('满足');

    const targetEdge = container.querySelector(
      '[data-id="cond-1->gate-1"]'
    ) as HTMLElement;
    expect(targetEdge).toBeTruthy();
    fireEvent.click(targetEdge);
    fireEvent.keyDown(targetEdge, { key: 'Delete', code: 'Delete' });
    fireEvent.keyUp(targetEdge, { key: 'Delete', code: 'Delete' });
    await waitFor(() => {
      expect(
        screen.queryByTestId('workflow-edge-label-cond-1->gate-1')
      ).not.toBeInTheDocument();
    });
  });
});

describe('Workflow Studio 5-Point UI/UX Optimization', () => {
  it('renders multi-point Left/Right/Top/Bottom handles, preserves targetPorts across codec round-trips, and supports leaf quick-add + floating canvas controls', async () => {
    const user = userEvent.setup();
    const { toBackendWorkflowDefinition, toStudioWorkflowDefinition } =
      await import('./WorkflowStudio');

    const studioDef: import('./WorkflowStudio').StudioWorkflowDefinition = {
      formatVersion: 1,
      name: 'Multi-Point Canvas',
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
          id: 'step-a',
          dependsOn: [],
          phase: null,
          inputBindings: {},
          kind: 'session',
          agentId: 'codex',
          prompt: 'Step A',
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
          id: 'step-b',
          dependsOn: ['step-a'],
          branchPorts: { 'step-a': 'source:secondary' },
          targetPorts: { 'step-a': 'target:secondary' },
          phase: null,
          inputBindings: {},
          kind: 'session',
          agentId: 'codex',
          prompt: 'Step B',
          workspaceIsolation: 'isolated_worktree',
          executorProfileId: null,
          modeOverride: null,
          configOverrides: {},
          outputLanguage: 'zh-CN',
          outputDescription: null,
          outputSchema: null,
          completionPolicy: 'automatic',
        },
      ],
    };

    const roundTripped = toStudioWorkflowDefinition(
      toBackendWorkflowDefinition(studioDef)
    );
    const rtStepB = roundTripped.steps.find((s) => s.id === 'step-b');
    expect(rtStepB?.branchPorts).toEqual({ 'step-a': 'source:secondary' });
    expect(rtStepB?.targetPorts).toEqual({ 'step-a': 'target:secondary' });

    let latest = studioDef;
    function Harness() {
      const [state, setState] = useState(studioDef);
      latest = state;
      return (
        <WorkflowStudio
          studioMode
          definition={state}
          onDefinitionChange={setState}
        />
      );
    }

    const { container } = render(<Harness />);

    // Multi-point handles on step-b: dual Left (target, target:secondary), dual Right (source, source:secondary), Top (target:top), Bottom (source:bottom)
    expect(
      screen.getByTestId('workflow-port-step-b-target')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('workflow-port-step-b-target:secondary')
    ).toHaveClass('workflow-port-connected');
    expect(
      screen.getByTestId('workflow-port-step-b-source')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('workflow-port-step-b-source:secondary')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('workflow-port-step-b-target:top')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('workflow-port-step-b-source:bottom')
    ).toBeInTheDocument();

    // Floating centered bottom canvas controls
    expect(screen.getByTestId('workflow-canvas-controls')).toBeInTheDocument();
    expect(container.querySelector('.react-flow__minimap')).toBeNull();
    await user.click(screen.getByTestId('workflow-canvas-minimap-toggle'));
    expect(container.querySelector('.react-flow__minimap')).toBeInTheDocument();

    // Leaf '+' quick-add button chains a downstream step onto step-b
    expect(screen.queryByTestId('workflow-quick-add-step-a')).toBeNull();
    const quickAddBtn = screen.getByTestId('workflow-quick-add-step-b');
    fireEvent.click(quickAddBtn);
    expect(latest.steps).toHaveLength(3);
    expect(latest.steps[2].dependsOn).toEqual(['step-b']);
  });

  it('reuses KanbanSessionConversationView from the Sessions tab for single-node Agent testing', async () => {
    const user = userEvent.setup();
    const { QueryClient, QueryClientProvider } = await import(
      '@tanstack/react-query'
    );
    const { MemoryRouter } = await import('react-router-dom');
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const onTestNode = vi.fn();

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <WorkflowStudio
            studioMode
            definition={definition}
            onDefinitionChange={() => undefined}
            onTestNode={onTestNode}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );

    fireEvent.click(screen.getByTestId('workflow-node-deck-start'));
    await user.click(screen.getByTestId('inspector-tab-conversation'));

    const startTestBtn = screen.getByTestId('workflow-step-start-test');
    await user.click(startTestBtn);
    expect(onTestNode).toHaveBeenCalledWith('start');

    rerender(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <WorkflowStudio
            studioMode
            definition={definition}
            onDefinitionChange={() => undefined}
            onTestNode={onTestNode}
            steps={[
              {
                id: 'test-step-start',
                runId: 'test-run',
                stepId: 'start',
                attempt: 1n,
                status: 'running',
                conversationId: 'conv-test-session-1',
                turnId: null,
                outputJson: null,
                outputSchemaDigest: null,
                candidateOutputJson: null,
                candidateSchemaDigest: null,
                awaitingAcceptance: false,
                awaitingInput: false,
                executionMode: 'debug',
                resolvedInputJson: null,
                resolvedInputDigest: null,
                executionEvidenceJson: null,
                workspaceId: 'proj-workspace-1',
                waitingInteraction: false,
                repairCount: 0n,
                claimToken: null,
                claimDeadline: null,
                startedAt: '2026-11-16T00:00:00Z',
                completedAt: null,
                updatedAt: '2026-11-16T00:00:00Z',
              },
            ]}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(
      screen.getByTestId('workflow-step-embedded-session')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('mock-kanban-session-conversation')
    ).toHaveAttribute('data-session-id', 'conv-test-session-1');
    expect(embeddedSessionPropsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'proj-workspace-1',
        sessionId: 'conv-test-session-1',
        embedded: true,
        interactive: true,
        showSessionSelector: false,
      })
    );
  });

  it('provides a top-left unified task switcher + editable task name input and renders rightToolbarSlot', async () => {
    const user = userEvent.setup();
    const onEditorNameChange = vi.fn();
    const onSelectTask = vi.fn();
    const onCreateNewTask = vi.fn();
    const onBack = vi.fn();

    render(
      <WorkflowStudio
        studioMode
        definition={definition}
        onDefinitionChange={() => undefined}
        onBack={onBack}
        editorName={definition.name}
        onEditorNameChange={onEditorNameChange}
        selectedDefinitionId="wf-1"
        taskCatalog={[
          {
            id: 'wf-1',
            name: 'Visible workflow',
            latestVersionId: 'wfv-1',
            latestVersion: 2n,
            latestNormalizedJson: null,
            updatedAt: '2026-11-16T00:00:00Z',
          },
          {
            id: 'wf-2',
            name: 'PR Review Guard',
            latestVersionId: 'wfv-2',
            latestVersion: 12n,
            latestNormalizedJson: null,
            updatedAt: '2026-11-16T00:00:00Z',
          },
        ]}
        onSelectTask={onSelectTask}
        onCreateNewTask={onCreateNewTask}
        rightToolbarSlot={
          <button type="button" data-testid="custom-right-toolbar-slot">
            Sidebar
          </button>
        }
      />
    );

    const nameInput = screen.getByTestId('workflow-task-name-input');
    expect(nameInput).toHaveValue('Visible workflow');
    fireEvent.change(nameInput, { target: { value: 'Renamed task' } });
    expect(onEditorNameChange).toHaveBeenCalledWith('Renamed task');

    expect(screen.getByTestId('custom-right-toolbar-slot')).toBeInTheDocument();
    await user.click(screen.getByTestId('embedded-studio-back-btn'));
    expect(onBack).toHaveBeenCalledOnce();

    // Open top-left task list switcher dropdown
    await user.click(screen.getByTestId('workflow-task-switcher-btn'));
    expect(
      await screen.findByTestId('workflow-task-option-wf-1')
    ).toHaveTextContent('Visible workflow');
    expect(screen.getByTestId('workflow-task-option-wf-2')).toHaveTextContent(
      'PR Review Guard'
    );
    expect(screen.getByTestId('workflow-task-option-wf-2')).toHaveTextContent(
      'v1.2'
    );

    await user.click(screen.getByTestId('workflow-task-option-wf-2'));
    expect(onSelectTask).toHaveBeenCalledWith('wf-2');

    // Re-open switcher and click "+ 新建任务 / New task"
    await user.click(screen.getByTestId('workflow-task-switcher-btn'));
    await user.click(await screen.findByTestId('workflow-task-create-new'));
    expect(onCreateNewTask).toHaveBeenCalledOnce();
  });
});

describe('Docked Edge-Connected Inspector Node & Workspace Canvas Parity', () => {
  it('mounts the inspector inside ReactFlow docked right of the selected step with a connecting bezier edge and clears on pane click', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <WorkflowStudio
        studioMode
        definition={definition}
        onDefinitionChange={() => undefined}
      />
    );

    const stepNodeEl = container.querySelector<HTMLElement>(
      '.react-flow__node[data-id="start"]'
    );
    expect(stepNodeEl).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('workflow-node-deck-start'));

    const inspectorNodeEl = container.querySelector<HTMLElement>(
      '.react-flow__node[data-id="workflow-inspector:start"]'
    );
    expect(inspectorNodeEl).toBeInTheDocument();
    expect(inspectorNodeEl).toHaveClass('draggable');
    expect(
      inspectorNodeEl?.querySelector('.workflow-inspector-drag-handle')
    ).toBeInTheDocument();
    expect(
      inspectorNodeEl?.querySelector('[data-testid="workflow-node-inspector"]')
    ).toBeInTheDocument();

    const stepMatch = stepNodeEl?.style.transform.match(
      /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/
    );
    const inspMatch = inspectorNodeEl?.style.transform.match(
      /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/
    );
    expect(stepMatch).not.toBeNull();
    expect(inspMatch).not.toBeNull();
    const stepX = Number(stepMatch![1]);
    const stepY = Number(stepMatch![2]);
    const inspX = Number(inspMatch![1]);
    const inspY = Number(inspMatch![2]);
    expect(inspX).toBe(stepX + 280 + 48);
    expect(inspY).toBe(stepY);

    const inspectorEdge = container.querySelector('.workflow-inspector-edge');
    expect(inspectorEdge).toBeInTheDocument();

    const pane = container.querySelector('.react-flow__pane');
    expect(pane).toBeInTheDocument();
    await user.click(pane!);

    expect(
      container.querySelector(
        '.react-flow__node[data-id="workflow-inspector:start"]'
      )
    ).toBeNull();
    expect(container.querySelector('.workflow-inspector-edge')).toBeNull();
  });

  it('uses .canvas-surface, 24px .canvas-dots grid, and defaults to marquee select tool matching Workspace Canvas', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <WorkflowStudio
        studioMode
        definition={definition}
        onDefinitionChange={() => undefined}
      />
    );

    const studioSection = container.querySelector('.workflow-studio');
    expect(studioSection).toHaveAttribute('data-canvas-tool', 'select');
    expect(container.querySelector('.workflow-studio-stage')).toHaveClass(
      'canvas-surface'
    );
    const dotsSvg = container.querySelector('.canvas-dots');
    expect(dotsSvg).toBeInTheDocument();
    const dotsPattern = dotsSvg?.querySelector('pattern');
    expect(dotsPattern).toBeInTheDocument();
    const patternWidth = Number(dotsPattern?.getAttribute('width'));
    const patternHeight = Number(dotsPattern?.getAttribute('height'));
    expect(patternWidth).toBeGreaterThan(0);
    expect(patternWidth).toBe(patternHeight);

    const selectBtn = screen.getByTestId('workflow-canvas-tool-select');
    const panBtn = screen.getByTestId('workflow-canvas-tool-pan');
    expect(selectBtn).toHaveAttribute('aria-pressed', 'true');
    expect(panBtn).toHaveAttribute('aria-pressed', 'false');

    await user.click(panBtn);
    expect(studioSection).toHaveAttribute('data-canvas-tool', 'pan');
    expect(panBtn).toHaveAttribute('aria-pressed', 'true');
    expect(selectBtn).toHaveAttribute('aria-pressed', 'false');
  });
});
