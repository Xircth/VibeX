import { describe, expect, it } from 'vitest';
import { formatFileTreeStructure } from './fileTreeStructure';

describe('formatFileTreeStructure', () => {
  it('prints folders with a trailing slash and indents children', () => {
    expect(
      formatFileTreeStructure([
        {
          name: 'src',
          path: 'src',
          type: 'folder',
          children: [
            {
              name: 'main.ts',
              path: 'src/main.ts',
              type: 'file',
              children: [],
            },
          ],
        },
        {
          name: 'README.md',
          path: 'README.md',
          type: 'file',
          children: [],
        },
      ])
    ).toBe('src/\n  main.ts\nREADME.md');
  });
});
