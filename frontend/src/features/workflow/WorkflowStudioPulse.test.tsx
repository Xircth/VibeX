import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceTabAddMenu } from '@/components/layout/panels/WorkspaceTabAddMenu';
import { BUILT_IN_SAMPLE_EVENTS } from '@/features/pulse';

import {
  WORKFLOW_PRESET_TEMPLATES,
  WorkflowStudio,
  validateStudioWorkflowExhaustively,
  type StudioWorkflowDefinition,
} from './WorkflowStudio';

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
    expect(within(triggerNode).getByText('Platform Trigger')).toBeInTheDocument();
    const inlineModeGroup = within(triggerNode).getByRole('group', {
      name: /Trigger gh-trigger evaluation mode/i,
    });
    fireEvent.click(within(inlineModeGroup).getByRole('button', { name: 'Auto' }));
    expect(
      within(inlineModeGroup).getByRole('button', { name: 'Auto' })
    ).toHaveAttribute('aria-pressed', 'true');

    // 2. Persistent Bot node
    const botNode = screen.getByTestId('workflow-node-triage-bot');
    expect(
      within(botNode).getByText('Persistent Bot · Fixed Session Memory')
    ).toBeInTheDocument();
    expect(within(botNode).getByText('Coalesce Batch')).toBeInTheDocument();

    // 3. Fresh Session node
    const sessionNode = screen.getByTestId('workflow-node-coder-session');
    expect(
      within(sessionNode).getByText('Fresh Session · Context Resets Per Run')
    ).toBeInTheDocument();
    expect(
      within(sessionNode).getByText('isolated_worktree')
    ).toBeInTheDocument();

    // 4. Group Stage node
    const groupNode = screen.getByTestId('workflow-node-council-stage');
    expect(within(groupNode).getByText('Group Stage')).toBeInTheDocument();
    expect(
      within(groupNode).getByText(/Moderator Triage · lead-bot/)
    ).toBeInTheDocument();

    // 5. Flow Control BoundedLoop node with tabular-nums Max 4x badge
    const controlNode = screen.getByTestId('workflow-node-review-loop');
    expect(
      within(controlNode).getByText('Flow Control · BoundedLoop')
    ).toBeInTheDocument();
    const loopBadge = within(controlNode).getByText('Max 4x');
    expect(loopBadge).toHaveClass('tabular-nums');

    // 6. User Gate node with tabular-nums SLA badge
    const gateNode = screen.getByTestId('workflow-node-owner-gate');
    expect(
      within(gateNode).getByText('User Gate · Approval')
    ).toBeInTheDocument();
    expect(within(gateNode).getByText('SLA 1800s')).toHaveClass('tabular-nums');

    // 7. Outbox Action node
    const outboxNode = screen.getByTestId('workflow-node-gh-outbox');
    expect(
      within(outboxNode).getByText('Outbox · GitHub Comment')
    ).toBeInTheDocument();
  });

  it('switches execution primitive between Fresh Session and Persistent Bot in the Visual inspector', () => {
    render(<StatefulStudioHarness />);

    fireEvent.click(
      within(screen.getByTestId('workflow-node-coder-session')).getByRole(
        'button',
        { name: /coder-session/i }
      )
    );

    // Switch Fresh Session -> Persistent Bot
    fireEvent.click(screen.getByTestId('inspector-primitive-bot'));
    expect(
      within(screen.getByTestId('workflow-node-coder-session')).getByText(
        'Persistent Bot · Fixed Session Memory'
      )
    ).toBeInTheDocument();

    // Switch Persistent Bot -> Fresh Session
    fireEvent.click(screen.getByTestId('inspector-primitive-session'));
    expect(
      within(screen.getByTestId('workflow-node-coder-session')).getByText(
        'Fresh Session · Context Resets Per Run'
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
      within(screen.getByTestId('workflow-node-review-loop')).getByText('Max 5x')
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('inspector-json-validation')).getByText(
        '0 issues'
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
        'Matched'
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
  it('exposes Workflow Studio under Features and opens vibex.workflow-creator', () => {
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

    expect(openPluginPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'vibex.workflow-creator',
        contributionId: 'workflow-studio',
      })
    );
  });
});
