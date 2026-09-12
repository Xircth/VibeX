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
});
