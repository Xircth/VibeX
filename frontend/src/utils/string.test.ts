import { describe, expect, it } from 'vitest';
import { generateProjectNameFromPath, parentDirectory } from './string';

describe('parentDirectory', () => {
  it('walks posix paths', () => {
    expect(parentDirectory('/Users/dev/Projects')).toBe('/Users/dev');
    expect(parentDirectory('/Users')).toBe('/');
    expect(parentDirectory('/')).toBe('/');
  });

  it('walks windows paths including a drive root', () => {
    expect(parentDirectory('C:\\Users\\dev\\Projects')).toBe('C:\\Users\\dev');
    expect(parentDirectory('C:\\Users')).toBe('C:\\');
    expect(parentDirectory('C:\\')).toBe('C:\\');
  });
});

describe('generateProjectNameFromPath', () => {
  it('uses the last posix segment', () => {
    expect(generateProjectNameFromPath('/tmp/my-awesome-project')).toBe(
      'My Awesome Project'
    );
  });

  it('uses the last windows segment', () => {
    expect(generateProjectNameFromPath('C:\\src\\my-awesome-project')).toBe(
      'My Awesome Project'
    );
  });
});
