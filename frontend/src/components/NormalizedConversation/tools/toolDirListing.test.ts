import { describe, expect, it } from 'vitest';
import { listDirPath, parseDirectoryListing } from './toolDirListing';

describe('parseDirectoryListing', () => {
  it('reads newline listings and trailing slashes as folders', () => {
    expect(parseDirectoryListing('src/\nREADME.md\npackage.json')).toEqual([
      { name: 'src', kind: 'folder' },
      { name: 'README.md', kind: 'file' },
      { name: 'package.json', kind: 'file' },
    ]);
  });

  it('reads structured entries', () => {
    expect(
      parseDirectoryListing({
        entries: [
          { name: 'hooks', type: 'directory' },
          { name: 'index.ts', type: 'file' },
        ],
      })
    ).toEqual([
      { name: 'hooks', kind: 'folder' },
      { name: 'index.ts', kind: 'file' },
    ]);
  });

  it('reads the directory path from list_dir arguments', () => {
    expect(
      listDirPath({ target_directory: '/Users/mac/Projects/VibeX/frontend' })
    ).toBe('/Users/mac/Projects/VibeX/frontend');
  });
});
