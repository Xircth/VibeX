import { describe, expect, it } from 'vitest';
import type { TimelineRow } from 'shared/types';

import {
  isAgentHandoffHostNote,
  isDurableHostNote,
  isPersonaHostNote,
  parseAgentHandoffNotice,
  shouldShowDurableHostNote,
} from './conversationStore';

function notice(
  announcementId: string | null,
  rowId = 'notice:1',
  message: string | null = '只评论 diff，不改文件'
): TimelineRow {
  return {
    row_id: rowId,
    revision: 1n,
    row: {
      kind: 'session_notice',
      notice: {
        title: '人设',
        message,
        severity: 'info',
        announcement_id: announcementId,
        action: null,
      },
    },
  };
}

describe('isDurableHostNote', () => {
  it('keeps persona and agent-handoff host notes on the timeline', () => {
    expect(isDurableHostNote(notice('host-note:persona'))).toBe(true);
    expect(isDurableHostNote(notice(null, 'host-note:persona'))).toBe(true);
    expect(
      isDurableHostNote(notice('host-note:agent-handoff:after:turn-1'))
    ).toBe(true);
  });

  it('leaves transient session notices in the status dock', () => {
    expect(isDurableHostNote(notice(null))).toBe(false);
    expect(isDurableHostNote(notice('cli-update'))).toBe(false);
  });
});

describe('isPersonaHostNote', () => {
  it('recognizes the persona host note by announcement or row id', () => {
    expect(isPersonaHostNote(notice('host-note:persona'))).toBe(true);
    expect(isPersonaHostNote(notice(null, 'host-note:persona'))).toBe(true);
    expect(isPersonaHostNote(notice('cli-update'))).toBe(false);
    expect(isPersonaHostNote(notice(null))).toBe(false);
  });
});

describe('shouldShowDurableHostNote', () => {
  it('hides persona notes for collaboration member sessions', () => {
    expect(
      shouldShowDurableHostNote(notice('host-note:persona'), {
        hidePersonaHostNotes: true,
      })
    ).toBe(false);
    expect(
      shouldShowDurableHostNote(notice('host-note:persona'), {
        hidePersonaHostNotes: false,
      })
    ).toBe(true);
  });
});

describe('agent handoff host notes', () => {
  it('parses structured cross-agent handoff notices and ignores round-trip same-agent notes', () => {
    const handoffRow = notice(
      'host-note:agent-handoff:after:turn-1',
      'host-note:agent-handoff:after:turn-1',
      JSON.stringify({
        afterTurnId: 'turn-1',
        fromAgent: 'claude_code',
        fromModel: 'claude-opus-4-6',
        toAgent: 'codex',
        handoffTokens: 2200,
        switchedAt: '2026-11-15T12:00:00Z',
      })
    );
    expect(isAgentHandoffHostNote(handoffRow)).toBe(true);
    expect(parseAgentHandoffNotice(handoffRow)).toEqual({
      fromAgent: 'claude_code',
      fromModel: 'claude-opus-4-6',
      toAgent: 'codex',
      toModel: null,
      handoffTokens: 2200,
      continuationPolicy: 'portable',
    });

    const roundTripSame = notice(
      'host-note:agent-handoff:after:turn-1',
      'host-note:agent-handoff:after:turn-1',
      JSON.stringify({
        afterTurnId: 'turn-1',
        fromAgent: 'claude_code',
        toAgent: 'claude-code',
      })
    );
    expect(parseAgentHandoffNotice(roundTripSame)).toBeNull();
  });
});
