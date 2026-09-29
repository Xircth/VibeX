import { describe, expect, it } from 'vitest';

import {
  importedProjectName,
  listedImportedProjects,
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

describe('listedImportedProjects', () => {
  it('drops hidden projects after a successful unlist', () => {
    expect(
      listedImportedProjects([
        { id: 'home', hidden: false },
        { id: 'stallerlab', hidden: true },
        { id: 'vibex', hidden: false },
      ]).map((project) => project.id)
    ).toEqual(['home', 'vibex']);
  });
});
