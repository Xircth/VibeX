import { describe, expect, it } from 'vitest';
import { applyUpsertPatch } from './jsonPatch';

describe('applyUpsertPatch', () => {
  it('treats add on an existing array index as replace', () => {
    const target = {
      entries: ['first', 'second'],
    };

    applyUpsertPatch(target, [
      {
        op: 'add',
        path: '/entries/1',
        value: 'updated-second',
      },
    ]);

    expect(target).toEqual({
      entries: ['first', 'updated-second'],
    });
  });

  it('preserves append semantics for add at the end of an array', () => {
    const target = {
      entries: ['first'],
    };

    applyUpsertPatch(target, [
      {
        op: 'add',
        path: '/entries/1',
        value: 'second',
      },
    ]);

    expect(target).toEqual({
      entries: ['first', 'second'],
    });
  });
});
