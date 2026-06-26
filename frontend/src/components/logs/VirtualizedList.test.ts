import { describe, expect, it } from 'vitest';
import {
  findPreviousUserMessageVirtualIndex,
  findViewportAnchorVirtualIndex,
  getDistanceFromConversationBottom,
  getVirtualRowTranslateY,
  isConversationNearBottom,
  pendingAgentPermissionsFromEvents,
  pendingAgentPermissionsForSession,
} from './VirtualizedList';

describe('virtualized user-message navigation', () => {
  it('finds the visible virtual item nearest the viewport anchor', () => {
    expect(
      findViewportAnchorVirtualIndex(
        [
          { index: 4, start: 480 },
          { index: 5, start: 600 },
          { index: 6, start: 780 },
        ],
        500,
        600
      )
    ).toBe(5);
  });

  it('jumps to the latest user turn above the current virtual anchor', () => {
    expect(findPreviousUserMessageVirtualIndex([0, 4, 9], 6)).toBe(4);
  });

  it('falls back to the earliest user turn when already near the top', () => {
    expect(findPreviousUserMessageVirtualIndex([2, 8], 0)).toBe(2);
  });

  it('skips the anchored user turn so repeated jumps keep moving upward', () => {
    expect(findPreviousUserMessageVirtualIndex([0, 4, 9], 9)).toBe(4);
  });
});

describe('conversation bottom distance', () => {
  it('calculates distance from the visible viewport to the scroll bottom', () => {
    expect(
      getDistanceFromConversationBottom({
        scrollHeight: 1200,
        scrollTop: 700,
        clientHeight: 400,
      })
    ).toBe(100);
  });

  it('treats near-bottom scroll positions as pinned', () => {
    expect(
      isConversationNearBottom({
        scrollHeight: 1200,
        scrollTop: 760,
        clientHeight: 400,
      })
    ).toBe(true);
  });

  it('releases stick-to-bottom once the user scrolls away', () => {
    expect(
      isConversationNearBottom({
        scrollHeight: 1200,
        scrollTop: 650,
        clientHeight: 400,
      })
    ).toBe(false);
  });

  it('offsets virtual rows by the measured scroll margin', () => {
    expect(getVirtualRowTranslateY(512, 96)).toBe('translateY(416px)');
  });
});

describe('pendingAgentPermissionsFromEvents', () => {
  it('keeps permission requests pending until a response event arrives', () => {
    const requested = {
      sequence: 1,
      workspace_id: 'workspace',
      connection_id: 'connection',
      session_id: 'session',
      created_at: '2026-06-11T00:00:01.000Z',
      event: {
        kind: 'permission_requested' as const,
        request: {
          id: 'permission-1',
          session_id: 'session',
          title: 'Run tests',
          options: [{ id: 'allow', label: 'Allow once' }],
        },
      },
    };

    expect(pendingAgentPermissionsFromEvents([requested])).toEqual([
      {
        connectionId: 'connection',
        request: requested.event.request,
      },
    ]);

    expect(
      pendingAgentPermissionsFromEvents([
        requested,
        {
          sequence: 2,
          workspace_id: 'workspace',
          connection_id: 'connection',
          session_id: 'session',
          created_at: '2026-06-11T00:00:02.000Z',
          event: {
            kind: 'permission_responded',
            permission_id: 'permission-1',
            response: { kind: 'selected', option_id: 'allow' },
          },
        },
      ])
    ).toEqual([]);
  });

  it('merges snapshot permissions when request events are no longer in the window', () => {
    expect(
      pendingAgentPermissionsForSession(
        [],
        {
          'permission-1': {
            id: 'permission-1',
            session_id: 'session',
            title: 'Run tests',
            options: [{ id: 'allow', label: 'Allow once' }],
          },
          'permission-2': {
            id: 'permission-2',
            session_id: 'other-session',
            title: 'Edit file',
            options: [{ id: 'reject', label: 'Reject' }],
          },
        },
        'session',
        'connection'
      )
    ).toEqual([
      {
        connectionId: 'connection',
        request: {
          id: 'permission-1',
          session_id: 'session',
          title: 'Run tests',
          options: [{ id: 'allow', label: 'Allow once' }],
        },
      },
    ]);
  });
});
