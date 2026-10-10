import { describe, expect, it } from 'vitest';
import type { ConversationQuestionRequest } from 'shared/types';
import type { ToolUseBlock } from '@/components/NormalizedConversation/messageTurnBlocks';
import {
  answerStateFromResponse,
  answerStateFromToolResult,
  firstQuestionTitle,
  isAskQuestionTool,
  questionRequestFromToolUse,
  questionTabsFromRequest,
  responseContent,
} from './agentQuestionModel';

function grokRequest(): ConversationQuestionRequest {
  return {
    question_id: 'q-1',
    prompt: 'Pick a tracker\nAdd a note\nChoose a host',
    options: [],
    schema: {
      type: 'object',
      'x-vibex-questions': [
        {
          id: 'tracker',
          header: 'Tracker',
          question: 'Pick a tracker',
          options: [
            {
              label: 'Local markdown (推荐)',
              description: 'Write issues locally.',
            },
            { label: 'GitHub Issues', description: 'Needs origin.' },
          ],
        },
        {
          id: 'note',
          header: 'Note',
          question: 'Add a note',
          options: [{ label: 'No note', description: 'Skip.' }],
        },
        {
          id: 'host',
          header: 'Host',
          question: 'Choose a host',
          options: [
            { label: 'GitHub', description: '' },
            { label: 'GitLab', description: '' },
          ],
        },
      ],
    },
  };
}

function claudeCustomField(multiSelect = false) {
  return {
    type: 'string',
    title: 'Other',
    description: multiSelect
      ? 'Type your own answer to add to your selection above (optional).'
      : 'Type your own answer, or add a note to the option you chose above (optional).',
  };
}

function claudeSingleQuestion(): ConversationQuestionRequest {
  return {
    question_id: 'claude-1',
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
        question_0_custom: claudeCustomField(),
      },
    },
  };
}

function claudeTwoQuestions(): ConversationQuestionRequest {
  return {
    question_id: 'claude-2',
    prompt: 'Please answer the following questions.',
    options: [],
    schema: {
      type: 'object',
      properties: {
        question_0: {
          type: 'string',
          title: 'Approach',
          description: 'Which approach should I take?',
          oneOf: [{ const: 'Incremental', title: 'Incremental' }],
        },
        question_0_custom: claudeCustomField(),
        question_1: {
          type: 'array',
          title: 'Checks',
          description: 'Which checks should run?',
          items: {
            anyOf: [
              { const: 'Lint', title: 'Lint' },
              { const: 'Tests', title: 'Tests' },
            ],
          },
        },
        question_1_custom: claudeCustomField(true),
      },
    },
  };
}

