import { describe, expect, it } from 'vitest';
import { getConversationRemovalPlan } from './conversationRemovalPlan';

describe('conversationRemovalPlan', () => {
  it('suppresses removals while process data is loading', () => {
    expect(
      getConversationRemovalPlan({
        displayedProcessIds: ['process-1'],
        visibleProcessIds: [],
        isLoading: true,
        hasError: false,
      })
    ).toEqual([]);
  });

  it('suppresses removals while process data has an error', () => {
    expect(
      getConversationRemovalPlan({
        displayedProcessIds: ['process-1'],
        visibleProcessIds: [],
        isLoading: false,
        hasError: true,
      })
    ).toEqual([]);
  });

  it('returns displayed process ids that are absent from the visible process list', () => {
    expect(
      getConversationRemovalPlan({
        displayedProcessIds: ['process-1', 'process-2', 'process-3'],
        visibleProcessIds: ['process-2'],
        isLoading: false,
        hasError: false,
      })
    ).toEqual(['process-1', 'process-3']);
  });

  it('returns an empty plan when displayed and visible process ids still match', () => {
    expect(
      getConversationRemovalPlan({
        displayedProcessIds: ['process-1', 'process-2'],
        visibleProcessIds: ['process-2', 'process-1'],
        isLoading: false,
        hasError: false,
      })
    ).toEqual([]);
  });
});
