import { describe, expect, it } from 'vitest';
import { isCreateSessionFormVisibleForProject } from './createSessionFormVisibility';

describe('isCreateSessionFormVisibleForProject', () => {
  it('hides the form when it is closed', () => {
    expect(
      isCreateSessionFormVisibleForProject({
        open: false,
        openedForProjectId: 'project-a',
        currentProjectId: 'project-a',
      })
    ).toBe(false);
  });

  it('shows the form only for the project that opened it', () => {
    expect(
      isCreateSessionFormVisibleForProject({
        open: true,
        openedForProjectId: 'project-a',
        currentProjectId: 'project-a',
      })
    ).toBe(true);
  });

  it('does not leak an open form into another project', () => {
    expect(
      isCreateSessionFormVisibleForProject({
        open: true,
        openedForProjectId: 'project-a',
        currentProjectId: 'project-b',
      })
    ).toBe(false);
  });

  it('hides the form when either project id is missing', () => {
    expect(
      isCreateSessionFormVisibleForProject({
        open: true,
        openedForProjectId: 'project-a',
        currentProjectId: undefined,
      })
    ).toBe(false);
    expect(
      isCreateSessionFormVisibleForProject({
        open: true,
        openedForProjectId: null,
        currentProjectId: 'project-b',
      })
    ).toBe(false);
  });
});
