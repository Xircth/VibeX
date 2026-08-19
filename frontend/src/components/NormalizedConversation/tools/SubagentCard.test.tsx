import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ToolResultBlock, ToolUseBlock } from '../messageTurnBlocks';
import { SubagentCard } from './SubagentCard';

vi.mock('../AstryxMarkdown', () => ({
  AstryxMarkdown: ({ value }: { value: string }) => (
    <div data-testid="markdown">{value}</div>
  ),
}));

function use(input: unknown, meta: unknown = null): ToolUseBlock {
  return {
    type: 'tool_use',
    tool_use_id: 'call-1',
    tool_name: 'spawn_subagent',
    kind: null,
    input_preview: JSON.stringify(input),
    meta: meta as ToolUseBlock['meta'],
  };
}

function result(output: string): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: 'call-1',
    output_preview: output,
    is_error: false,
    agent_stats: null,
  };
}

describe('SubagentCard', () => {
  it('shows status, prompt, tools, context, and tokens', () => {
    render(
      <SubagentCard
        use={use(
          {
            subagent_type: 'explore',
            description: 'Audit agent message stream',
            prompt: 'Inspect the parent transcript',
          },
          {
            subagent: {
              status: 'background',
              progress: {
                toolCallCount: 125,
                turnCount: 1,
                durationMs: 324000,
                contextUsagePct: 32,
                tokenCount: 18432,
              },
            },
          }
        )}
        result={result('Subagent started in background.')}
      />
    );

    expect(
      screen.getByRole('group', { name: 'explore: Audit agent message stream' })
    ).toBeInTheDocument();
    expect(screen.getByText('后台运行中')).toBeInTheDocument();
    expect(screen.getByText('耗时 5.4 分钟')).toBeInTheDocument();
    expect(
      screen.getByText('125 次工具调用 · 1 轮 · 18k tokens')
    ).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /上下文 32%/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '提示词' }));
    expect(screen.getByTestId('markdown')).toHaveTextContent(
      'Inspect the parent transcript'
    );
    expect(
      screen.queryByRole('button', { name: /查看子智能体|open child/i })
    ).not.toBeInTheDocument();
  });

  it('keeps prompt and result collapsed, exclusive, and rendered as markdown', () => {
    render(
      <SubagentCard
        use={use({
          subagent_type: 'general-purpose',
          description: 'Search GitHub similar projects',
          prompt: 'Find **similar** projects.',
        })}
        result={result(
          JSON.stringify({
            type: 'TaskOutput',
            Result: {
              status: 'completed',
              started: '2026-08-17T14:23:52Z',
              ended: '2026-08-17T14:28:52Z',
              output: '# Similar-project search\n\nThere are **none**.',
            },
          })
        )}
      />
    );

    expect(screen.getByRole('button', { name: '提示词' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.getByRole('button', { name: '结果' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    const resultToggle = screen.getByRole('button', { name: '结果' });
    const duration = screen.getByText('耗时 5 分钟');
    const status = screen.getByText('已完成');
    expect(
      resultToggle.compareDocumentPosition(duration) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      duration.compareDocumentPosition(status) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '结果' }));
    expect(screen.getByTestId('markdown')).toHaveTextContent(
      '# Similar-project search There are **none**.'
    );
    expect(screen.getByTestId('markdown')).not.toHaveTextContent('TaskOutput');
    expect(screen.getByRole('button', { name: '结果' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByRole('button', { name: '提示词' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );

    fireEvent.click(screen.getByRole('button', { name: '提示词' }));
    expect(screen.getByTestId('markdown')).toHaveTextContent(
      'Find **similar** projects.'
    );
    expect(screen.getByRole('button', { name: '提示词' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByRole('button', { name: '结果' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('shows the delegated Grok brand mark instead of the generic robot', () => {
    render(
      <SubagentCard
        use={use({ agent_type: 'grok', task: 'Review the diff' })}
        result={result('Subagent started in background.')}
      />
    );

    expect(screen.getByTitle('Grok')).toBeInTheDocument();
    expect(document.querySelector('.lucide-bot')).not.toBeInTheDocument();
  });
});
