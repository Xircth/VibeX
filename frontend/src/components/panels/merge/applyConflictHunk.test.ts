import { describe, expect, it } from 'vitest';
import { applyConflictHunk } from './applyConflictHunk';

const RESULT = [
  'keep',
  '<<<<<<< ours',
  'left',
  '=======',
  'right',
  '>>>>>>> theirs',
  'tail',
].join('\n');

const HUNKS = [{ index: 0, ours: 'left', theirs: 'right' }];

describe('applyConflictHunk', () => {
  it('takes ours without touching surrounding lines', () => {
    expect(applyConflictHunk(RESULT, HUNKS, 0, 'ours')).toBe(
      'keep\nleft\ntail'
    );
  });

  it('takes theirs', () => {
    expect(applyConflictHunk(RESULT, HUNKS, 0, 'theirs')).toBe(
      'keep\nright\ntail'
    );
  });

  it('takes both in order', () => {
    expect(applyConflictHunk(RESULT, HUNKS, 0, 'both')).toBe(
      'keep\nleft\nright\ntail'
    );
  });

  it('leaves the buffer unchanged for an unknown hunk', () => {
    expect(applyConflictHunk(RESULT, HUNKS, 4, 'ours')).toBe(RESULT);
  });
});