describe('agentQuestionModel', () => {
  it('recognizes Grok ask_user_question tool calls by title or vendor meta', () => {
    const use: ToolUseBlock = {
      type: 'tool_use',
      tool_use_id: 'call-ask-0',
      tool_name: 'ask_user_question',
      kind: 'ask_user',
      input_preview: '{"questions":[{"question":"Pick a tracker"}]}',
      meta: { 'x.ai/tool': { name: 'ask_user_question', kind: 'ask_user' } },
    };
    expect(isAskQuestionTool(use)).toBe(true);
    expect(
      isAskQuestionTool({
        ...use,
        tool_name: 'call_abc123',
        kind: null,
      })
    ).toBe(true);
  });

  it('builds question tabs and titles from Grok tool input', () => {
    const request = questionRequestFromToolUse({
      type: 'tool_use',
      tool_use_id: 'call-ask-0',
      tool_name: 'ask_user_question',
      kind: 'ask_user',
      input_preview: JSON.stringify({
        questions: grokRequest().schema
          ? (
              grokRequest().schema as {
                'x-vibex-questions': Array<Record<string, unknown>>;
              }
            )['x-vibex-questions']
          : [],
      }),
      meta: null,
    });
    const questions = questionTabsFromRequest(request);
    expect(firstQuestionTitle(questions)).toBe('Pick a tracker');
    expect(questions).toHaveLength(3);
    expect(questions[0]?.choices[0]?.recommended).toBe(true);
  });

  it('maps mixed choice, custom, and later-choice answers onto every question', () => {
    const questions = questionTabsFromRequest(grokRequest());
    const state = answerStateFromResponse(questions, {
      answer: 'Local markdown (Recommended)',
      content: {
        answers: [
          { questionId: 'tracker', labels: ['Local markdown (推荐)'] },
          { questionId: 'note', labels: ['Keep tests at the public UI seam.'] },
          { questionId: 'host', labels: ['GitLab'] },
        ],
      },
    });

    expect(state).not.toBeNull();
    expect(state?.tracker).toEqual({
      selected: ['Local markdown (推荐)'],
      customActive: false,
      customText: '',
    });
    expect(state?.note).toEqual({
      selected: [],
      customActive: true,
      customText: 'Keep tests at the public UI seam.',
    });
    expect(state?.host).toEqual({
      selected: ['GitLab'],
      customActive: false,
      customText: '',
    });
  });

  it('reads Grok tool-result answer maps and ignores cancelled outcomes', () => {
    const questions = questionTabsFromRequest(grokRequest());
    expect(
      answerStateFromToolResult(questions, {
        type: 'tool_result',
        tool_use_id: 'call-ask-0',
        output_preview: JSON.stringify({
          outcome: 'accepted',
          answers: {
            tracker: ['Local markdown (推荐)'],
            note: ['typed note'],
          },
        }),
        is_error: false,
        agent_stats: null,
      })?.note
    ).toEqual({
      selected: [],
      customActive: true,
      customText: 'typed note',
    });
    expect(
      answerStateFromToolResult(questions, {
        type: 'tool_result',
        tool_use_id: 'call-ask-0',
        output_preview: JSON.stringify({ outcome: 'cancelled' }),
        is_error: false,
        agent_stats: null,
      })
    ).toBeNull();
  });

  it('folds the Claude custom-answer companion into its select question', () => {
    const questions = questionTabsFromRequest(claudeSingleQuestion());
    expect(questions).toHaveLength(1);
    expect(questions[0]?.id).toBe('question_0');
    expect(questions[0]?.customFieldName).toBe('question_0_custom');

    const pair = questionTabsFromRequest(claudeTwoQuestions());
    expect(pair.map((question) => question.id)).toEqual([
      'question_0',
      'question_1',
    ]);
    expect(pair.map((question) => question.customFieldName)).toEqual([
      'question_0_custom',
      'question_1_custom',
    ]);
  });

  it('keeps a free-text field that is not the companion of a select', () => {
    const request = claudeSingleQuestion();
    const schema = request.schema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    schema.properties.notes_custom = { type: 'string', title: 'Notes' };
    schema.required = ['question_0_custom'];

    expect(
      questionTabsFromRequest(request).map((question) => question.id)
    ).toEqual(['question_0', 'question_0_custom', 'notes_custom']);
  });

  it('asks the message as the question when a single field has no description', () => {
    const [question] = questionTabsFromRequest(claudeSingleQuestion());
    expect(question?.question).toBe('Which approach should I take?');
    expect(question?.header).toBe('Approach');

    const [first] = questionTabsFromRequest(claudeTwoQuestions());
    expect(first?.question).toBe('Which approach should I take?');
  });

  it('writes typed text to the companion field and keeps picks on the main field', () => {
    const request = claudeTwoQuestions();
    const questions = questionTabsFromRequest(request);
    expect(
      responseContent(request, questions, {
        question_0: { selected: [], customActive: true, customText: ' Mixed ' },
        question_1: {
          selected: ['Lint'],
          customActive: true,
          customText: 'Typecheck',
        },
      })
    ).toEqual({
      question_0_custom: 'Mixed',
      question_1: ['Lint'],
      question_1_custom: 'Typecheck',
    });
    expect(
      responseContent(request, questions, {
        question_0: {
          selected: ['Incremental'],
          customActive: false,
          customText: '',
        },
        question_1: {
          selected: ['Tests'],
          customActive: false,
          customText: '',
        },
      })
    ).toEqual({ question_0: 'Incremental', question_1: ['Tests'] });
  });

  it('restores the companion text as the custom answer when recalling a response', () => {
    const request = claudeSingleQuestion();
    const questions = questionTabsFromRequest(request);
    expect(
      answerStateFromResponse(questions, {
        answer: 'Mixed',
        content: { question_0_custom: 'Mixed' },
      })?.question_0
    ).toEqual({ selected: [], customActive: true, customText: 'Mixed' });
  });
});
