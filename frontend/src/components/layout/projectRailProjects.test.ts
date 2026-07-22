import { describe, expect, it } from 'vitest';
import {
  buildProjectRailOrderedIds,
  capProjectRailVisibleCount,
  MAX_PROJECT_RAIL_VISIBLE_PROJECTS,
} from './projectRailProjects';

describe('project rail project ordering', () => {
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

  it('caps the visible project count to the rail limit', () => {
    expect(capProjectRailVisibleCount(3)).toBe(3);
    expect(capProjectRailVisibleCount(99)).toBe(
      MAX_PROJECT_RAIL_VISIBLE_PROJECTS
    );
  });
});
