import { describe, expect, it } from 'vitest';
import type { ContentBlock } from 'shared/types';
import {
  collaborationSpaceOriginFromBlocks,
  shouldShowGroupMemberSender,
} from './collaborationSpaceOrigin';

const groupOrigin = {
  kind: 'collaboration_space_origin',
  spaceId: 'space-1',
  threadKind: 'group',
  senderKind: 'member',
  senderNickname: '小A',
  senderConversationId: 'conv-a',
  senderMemberId: 'member-a',
};

describe('collaborationSpaceOriginFromBlocks', () => {
  it('reads the space origin protocol block', () => {
    const blocks: ContentBlock[] = [
      { type: 'protocol', content: groupOrigin },
      { type: 'text', text: '请核对接口' },
    ];
    expect(collaborationSpaceOriginFromBlocks(blocks)).toEqual({
      spaceId: 'space-1',
      threadKind: 'group',
      senderKind: 'member',
      senderNickname: '小A',
      senderConversationId: 'conv-a',
      senderMemberId: 'member-a',
    });
  });

  it('ignores ordinary user turns', () => {
    expect(
      collaborationSpaceOriginFromBlocks([{ type: 'text', text: 'hello' }])
    ).toBeNull();
  });
});

describe('shouldShowGroupMemberSender', () => {
  it('shows the sender chip only for group member sessions', () => {
    expect(
      shouldShowGroupMemberSender({
        spaceId: 'space-1',
        threadKind: 'group',
        senderKind: 'user',
        senderNickname: '你',
      })
    ).toBe(true);
    expect(
      shouldShowGroupMemberSender({
        spaceId: 'direct:m1',
        threadKind: 'dm',
        senderKind: 'user',
        senderNickname: '你',
      })
    ).toBe(false);
    expect(shouldShowGroupMemberSender(null)).toBe(false);
  });
});
