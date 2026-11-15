import { describe, expect, it } from 'vitest';
import {
  beginCollaborationComposerSend,
  buildCollaborationSendContent,
  isAutomateSlashCommand,
  parseAutomateSlashIntent,
  restoreCollaborationComposerAfterSendFailure,
} from './collaborationComposerSend';

const image = {
  id: 'image-1',
  name: 'shot.png',
  path: '.vibe-images/shot.png',
  previewUrl: 'blob:shot',
};

describe('collaborationComposerSend', () => {
  it('builds send content from text and attachment markdown', () => {
    expect(buildCollaborationSendContent('看这张图', [image])).toBe(
      '看这张图\n\n![shot.png](.vibe-images/shot.png)'
    );
    expect(buildCollaborationSendContent('   ', [image])).toBe(
      '![shot.png](.vibe-images/shot.png)'
    );
  });

  it('clears composer attachments immediately while keeping the sent snapshot', () => {
    expect(beginCollaborationComposerSend([image])).toEqual({
      message: '',
      attachments: [],
      sentAttachments: [image],
    });
  });

  it('restores the sent attachments when send fails and the composer is still empty', () => {
    expect(
      restoreCollaborationComposerAfterSendFailure({
        currentAttachments: [],
        sentAttachments: [image],
      })
    ).toEqual([image]);
  });

  it('detects /automate slash commands and builds a Bot PulseRuleSpec with fifo_serial mailbox', () => {
    expect(isAutomateSlashCommand('/automate triage jira bugs')).toBe(true);
    expect(isAutomateSlashCommand('hello /automate')).toBe(false);

    const parsed = parseAutomateSlashIntent(
      '/automate triage incoming Jira bug tickets',
      [],
      {
        kind: 'bot',
        memberId: 'bot-alpha',
        botName: 'Alpha Bot',
        projectId: 'proj-1',
        workspaceId: 'ws-1',
      }
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.inferredSourceKind).toBe('jira');
    expect(parsed?.spec.evalMode).toBe('observe');
    expect(parsed?.spec.targets[0]).toMatchObject({
      kind: 'bot',
      memberId: 'bot-alpha',
      conversationScope: 'fixed_primary',
      mailboxPolicy: 'fifo_serial',
    });
  });

  it('maps Group /automate @mentions to specific_seat, mention_seats, or moderator_triage', () => {
    const roster = [
      { memberId: 'seat-lead', nickname: 'Lead' },
      { memberId: 'seat-qa', nickname: 'QA' },
      { memberId: 'seat-sec', nickname: 'SecOps' },
    ];

    const singleMention = parseAutomateSlashIntent(
      '/automate when GitHub PR opens notify @QA',
      roster,
      {
        kind: 'group',
        spaceId: 'space-eng',
        spaceName: 'Engineering',
        leadMemberId: 'seat-lead',
      }
    );
    expect(singleMention?.inferredSourceKind).toBe('github');
    expect(singleMention?.spec.targets[0]).toMatchObject({
      kind: 'group',
      spaceId: 'space-eng',
      dispatchMode: { type: 'specific_seat', memberId: 'seat-qa' },
    });

    const multiMention = parseAutomateSlashIntent(
      '/automate Feishu release alert @QA and @SecOps',
      roster,
      {
        kind: 'group',
        spaceId: 'space-eng',
        spaceName: 'Engineering',
        leadMemberId: 'seat-lead',
      }
    );
    expect(multiMention?.inferredSourceKind).toBe('feishu');
    expect(multiMention?.spec.targets[0]).toMatchObject({
      kind: 'group',
      spaceId: 'space-eng',
      dispatchMode: {
        type: 'mention_seats',
        memberIds: ['seat-qa', 'seat-sec'],
      },
    });

    const moderatorFallback = parseAutomateSlashIntent(
      '/automate daily cron standup digest',
      roster,
      {
        kind: 'group',
        spaceId: 'space-eng',
        spaceName: 'Engineering',
        leadMemberId: 'seat-lead',
      }
    );
    expect(moderatorFallback?.inferredSourceKind).toBe('time_cron');
    expect(moderatorFallback?.spec.targets[0]).toMatchObject({
      kind: 'group',
      spaceId: 'space-eng',
      dispatchMode: {
        type: 'moderator_triage',
        moderatorMemberId: 'seat-lead',
      },
    });
  });
});
