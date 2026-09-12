import { describe, expect, it } from 'vitest';

import { pluginConfigEnableItemCount } from './pluginConfigEnableConfirm';

describe('pluginConfigEnableItemCount', () => {
  it('prefers an explicit schema count', () => {
    expect(
      pluginConfigEnableItemCount(
        {
          type: 'boolean',
          'x-itemCount': 7,
          description: 'Topic ideation. (13 Skills)',
        },
        '（13 项技能）'
      )
    ).toBe(7);
  });

  it('reads the localized description before the schema fallback', () => {
    expect(
      pluginConfigEnableItemCount(
        {
          type: 'boolean',
          description: '选题构思。默认开启。（13 项技能）',
        },
        'Search papers. (12 Skills)'
      )
    ).toBe(12);
  });

  it('reads a Chinese or English skill-pack count from schema copy', () => {
    expect(
      pluginConfigEnableItemCount({
        type: 'boolean',
        description: '默认开启。（13 项技能）',
      })
    ).toBe(13);
    expect(
      pluginConfigEnableItemCount({
        type: 'boolean',
        description: 'On by default. (13 Skills)',
      })
    ).toBe(13);
  });

  it('ignores booleans that are not skill packs', () => {
    expect(
      pluginConfigEnableItemCount({
        type: 'boolean',
        title: 'Document preview',
      })
    ).toBeNull();
    expect(
      pluginConfigEnableItemCount({ type: 'boolean', 'x-itemCount': 0 })
    ).toBeNull();
  });
});
