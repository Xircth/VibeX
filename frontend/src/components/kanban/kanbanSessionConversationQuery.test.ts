import { describe, expect, it } from 'vitest';
import { getKanbanSessionDetailQueryState } from './kanbanSessionConversationQuery';

describe('kanban session conversation query helpers', () => {
  it('disables session detail fetching without a session id', () => {
    expect(getKanbanSessionDetailQueryState(undefined)).toEqual({
      queryKey: ['session', undefined],
      enabled: false,
      fetchSessionId: null,
    });
  });

  it('enables session detail fetching with the provided session id', () => {
    expect(getKanbanSessionDetailQueryState('session-1')).toEqual({
      queryKey: ['session', 'session-1'],
      enabled: true,
      fetchSessionId: 'session-1',
    });
  });
});
