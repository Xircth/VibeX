import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, vi } from 'vitest';
import type { WorkflowDefinition } from 'shared/types';

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
      prompt: 'Start',
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

describe('WorkflowStudio', () => {
  beforeEach(() => {
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

    expect(screen.getByText('start')).toBeInTheDocument();
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

  it('selects a node, anchors an inspector tether, and keeps confirmation on the node', async () => {
    render(
      <WorkflowStudio
        definition={definition}
        onDefinitionChange={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(screen.getByRole('button', { name: /start/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByTestId('workflow-inspector-tether')).toBeInTheDocument();
    expect(screen.getByText(/完成后|after completion/i)).toBeInTheDocument();
  });

  it('shows live graph metrics and exposes undo as an editor action', async () => {
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
    expect(screen.queryByText(/1.*Agent/i)).toBeNull();
    expect(screen.queryByText('v0.4')).toBeNull();

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

  it('creates the selected node type from the add-node popover', async () => {
    const user = userEvent.setup();
    const onDefinitionChange = vi.fn();
    render(
      <WorkflowStudio
        definition={definition}
        onDefinitionChange={onDefinitionChange}
      />
    );

    await user.click(
      screen.getByRole('button', { name: /添加节点|add node/i })
    );
    await user.click(
      screen.getByRole('menuitem', { name: /通知节点|notification/i })
    );

    expect(onDefinitionChange).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({ kind: 'notify' }),
        ]),
      })
    );
  });

  it('creates an Agent node with the user default Agent', async () => {
    const user = userEvent.setup();
    const onDefinitionChange = vi.fn();
    render(
      <WorkflowStudio
        definition={definition}
        onDefinitionChange={onDefinitionChange}
        agentOptions={[
          { value: 'codex', label: 'Codex', runnable: true },
          { value: 'grok', label: 'Grok', runnable: true },
          { value: 'claude_code', label: 'Claude Code', runnable: false },
        ]}
      />
    );

    await user.click(
      screen.getByRole('button', { name: /添加节点|add node/i })
    );
    await user.click(screen.getByRole('menuitem', { name: /Agent|代理/i }));

    expect(onDefinitionChange).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({ kind: 'agent', agentId: 'grok' }),
        ]),
      })
    );
  });

  it('shows enabled Agents and greys out Agents that are not ready', async () => {
    const user = userEvent.setup();
    render(
      <WorkflowStudio
        definition={definition}
        onDefinitionChange={() => undefined}
        agentOptions={[
          { value: 'codex', label: 'Codex', runnable: true },
          { value: 'claude_code', label: 'Claude Code', runnable: false },
        ]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /start codex/i }));
    await user.click(screen.getAllByRole('combobox')[0]);

    expect(
      await screen.findByRole('option', { name: /Claude Code/i })
    ).toHaveAttribute('data-disabled');
    expect(screen.getByRole('option', { name: /Codex/i })).not.toHaveAttribute(
      'data-disabled'
    );
  });

  it('shows read-only graph relations and edits the node id from the title', async () => {
    render(
      <WorkflowStudio
        definition={connectedDefinition}
        onDefinitionChange={() => undefined}
        agentOptions={[
          { value: 'codex', label: 'Codex' },
          { value: 'claude_code', label: 'Claude Code' },
        ]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /start codex/i }));

    expect(screen.queryByText(/节点 ID|step id/i)).not.toBeInTheDocument();
    expect(screen.getByText(/前置节点|predecessors/i)).toBeInTheDocument();
    expect(screen.getByText(/后置节点|successors/i)).toBeInTheDocument();
    expect(screen.getAllByText('finish')).not.toHaveLength(0);
    expect(
      screen.getByRole('textbox', { name: /节点名称|node name/i })
    ).toHaveValue('start');
    expect(screen.getByText(/完成后|after completion/i)).toBeInTheDocument();
    expect(
      screen.getByText(/输出要求|output requirement/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /严格|strict/i })
    ).toBeInTheDocument();
    expect(screen.queryByText(/工作区访问|workspace access/i)).toBeNull();
  });

  it('switches the output requirement between brief description and strict JSON Schema tabs', async () => {
    const user = userEvent.setup();
    const onDefinitionChange = vi.fn();
    render(
      <WorkflowStudio
        definition={definition}
        onDefinitionChange={onDefinitionChange}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /start codex/i }));

    expect(
      screen.getByRole('button', { name: /严格|strict/i })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /简要|brief/i }));

    const description = screen.getByRole('textbox', {
      name: /输出要求|output requirement/i,
    });
    fireEvent.change(description, {
      target: { value: 'a one-paragraph brief' },
    });
    fireEvent.blur(description);

    expect(onDefinitionChange).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({
            id: 'start',
            outputDescription: 'a one-paragraph brief',
            outputSchema: null,
          }),
        ]),
      })
    );
  });

  it('clears the default JSON Schema when switching an Agent step to a brief output requirement', async () => {
    const user = userEvent.setup();
    const onDefinitionChange = vi.fn();
    const schemaDefinition: WorkflowDefinition = {
      ...definition,
      steps: [
        {
          ...(definition.steps[0] as Extract<
            WorkflowDefinition['steps'][number],
            { kind: 'agent' }
          >),
          outputSchema: {
            type: 'object',
            required: ['summary'],
            properties: { summary: { type: 'string' } },
          },
        },
      ],
    };
    render(
      <WorkflowStudio
        definition={schemaDefinition}
        onDefinitionChange={onDefinitionChange}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /start codex/i }));
    await user.click(screen.getByRole('button', { name: /简要|brief/i }));

    expect(onDefinitionChange).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({
            id: 'start',
            outputSchema: null,
          }),
        ]),
      })
    );
  });

  it('shows Grok model, effort, and permission in the node inspector summary', async () => {
    const grokDefinition: WorkflowDefinition = {
      ...definition,
      steps: [
        {
          ...(definition.steps[0] as Extract<
            WorkflowDefinition['steps'][number],
            { kind: 'agent' }
          >),
          agentId: 'grok',
        },
      ],
    };
    render(
      <WorkflowStudio
        definition={grokDefinition}
        onDefinitionChange={() => undefined}
        agentOptions={[{ value: 'grok', label: 'Grok' }]}
        loadAgentSessionControls={async () => ({
          current_mode: 'default',
          modes: [
            { id: 'default', label: 'Ask', description: null },
            { id: 'bypassPermissions', label: 'Bypass', description: null },
          ],
          config_options: [
            {
              key: 'model',
              label: 'Model',
              category: 'model',
              value: 'grok-4.6',
              choices: [
                { value: 'grok-4.6', label: 'Grok 4.6' },
                { value: 'grok-4.5', label: 'Grok 4.5' },
              ],
            },
            {
              key: 'effort',
              label: '推理强度',
              category: 'thought_level',
              value: 'high',
              choices: [
                { value: 'high', label: 'High Effort' },
                { value: 'medium', label: 'Medium Effort' },
              ],
            },
          ],
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /start grok/i }));
    const summary = await screen.findByTestId('session-settings-summary');
    expect(summary).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/Grok 4\.6/)
    );
    expect(summary).toHaveAttribute('aria-label', expect.stringMatching(/高/));
    expect(summary).toHaveAttribute('aria-label', expect.stringMatching(/Ask/));
    expect(screen.getAllByRole('img', { name: 'Grok' })[0]).toHaveAttribute(
      'src',
      '/agents/grok.svg'
    );
  });

  it('renders Kimi brand artwork instead of the generic glyph', () => {
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
      screen.getAllByRole('img', { name: 'Kimi Code' })[0]
    ).toHaveAttribute('src', '/agents/kimi.svg');
    expect(document.querySelector('.lucide-bot')).not.toBeInTheDocument();
  });

  it('keeps the native session controls request alive across parent rerenders', async () => {
    const loadControls = vi.fn().mockResolvedValue({
      current_mode: 'agent-full-access',
      modes: [{ id: 'agent-full-access', label: '完全访问' }],
      config_options: [],
    });
    const view = (name: string) => (
      <WorkflowStudio
        definition={{ ...definition, name }}
        onDefinitionChange={() => undefined}
        loadAgentSessionControls={(agentId) => loadControls(agentId)}
      />
    );
    const { rerender } = render(view('First render'));

    fireEvent.click(screen.getByRole('button', { name: /start codex/i }));
    expect(
      await screen.findByRole('button', {
        name: /本次会话: 完全访问|This session: Full Access/i,
      })
    ).toBeInTheDocument();

    rerender(view('Parent rerender'));
    expect(loadControls).toHaveBeenCalledTimes(1);
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

  it('duplicates an Agent node from the node context menu and hides copy on confirmation', async () => {
    const user = userEvent.setup();
    const onDefinitionChange = vi.fn();
    const { container } = render(
      <WorkflowStudio
        definition={definition}
        onDefinitionChange={onDefinitionChange}
      />
    );

    fireEvent.contextMenu(screen.getByRole('button', { name: /start/i }));
    await user.click(screen.getByRole('menuitem', { name: /复制|duplicate/i }));
    expect(onDefinitionChange).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({ id: 'start' }),
          expect.objectContaining({ kind: 'agent' }),
        ]),
      })
    );

    fireEvent.contextMenu(
      container.querySelector('.workflow-confirmation-node')!
    );
    expect(
      screen.queryByRole('menuitem', { name: /复制|duplicate/i })
    ).toBeNull();
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

  it('renders the conversation as a message stream with the shared chat composer', () => {
    const { container } = render(
      <WorkflowStudio
        definition={definition}
        onDefinitionChange={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /start codex/i }));
    fireEvent.click(screen.getByRole('button', { name: /对话|conversation/i }));

    expect(
      container.querySelector('.workflow-step-chat-composer')
    ).toBeInTheDocument();
    expect(screen.queryByText(/自动提示词|automatic prompt/i)).toBeNull();
    expect(
      screen.queryByPlaceholderText(/为此节点补充指导|additional guidance/i)
    ).toBeNull();
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

  it('renames dependent bindings atomically with the node id', () => {
    const onDefinitionChange = vi.fn();
    render(
      <WorkflowStudio
        definition={connectedDefinition}
        onDefinitionChange={onDefinitionChange}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /start codex/i }));
    fireEvent.change(
      screen.getByRole('textbox', { name: /节点名称|node name/i }),
      { target: { value: 'inventory' } }
    );

    expect(onDefinitionChange).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({ id: 'inventory' }),
          expect.objectContaining({
            id: 'finish',
            dependsOn: ['inventory'],
            inputBindings: {
              predecessor: {
                source: 'step_output',
                step_id: 'inventory',
                pointer: '',
              },
            },
          }),
        ]),
      })
    );
  });
});

