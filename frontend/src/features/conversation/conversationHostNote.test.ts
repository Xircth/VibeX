import { describe, expect, it } from 'vitest';
import type { TimelineRow } from 'shared/types';

import {
  isDurableHostNote,
  isPersonaHostNote,
  shouldShowDurableHostNote,
} from './conversationStore';

function notice(
  announcementId: string | null,
  rowId = 'notice:1'
): TimelineRow {
  return {
    row_id: rowId,
    revision: 1n,
    row: {
      kind: 'session_notice',
      notice: {
        title: '人设',
        message: '只评论 diff，不改文件',
        severity: 'info',
        announcement_id: announcementId,
        action: null,
      },
    },
  };
}

describe('isDurableHostNote', () => {
  it('keeps a persona host note on the timeline', () => {
    expect(isDurableHostNote(notice('host-note:persona'))).toBe(true);
    expect(isDurableHostNote(notice(null, 'host-note:persona'))).toBe(true);
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
