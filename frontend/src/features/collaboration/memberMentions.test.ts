import { describe, expect, it } from 'vitest';

import { splitTextByMemberMentions } from './memberMentions';

describe('splitTextByMemberMentions', () => {
  const roster = ['小A', '小AB', '小B'];

  it('chips only nicknames that exist on the agent roster', () => {
    expect(splitTextByMemberMentions('请 @小A 看 diff', roster)).toEqual([
      { type: 'text', value: '请 ' },
      { type: 'mention', nickname: '小A' },
      { type: 'text', value: ' 看 diff' },
    ]);
  });

  it('keeps @我 and @你 as plain text when no such member exists', () => {
    expect(splitTextByMemberMentions('@我 看一下', roster)).toEqual([
      { type: 'text', value: '@我 看一下' },
    ]);
    expect(splitTextByMemberMentions('抄送 @你', roster)).toEqual([
      { type: 'text', value: '抄送 @你' },
    ]);
  });

  it('does not invent a member from a generic @word', () => {
    expect(splitTextByMemberMentions('见 @不存在 和 @someone', roster)).toEqual(
      [{ type: 'text', value: '见 @不存在 和 @someone' }]
    );
  });

  it('does not chip anything when the roster is empty', () => {
    expect(splitTextByMemberMentions('@小A @我 hello', [])).toEqual([
      { type: 'text', value: '@小A @我 hello' },
    ]);
  });

  it('prefers the longer known nickname when one is a prefix of another', () => {
    expect(splitTextByMemberMentions('@小AB 来一下', roster)).toEqual([
      { type: 'mention', nickname: '小AB' },
      { type: 'text', value: ' 来一下' },
    ]);
  });
});
