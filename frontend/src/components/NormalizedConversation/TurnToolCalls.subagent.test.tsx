import { render, screen } from '@testing-library/react';
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

describe('TurnToolCalls subagent expansion', () => {
  it('renders the host product card for MCP delegation and hides the poll tool', () => {
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
              null,
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
    expect(
      screen.getByRole('group', { name: '委派给 Grok' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { expanded: true })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(
      captured.groups.some((group) =>
        group.calls.some((call) =>
          /get_delegation_status|子代理状态|Sub-agent status/i.test(
            String(call.name)
          )
        )
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
});
