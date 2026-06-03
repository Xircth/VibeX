import { describe, expect, it } from 'vitest';
import {
  buildProjectRailOrderedIds,
  capProjectRailVisibleCount,
  MAX_PROJECT_RAIL_VISIBLE_PROJECTS,
  mergeProjectsById,
} from './projectRailProjects';

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

  it('orders recent and tracked projects before the rest of the project list', () => {
    expect(
      buildProjectRailOrderedIds({
        openProjectIds: ['project-c', 'project-a'],
        currentProjectId: 'project-b',
        projectSnapshotIds: ['project-a', 'project-d'],
        projectIds: ['project-a', 'project-b', 'project-c', 'project-d'],
      })
    ).toEqual(['project-c', 'project-a', 'project-b', 'project-d']);
  });

  it('prefers project list order when explicitly requested for standalone rail rendering', () => {
    expect(
      buildProjectRailOrderedIds({
        openProjectIds: ['project-c', 'project-a'],
        currentProjectId: 'project-b',
        projectSnapshotIds: ['project-a', 'project-d'],
        projectIds: ['project-d', 'project-c', 'project-b', 'project-a'],
        preferProjectListOrder: true,
      })
    ).toEqual(['project-d', 'project-c', 'project-b', 'project-a']);
  });

  it('caps the visible project count to the standalone rail limit', () => {
    expect(capProjectRailVisibleCount(3)).toBe(3);
    expect(capProjectRailVisibleCount(99)).toBe(
      MAX_PROJECT_RAIL_VISIBLE_PROJECTS
    );
  });
});
