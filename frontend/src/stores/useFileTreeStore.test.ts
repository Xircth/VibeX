import { beforeEach, describe, expect, it } from 'vitest';
import { useFileTreeStore } from './useFileTreeStore';

describe('useFileTreeStore expansion', () => {
  beforeEach(() => {
    useFileTreeStore.setState({
      rootPath: null,
      selectedFilePath: null,
      expandedByRoot: {},
      lazyListingByRoot: {},
      diffFilePath: null,
      revealTarget: null,
    });
  });

  it('keeps expanded folders for a workspace after a remount-style reset', () => {
    useFileTreeStore
      .getState()
      .setExpandedFolders('/repo', new Set(['src', 'docs']));

    expect([
      ...useFileTreeStore.getState().expandedFoldersFor('/repo'),
    ]).toEqual(['src', 'docs']);

    useFileTreeStore.getState().setRootPath(null);
    useFileTreeStore.getState().setRootPath('/repo');

    expect([
      ...useFileTreeStore.getState().expandedFoldersFor('/repo'),
    ]).toEqual(['src', 'docs']);
  });

  it('keeps lazy listings for a workspace after the root path is cleared', () => {
    const listing = {
      files: new Set(['src/index.ts']),
      directories: new Set(['src']),
      gitignoredFiles: new Set<string>(),
      gitignoredDirectories: new Set<string>(),
      loadableDirectories: new Set(['src']),
      loadedDirectories: new Set(['src']),
    };
    useFileTreeStore.getState().setLazyListing('/repo', listing);
    useFileTreeStore.getState().setRootPath(null);
    useFileTreeStore.getState().setRootPath('/repo');

    expect([
      ...useFileTreeStore.getState().lazyListingFor('/repo').loadedDirectories,
    ]).toEqual(['src']);
    expect([
      ...useFileTreeStore.getState().lazyListingFor('/repo').files,
    ]).toEqual(['src/index.ts']);
  });

  it('does not leak one workspace expansion into another', () => {
    useFileTreeStore.getState().setExpandedFolders('/repo-a', new Set(['src']));
    useFileTreeStore.getState().setExpandedFolders('/repo-b', new Set(['lib']));

    expect([
      ...useFileTreeStore.getState().expandedFoldersFor('/repo-a'),
    ]).toEqual(['src']);
    expect([
      ...useFileTreeStore.getState().expandedFoldersFor('/repo-b'),
    ]).toEqual(['lib']);
  });
});
