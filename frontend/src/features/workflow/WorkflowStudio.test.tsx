import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import type { WorkflowDefinition } from 'shared/types';

import { WorkflowStudio } from './WorkflowStudio';

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
