import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatToolCallItem } from '@astryxdesign/core/Chat';
import { BackendTransportProvider } from '@/lib/transport';
import type { BackendTransport } from '@/lib/backendTransport';
import { TurnToolCalls } from './TurnToolCalls';
import type { IndexedTurnItem } from './messageTurnAggregate';
import type { ToolResultBlock, ToolUseBlock } from './messageTurnBlocks';

const captured = vi.hoisted(() => ({
  groups: [] as Array<{
    calls: ChatToolCallItem[];
    defaultIsExpanded?: boolean;
  }>,
}));

vi.mock('@astryxdesign/core/Chat', () => ({
  ChatToolCalls: ({
    calls,
    defaultIsExpanded,
  }: {
    calls: ChatToolCallItem[];
    defaultIsExpanded?: boolean;
  }) => {
    captured.groups.push({ calls, defaultIsExpanded });
    return (
      <div data-testid="chat-tool-calls">
        {calls.map((call) => (
          <div key={call.key ?? call.name}>
            <span>{call.name}</span>
            {call.stats}
            {call.resultDetail}
          </div>
        ))}
      </div>
    );
  },
}));

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

function capturedNames(): string[] {
  return captured.groups.flatMap((group) =>
    group.calls.map((call) => String(call.name ?? ''))
  );
}

describe('TurnToolCalls subagent expansion', () => {
  it('renders the host product card for MCP delegation and shows the poll tool', () => {
    captured.groups = [];
    const transport = {
      environment: 'desktop',
      call: vi.fn().mockResolvedValue(undefined),
    } satisfies BackendTransport;
    render(
      <BackendTransportProvider transport={transport}>
        <TurnToolCalls
          turnId="turn-1"
          timestamp="2026-08-18T00:00:00.000Z"
          offset={0}
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
    expect(
      capturedNames().some((name) =>
        /get_delegation_status|子代理状态|Sub-agent status/i.test(name)
      )
    ).toBe(true);
    expect(capturedNames()).not.toContain('子代理');
    expect(
      capturedNames().some((name) =>
        /vibex-delegation-mcp__delegate_to_agent/.test(name)
      )
    ).toBe(false);
    expect(
      captured.groups
        .filter((group) =>
          group.calls.some((call) => /终端|Terminal/.test(String(call.name)))
        )
        .every((group) => group.defaultIsExpanded === false)
    ).toBe(true);
  });

  it('expands the card result from the sibling poll instead of a truncated preview', () => {
    captured.groups = [];
    const full =
      '你好，我是 Codex，OpenAI 的编程助手。我擅长阅读现有代码、编写和修改实现、运行测试，并在动手前先说明我打算做什么。';
    const transport = {
      environment: 'desktop',
      call: vi.fn().mockResolvedValue(undefined),
    } satisfies BackendTransport;
    render(
      <BackendTransportProvider transport={transport}>
        <TurnToolCalls
          turnId="turn-result"
          timestamp="2026-08-18T00:00:00.000Z"
          offset={0}
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

    fireEvent.click(screen.getByRole('button', { name: '结果' }));
    expect(screen.getByTestId('markdown')).toHaveTextContent(full);
    expect(screen.queryByText(/\.\.\.$/)).not.toBeInTheDocument();
    expect(screen.getByTestId('host-delegation-duration')).toHaveTextContent(
      '耗时 1.5 秒'
    );
  });

  it('renders only the product card for prefixed and Grok-envelope MCP names', () => {
    captured.groups = [];
    const transport = {
      environment: 'desktop',
      call: vi.fn().mockResolvedValue(undefined),
    } satisfies BackendTransport;
    render(
      <BackendTransportProvider transport={transport}>
        <TurnToolCalls
          turnId="turn-2"
          timestamp="2026-08-18T00:00:00.000Z"
          offset={0}
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

    expect(screen.getAllByTestId('host-delegation-card')).toHaveLength(3);
    expect(
      screen.queryByText(/vibex-delegation-mcp__delegate_to_agent/)
    ).not.toBeInTheDocument();
    expect(capturedNames()).not.toContain('子代理');
    expect(
      capturedNames().some((name) =>
        /搜索|Search|delegate_to_agent|vibex-delegation/.test(name)
      )
    ).toBe(false);
  });
});
