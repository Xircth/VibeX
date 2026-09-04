import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CONTRIBUTION_ICONS,
  contributionIconComponent,
} from './contributionIcon';

const catalog = JSON.parse(
  readFileSync(
    resolve(process.cwd(), '../packages/plugin-contract/catalog/icons.v1.json'),
    'utf8'
  )
) as { icons: string[] };

describe('contribution icon map', () => {
  it('renders exactly the icons the contract publishes', () => {
    expect(Object.keys(CONTRIBUTION_ICONS).sort()).toEqual(
      [...catalog.icons].sort()
    );
  });

  it('falls back instead of rendering nothing for an unknown name', () => {
    expect(contributionIconComponent('not-an-icon')).toBe(
      CONTRIBUTION_ICONS.puzzle
    );
    expect(contributionIconComponent(undefined)).toBe(
      CONTRIBUTION_ICONS.puzzle
    );
  });
});
