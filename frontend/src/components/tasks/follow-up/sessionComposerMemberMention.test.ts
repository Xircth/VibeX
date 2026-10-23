import { describe, expect, it } from 'vitest';

import {
  deleteSessionComposerStructuredToken,
  getSessionComposerStructuredTokenSegments,
  serializeSessionComposerBackendMessage,
} from './sessionComposerStructuredTokens';

const members = [{ nickname: 'Alice' }, { nickname: 'Alice Pro' }, { nickname: '小明' }];

describe('member mention composer tokens', () => {
  it('parses a known @member followed by whitespace as one atomic chip', () => {
    const segments = getSessionComposerStructuredTokenSegments('hi @小明 go', {
      memberMentions: members,
    });
    const token = segments.find((s) => s.kind === 'token');
    expect(token && 'token' in token ? token.token : null).toMatchObject({ kind: 'member_mention', raw: '@小明', label: '小明' });
  });

  it('does not chip a mention still being typed at end of text', () => {
    const segments = getSessionComposerStructuredTokenSegments('hi @小明', {
      memberMentions: members,
    });
    expect(segments.some((s) => 'token' in s && s.token.kind === 'member_mention')).toBe(false);
  });

  it('serializes chips back to the plain @nick the backend parses', () => {
    const text = '@Alice please ping @小明 now';
    expect(serializeSessionComposerBackendMessage(text)).toBe(text);
    expect(/(?:^|\s)@([^\s@]+)/g.test(serializeSessionComposerBackendMessage(text))).toBe(true);
  });

  it('removes the whole chip with one Backspace', () => {
    const value = 'hi @小明 go';
    const caret = 'hi @小明'.length;
    const result = deleteSessionComposerStructuredToken({
      value,
      selectionStart: caret,
      selectionEnd: caret,
      direction: 'backward',
      memberMentions: members,
    });
    expect(result?.value.replace(/\s+/g, ' ')).toBe('hi go');
    expect(result?.caretOffset).toBe(3);
  });

  it('removes the whole chip with one Delete', () => {
    const value = 'hi @小明 go';
    const result = deleteSessionComposerStructuredToken({
      value,
      selectionStart: 3,
      selectionEnd: 3,
      direction: 'forward',
      memberMentions: members,
    });
    expect(result?.value).not.toContain('小明');
  });

  it('prefers the longest nickname match', () => {
    const segments = getSessionComposerStructuredTokenSegments('@Alice Pro hi', {
      memberMentions: members,
    });
    const seg = segments.find((s) => 'token' in s && s.token.kind === 'member_mention');
    expect(seg && 'token' in seg ? seg.token : undefined).toMatchObject({ label: 'Alice Pro' });
  });
});
