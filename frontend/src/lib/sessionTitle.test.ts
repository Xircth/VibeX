import { describe, expect, it } from 'vitest';
import { sanitizeSessionListTitle } from './sessionTitle';

describe('sanitizeSessionListTitle', () => {
  it('keeps a normal agent-returned title', () => {
    expect(sanitizeSessionListTitle('Implement auth')).toBe('Implement auth');
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
});
