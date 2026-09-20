import { describe, expect, it } from 'vitest';
import {
  buildProjectRailOrderedIds,
  capProjectRailVisibleCount,
  DEFAULT_PROJECT_RAIL_VISIBLE_PROJECTS,
  MAX_PROJECT_RAIL_VISIBLE_PROJECTS,
  projectRailPanelHeight,
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

  it('keeps a six-project default height and expands up to ten', () => {
    expect(capProjectRailVisibleCount(3)).toBe(
      DEFAULT_PROJECT_RAIL_VISIBLE_PROJECTS
    );
    expect(capProjectRailVisibleCount(8)).toBe(8);
    expect(capProjectRailVisibleCount(99)).toBe(
      MAX_PROJECT_RAIL_VISIBLE_PROJECTS
    );
    expect(projectRailPanelHeight(6)).toBeLessThan(projectRailPanelHeight(10));
  });
});
