import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationQuestionRequest } from 'shared/types';
import { AgentQuestionCard } from './AgentQuestionCard';

function delegatedQuestion(): ConversationQuestionRequest {
  return {
    question_id: 'question-set-1',
    prompt: 'Choose how to continue\nAdd any constraints',
    options: [],
    asked_at: '2026-08-08T10:05:00+08:00',
    schema: {
      type: 'object',
      'x-dimo-questions': [
        {
          id: 'approach',
          header: 'Approach',
          question: 'Choose how to continue',
          multiSelect: false,
          options: [
            {
              label: 'Focused patch (Recommended)',
              description: 'Change only the affected surface.',
            },
            {
              label: 'Broad refactor',
              description: 'Rework the surrounding architecture too.',
            },
          ],
        },
        {
          id: 'constraints',
          header: 'Constraints',
          question: 'Add any constraints',
          multiSelect: false,
          options: [
            {
              label: 'No extra constraints',
              description: 'Use the project defaults.',
            },
            {
              label: 'Keep the current API',
              description: 'Do not change the public boundary.',
            },
          ],
        },
      ],
    },
  };
}

describe('AgentQuestionCard', () => {
  it('starts expanded above the composer with the recommended option selected and rolling step counter', () => {
    render(
      <AgentQuestionCard request={delegatedQuestion()} onRespond={vi.fn()} />
    );

    const card = screen.getByRole('group', { name: '智能体提问' });
    expect(card).toHaveAttribute('data-expanded', 'true');
    const pos = screen.getByTestId('agent-question-position');
    expect(pos).toHaveTextContent('1 / 2');
    expect(pos).toHaveAttribute('aria-label', '1 / 2');
    expect(pos).toHaveClass('tabular-nums');
    expect(screen.getByText('推荐')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Focused patch/ })).toBeChecked();
    expect(screen.getByRole('button', { name: '上一个' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一个' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '跳过' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续' })).toBeEnabled();
  });

  it('supports manual step navigation and submits option plus inline free-text answers', () => {
    const onRespond = vi.fn();
    render(
      <AgentQuestionCard request={delegatedQuestion()} onRespond={onRespond} />
    );

    fireEvent.click(screen.getByRole('radio', { name: /Broad refactor/ }));
    expect(screen.getByTestId('agent-question-position')).toHaveTextContent(
      '1 / 2'
    );
    fireEvent.click(screen.getByRole('radio', { name: /Focused patch/ }));
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(screen.getByTestId('agent-question-position')).toHaveTextContent(
      '2 / 2'
    );
    expect(screen.getByText('Add any constraints')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: '输入回答' }), {
      target: { value: 'Keep tests at the public UI seam.' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));

    expect(onRespond).toHaveBeenCalledWith('question-set-1', {
      action: 'accept',
      content: {
        answers: [
          {
            questionId: 'approach',
            labels: ['Focused patch (Recommended)'],
          },
          {
            questionId: 'constraints',
            labels: ['Keep tests at the public UI seam.'],
          },
        ],
      },
    });
    expect(screen.getByRole('button', { name: '上一个' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '下一个' })).toBeDisabled();
  });

  it('auto-advances single-choice questions after 480ms and waits for multi-select questions', async () => {
    vi.useFakeTimers();
    const onRespond = vi.fn();
    const multiRequest: ConversationQuestionRequest = {
      question_id: 'multi-auto',
      prompt: 'Pick one then pick many',
      options: [],
      schema: {
        type: 'object',
        'x-dimo-questions': [
          {
            id: 'q1',
            header: 'Flavors',
            question: 'How many flavors?',
            multiSelect: false,
            options: [{ label: 'Three' }, { label: 'Five' }],
          },
          {
            id: 'q2',
            header: 'Mix-ins',
            question: 'Which mix-ins?',
            multiSelect: true,
            options: [{ label: 'Chocolate chips' }, { label: 'Sprinkles' }],
          },
        ],
      },
    };

    try {
      render(
        <AgentQuestionCard request={multiRequest} onRespond={onRespond} />
      );

      fireEvent.click(screen.getByRole('radio', { name: 'Three' }));
      expect(screen.getByTestId('agent-question-position')).toHaveTextContent(
        '1 / 2'
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(480);
      });
      expect(screen.getByTestId('agent-question-position')).toHaveTextContent(
        '2 / 2'
      );

      fireEvent.click(
        screen.getByRole('checkbox', { name: 'Chocolate chips' })
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(onRespond).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
      await act(async () => {
        await Promise.resolve();
      });

      expect(onRespond).toHaveBeenCalledWith('multi-auto', {
        action: 'accept',
        content: {
          answers: [
            { questionId: 'q1', labels: ['Three'] },
            { questionId: 'q2', labels: ['Chocolate chips'] },
          ],
        },
      });
      expect(screen.getByTestId('agent-question-sent')).toHaveTextContent(
        '已发送回答'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('collapses to a compact reopen pill via top-right X and preserves state when reopened', () => {
    render(
      <AgentQuestionCard request={delegatedQuestion()} onRespond={vi.fn()} />
    );

    fireEvent.click(screen.getByRole('radio', { name: /Broad refactor/ }));
    fireEvent.click(screen.getByRole('button', { name: '收起智能体提问' }));

    expect(screen.queryByTestId('agent-question-card')).toBeNull();
    const reopen = screen.getByTestId('agent-question-reopen');
    expect(reopen).toHaveTextContent('Approach');

    fireEvent.click(reopen);
    expect(screen.getByTestId('agent-question-card')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Broad refactor/ })).toBeChecked();
  });

  it('maps a standard ACP form schema back to its property-keyed content', () => {
    const onRespond = vi.fn();
    const request: ConversationQuestionRequest = {
      question_id: 'form-question',
      prompt: 'Configure the change',
      options: [],
      schema: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            title: 'Scope',
            description: 'Choose the rollout scope.',
            oneOf: [
              { const: 'project', title: 'Project (Recommended)' },
              { const: 'workspace', title: 'Workspace' },
            ],
          },
          note: {
            type: 'string',
            title: 'Note',
            description: 'Add a note for the agent.',
          },
        },
        required: ['scope', 'note'],
      },
    };

    render(<AgentQuestionCard request={request} onRespond={onRespond} />);

    fireEvent.click(screen.getByRole('button', { name: '下一个' }));
    fireEvent.change(screen.getByRole('textbox', { name: '输入回答' }), {
      target: { value: 'Preserve the public API.' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));

    expect(onRespond).toHaveBeenCalledWith('form-question', {
      action: 'accept',
      content: {
        scope: 'project',
        note: 'Preserve the public API.',
      },
    });
  });

  it('lets the user skip intermediate questions and decline on the final step without choosing', () => {
    const onRespond = vi.fn();
    render(
      <AgentQuestionCard request={delegatedQuestion()} onRespond={onRespond} />
    );

    fireEvent.click(screen.getByRole('button', { name: '跳过' }));
    expect(screen.getByTestId('agent-question-position')).toHaveTextContent(
      '2 / 2'
    );

    const decline = screen.getByRole('button', { name: '拒绝回答' });
    expect(decline).toHaveClass('agent-question-decline');
    fireEvent.click(decline);

    expect(onRespond).toHaveBeenCalledWith('question-set-1', {
      action: 'decline',
    });
  });

  describe('Claude Code AskUserQuestion form', () => {
    function claudeRequest(): ConversationQuestionRequest {
      return {
        question_id: 'claude-question',
        prompt: 'Which approach should I take?',
        options: [],
        schema: {
          type: 'object',
          properties: {
            question_0: {
              type: 'string',
              title: 'Approach',
              oneOf: [
                { const: 'Incremental', title: 'Incremental' },
                { const: 'Rewrite', title: 'Rewrite' },
              ],
            },
            question_0_custom: {
              type: 'string',
              title: 'Other',
              description:
                'Type your own answer, or add a note to the option you chose above (optional).',
            },
          },
        },
      };
    }

    it('shows one page with the question text and submits a plain pick', () => {
      const onRespond = vi.fn();
      render(
        <AgentQuestionCard request={claudeRequest()} onRespond={onRespond} />
      );

      expect(screen.getByTestId('agent-question-position')).toHaveTextContent(
        '1 / 1'
      );
      expect(
        screen.getByText('Which approach should I take?')
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '下一个' })).toBeDisabled();

      const submit = screen.getByRole('button', { name: '提交回答' });
      expect(submit).toBeDisabled();
      fireEvent.click(screen.getByRole('radio', { name: 'Rewrite' }));
      expect(submit).toBeEnabled();
      fireEvent.click(submit);

      expect(onRespond).toHaveBeenCalledWith('claude-question', {
        action: 'accept',
        content: { question_0: 'Rewrite' },
      });
    });

    it('submits typed text through the companion field', () => {
      const onRespond = vi.fn();
      render(
        <AgentQuestionCard request={claudeRequest()} onRespond={onRespond} />
      );

      fireEvent.change(screen.getByRole('textbox', { name: '输入回答' }), {
        target: { value: 'Split it by module.' },
      });
      fireEvent.click(screen.getByRole('button', { name: '提交回答' }));

      expect(onRespond).toHaveBeenCalledWith('claude-question', {
        action: 'accept',
        content: { question_0_custom: 'Split it by module.' },
      });
    });

    it('lets the user decline without choosing', () => {
      const onRespond = vi.fn();
      render(
        <AgentQuestionCard request={claudeRequest()} onRespond={onRespond} />
      );

      fireEvent.click(screen.getByRole('button', { name: '拒绝回答' }));

      expect(onRespond).toHaveBeenCalledWith('claude-question', {
        action: 'decline',
      });
    });
  });

  it('recognizes Antigravity prefix (Recommended) option labels and pre-selects them', () => {
    const onRespond = vi.fn();
    const request: ConversationQuestionRequest = {
      question_id: 'interaction-question',
      prompt: '您倾向于哪种 HTML 课件视觉风格？',
      options: [],
      schema: {
        type: 'object',
        'x-dimo-questions': [
          {
            id: 'interaction_b8486ad3',
            header: '您倾向于哪种 HTML 课件视…',
            question: '您倾向于哪种 HTML 课件视觉风格？',
            multiSelect: false,
            options: [
              {
                id: '1',
                label: '(Recommended) 方案 A：极夜极客风',
                description: '',
              },
              {
                id: '2',
                label: '方案 B：现代学术白',
                description: '',
              },
            ],
          },
        ],
      },
    };

    render(<AgentQuestionCard request={request} onRespond={onRespond} />);

    expect(screen.getByText('推荐')).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: /方案 A：极夜极客风/ })
    ).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));

    expect(onRespond).toHaveBeenCalledWith('interaction-question', {
      action: 'accept',
      content: {
        answers: [
          {
            questionId: 'interaction_b8486ad3',
            labels: ['方案 A：极夜极客风 (Recommended)'],
          },
        ],
      },
    });
  });

  it('shows error and dismiss fallback when submit fails on orphaned question and auto-dismisses orphaned decline', async () => {
    const onDismiss = vi.fn();
    const onRespond = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'Conversation has no active Agent connection for question response'
        )
      );

    render(
      <AgentQuestionCard
        request={delegatedQuestion()}
        onRespond={onRespond}
        onDismiss={onDismiss}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '下一个' }));
    fireEvent.click(
      screen.getByRole('radio', { name: /No extra constraints/ })
    );
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));

    const alert = await screen.findByTestId('agent-question-error');
    expect(alert).toHaveTextContent(
      'Conversation has no active Agent connection for question response'
    );

    fireEvent.click(screen.getByTestId('agent-question-dismiss'));
    expect(onDismiss).toHaveBeenCalledWith('question-set-1');
    expect(screen.queryByTestId('agent-question-card')).toBeNull();
  });

  it('auto-dismisses when declining an orphaned question with BadRequest/no active connection', async () => {
    const onDismiss = vi.fn();
    const onRespond = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'Conversation has no active Agent connection for question response'
        )
      );

    render(
      <AgentQuestionCard
        request={delegatedQuestion()}
        onRespond={onRespond}
        onDismiss={onDismiss}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '跳过' }));
    fireEvent.click(screen.getByRole('button', { name: '拒绝回答' }));

    await vi.waitFor(() => {
      expect(onDismiss).toHaveBeenCalledWith('question-set-1');
    });
    expect(screen.queryByTestId('agent-question-card')).toBeNull();
  });
});