describe('Track U2: Bilingual zh-CN/en Localization & Group/Gate Inspector Metadata', () => {
  it('switches cleanly between en and zh-CN across Toolbar, Replay Popover, all 9 node badges, Inspector fields, and DockPanel starter name', async () => {
    const i18n = (await import('@/i18n')).default;
    const { act, within, waitFor } = await import('@testing-library/react');
    const { BUILT_IN_SAMPLE_EVENTS } = await import('@/features/pulse');
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
          evalMode: 'observe',
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
          prompt: 'Analyze {{threadKey}}',
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
          prompt: 'Summarize {{threadKey}}',
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
          prompt: 'Converge on plan',
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

    // Verify lossless round-trip of group_stage.rounds/quorumCount and user_gate.severity
    const roundTripped = toStudioWorkflowDefinition(
      toBackendWorkflowDefinition(showcase)
    );
    const rtGroup = roundTripped.steps.find((s) => s.id === 'n-group');
    expect(rtGroup?.kind === 'group_stage' ? rtGroup.rounds : null).toBe(3);
    expect(rtGroup?.kind === 'group_stage' ? rtGroup.quorumCount : null).toBe(2);
    const rtGate = roundTripped.steps.find((s) => s.id === 'n-gate');
    expect(rtGate?.kind === 'user_gate' ? rtGate.severity : null).toBe('urgent');

    try {
      await act(async () => {
        await i18n.changeLanguage('en');
      });

      const user = userEvent.setup();
      const { unmount } = render(
        <WorkflowStudio
          studioMode
          definition={showcase}
          onDefinitionChange={vi.fn()}
          capturedEvents={BUILT_IN_SAMPLE_EVENTS}
        />
      );

      // English assertions
      expect(screen.getByTestId('workflow-presets-trigger')).toHaveTextContent(
        'Templates'
      );
      expect(screen.getByText('Hybrid Pipeline')).toBeInTheDocument();
      expect(screen.getByTestId('workflow-replay-trigger')).toHaveTextContent(
        'Event Replay'
      );

      await user.click(screen.getByRole('button', { name: /^Add node$/i }));
      for (const label of [
        'Event Trigger',
        'Ephemeral Session',
        'Persistent Bot',
        'Group Stage',
        'User Gate',
        'Condition Branch',
        'Bounded Loop',
        'Wait For Event',
        'Outbox Action',
      ]) {
        expect(screen.getByRole('menuitem', { name: label })).toBeInTheDocument();
      }
      await user.keyboard('{Escape}');

      for (const [id, badge] of [
        ['n-trigger', 'TRIGGER'],
        ['n-session', 'SESSION'],
        ['n-bot', 'BOT'],
        ['n-group', 'GROUP'],
        ['n-loop', 'LOOP'],
        ['n-wait', 'WAIT'],
        ['n-branch', 'BRANCH'],
        ['n-gate', 'GATE'],
        ['n-outbox', 'OUTBOX'],
      ] as const) {
        expect(
          screen.getByTestId(`workflow-node-category-badge-${id}`)
        ).toHaveTextContent(badge);
      }
      expect(
        within(screen.getByTestId('workflow-node-n-group')).getByText(
          'Max 3x · Quorum 2'
        )
      ).toHaveClass('tabular-nums');
      expect(
        within(screen.getByTestId('workflow-node-n-loop')).getByText('Max 4x')
      ).toHaveClass('tabular-nums');

      fireEvent.click(screen.getByTestId('workflow-replay-trigger'));
      fireEvent.click(
        screen.getByTestId(
          `workflow-replay-sample-${BUILT_IN_SAMPLE_EVENTS[2].eventId}`
        )
      );
      expect(
        within(screen.getByTestId('workflow-trigger-replay-n-trigger')).getByText(
          'Matched'
        )
      ).toBeVisible();

      fireEvent.click(
        within(screen.getByTestId('workflow-node-n-group')).getByRole('button', {
          name: /n-group/i,
        })
      );
      expect(screen.getByLabelText('Max Rounds')).toHaveValue(3);
      expect(screen.getByLabelText('Quorum Seats')).toHaveValue(2);

      fireEvent.click(
        within(screen.getByTestId('workflow-node-n-gate')).getByRole('button', {
          name: /n-gate/i,
        })
      );
      expect(screen.getByTestId('inspector-user-gate-severity')).toHaveTextContent(
        'Urgent'
      );

      // Switch live to zh-CN
      await act(async () => {
        await i18n.changeLanguage('zh-CN');
      });

      expect(screen.getByTestId('workflow-presets-trigger')).toHaveTextContent(
        '场景模板'
      );
      expect(screen.getByText('混合交付流水线')).toBeInTheDocument();
      expect(screen.getByTestId('workflow-replay-trigger')).toHaveTextContent(
        '事件回放演练'
      );
      for (const [id, badge] of [
        ['n-trigger', '触发器'],
        ['n-session', '临时会话'],
        ['n-bot', 'Bot 助手'],
        ['n-group', '群组协作'],
        ['n-loop', '循环'],
        ['n-wait', '等待事件'],
        ['n-branch', '条件分支'],
        ['n-gate', '人工门控'],
        ['n-outbox', '回写动作'],
      ] as const) {
        expect(
          screen.getByTestId(`workflow-node-category-badge-${id}`)
        ).toHaveTextContent(badge);
      }
      expect(
        within(screen.getByTestId('workflow-node-n-group')).getByText(
          '最多 3 轮 · 法定 2 席'
        )
      ).toBeInTheDocument();
      expect(
        within(screen.getByTestId('workflow-node-n-loop')).getByText('最多 4 轮')
      ).toBeInTheDocument();
      expect(
        within(screen.getByTestId('workflow-trigger-replay-n-trigger')).getByText(
          '命中'
        )
      ).toBeVisible();
      expect(screen.getByTestId('inspector-user-gate-severity')).toHaveTextContent(
        '紧急'
      );

      unmount();

      // Verify DockPanel bilingual starter workflow name & Pulse Rules shortcut label
      await act(async () => {
        await i18n.changeLanguage('en');
      });
      const mockTransport = {
        environment: 'desktop' as const,
        call: vi.fn(async (cmd: string) => {
          if (cmd === 'workflow_list') return [];
          if (cmd === 'pulse_captured_events') return [];
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
        ).toHaveTextContent('Pulse Rules');
      });
      expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue(
        'New Workflow'
      );

      await act(async () => {
        await i18n.changeLanguage('zh-CN');
      });
      expect(
        screen.getByTestId('workflow-studio-open-pulse-deck')
      ).toHaveTextContent('脉冲自动化');
      fireEvent.click(screen.getByRole('button', { name: '新建工作流' }));
      expect(screen.getByRole('textbox', { name: '名称' })).toHaveValue(
        '新建工作流'
      );
    } finally {
      await act(async () => {
        await i18n.changeLanguage('zh-CN');
      });
    }
  });
});
