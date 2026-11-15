import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BackendTransportProvider } from '@/lib/transport';
import type { BackendTransport } from '@/lib/backendTransport';
import { TurnActivity } from './TurnActivity';
import type { IndexedTurnItem } from './messageTurnAggregate';
import type { ToolResultBlock, ToolUseBlock } from './messageTurnBlocks';

vi.mock('./DisplayConversationEntry', () => ({
  default: () => <div />,
}));

vi.mock('./AstryxMarkdown', () => ({
  AstryxMarkdown: ({ value }: { value: string }) => (
    <div data-testid="markdown">{value}</div>
  ),
}));

function toolItem(
  toolName: string,
  input: unknown,
  output: string | null,
  index: number
): IndexedTurnItem {
  const use: ToolUseBlock = {
    type: 'tool_use',
    tool_use_id: `tool-${index}`,
    tool_name: toolName,
    kind: null,
    input_preview: JSON.stringify(input),
    meta: null,
  };
  const result: ToolResultBlock | null =
    output == null
      ? null
      : {
          type: 'tool_result',
          tool_use_id: `tool-${index}`,
          output_preview: output,
          is_error: false,
          agent_stats: null,
        };
  return {
    item: { kind: 'tool', use, result },
    index,
  };
}

function renderedChipRowTexts(): string[] {
  return screen
    .queryAllByTestId('turn-tool-chip-row')
    .map((row) => row.textContent ?? '');
}

