import { describe, expect, it } from 'vitest';
import {
  applyConflictHunk,
  getResolvedHunkIndices,
} from './applyConflictHunk';

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

const MULTI_RESULT = [
  'top',
  '<<<<<<< ours',
  'ours-1',
  '=======',
  'theirs-1',
  '>>>>>>> theirs',
  'middle',
  '<<<<<<< ours',
  'ours-2',
  '=======',
  'theirs-2',
  '>>>>>>> theirs',
  'bottom',
].join('\n');

const MULTI_HUNKS = [
  { index: 0, ours: 'ours-1', theirs: 'theirs-1' },
  { index: 1, ours: 'ours-2', theirs: 'theirs-2' },
];

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

  it('resolves hunk #0 then hunk #1 without shifting hunk indices', () => {
    const afterFirst = applyConflictHunk(MULTI_RESULT, MULTI_HUNKS, 0, 'ours');
    expect(afterFirst).toContain('ours-1');
    expect(afterFirst).toContain('<<<<<<< ours\nours-2');

    const resolvedAfterFirst = getResolvedHunkIndices(afterFirst, MULTI_HUNKS, [
      0,
    ]);
    expect(Array.from(resolvedAfterFirst)).toEqual([0]);

    const afterSecond = applyConflictHunk(
      afterFirst,
      MULTI_HUNKS,
      1,
      'theirs',
      resolvedAfterFirst
    );
    expect(afterSecond).toBe('top\nours-1\nmiddle\ntheirs-2\nbottom');
    expect(
      Array.from(getResolvedHunkIndices(afterSecond, MULTI_HUNKS, [0, 1]))
    ).toEqual([0, 1]);
  });

  it('resolves hunk #1 then hunk #0 in reverse order', () => {
    const afterSecond = applyConflictHunk(
      MULTI_RESULT,
      MULTI_HUNKS,
      1,
      'theirs'
    );
    expect(afterSecond).toContain('theirs-2');
    expect(afterSecond).toContain('<<<<<<< ours\nours-1');

    const afterFirst = applyConflictHunk(afterSecond, MULTI_HUNKS, 0, 'ours');
    expect(afterFirst).toBe('top\nours-1\nmiddle\ntheirs-2\nbottom');
  });

  it('handles identical conflict hunks and undo restoration accurately', () => {
    const identicalResult = [
      'a',
      '<<<<<<< ours',
      'same-ours',
      '=======',
      'same-theirs',
      '>>>>>>> theirs',
      'b',
      '<<<<<<< ours',
      'same-ours',
      '=======',
      'same-theirs',
      '>>>>>>> theirs',
      'c',
    ].join('\n');
    const identicalHunks = [
      { index: 0, ours: 'same-ours', theirs: 'same-theirs' },
      { index: 1, ours: 'same-ours', theirs: 'same-theirs' },
    ];

    const afterFirst = applyConflictHunk(
      identicalResult,
      identicalHunks,
      0,
      'ours'
    );
    expect(afterFirst).toBe(
      [
        'a',
        'same-ours',
        'b',
        '<<<<<<< ours',
        'same-ours',
        '=======',
        'same-theirs',
        '>>>>>>> theirs',
        'c',
      ].join('\n')
    );

    const resolvedAfterFirst = getResolvedHunkIndices(
      afterFirst,
      identicalHunks,
      [0]
    );
    expect(Array.from(resolvedAfterFirst)).toEqual([0]);

    // Clicking an already-resolved hunk is a no-op when resolvedIndices is passed.
    expect(
      applyConflictHunk(
        afterFirst,
        identicalHunks,
        0,
        'theirs',
        resolvedAfterFirst
      )
    ).toBe(afterFirst);

    const afterSecond = applyConflictHunk(
      afterFirst,
      identicalHunks,
      1,
      'theirs',
      resolvedAfterFirst
    );
    expect(afterSecond).toBe('a\nsame-ours\nb\nsame-theirs\nc');

    // Simulating Ctrl+Z undoing the second resolution restores #2 as unresolved while keeping #1 resolved.
    expect(
      Array.from(getResolvedHunkIndices(afterFirst, identicalHunks, [0, 1]))
    ).toEqual([0]);
  });
});
