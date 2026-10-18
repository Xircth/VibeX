import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  ConversationQuestionRequest,
  ConversationQuestionResponse,
} from 'shared/types';
import { QuestionRequestCard } from './QuestionRequestCard';

const REQUEST: ConversationQuestionRequest = {
  question_id: 'q-tracker',
  prompt: 'Pick a tracker',
  options: ['Local markdown'],
  schema: {
    'x-vibex-questions': [
      {
        id: 'tracker',
        question: 'Pick a tracker',
        options: [{ label: 'Local markdown' }],
      },
    ],
  },
};

const RESPONSE: ConversationQuestionResponse = {
  answer: 'Local markdown',
  content: {
    answers: [{ questionId: 'tracker', labels: ['Local markdown'] }],
  },
};

describe('QuestionRequestCard', () => {
  it('renders pending questions with the composer card', () => {
    render(<QuestionRequestCard request={REQUEST} onRespond={vi.fn()} />);

    expect(
      screen.queryByTestId('ask-question-tool-card')
    ).not.toBeInTheDocument();
    expect(screen.getByText('Pick a tracker')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '提交回答' })
    ).toBeInTheDocument();
  });

  it('renders answered questions with the shared ask-question card', () => {
    render(
      <QuestionRequestCard
        request={REQUEST}
        response={RESPONSE}
        onRespond={vi.fn()}
      />
    );

    expect(screen.getByTestId('ask-question-tool-card')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '提交回答' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '查看详情' })
    ).toBeInTheDocument();
  });
});
