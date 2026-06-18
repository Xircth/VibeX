import { describe, expect, it } from 'vitest';
import type { Operation } from 'rfc6902';
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

  it('structural-sharing copy matches a deep clone and shares untouched entries', () => {
    // Locks the streamJsonPatchEntries hot-path change: replacing
    // `structuredClone(snapshot)` with `{ entries: entries.slice() }` yields the
    // same values, since applyUpsertPatch replaces whole elements at /entries/N
    // and never mutates the others.
    const a = { id: 1, v: 'a' };
    const b = { id: 2, v: 'b' };
    const snapshot = { entries: [a, b] };
    const ops: Operation[] = [
      { op: 'replace', path: '/entries/1', value: { id: 2, v: 'B' } },
      { op: 'add', path: '/entries/2', value: { id: 3, v: 'c' } },
    ];

    const deep = structuredClone(snapshot);
    applyUpsertPatch(deep, ops);

    const shared = { entries: snapshot.entries.slice() };
    applyUpsertPatch(shared, ops);

    expect(shared.entries).toEqual(deep.entries);
    // Untouched entry is shared by reference (the point of the change), and the
    // original snapshot is left intact.
    expect(shared.entries[0]).toBe(a);
    expect(snapshot.entries).toEqual([a, b]);
  });
});
