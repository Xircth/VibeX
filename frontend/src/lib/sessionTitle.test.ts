import { describe, expect, it } from 'vitest';
import {
  sanitizeSessionListTitle,
  sessionTitleIsCjk,
  truncateSessionTitle,
} from './sessionTitle';

describe('sanitizeSessionListTitle', () => {
  it('keeps a normal agent-returned title', () => {
    expect(sanitizeSessionListTitle('Implement auth')).toBe('Implement auth');
  });

  it('caps long titles at 32 characters', () => {
    const longTitle = 'Double Password Prompt on Project Login';
    expect(truncateSessionTitle(longTitle)).toBe(
      'Double Password Prompt on Projec'
    );
    expect(Array.from(sanitizeSessionListTitle(longTitle))).toHaveLength(32);
  });

  it('strips a host-history prefix from an agent-returned name', () => {
    expect(
      sanitizeSessionListTitle('Previous conversation:User Fix login')
    ).toBe('Fix login');
    expect(
      sanitizeSessionListTitle('Previous conversation:\nUser: Fix login')
    ).toBe('Fix login');
  });

  it('treats a prefix-only title as missing', () => {
    expect(sanitizeSessionListTitle('Previous conversation:User')).toBe('');
    expect(sanitizeSessionListTitle('Previous conversation:')).toBe('');
  });

  it('keeps a real title that only starts with previous conversation', () => {
    expect(sanitizeSessionListTitle('Previous conversation notes')).toBe(
      'Previous conversation notes'
    );
    expect(sanitizeSessionListTitle('Previous work on auth')).toBe(
      'Previous work on auth'
    );
  });

  it('detects CJK session titles for regular type weight', () => {
    expect(sessionTitleIsCjk('请参考附图，对我')).toBe(true);
    expect(sessionTitleIsCjk('新会话1')).toBe(true);
    expect(sessionTitleIsCjk('Implement auth')).toBe(false);
  });
});
