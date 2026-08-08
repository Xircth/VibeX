import { fireEvent, render, screen } from '@testing-library/react';
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
      'x-vibex-questions': [
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
  it('starts tucked behind the composer with the recommended option selected', () => {
    render(
      <AgentQuestionCard request={delegatedQuestion()} onRespond={vi.fn()} />
    );

    const card = screen.getByRole('group', { name: '智能体提问' });
    expect(card).toHaveAttribute('data-expanded', 'false');
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    expect(screen.getByText('推荐')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Focused patch/ })).toBeChecked();
    expect(screen.getByRole('time')).toHaveAttribute(
      'dateTime',
      '2026-08-08T10:05:00+08:00'
    );
    expect(
      screen.queryByRole('button', { name: '上一个' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一个' })).toBeInTheDocument();
  });

  it('keeps tab changes explicit and submits option plus free-text answers', () => {
    const onRespond = vi.fn();
    render(
      <AgentQuestionCard request={delegatedQuestion()} onRespond={onRespond} />
    );

    fireEvent.click(screen.getByRole('button', { name: '展开智能体提问' }));
    expect(screen.getByRole('group', { name: '智能体提问' })).toHaveAttribute(
      'data-expanded',
      'true'
    );

    fireEvent.click(screen.getByRole('radio', { name: /Broad refactor/ }));
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Focused patch/ }));
    fireEvent.click(screen.getByRole('button', { name: '下一个' }));
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
    expect(screen.getByText('Add any constraints')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: '输入回答' }));
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
    expect(screen.getByRole('button', { name: '上一个' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '下一个' })
    ).not.toBeInTheDocument();
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
});
