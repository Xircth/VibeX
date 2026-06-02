import { describe, expect, it } from 'vitest';
import { mergeProjectsById } from './projectRailProjects';

describe('mergeProjectsById', () => {
  it('keeps live stream projects first and appends fallback-only projects', () => {
    expect(
      mergeProjectsById(
        [
          { id: 'project-b', name: 'Project B' },
          { id: 'project-a', name: 'Project A (live)' },
        ],
        [
          { id: 'project-a', name: 'Project A (fallback)' },
          { id: 'project-c', name: 'Project C' },
        ]
      )
    ).toEqual([
      { id: 'project-b', name: 'Project B' },
      { id: 'project-a', name: 'Project A (live)' },
      { id: 'project-c', name: 'Project C' },
    ]);
  });

  it('returns fallback projects when the live stream is empty', () => {
    expect(
      mergeProjectsById([], [
        { id: 'project-a', name: 'Project A' },
        { id: 'project-b', name: 'Project B' },
      ])
    ).toEqual([
      { id: 'project-a', name: 'Project A' },
      { id: 'project-b', name: 'Project B' },
    ]);
  });
});
