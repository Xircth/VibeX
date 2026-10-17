import { Orientation } from 'dockview-core';
import { describe, expect, it } from 'vitest';
import {
  leastPopulatedEditorGroup,
  locationBelowGroups,
  terminalShelfHeight,
} from './dockviewEditorSplit';

describe('locationBelowGroups', () => {
  const root = Orientation.HORIZONTAL;

  it('puts a shelf under side-by-side groups that share a vertical parent', () => {
    expect(
      locationBelowGroups(
        [
          [1, 0, 0],
          [1, 0, 1],
        ],
        root
      )
    ).toEqual([1, 1]);
  });

  it('splits a single group downward', () => {
    expect(locationBelowGroups([[1]], root)).toEqual([1, 1]);
  });

  it('extends a stack below the lowest group', () => {
    expect(
      locationBelowGroups(
        [
          [1, 0],
          [1, 1],
        ],
        root
      )
    ).toEqual([1, 2]);
  });

  it('returns null when groups do not share a branch', () => {
    expect(locationBelowGroups([[1], [2]], root)).toBeNull();
  });
});

describe('leastPopulatedEditorGroup', () => {
  it('prefers the active group when tab counts tie', () => {
    const groups = [
      { id: 'group-editor-1', panels: [{ id: 'file:a.ts' }] },
      { id: 'group-editor-2', panels: [{ id: 'file:b.ts' }] },
    ];

    expect(leastPopulatedEditorGroup(groups, 'group-editor-2')?.id).toBe(
      'group-editor-2'
    );
  });

  it('ignores placeholder tabs and chooses the smaller group', () => {
    const groups = [
      {
        id: 'group-editor-1',
        panels: [{ id: 'welcome' }, { id: 'file:a.ts' }, { id: 'file:b.ts' }],
      },
      { id: 'group-editor-2', panels: [{ id: 'file:c.ts' }] },
    ];

    expect(leastPopulatedEditorGroup(groups, 'group-editor-1')?.id).toBe(
      'group-editor-2'
    );
  });
});

describe('terminalShelfHeight', () => {
  it('uses about 40 percent of the grid and at least 120', () => {
    expect(terminalShelfHeight(800)).toBe(320);
    expect(terminalShelfHeight(200)).toBe(120);
    expect(terminalShelfHeight(0)).toBe(0);
  });
});
