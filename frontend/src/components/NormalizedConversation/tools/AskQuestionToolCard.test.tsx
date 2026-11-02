import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ToolResultBlock, ToolUseBlock } from '../messageTurnBlocks';
import { AskQuestionToolCard } from './AskQuestionToolCard';

function use(questions: unknown[]): ToolUseBlock {
  return {
    type: 'tool_use',
    tool_use_id: 'call-ask-0',
    tool_name: 'ask_user_question',
    kind: 'ask_user',
    input_preview: JSON.stringify({ questions }),
    meta: { 'x.ai/tool': { name: 'ask_user_question', kind: 'ask_user' } },
  };
}

function result(output: unknown): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: 'call-ask-0',
    output_preview: JSON.stringify(output),
    is_error: false,
    agent_stats: null,
  };
}

const QUESTIONS = [
  {
    id: 'tracker',
    question:
      '这个仓库没有 git remote，也还没有 AGENTS.md / CLAUDE.md。工程技能需要知道 issue 住在哪。',
    options: [
      { label: 'Local markdown (推荐)', description: 'Write issues locally.' },
      { label: 'GitHub Issues', description: 'Needs origin.' },
    ],
  },
  {
    id: 'note',
    question: 'Add a note',
    options: [{ label: 'No note', description: 'Skip.' }],
  },
  {
    id: 'host',
    question: 'Choose a host',
    options: [
      { label: 'GitHub', description: '' },
      { label: 'GitLab', description: '' },
    ],
  },
];

describe('AskQuestionToolCard', () => {
  it('shows a title row with a Questions tag and no leading icon', () => {
    render(<AskQuestionToolCard use={use(QUESTIONS)} result={null} />);

    expect(
      document.querySelector(
        '.lucide-circle-help, .lucide-circle-question-mark, .lucide-circle-question'
      )
    ).toBeNull();
    expect(
      screen.getByRole('group', { name: QUESTIONS[0]?.question })
    ).toBeInTheDocument();
    expect(screen.getByTestId('ask-question-title')).toHaveClass(
      'ask-question-tool-title'
    );
    expect(screen.getByTestId('ask-question-kind-tag')).toHaveTextContent(
      'Questions'
    );
    expect(
      screen.queryByRole('button', { name: '提示词' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '结果' })
    ).not.toBeInTheDocument();

    const details = screen.getByRole('button', { name: '查看详情' });
    expect(details).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(details);
    expect(details).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.queryByTestId('ask-question-detail-well')
    ).not.toBeInTheDocument();
    const detail = screen.getByTestId('agent-question-detail');
    expect(detail).toBeInTheDocument();
    expect(
      detail.querySelector('.agent-question-card-prompt')
    ).not.toBeInTheDocument();
    expect(screen.getByText('Local markdown')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '提交回答' })
    ).not.toBeInTheDocument();
  });

  it('unwraps MCP argument envelopes and falls back to generic title instead of raw tool name when input is empty', () => {
    const { unmount } = render(
      <AskQuestionToolCard
        use={{
          type: 'tool_use',
          tool_use_id: 'call-mcp-ask',
          tool_name: 'vibex-delegation-mcp__ask_user_question',
          kind: 'other',
          input_preview: JSON.stringify({
            server: 'vibex-delegation-mcp',
            tool: 'ask_user_question',
            arguments: { questions: QUESTIONS },
          }),
          meta: null,
        }}
        result={result({ declined: true, answers: [] })}
      />
    );

    expect(screen.getByTestId('ask-question-title')).toHaveTextContent(
      QUESTIONS[0]!.question
    );
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    expect(screen.getByText('Local markdown')).toBeInTheDocument();
    expect(screen.getByText('GitHub Issues')).toBeInTheDocument();
    unmount();

    render(
      <AskQuestionToolCard
        use={{
          type: 'tool_use',
          tool_use_id: 'call-empty-ask',
          tool_name: 'vibex-delegation-mcp__ask_user_question',
          kind: 'other',
          input_preview: '{}',
          meta: null,
        }}
        result={result({ declined: true, answers: [] })}
      />
    );

    expect(screen.getByTestId('ask-question-title')).not.toHaveTextContent(
      'vibex-delegation-mcp__ask_user_question'
    );
    expect(
      screen.queryByRole('button', { name: '查看详情' })
    ).not.toBeInTheDocument();
  });

  it('pages completed answers one question at a time directly without an inner container or duplicate prompt', () => {
    render(
      <AskQuestionToolCard
        use={use(QUESTIONS)}
        result={result({
          outcome: 'accepted',
          answers: {
            tracker: ['Local markdown (推荐)'],
            note: ['Keep tests at the public UI seam.'],
            host: ['GitLab'],
          },
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));

    expect(
      screen.queryByTestId('ask-question-detail-well')
    ).not.toBeInTheDocument();
    const detail = screen.getByTestId('agent-question-detail');
    expect(
      detail.querySelector('.agent-question-card-prompt')
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('ask-question-title')).toHaveTextContent(
      QUESTIONS[0]!.question
    );
    expect(detail).not.toHaveTextContent(QUESTIONS[0]!.question);
    expect(screen.getByText('1 / 3')).toBeInTheDocument();

    const selected = screen.getByText(/Local markdown/);
    expect(selected.closest('label')).toHaveClass('is-answered');

    fireEvent.click(screen.getByRole('button', { name: '下一个' }));
    expect(screen.getByTestId('ask-question-title')).toHaveTextContent(
      'Add a note'
    );
    expect(
      screen.getByDisplayValue('Keep tests at the public UI seam.')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '下一个' }));
    expect(screen.getByTestId('ask-question-title')).toHaveTextContent(
      'Choose a host'
    );
    expect(screen.getByText('GitLab').closest('label')).toHaveClass(
      'is-answered'
    );
    expect(
      screen.queryByRole('button', { name: '拒绝回答' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '提交回答' })
    ).not.toBeInTheDocument();
  });
});
