import { describe, expect, it } from 'vitest';
import {
  buildProjectRailOrderedIds,
  buildProjectRailTree,
  capProjectRailVisibleCount,
  selectBottomStatusProjectIds,
  DEFAULT_PROJECT_RAIL_VISIBLE_PROJECTS,
  MAX_PROJECT_RAIL_VISIBLE_PROJECTS,
  projectRailPanelHeight,
} from './projectRailProjects';

describe('project rail project ordering', () => {
  it('keeps the status bar to the six most recently opened projects', () => {
    expect(
      selectBottomStatusProjectIds({
        currentProjectId: 'p1',
        openProjectIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'],
        existingProjectIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'],
      })
    ).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
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

  it('keeps child repos nested under their parent in a stable order', () => {
    const parent = {
      id: 'parent',
      name: 'projects',
      parent_project_id: null,
    };
    const children = [
      { id: 'c-open', name: 'open-connector', parent_project_id: 'parent' },
      { id: 'c-vibex', name: 'VibeX', parent_project_id: 'parent' },
      { id: 'c-codeg', name: 'codeg', parent_project_id: 'parent' },
    ];

    const first = buildProjectRailTree([parent, ...children]);
    const second = buildProjectRailTree([
      children[1],
      parent,
      children[2],
      children[0],
    ]);

    expect(first.map((project) => project.id)).toEqual([
      'parent',
      'c-codeg',
      'c-open',
      'c-vibex',
    ]);
    expect(second.map((project) => project.id)).toEqual(
      first.map((project) => project.id)
    );
    expect(second.map((project) => project.depth)).toEqual([0, 1, 1, 1]);
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
