import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MASTER_BOT_AVATAR,
  deriveMemberBotAvatar,
  resolveMemberBotAvatar,
} from './MemberBotAvatar';

describe('resolveMemberBotAvatar', () => {
  it('keeps Master on the identity face when the group seat uses another conversation id', () => {
    const groupSeatConversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const hashedSeat = deriveMemberBotAvatar(groupSeatConversationId);

    expect(hashedSeat).not.toEqual(DEFAULT_MASTER_BOT_AVATAR);

    expect(
      resolveMemberBotAvatar({
        conversationId: groupSeatConversationId,
        nickname: 'Master',
        stored: {},
      })
    ).toEqual(DEFAULT_MASTER_BOT_AVATAR);
  });

  it('prefers the identity nickname over a per-thread conversation hash', () => {
    const identity = deriveMemberBotAvatar('Builder');
    const groupSeatConversationId = '11111111-2222-3333-4444-555555555555';

    expect(
      resolveMemberBotAvatar({
        conversationId: groupSeatConversationId,
        nickname: 'Builder',
        stored: { Builder: identity },
      })
    ).toEqual(identity);
    expect(
      resolveMemberBotAvatar({
        conversationId: groupSeatConversationId,
        nickname: 'Builder',
        identityMemberId: 'member-builder',
        stored: { 'member-builder': identity },
      })
    ).toEqual(identity);
  });
});
