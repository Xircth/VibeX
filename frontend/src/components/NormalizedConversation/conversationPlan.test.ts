import { describe, expect, it } from 'vitest';
import {
  formatPlanStepIndex,
  normalizePlanStatus,
  planProgress,
  splitPlanContent,
  toConversationPlanItem,
} from './conversationPlan';

describe('conversationPlan', () => {
  it('normalizes completed and in-progress aliases', () => {
    expect(normalizePlanStatus('done')).toBe('completed');
    expect(normalizePlanStatus('In Progress')).toBe('in_progress');
    expect(normalizePlanStatus('running')).toBe('in_progress');
    expect(normalizePlanStatus('todo')).toBe('pending');
  });

  it('counts completed and active steps for the progress bar', () => {
    expect(
      planProgress([
        { status: 'completed' },
        { status: 'done' },
        { status: 'in_progress' },
        { status: 'pending' },
        { status: 'pending' },
      ])
    ).toEqual({
      completed: 2,
      inProgress: 1,
      pending: 2,
      total: 5,
    });
  });

  it('keeps a single-line entry as the step title', () => {
    expect(splitPlanContent('Investigate existing plan UI')).toEqual({
      title: 'Investigate existing plan UI',
      children: [],
    });
  });

  it('splits multiline content into a title and child rows', () => {
    expect(
      splitPlanContent(
        [
          'Implement restyle in VibeX',
          '- Update TimelinePlanCard',
          '* Add progress and numbered steps',
        ].join('\n')
      )
    ).toEqual({
      title: 'Implement restyle in VibeX',
      children: ['Update TimelinePlanCard', 'Add progress and numbered steps'],
    });
  });

  it('builds a numbered conversation plan item', () => {
    expect(
      toConversationPlanItem({
        status: 'IN-PROGRESS',
        content: 'Extract reference styles\n- Review codeg plan component',
      })
    ).toEqual({
      status: 'in_progress',
      content: 'Extract reference styles',
      children: ['Review codeg plan component'],
    });
    expect(formatPlanStepIndex(0)).toBe('01');
    expect(formatPlanStepIndex(3)).toBe('04');
  });
});
