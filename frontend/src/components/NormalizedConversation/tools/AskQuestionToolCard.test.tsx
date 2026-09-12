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
  it('shows a question-mark card with a truncated title and a details toggle', () => {
    render(<AskQuestionToolCard use={use(QUESTIONS)} result={null} />);

    expect(
      document.querySelector(
        '.lucide-circle-help, .lucide-circle-question-mark, .lucide-circle-question'
      )
    ).not.toBeNull();
    expect(
      screen.getByRole('group', { name: QUESTIONS[0]?.question })
    ).toBeInTheDocument();
    expect(screen.getByTestId('ask-question-title')).toHaveClass(
      'ask-question-tool-title'
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
    expect(screen.queryByText('Local markdown')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '提交回答' })
    ).not.toBeInTheDocument();
  });

  it('expands every question and greens the completed answers', () => {
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

    const detail = screen.getByTestId('agent-question-detail');
    expect(detail).toHaveTextContent(QUESTIONS[0]!.question);
    expect(detail).toHaveTextContent('Add a note');
    expect(detail).toHaveTextContent('Choose a host');

    const selected = screen.getByText(/Local markdown/);
    expect(selected.closest('label')).toHaveClass('is-answered');
    expect(
      screen.getByDisplayValue('Keep tests at the public UI seam.')
    ).toBeInTheDocument();
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
