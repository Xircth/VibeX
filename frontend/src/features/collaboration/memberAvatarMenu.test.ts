import { describe, expect, it, vi } from 'vitest';

import { deriveMemberBotAvatar } from './MemberBotAvatar';
import {
  buildMemberAvatarMenuItems,
  memberMentionLabelStyle,
  memberMentionMenuLabel,
} from './memberAvatarMenu';

const labels = (
  items: ReturnType<typeof buildMemberAvatarMenuItems>
) =>
  items.map((item) =>
    item.type === 'separator'
      ? '---'
      : item.type === 'emoji-row'
        ? 'emojis'
        : item.label
  );

describe('member avatar menu', () => {
  it('lists a colored @mention, private chat and open session', () => {
    const color = deriveMemberBotAvatar('小A').color;
    const onMention = vi.fn();
    const items = buildMemberAvatarMenuItems({
      nickname: '小A',
      color,
      onMention,
      onOpenPrivateChat: vi.fn(),
      onOpenSession: vi.fn(),
    });
    expect(labels(items)).toEqual(['@小A', '---', '进入私聊', '打开会话']);
    const mention = items[0];
    expect(
      mention.type !== 'separator' &&
        mention.type !== 'emoji-row' &&
        mention.label
    ).toBe(memberMentionMenuLabel('小A'));
    expect(
      mention.type !== 'separator' &&
        mention.type !== 'emoji-row' &&
        'labelStyle' in mention &&
        mention.labelStyle
    ).toEqual(memberMentionLabelStyle(color));
    if (mention.type !== 'separator' && mention.type !== 'emoji-row') {
      mention.onSelect?.();
    }
    expect(onMention).toHaveBeenCalledOnce();
  });
});
