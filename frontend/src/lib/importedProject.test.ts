import { describe, expect, it } from 'vitest';

import {
  importedProjectName,
  orderImportedProjects,
} from './importedProject';

describe('importedProjectName', () => {
  it('uses the localized Global label for the home project', () => {
    expect(
      importedProjectName({ name: 'Global', is_home: true }, (key) =>
        key === 'welcomePage.globalProject' ? '全局' : key
      )
    ).toBe('全局');
  });

  it('keeps ordinary project names', () => {
    expect(importedProjectName({ name: 'VibeX' }, (key) => key)).toBe('VibeX');
  });
});

describe('orderImportedProjects', () => {
  it('puts the home project first', () => {
    expect(
      orderImportedProjects([
        { name: 'codeg', is_home: false },
        { name: 'Global', is_home: true },
        { name: 'notes', is_home: false },
      ]).map((project) => project.name)
    ).toEqual(['Global', 'codeg', 'notes']);
  });
});
