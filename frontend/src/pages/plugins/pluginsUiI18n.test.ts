import { afterEach, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import enSettings from '@/i18n/locales/en/settings.json';
import zhSettings from '@/i18n/locales/zh-CN/settings.json';
import {
  buildRepoTreeNodes,
  localizedContentTitle,
} from './officialPluginContentCatalog';
import { pluginCategoryLabel } from './officialPlugins';

const t = (key: string, options?: Record<string, unknown>) =>
  i18n.t(key, { ns: 'settings', ...options }) as string;

function leafPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([k, v]) =>
    leafPaths(v, prefix ? `${prefix}.${k}` : k)
  );
}

describe('plugins / kanban / settings UI i18n', () => {
  afterEach(async () => {
    await i18n.changeLanguage('zh-CN');
  });

  it('en and zh-CN define the same uiwonder keys', () => {
    for (const section of ['pluginsUi', 'kanbanUi', 'settingsUi'] as const) {
      const en = leafPaths((enSettings as Record<string, unknown>)[section]);
      const zh = leafPaths((zhSettings as Record<string, unknown>)[section]);
      expect(zh.sort(), section).toEqual(en.sort());
    }
  });

  it('english locale has no CJK in the new blocks', () => {
    const json = JSON.stringify([
      enSettings.pluginsUi,
      enSettings.kanbanUi,
      enSettings.settingsUi,
    ]);
    expect(json).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('repo tree folder labels follow the language', async () => {
    const entries = [
      { path: 'a', type: 'tree' as const },
      { path: 'a/b.md', type: 'blob' as const },
    ];
    await i18n.changeLanguage('en');
    const en = buildRepoTreeNodes(entries as never, t).nodes[0];
    expect(en.kindLabel).toBe('Folder');
    expect(en.sizeLabel).toBe('1 items');
    await i18n.changeLanguage('zh-CN');
    const zh = buildRepoTreeNodes(entries as never, t).nodes[0];
    expect(zh.kindLabel).toBe('目录');
  });

  it('official component titles and categories re-localize', async () => {
    const doc = {
      path: 'app/settings-pages/computer-use.md',
      title: '电脑控制',
    };
    await i18n.changeLanguage('en');
    expect(localizedContentTitle(doc, t)).toBe('Computer Control');
    expect(localizedContentTitle({ path: 'x.md', title: '自定义' }, t)).toBe(
      '自定义'
    );
    expect(
      pluginCategoryLabel('design', i18n.getFixedT('en', 'settings'))
    ).toBe('Design');
    await i18n.changeLanguage('zh-CN');
    expect(localizedContentTitle(doc, t)).toBe('电脑控制');
  });
});