describe('TurnActivity subagent expansion', () => {
  it('preserves an opened delegation result when it moves into an activity batch', () => {
    const delegation = toolItem(
      'delegate_to_agent',
      { agent_type: 'codex', task: 'Review' },
      JSON.stringify({
        task_id: 'review-1',
        status: 'completed',
        text: 'Review result',
      }),
      0
    );
    const props = {
      turnId: 'regrouped-delegation',
      timestamp: '2026-10-10T00:00:00.000Z',
      attempt: { id: 'ws-1', container_ref: null } as never,
      task: null,
      isStreaming: true,
    };
    const transport = {
      environment: 'web',
      call: vi.fn().mockResolvedValue(undefined),
    } satisfies BackendTransport;
    const view = (items: IndexedTurnItem[]) => (
      <BackendTransportProvider transport={transport}>
        <TurnActivity {...props} items={items} />
      </BackendTransportProvider>
    );
    const { rerender } = render(view([delegation]));
    fireEvent.click(screen.getByRole('button', { name: '结果' }));
    expect(screen.getByText('Review result')).toBeInTheDocument();
    rerender(
      view([
        delegation,
        ...Array.from({ length: 3 }, (_, index) =>
          toolItem('bash', { command: `later-${index}` }, null, index + 1)
        ),
      ])
    );
    expect(
      screen.getByRole('button', { name: /启动 1 个智能体/ })
    ).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: '结果' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByText('Review result')).toBeInTheDocument();
  });

  it('renders the host product card for MCP delegation and shows the poll tool', () => {
    const transport = {
      environment: 'desktop',
      call: vi.fn().mockResolvedValue(undefined),
    } satisfies BackendTransport;
    render(
      <BackendTransportProvider transport={transport}>
        <TurnActivity
          turnId="turn-1"
          timestamp="2026-08-18T00:00:00.000Z"
          items={[
            toolItem(
              'delegate_to_agent',
              { agent_type: 'grok', task: 'Review the diff' },
              'task_id: task-1',
              0
            ),
            toolItem(
              'get_delegation_status',
              { task_ids: ['task-1'] },
              JSON.stringify({
                tasks: [
                  {
                    status: 'completed',
                    text: '你好，我是 Codex',
                  },
                ],
              }),
              1
            ),
            toolItem('bash', { command: 'ls' }, 'ok', 2),
          ]}
          attempt={{ id: 'ws-1', container_ref: null } as never}
          task={null}
        />
      </BackendTransportProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: /启动 1 个智能体/ }));
    expect(screen.getByTestId('host-delegation-card')).toBeInTheDocument();
    expect(screen.getByTitle('Grok')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Grok' })).toBeInTheDocument();
    expect(
      screen.queryByText(/vibex-delegation-mcp__delegate_to_agent/)
    ).not.toBeInTheDocument();
    const statusRow = screen.getByTestId('host-delegation-status-row');
    expect(statusRow).toHaveTextContent('子代理状态');
    expect(statusRow).toHaveTextContent('已完成');
    expect(screen.queryByText(/你好，我是 Codex/)).not.toBeInTheDocument();
    expect(renderedChipRowTexts()).not.toContain('子代理');
    expect(
      renderedChipRowTexts().some((name) =>
        /vibex-delegation-mcp__delegate_to_agent/.test(name)
      )
    ).toBe(false);
  });

  it('expands the card result from the sibling poll instead of a truncated preview', () => {
    const full =
      '你好，我是 Codex，OpenAI 的编程助手。我擅长阅读现有代码、编写和修改实现、运行测试，并在动手前先说明我打算做什么。';
    const transport = {
      environment: 'desktop',
      call: vi.fn().mockResolvedValue(undefined),
    } satisfies BackendTransport;
    render(
      <BackendTransportProvider transport={transport}>
        <TurnActivity
          turnId="turn-result"
          timestamp="2026-08-18T00:00:00.000Z"
          items={[
            toolItem(
              'delegate_to_agent',
              { agent_type: 'codex', task: 'introduce yourself' },
              JSON.stringify({
                task_id: 'task-1',
                status: 'running',
                child_session_id: 'child-1',
              }),
              0
            ),
            toolItem(
              'get_delegation_status',
              { task_ids: ['task-1'] },
              JSON.stringify({
                tasks: [
                  {
                    task_id: 'task-1',
                    status: 'completed',
                    text: full,
                    duration_ms: 1500,
                    child_session_id: 'child-1',
                  },
                ],
              }),
              1
            ),
          ]}
          attempt={{ id: 'ws-1', container_ref: null } as never}
          task={null}
          delegations={[
            {
              delegation_id: 'd1',
              parent_tool_call_id: 'tool-0',
              child_conversation_id: 'child-1',
              agent_id: 'codex',
              task_preview: 'introduce yourself',
              status: 'completed',
              result: {
                kind: 'ok',
                text_preview: `${full.slice(0, 40)}...`,
                duration_ms: 0n,
              },
            },
          ]}
        />
      </BackendTransportProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: /启动 1 个智能体/ }));
    fireEvent.click(screen.getByRole('button', { name: '结果' }));
    expect(screen.getByTestId('markdown')).toHaveTextContent(full);
    expect(screen.queryByText(/\.\.\.$/)).not.toBeInTheDocument();
    expect(screen.getByTestId('host-delegation-duration')).toHaveTextContent(
      '耗时 1.5 秒'
    );
  });

  it('renders only the product card for prefixed and Grok-envelope MCP names', () => {
    const transport = {
      environment: 'desktop',
      call: vi.fn().mockResolvedValue(undefined),
    } satisfies BackendTransport;
    render(
      <BackendTransportProvider transport={transport}>
        <TurnActivity
          turnId="turn-2"
          timestamp="2026-08-18T00:00:00.000Z"
          items={[
            toolItem(
              'vibex-delegation-mcp__delegate_to_agent',
              { agent_type: 'codex', task: 'introduce yourself' },
              null,
              0
            ),
            toolItem(
              'use_tool',
              {
                tool_name: 'vibex-delegation-mcp__delegate_to_agent',
                tool_input: {
                  agent_type: 'codex',
                  task: 'introduce yourself',
                },
              },
              null,
              1
            ),
            toolItem(
              'use_tool',
              { agent_type: 'codex', task: 'introduce yourself' },
              null,
              2
            ),
            toolItem('search_tool', { query: 'delegate_to_agent' }, null, 3),
            toolItem('Search', { query: 'delegate_to_agent' }, null, 4),
            toolItem('search_tool', {}, null, 5),
            toolItem('bash', { command: 'ls' }, 'ok', 6),
          ]}
          attempt={{ id: 'ws-1', container_ref: null } as never}
          task={null}
        />
      </BackendTransportProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: /启动 3 个智能体/ }));
    expect(screen.getAllByTestId('host-delegation-card')).toHaveLength(3);
    expect(
      screen.queryByText(/vibex-delegation-mcp__delegate_to_agent/)
    ).not.toBeInTheDocument();
    expect(renderedChipRowTexts()).not.toContain('子代理');
    expect(
      renderedChipRowTexts().some((name) =>
        /搜索|Search|delegate_to_agent|vibex-delegation/.test(name)
      )
    ).toBe(false);
  });

  it('preserves the dedicated question card inside the activity aggregate', () => {
    render(
      <TurnActivity
        turnId="turn-ask-card"
        timestamp="2026-08-18T00:00:00.000Z"
        items={[
          toolItem(
            'ask_user_question',
            {
              questions: [
                {
                  id: 'tracker',
                  question: 'Pick a tracker',
                  options: [{ label: 'Local markdown' }],
                },
              ],
            },
            JSON.stringify({
              outcome: 'accepted',
              answers: { tracker: ['Local markdown'] },
            }),
            0
          ),
          toolItem('bash', { command: 'ls' }, 'ok', 1),
        ]}
        attempt={{ id: 'ws-1', container_ref: null } as never}
        task={null}
      />
    );

    expect(screen.getByTestId('ask-question-tool-card')).toBeInTheDocument();
    expect(screen.getByText('Pick a tracker')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '查看详情' })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '运行 1 个命令' }));
    expect(screen.getByText('ls')).toBeInTheDocument();
    expect(
      renderedChipRowTexts().some((name) =>
        /ask_user_question|问题|Question/i.test(name)
      )
    ).toBe(false);
  });

  it('skips the tool-use question card while a matching elicitation row is pending and renders it in-place once answered', () => {
    const { rerender } = render(
      <TurnActivity
        turnId="turn-ask-pending"
        timestamp="2026-08-18T00:00:00.000Z"
        items={[
          toolItem(
            'ask_user_question',
            {
              questions: [
                {
                  id: 'tracker',
                  question: 'Pick a tracker',
                  options: [{ label: 'Local markdown' }],
                },
              ],
            },
            null,
            0
          ),
          toolItem('bash', { command: 'ls' }, 'ok', 1),
        ]}
        questions={[
          {
            request: {
              question_id: 'q-tracker',
              prompt: 'Pick a tracker',
              options: ['Local markdown'],
            },
            response: null,
          },
        ]}
        attempt={{ id: 'ws-1', container_ref: null } as never}
        task={null}
      />
    );

    expect(
      screen.queryByTestId('ask-question-tool-card')
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '运行 1 个命令' }));
    expect(screen.getByText('ls')).toBeInTheDocument();

    rerender(
      <TurnActivity
        turnId="turn-ask-pending"
        timestamp="2026-08-18T00:00:00.000Z"
        items={[
          toolItem(
            'ask_user_question',
            {
              questions: [
                {
                  id: 'tracker',
                  question: 'Pick a tracker',
                  options: [{ label: 'Local markdown' }],
                },
              ],
            },
            JSON.stringify({
              outcome: 'accepted',
              answers: { tracker: ['Local markdown'] },
            }),
            0
          ),
          toolItem('bash', { command: 'ls' }, 'ok', 1),
        ]}
        questions={[
          {
            request: {
              question_id: 'q-tracker',
              prompt: 'Pick a tracker',
              options: ['Local markdown'],
            },
            response: { answer: 'Local markdown' },
          },
        ]}
        attempt={{ id: 'ws-1', container_ref: null } as never}
        task={null}
      />
    );

    expect(screen.getByTestId('ask-question-tool-card')).toBeInTheDocument();
    expect(screen.getByText('Pick a tracker')).toBeInTheDocument();
  });

  it('nests Claude child tool calls inside SubagentCard and excludes them from top-level tool rows', () => {
    const parentSubagent = toolItem(
      'Agent',
      {
        subagent_type: 'Explore',
        description: 'Inspect repository structure',
      },
      'Repository structure verified.',
      0
    );
    if (parentSubagent.item.kind === 'tool' && parentSubagent.item.use) {
      parentSubagent.item.use.tool_use_id = 'toolu_parent';
      parentSubagent.item.use.meta = {
        claudeCode: { subagent: true },
        subagent: { thinking: 'Scanning directories...' },
      };
      if (parentSubagent.item.result) {
        parentSubagent.item.result.tool_use_id = 'toolu_parent';
      }
    }
    const childBash = toolItem(
      'Bash',
      { command: 'git status --short' },
      'M README.md',
      1
    );
    if (childBash.item.kind === 'tool' && childBash.item.use) {
      childBash.item.use.tool_use_id = 'toolu_child_bash';
      childBash.item.use.meta = {
        claudeCode: {
          toolName: 'Bash',
          parentToolUseId: 'toolu_parent',
          title: 'Check git status',
        },
      };
      if (childBash.item.result) {
        childBash.item.result.tool_use_id = 'toolu_child_bash';
      }
    }

    render(
      <TurnActivity
        turnId="turn-claude-nested"
        timestamp="2026-08-18T00:00:00.000Z"
        items={[parentSubagent, childBash]}
        attempt={
          {
            id: 'ws-1',
            container_ref: null,
            session: { agent_id: 'claude_code' },
          } as never
        }
        task={null}
        isStreaming={true}
      />
    );

    expect(
      screen.getByRole('group', {
        name: 'Explore: Inspect repository structure',
      })
    ).toBeInTheDocument();
    const childTools = screen.getByTestId('subagent-child-tools');
    expect(childTools).toHaveTextContent('Check git status');
    expect(childTools).toHaveTextContent('git status --short');
    expect(screen.getByTestId('subagent-thinking')).toHaveTextContent(
      'Scanning directories...'
    );
    expect(
      renderedChipRowTexts().some((name) =>
        /git status|Check git status/i.test(name)
      )
    ).toBe(false);
  });
});
