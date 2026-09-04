import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CONTRIBUTION_ICONS } from './manifest.js';

describe('contribution icons', () => {
  it('match the published contract catalog', async () => {
    const catalogUrl = new URL(
      '../../plugin-contract/catalog/icons.v1.json',
      import.meta.url
    );
    const catalog = JSON.parse(
      await readFile(fileURLToPath(catalogUrl), 'utf8')
    ) as { icons: string[] };

    expect([...CONTRIBUTION_ICONS]).toEqual(catalog.icons);
  });

  it('are sorted and unique so the set stays reviewable', () => {
    const sorted = [...CONTRIBUTION_ICONS].sort();
    expect([...CONTRIBUTION_ICONS]).toEqual(sorted);
    expect(new Set(CONTRIBUTION_ICONS).size).toBe(CONTRIBUTION_ICONS.length);
  });
});
